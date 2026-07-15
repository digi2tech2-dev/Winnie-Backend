'use strict';

const mongoose = require('mongoose');
const Group = require('../groups/group.model');
const {
    User,
    ROLES,
    USER_STATUS,
    SUB_AGENT_STATUS,
    AGENT_PROFILE_STATUS,
    REFERRAL_STOP_REASONS,
} = require('../users/user.model');
const referralService = require('../referrals/referral.service');
const { createAuditLog } = require('../audit/audit.service');
const {
    GROUP_REQUEST_ACTIONS,
    REFERRAL_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
} = require('../audit/audit.constants');
const {
    safeCreateNotification,
    safeCreateAdminActorNotifications,
} = require('../notifications/notification.service');
const { NOTIFICATION_TYPES, NOTIFICATION_PRIORITIES } = require('../notifications/notification.model');
const {
    NotFoundError,
    BusinessRuleError,
    AuthorizationError,
} = require('../../shared/errors/AppError');
const { GroupChangeRequest } = require('./groupRequest.model');
const {
    GROUP_REQUEST_TYPES,
    GROUP_REQUEST_STATUS,
    GROUP_REQUEST_PERMISSIONS,
} = require('./groupRequest.constants');

const GROUP_PROJECTION = 'name percentage isActive deletedAt';
const USER_PROJECTION = 'name email role status groupId isSubAgent subAgentStatus permissions referralCode referredBy referredByAgentId referralCommissionStoppedAt agentProfile';

const parsePage = (value) => Math.max(1, parseInt(value, 10) || 1);
const parseLimit = (value) => Math.min(100, Math.max(1, parseInt(value, 10) || 20));

const toIdString = (value) => {
    if (!value) return null;
    if (typeof value === 'object' && value._id) return value._id.toString();
    return value.toString();
};

const sameId = (left, right) => toIdString(left) === toIdString(right);

const trimOrNull = (value) => {
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim();
    return normalized || null;
};

const runQuery = (query, session = null) => (session ? query.session(session) : query);

const getActiveGroupOrThrow = async (groupId, { session = null } = {}) => {
    if (!groupId) return null;

    const group = await runQuery(Group.findById(groupId).select(GROUP_PROJECTION), session);
    if (!group) throw new NotFoundError('Group');

    if (!group.isActive || group.deletedAt) {
        throw new BusinessRuleError(
            `Group '${group.name}' is inactive and cannot be selected.`,
            'GROUP_INACTIVE'
        );
    }

    return group;
};

const getCustomerOrThrow = async (userId, { session = null } = {}) => {
    const user = await runQuery(User.findById(userId).select(USER_PROJECTION), session);
    if (!user) throw new NotFoundError('User');

    if (user.role !== ROLES.CUSTOMER) {
        throw new AuthorizationError('Only customers can use group request workflow.');
    }

    if (user.status !== USER_STATUS.ACTIVE) {
        throw new AuthorizationError('Only active customers can create or update group requests.');
    }

    return user;
};

const snapshotGroup = (group) => {
    if (!group) return null;
    return {
        id: toIdString(group._id || group.id),
        name: group.name,
        percentage: group.percentage,
        isActive: group.isActive,
    };
};

const snapshotUser = (user) => {
    if (!user) return null;
    return {
        id: toIdString(user._id || user.id),
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status,
        groupId: toIdString(user.groupId),
        isSubAgent: user.isSubAgent === true,
        subAgentStatus: user.subAgentStatus || SUB_AGENT_STATUS.NONE,
    };
};

const summarizeGroup = (group, snapshot = null) => {
    const source = group && typeof group === 'object' && group.name !== undefined ? group : snapshot;
    if (!source) return group ? { id: toIdString(group) } : null;
    return {
        id: toIdString(source._id || source.id),
        name: source.name || null,
        percentage: source.percentage ?? null,
        isActive: source.isActive ?? null,
    };
};

const summarizeGroupOption = (group, currentGroupId = null) => {
    if (!group) return null;
    const id = toIdString(group._id || group.id);
    return {
        id,
        name: group.name || null,
        isCurrent: Boolean(currentGroupId && id === toIdString(currentGroupId)),
    };
};

const summarizeUser = (user, { admin = false } = {}) => {
    if (!user) return null;
    const source = user && typeof user === 'object' && user.name !== undefined ? user : null;
    if (!source) return { id: toIdString(user) };

    const summary = {
        id: toIdString(source._id || source.id),
        name: source.name || null,
        role: source.role || null,
        status: source.status || null,
        isSubAgent: source.isSubAgent === true,
        subAgentStatus: source.subAgentStatus || SUB_AGENT_STATUS.NONE,
    };

    if (admin) summary.email = source.email || null;
    return summary;
};

const formatRequest = (request, { admin = false } = {}) => {
    if (!request) return null;
    const reviewed = Boolean(request.reviewedAt) ||
        [GROUP_REQUEST_STATUS.APPROVED, GROUP_REQUEST_STATUS.REJECTED].includes(request.status);

    const formatted = {
        id: toIdString(request._id || request.id),
        requestType: request.requestType,
        status: request.status,
        currentGroup: summarizeGroup(request.currentGroupId, request.currentGroupSnapshot),
        requestedGroup: summarizeGroup(request.requestedGroupId, request.requestedGroupSnapshot),
        approvedGroup: summarizeGroup(request.approvedGroupId, request.approvedGroupSnapshot),
        approvedCommissionPercent: request.approvedCommissionPercent ?? null,
        reason: request.reason || null,
        adminNote: admin || reviewed ? request.adminNote || null : null,
        reviewedAt: request.reviewedAt || null,
        reviewedBy: admin ? summarizeUser(request.reviewedBy, { admin: true }) : undefined,
        canceledAt: request.canceledAt || null,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
    };

    if (admin) {
        formatted.user = summarizeUser(request.userId, { admin: true });
        formatted.metadata = request.metadata || undefined;
    }

    return formatted;
};

const populateRequestQuery = (query) => query
    .populate('userId', 'name email role status isSubAgent subAgentStatus')
    .populate('currentGroupId', 'name percentage isActive')
    .populate('requestedGroupId', 'name percentage isActive')
    .populate('approvedGroupId', 'name percentage isActive')
    .populate('reviewedBy', 'name email role status');

const getFormattedRequestById = async (id, { admin = false } = {}) => {
    const request = await populateRequestQuery(GroupChangeRequest.findById(id)).lean();
    if (!request) throw new NotFoundError('Group change request');
    return formatRequest(request, { admin });
};

const getGroupChangeOptionsForUser = async (userId) => {
    const user = await getCustomerOrThrow(userId);
    const currentGroupId = user.groupId || null;

    const [currentGroup, groups] = await Promise.all([
        currentGroupId
            ? Group.findById(currentGroupId).select('name').lean()
            : null,
        Group.find({ isActive: true, deletedAt: null })
            .select('name')
            .sort({ name: 1 })
            .lean(),
    ]);

    return {
        currentGroup: currentGroup ? summarizeGroupOption(currentGroup, currentGroupId) : null,
        groups: groups.map((group) => summarizeGroupOption(group, currentGroupId)),
    };
};

const buildDateFilter = ({ from, to } = {}) => {
    if (!from && !to) return undefined;
    const createdAt = {};
    if (from) createdAt.$gte = new Date(from);
    if (to) createdAt.$lte = new Date(to);
    return createdAt;
};

const emitCreatedSideEffects = ({ request, userId, actor = {} }) => {
    if (!request) return;

    const requestId = request.id;
    const requestObjectId = new mongoose.Types.ObjectId(requestId);

    void createAuditLog({
        actorId: actor.actorId || userId,
        actorRole: actor.actorRole || ACTOR_ROLES.CUSTOMER,
        action: request.requestType === GROUP_REQUEST_TYPES.SUB_AGENT
            ? REFERRAL_ACTIONS.SUB_AGENT_REQUEST_CREATED
            : GROUP_REQUEST_ACTIONS.CREATED,
        entityType: ENTITY_TYPES.GROUP_REQUEST,
        entityId: requestObjectId,
        metadata: {
            requestType: request.requestType,
            userId: toIdString(userId),
            requestedGroupId: request.requestedGroup?.id || null,
        },
        ipAddress: actor.ipAddress || null,
        userAgent: actor.userAgent || null,
    });

    void safeCreateNotification({
        userId,
        title: 'Request submitted',
        message: request.requestType === GROUP_REQUEST_TYPES.SUB_AGENT
            ? 'Your sub-agent request was submitted for review.'
            : 'Your group change request was submitted for review.',
        type: NOTIFICATION_TYPES.ACCOUNT,
        priority: NOTIFICATION_PRIORITIES.NORMAL,
        route: '/me/group-change-requests',
        entityType: 'group_change_request',
        entityId: requestObjectId,
        metadata: {
            eventKey: `group-request:${requestId}:created:user`,
            eventType: 'group_request_created',
            requestType: request.requestType,
        },
    });

    void safeCreateAdminActorNotifications({
        roles: [ROLES.ADMIN, ROLES.SUPERVISOR],
        permissions: [
            GROUP_REQUEST_PERMISSIONS.VIEW,
            GROUP_REQUEST_PERMISSIONS.MANAGE,
        ],
        permissionMode: 'any',
        title: 'New group request',
        message: `${request.requestType} request submitted.`,
        type: NOTIFICATION_TYPES.ADMIN,
        priority: NOTIFICATION_PRIORITIES.NORMAL,
        route: '/admin/group-change-requests',
        entityType: 'group_change_request',
        entityId: requestObjectId,
        metadata: {
            eventKey: `group-request:${requestId}:created:admin`,
            eventType: 'group_request_created_admin',
            requestType: request.requestType,
            userId: toIdString(userId),
        },
    });
};

const emitCanceledSideEffects = ({ request, userId, actor = {} }) => {
    if (!request) return;
    const requestObjectId = new mongoose.Types.ObjectId(request.id);

    void createAuditLog({
        actorId: actor.actorId || userId,
        actorRole: actor.actorRole || ACTOR_ROLES.CUSTOMER,
        action: GROUP_REQUEST_ACTIONS.CANCELED,
        entityType: ENTITY_TYPES.GROUP_REQUEST,
        entityId: requestObjectId,
        metadata: {
            requestType: request.requestType,
            userId: toIdString(userId),
        },
        ipAddress: actor.ipAddress || null,
        userAgent: actor.userAgent || null,
    });
};

const emitReviewSideEffects = ({
    request,
    adminId,
    actor = {},
    approved = false,
    rejected = false,
    groupChanged = false,
    subAgentMarked = false,
    previousGroupId = null,
}) => {
    if (!request) return;

    const requestObjectId = new mongoose.Types.ObjectId(request.id);
    const userId = request.user?.id || null;

    void createAuditLog({
        actorId: actor.actorId || adminId,
        actorRole: actor.actorRole || ACTOR_ROLES.ADMIN,
        action: request.requestType === GROUP_REQUEST_TYPES.SUB_AGENT
            ? (approved ? REFERRAL_ACTIONS.SUB_AGENT_REQUEST_APPROVED : REFERRAL_ACTIONS.SUB_AGENT_REQUEST_REJECTED)
            : (approved ? GROUP_REQUEST_ACTIONS.APPROVED : GROUP_REQUEST_ACTIONS.REJECTED),
        entityType: ENTITY_TYPES.GROUP_REQUEST,
        entityId: requestObjectId,
        metadata: {
            requestType: request.requestType,
            userId,
            approvedGroupId: request.approvedGroup?.id || null,
            status: request.status,
        },
        ipAddress: actor.ipAddress || null,
        userAgent: actor.userAgent || null,
    });

    if (groupChanged && userId) {
        void createAuditLog({
            actorId: actor.actorId || adminId,
            actorRole: actor.actorRole || ACTOR_ROLES.ADMIN,
            action: GROUP_REQUEST_ACTIONS.USER_GROUP_CHANGED,
            entityType: ENTITY_TYPES.USER,
            entityId: new mongoose.Types.ObjectId(userId),
            metadata: {
                groupRequestId: request.id,
                previousGroupId: toIdString(previousGroupId),
                newGroupId: request.approvedGroup?.id || null,
                requestType: request.requestType,
            },
            ipAddress: actor.ipAddress || null,
            userAgent: actor.userAgent || null,
        });
    }

    if (subAgentMarked && userId) {
        void createAuditLog({
            actorId: actor.actorId || adminId,
            actorRole: actor.actorRole || ACTOR_ROLES.ADMIN,
            action: GROUP_REQUEST_ACTIONS.USER_MARKED_SUB_AGENT,
            entityType: ENTITY_TYPES.USER,
            entityId: new mongoose.Types.ObjectId(userId),
            metadata: {
                groupRequestId: request.id,
                requestType: request.requestType,
            },
            ipAddress: actor.ipAddress || null,
            userAgent: actor.userAgent || null,
        });
    }

    if (userId) {
        void safeCreateNotification({
            userId,
            title: approved ? 'Request approved' : 'Request rejected',
            message: approved
                ? 'Your group request was approved.'
                : 'Your group request was rejected.',
            type: NOTIFICATION_TYPES.ACCOUNT,
            priority: NOTIFICATION_PRIORITIES.NORMAL,
            route: '/me/group-change-requests',
            entityType: 'group_change_request',
            entityId: requestObjectId,
            metadata: {
                eventKey: `group-request:${request.id}:${approved ? 'approved' : 'rejected'}`,
                eventType: approved ? 'group_request_approved' : 'group_request_rejected',
                requestType: request.requestType,
            },
        });
    }

    return Boolean(rejected);
};

const createGroupRequest = async ({
    userId,
    requestType,
    requestedGroupId = null,
    reason = null,
    metadata = {},
    actor = {},
} = {}) => {
    const session = await mongoose.startSession();
    let createdRequestId;

    try {
        session.startTransaction();

        const user = await getCustomerOrThrow(userId, { session });

        if (requestType === GROUP_REQUEST_TYPES.SUB_AGENT && user.isSubAgent === true) {
            throw new BusinessRuleError('User is already an active sub-agent.', 'SUB_AGENT_ALREADY_ACTIVE');
        }

        const existing = await GroupChangeRequest.findOne({
            userId: user._id,
            requestType,
            status: GROUP_REQUEST_STATUS.PENDING,
        }).session(session);

        if (existing) {
            throw new BusinessRuleError(
                'A pending request of this type already exists.',
                'GROUP_REQUEST_PENDING_EXISTS'
            );
        }

        let requestedGroup = null;
        if (requestType === GROUP_REQUEST_TYPES.GROUP_CHANGE) {
            if (!requestedGroupId) {
                throw new BusinessRuleError(
                    'requestedGroupId is required for group change requests.',
                    'REQUESTED_GROUP_REQUIRED'
                );
            }
            requestedGroup = await getActiveGroupOrThrow(requestedGroupId, { session });
            if (sameId(user.groupId, requestedGroup._id)) {
                throw new BusinessRuleError(
                    'You are already assigned to the requested group.',
                    'GROUP_REQUEST_SAME_GROUP'
                );
            }
        } else if (requestType === GROUP_REQUEST_TYPES.SUB_AGENT && requestedGroupId) {
            requestedGroup = await getActiveGroupOrThrow(requestedGroupId, { session });
        } else if (!Object.values(GROUP_REQUEST_TYPES).includes(requestType)) {
            throw new BusinessRuleError('Invalid request type.', 'INVALID_GROUP_REQUEST_TYPE');
        }

        const currentGroup = user.groupId
            ? await runQuery(Group.findById(user.groupId).select(GROUP_PROJECTION), session)
            : null;

        const [request] = await GroupChangeRequest.create([{
            userId: user._id,
            requestType,
            status: GROUP_REQUEST_STATUS.PENDING,
            currentGroupId: user.groupId || null,
            requestedGroupId: requestedGroup?._id || null,
            reason: trimOrNull(reason),
            userSnapshot: snapshotUser(user),
            currentGroupSnapshot: snapshotGroup(currentGroup),
            requestedGroupSnapshot: snapshotGroup(requestedGroup),
            metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {},
        }], { session });

        if (requestType === GROUP_REQUEST_TYPES.SUB_AGENT) {
            await User.updateOne(
                { _id: user._id, isSubAgent: { $ne: true } },
                { $set: { subAgentStatus: SUB_AGENT_STATUS.PENDING } },
                { session }
            );
        }

        createdRequestId = request._id;
        await session.commitTransaction();
    } catch (err) {
        if (session.inTransaction()) await session.abortTransaction();
        if (err.code === 11000) {
            throw new BusinessRuleError(
                'A pending request of this type already exists.',
                'GROUP_REQUEST_PENDING_EXISTS'
            );
        }
        throw err;
    } finally {
        session.endSession();
    }

    const formatted = await getFormattedRequestById(createdRequestId, { admin: false });
    emitCreatedSideEffects({ request: formatted, userId, actor });
    return formatted;
};

const listMyRequests = async (userId, {
    status,
    requestType,
    page = 1,
    limit = 20,
} = {}) => {
    const normalizedPage = parsePage(page);
    const normalizedLimit = parseLimit(limit);
    const skip = (normalizedPage - 1) * normalizedLimit;
    const filter = { userId };

    if (status) filter.status = status;
    if (requestType) filter.requestType = requestType;

    const [requests, total] = await Promise.all([
        populateRequestQuery(GroupChangeRequest.find(filter))
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(normalizedLimit)
            .lean(),
        GroupChangeRequest.countDocuments(filter),
    ]);

    return {
        requests: requests.map((request) => formatRequest(request, { admin: false })),
        pagination: {
            page: normalizedPage,
            limit: normalizedLimit,
            total,
            pages: Math.ceil(total / normalizedLimit) || 1,
        },
    };
};

const getMyRequestById = async (userId, id) => {
    const request = await populateRequestQuery(
        GroupChangeRequest.findOne({ _id: id, userId })
    ).lean();

    if (!request) throw new NotFoundError('Group change request');
    return formatRequest(request, { admin: false });
};

const cancelMyRequest = async (userId, id, { actor = {} } = {}) => {
    const session = await mongoose.startSession();
    let requestId;
    let requestType;

    try {
        session.startTransaction();

        await getCustomerOrThrow(userId, { session });

        const request = await GroupChangeRequest.findOne({ _id: id, userId }).session(session);
        if (!request) throw new NotFoundError('Group change request');

        if (request.status !== GROUP_REQUEST_STATUS.PENDING) {
            throw new BusinessRuleError(
                'Only pending requests can be canceled.',
                'GROUP_REQUEST_NOT_PENDING'
            );
        }

        const canceled = await GroupChangeRequest.findOneAndUpdate(
            { _id: id, userId, status: GROUP_REQUEST_STATUS.PENDING },
            {
                $set: {
                    status: GROUP_REQUEST_STATUS.CANCELED,
                    canceledAt: new Date(),
                },
            },
            { new: true, session }
        );

        if (!canceled) {
            throw new BusinessRuleError(
                'Only pending requests can be canceled.',
                'GROUP_REQUEST_NOT_PENDING'
            );
        }

        if (canceled.requestType === GROUP_REQUEST_TYPES.SUB_AGENT) {
            await User.updateOne(
                {
                    _id: userId,
                    isSubAgent: { $ne: true },
                    subAgentStatus: SUB_AGENT_STATUS.PENDING,
                },
                { $set: { subAgentStatus: SUB_AGENT_STATUS.NONE } },
                { session }
            );
        }

        requestId = canceled._id;
        requestType = canceled.requestType;
        await session.commitTransaction();
    } catch (err) {
        if (session.inTransaction()) await session.abortTransaction();
        throw err;
    } finally {
        session.endSession();
    }

    const formatted = await getFormattedRequestById(requestId, { admin: false });
    emitCanceledSideEffects({ request: { ...formatted, requestType }, userId, actor });
    return formatted;
};

const listRequests = async ({
    status,
    requestType,
    userId,
    requestedGroupId,
    from,
    to,
    page = 1,
    limit = 20,
} = {}) => {
    const normalizedPage = parsePage(page);
    const normalizedLimit = parseLimit(limit);
    const skip = (normalizedPage - 1) * normalizedLimit;
    const filter = {};

    if (status) filter.status = status;
    if (requestType) filter.requestType = requestType;
    if (userId) filter.userId = userId;
    if (requestedGroupId) filter.requestedGroupId = requestedGroupId;
    const dateFilter = buildDateFilter({ from, to });
    if (dateFilter) filter.createdAt = dateFilter;

    const [requests, total] = await Promise.all([
        populateRequestQuery(GroupChangeRequest.find(filter))
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(normalizedLimit)
            .lean(),
        GroupChangeRequest.countDocuments(filter),
    ]);

    return {
        requests: requests.map((request) => formatRequest(request, { admin: true })),
        pagination: {
            page: normalizedPage,
            limit: normalizedLimit,
            total,
            pages: Math.ceil(total / normalizedLimit) || 1,
        },
    };
};

const getRequestById = async (id) => getFormattedRequestById(id, { admin: true });

const approveGroupRequest = async (id, {
    approvedGroupId = null,
    approvedCommissionPercent = null,
    adminNote = null,
    adminId,
    actor = {},
} = {}) => {
    const session = await mongoose.startSession();
    let requestId;
    let alreadyProcessed = false;
    let groupChanged = false;
    let subAgentMarked = false;
    let previousGroupId = null;

    try {
        session.startTransaction();

        const request = await GroupChangeRequest.findById(id).session(session);
        if (!request) throw new NotFoundError('Group change request');

        requestId = request._id;

        if (request.status === GROUP_REQUEST_STATUS.APPROVED) {
            alreadyProcessed = true;
            await session.commitTransaction();
        } else if (request.status !== GROUP_REQUEST_STATUS.PENDING) {
            throw new BusinessRuleError(
                'Only pending requests can be approved.',
                'GROUP_REQUEST_NOT_PENDING'
            );
        } else {
            const user = await runQuery(User.findById(request.userId).select(USER_PROJECTION), session);
            if (!user) throw new NotFoundError('User');
            if (user.status !== USER_STATUS.ACTIVE) {
                throw new BusinessRuleError('Only active users can be approved for this request.', 'USER_NOT_ACTIVE');
            }

            let approvedGroup = null;
            const updateUser = {};
            const now = new Date();

            if (request.requestType === GROUP_REQUEST_TYPES.GROUP_CHANGE) {
                const targetGroupId = approvedGroupId || request.requestedGroupId;
                if (!targetGroupId) {
                    throw new BusinessRuleError(
                        'approvedGroupId is required for group change approval.',
                        'APPROVED_GROUP_REQUIRED'
                    );
                }
                approvedGroup = await getActiveGroupOrThrow(targetGroupId, { session });
                if (sameId(user.groupId, approvedGroup._id)) {
                    throw new BusinessRuleError(
                        'User is already assigned to the approved group.',
                        'GROUP_REQUEST_SAME_GROUP'
                    );
                }
                previousGroupId = user.groupId;
                updateUser.groupId = approvedGroup._id;
                groupChanged = true;
            }

            if (request.requestType === GROUP_REQUEST_TYPES.SUB_AGENT) {
                if (!approvedGroupId) {
                    throw new BusinessRuleError(
                        'approvedGroupId is required for sub-agent approval.',
                        'APPROVED_GROUP_REQUIRED'
                    );
                }

                if (
                    approvedCommissionPercent === undefined ||
                    approvedCommissionPercent === null ||
                    approvedCommissionPercent === ''
                ) {
                    throw new BusinessRuleError(
                        'approvedCommissionPercent is required and must be between 0 and 100.',
                        'INVALID_SUB_AGENT_PERCENTAGE'
                    );
                }

                const commissionPercent = Number(approvedCommissionPercent);
                if (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 100) {
                    throw new BusinessRuleError(
                        'approvedCommissionPercent is required and must be between 0 and 100.',
                        'INVALID_SUB_AGENT_PERCENTAGE'
                    );
                }

                approvedGroup = await getActiveGroupOrThrow(approvedGroupId, { session });
                previousGroupId = user.groupId;
                updateUser.groupId = approvedGroup._id;
                groupChanged = !sameId(user.groupId, approvedGroup._id);

                const referralCode = await referralService.ensureReferralCode(user._id, { session });
                updateUser.isSubAgent = true;
                updateUser.subAgentStatus = SUB_AGENT_STATUS.ACTIVE;
                updateUser.subAgentApprovedAt = now;
                updateUser.subAgentApprovedBy = adminId;
                updateUser.agentProfile = {
                    ...(user.agentProfile?.toObject ? user.agentProfile.toObject() : user.agentProfile || {}),
                    enabled: true,
                    code: referralCode,
                    commissionPercent,
                    approvedAt: now,
                    approvedBy: adminId,
                    groupId: approvedGroup._id,
                    status: AGENT_PROFILE_STATUS.ACTIVE,
                };
                subAgentMarked = user.isSubAgent !== true;

                if ((user.referredByAgentId || user.referredBy) && !user.referralCommissionStoppedAt) {
                    await referralService.stopReferralCommissionForUser({
                        userId: user._id,
                        reason: REFERRAL_STOP_REASONS.PROMOTED_TO_SUB_AGENT,
                        stoppedAt: now,
                        actor,
                        session,
                    });
                }
            }

            const updatedRequest = await GroupChangeRequest.findOneAndUpdate(
                { _id: request._id, status: GROUP_REQUEST_STATUS.PENDING },
                {
                    $set: {
                        status: GROUP_REQUEST_STATUS.APPROVED,
                        approvedGroupId: approvedGroup?._id || null,
                        approvedGroupSnapshot: snapshotGroup(approvedGroup),
                        approvedCommissionPercent: request.requestType === GROUP_REQUEST_TYPES.SUB_AGENT
                            ? Number(approvedCommissionPercent)
                            : null,
                        reviewedBy: adminId,
                        reviewedAt: now,
                        adminNote: trimOrNull(adminNote),
                    },
                },
                { new: true, session }
            );

            if (!updatedRequest) {
                const refreshed = await GroupChangeRequest.findById(request._id).session(session);
                if (refreshed?.status === GROUP_REQUEST_STATUS.APPROVED) {
                    alreadyProcessed = true;
                } else {
                    throw new BusinessRuleError(
                        'Only pending requests can be approved.',
                        'GROUP_REQUEST_NOT_PENDING'
                    );
                }
            } else {
                await User.updateOne(
                    { _id: user._id },
                    { $set: updateUser },
                    { session }
                );
            }

            await session.commitTransaction();
        }
    } catch (err) {
        if (session.inTransaction()) await session.abortTransaction();
        throw err;
    } finally {
        session.endSession();
    }

    const formatted = await getFormattedRequestById(requestId, { admin: true });
    if (!alreadyProcessed) {
        emitReviewSideEffects({
            request: formatted,
            adminId,
            actor,
            approved: true,
            groupChanged,
            subAgentMarked,
            previousGroupId,
        });
    }

    return { request: formatted, alreadyProcessed };
};

const rejectGroupRequest = async (id, {
    adminNote = null,
    adminId,
    actor = {},
} = {}) => {
    const session = await mongoose.startSession();
    let requestId;
    let alreadyProcessed = false;

    try {
        session.startTransaction();

        const request = await GroupChangeRequest.findById(id).session(session);
        if (!request) throw new NotFoundError('Group change request');

        requestId = request._id;

        if (request.status === GROUP_REQUEST_STATUS.REJECTED) {
            alreadyProcessed = true;
            await session.commitTransaction();
        } else if (request.status !== GROUP_REQUEST_STATUS.PENDING) {
            throw new BusinessRuleError(
                'Only pending requests can be rejected.',
                'GROUP_REQUEST_NOT_PENDING'
            );
        } else {
            const now = new Date();
            const updatedRequest = await GroupChangeRequest.findOneAndUpdate(
                { _id: request._id, status: GROUP_REQUEST_STATUS.PENDING },
                {
                    $set: {
                        status: GROUP_REQUEST_STATUS.REJECTED,
                        reviewedBy: adminId,
                        reviewedAt: now,
                        adminNote: trimOrNull(adminNote),
                    },
                },
                { new: true, session }
            );

            if (!updatedRequest) {
                const refreshed = await GroupChangeRequest.findById(request._id).session(session);
                if (refreshed?.status === GROUP_REQUEST_STATUS.REJECTED) {
                    alreadyProcessed = true;
                } else {
                    throw new BusinessRuleError(
                        'Only pending requests can be rejected.',
                        'GROUP_REQUEST_NOT_PENDING'
                    );
                }
            } else if (request.requestType === GROUP_REQUEST_TYPES.SUB_AGENT) {
                await User.updateOne(
                    {
                        _id: request.userId,
                        isSubAgent: { $ne: true },
                        subAgentStatus: SUB_AGENT_STATUS.PENDING,
                    },
                    { $set: { subAgentStatus: SUB_AGENT_STATUS.REJECTED } },
                    { session }
                );
            }

            await session.commitTransaction();
        }
    } catch (err) {
        if (session.inTransaction()) await session.abortTransaction();
        throw err;
    } finally {
        session.endSession();
    }

    const formatted = await getFormattedRequestById(requestId, { admin: true });
    if (!alreadyProcessed) {
        emitReviewSideEffects({
            request: formatted,
            adminId,
            actor,
            rejected: true,
        });
    }

    return { request: formatted, alreadyProcessed };
};

module.exports = {
    createGroupRequest,
    listMyRequests,
    getMyRequestById,
    cancelMyRequest,
    getGroupChangeOptionsForUser,
    listRequests,
    getRequestById,
    approveGroupRequest,
    rejectGroupRequest,
    formatRequest,
};
