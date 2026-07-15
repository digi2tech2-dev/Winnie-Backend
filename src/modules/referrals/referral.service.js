'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../../config/config');
const {
    User,
    ROLES,
    SUB_AGENT_STATUS,
    AGENT_PROFILE_STATUS,
    REFERRAL_STOP_REASONS,
} = require('../users/user.model');
const { Setting } = require('../admin/setting.model');
const {
    WalletTransaction,
    TRANSACTION_TYPES,
    TRANSACTION_DIRECTIONS,
    TRANSACTION_STATUS,
} = require('../wallet/walletTransaction.model');
const { createAuditLog } = require('../audit/audit.service');
const {
    REFERRAL_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
} = require('../audit/audit.constants');
const { safeCreateNotification } = require('../notifications/notification.service');
const { NOTIFICATION_TYPES, NOTIFICATION_PRIORITIES } = require('../notifications/notification.model');
const { toDecimal, toFiat } = require('../../shared/utils/decimalPrecision');
const {
    NotFoundError,
    BusinessRuleError,
    AuthorizationError,
} = require('../../shared/errors/AppError');
const {
    ReferralRelationship,
    ReferralCommission,
} = require('./referral.model');
const {
    REFERRAL_RELATIONSHIP_STATUS,
    REFERRAL_COMMISSION_STATUS,
    REFERRAL_APPLY_TO,
    REFERRAL_SETTINGS_KEY,
    DEFAULT_REFERRAL_SETTINGS,
    ELIGIBLE_REFERRAL_SEMANTIC_TYPES,
} = require('./referral.constants');

const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERRAL_CODE_LENGTH = 8;

const normalizeCode = (code) => String(code || '').trim().toUpperCase();

const normalizeCurrency = (currency) => String(currency || 'USD').trim().toUpperCase();

const parsePage = (value) => Math.max(1, parseInt(value, 10) || 1);
const parseLimit = (value) => Math.min(100, Math.max(1, parseInt(value, 10) || 20));

const toIdString = (value) => {
    if (!value) return null;
    if (typeof value === 'object' && value._id) return value._id.toString();
    return value.toString();
};

const sameId = (left, right) => toIdString(left) === toIdString(right);

const REFERRAL_COMMISSION_DAYS = 30;

const addReferralWindow = (date) => new Date(date.getTime() + REFERRAL_COMMISSION_DAYS * 24 * 60 * 60 * 1000);

const getAgentCode = (user) => normalizeCode(user?.agentProfile?.code || user?.referralCode);

const isActiveSubAgent = (user) => Boolean(
    user &&
    user.isSubAgent === true &&
    user.subAgentStatus === SUB_AGENT_STATUS.ACTIVE &&
    user.agentProfile?.enabled === true &&
    user.agentProfile?.status === AGENT_PROFILE_STATUS.ACTIVE
);

const getAgentCommissionPercent = (user) => {
    const percent = Number(user?.agentProfile?.commissionPercent ?? 0);
    return Number.isFinite(percent) ? percent : 0;
};

const generateReferralCodeCandidate = () => {
    let code = 'K';
    for (let i = 0; i < REFERRAL_CODE_LENGTH - 1; i += 1) {
        const index = crypto.randomInt(0, REFERRAL_CODE_ALPHABET.length);
        code += REFERRAL_CODE_ALPHABET[index];
    }
    return code;
};

const generateUniqueReferralCode = async (session = null) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const referralCode = generateReferralCodeCandidate();
        const query = User.exists({
            $or: [
                { referralCode },
                { 'agentProfile.code': referralCode },
            ],
        });
        const exists = session ? await query.session(session) : await query;
        if (!exists) return referralCode;
    }

    throw new Error('Unable to generate a unique referral code.');
};

const normalizeOptionalAmount = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        throw new BusinessRuleError('Referral amount limits must be non-negative numbers.', 'INVALID_REFERRAL_SETTING');
    }
    return toFiat(number);
};

const normalizeSettings = (raw = {}) => {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const percentage = Number(source.depositCommissionPercentage ?? DEFAULT_REFERRAL_SETTINGS.depositCommissionPercentage);

    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
        throw new BusinessRuleError('Referral commission percentage must be between 0 and 100.', 'INVALID_REFERRAL_PERCENTAGE');
    }

    const applyTo = source.applyTo || DEFAULT_REFERRAL_SETTINGS.applyTo;
    if (applyTo !== REFERRAL_APPLY_TO.EVERY_ELIGIBLE_WALLET_CREDIT) {
        throw new BusinessRuleError('Unsupported referral applyTo setting.', 'INVALID_REFERRAL_APPLY_TO');
    }

    return {
        enabled: source.enabled !== false,
        depositCommissionPercentage: Number(percentage),
        applyTo,
        minSourceAmount: normalizeOptionalAmount(source.minSourceAmount),
        maxCommissionAmount: normalizeOptionalAmount(source.maxCommissionAmount),
    };
};

const getReferralSettings = async ({ persistDefault = true } = {}) => {
    let setting = await Setting.findOne({ key: REFERRAL_SETTINGS_KEY });

    if (!setting && persistDefault) {
        setting = await Setting.findOneAndUpdate(
            { key: REFERRAL_SETTINGS_KEY },
            {
                $setOnInsert: {
                    key: REFERRAL_SETTINGS_KEY,
                    value: { ...DEFAULT_REFERRAL_SETTINGS },
                    description: 'Referral and invitation commission settings',
                },
            },
            { upsert: true, new: true }
        );
    }

    return normalizeSettings(setting?.value || DEFAULT_REFERRAL_SETTINGS);
};

const updateReferralSettings = async (patch, actor = {}) => {
    const actorRole = String(actor.actorRole || actor.role || '').toUpperCase();
    if (actorRole !== ROLES.ADMIN && actorRole !== ACTOR_ROLES.ADMIN) {
        throw new AuthorizationError('Only admins can update referral settings.');
    }

    const allowedKeys = new Set([
        'enabled',
        'depositCommissionPercentage',
        'applyTo',
        'minSourceAmount',
        'maxCommissionAmount',
    ]);

    for (const key of Object.keys(patch || {})) {
        if (!allowedKeys.has(key)) {
            throw new BusinessRuleError(`Unknown referral setting '${key}'.`, 'INVALID_REFERRAL_SETTING');
        }
    }

    const before = await getReferralSettings();
    const next = normalizeSettings({ ...before, ...patch });

    const setting = await Setting.findOneAndUpdate(
        { key: REFERRAL_SETTINGS_KEY },
        {
            $set: {
                value: next,
                description: 'Referral and invitation commission settings',
                updatedBy: actor.actorId || actor._id || actor.userId || null,
            },
            $setOnInsert: { key: REFERRAL_SETTINGS_KEY },
        },
        { upsert: true, new: true }
    );

    void createAuditLog({
        actorId: actor.actorId || actor._id || actor.userId,
        actorRole: actorRole || ACTOR_ROLES.ADMIN,
        action: REFERRAL_ACTIONS.SETTINGS_UPDATED,
        entityType: ENTITY_TYPES.SETTING,
        entityId: setting._id,
        metadata: { before, after: next },
        ipAddress: actor.ipAddress || null,
        userAgent: actor.userAgent || null,
    });

    return next;
};

const ensureReferralCode = async (userOrId, { session = null } = {}) => {
    const userId = typeof userOrId === 'object' && userOrId._id ? userOrId._id : userOrId;
    if (!userId) throw new NotFoundError('User');

    if (typeof userOrId === 'object' && userOrId.referralCode) {
        return userOrId.referralCode;
    }

    const currentQuery = User.findById(userId).select('_id referralCode');
    const current = session ? await currentQuery.session(session) : await currentQuery;
    if (!current) throw new NotFoundError('User');
    if (current.referralCode) {
        if (typeof userOrId === 'object') userOrId.referralCode = current.referralCode;
        return current.referralCode;
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
        const referralCode = await generateUniqueReferralCode(session);
        try {
            const updateQuery = User.findOneAndUpdate(
                {
                    _id: userId,
                    $or: [{ referralCode: null }, { referralCode: '' }, { referralCode: { $exists: false } }],
                },
                { $set: { referralCode } },
                { new: true }
            ).select('_id referralCode');
            const updated = session ? await updateQuery.session(session) : await updateQuery;

            if (updated?.referralCode) {
                if (typeof userOrId === 'object') userOrId.referralCode = updated.referralCode;
                return updated.referralCode;
            }

            const refreshedQuery = User.findById(userId).select('_id referralCode');
            const refreshed = session ? await refreshedQuery.session(session) : await refreshedQuery;
            if (refreshed?.referralCode) return refreshed.referralCode;
        } catch (err) {
            if (err.code !== 11000) throw err;
        }
    }

    throw new Error('Unable to generate a unique referral code.');
};

const getInviterByCode = async (code, { session = null } = {}) => {
    const referralCode = normalizeCode(code);
    if (!referralCode) return null;

    const query = User.findOne({
        deletedAt: null,
        $or: [
            { referralCode },
            { 'agentProfile.code': referralCode },
        ],
    }).select('_id name email referralCode currency role status isSubAgent subAgentStatus agentProfile');
    return session ? query.session(session) : query;
};

const resolveInviteCodeOrThrow = async (code, { email = null, userId = null } = {}) => {
    const referralCode = normalizeCode(code);
    if (!referralCode) return null;

    const inviter = await getInviterByCode(referralCode);
    if (!inviter || !isActiveSubAgent(inviter)) {
        throw new BusinessRuleError('Invalid referral code.', 'INVALID_REFERRAL_CODE');
    }

    if (userId && sameId(inviter._id, userId)) {
        throw new BusinessRuleError('Users cannot refer themselves.', 'SELF_REFERRAL_NOT_ALLOWED');
    }

    if (email && String(inviter.email || '').toLowerCase() === String(email).toLowerCase()) {
        throw new BusinessRuleError('Users cannot refer themselves.', 'SELF_REFERRAL_NOT_ALLOWED');
    }

    return inviter;
};

const validateReferralCode = async (code, options = {}) => {
    const referralCode = normalizeCode(code);
    if (!referralCode) {
        return { valid: false, reason: 'MISSING_REFERRAL_CODE' };
    }

    const inviter = await getInviterByCode(referralCode);
    if (!inviter || !isActiveSubAgent(inviter)) {
        return { valid: false, reason: 'INVALID_REFERRAL_CODE' };
    }

    if (
        (options.userId && sameId(inviter._id, options.userId)) ||
        (options.email && String(inviter.email || '').toLowerCase() === String(options.email).toLowerCase())
    ) {
        return { valid: false, reason: 'SELF_REFERRAL_NOT_ALLOWED' };
    }

    return {
        valid: true,
        inviter: {
            id: inviter._id.toString(),
            name: inviter.name,
            referralCode: getAgentCode(inviter),
        },
    };
};

const createReferralRelationship = async ({
    inviterUserId,
    invitedUserId,
    referralCode,
    metadata = {},
    session = null,
} = {}) => {
    if (sameId(inviterUserId, invitedUserId)) {
        throw new BusinessRuleError('Users cannot refer themselves.', 'SELF_REFERRAL_NOT_ALLOWED');
    }

    const findExisting = ReferralRelationship.findOne({ invitedUserId });
    const existing = session ? await findExisting.session(session) : await findExisting;
    if (existing) {
        if (sameId(existing.inviterUserId, inviterUserId)) {
            return { relationship: existing, idempotent: true };
        }
        throw new BusinessRuleError('This user already has an inviter.', 'INVITER_ALREADY_SET');
    }

    const inviterQuery = User.findById(inviterUserId).select('_id referralCode agentProfile isSubAgent subAgentStatus deletedAt');
    const inviter = session ? await inviterQuery.session(session) : await inviterQuery;
    if (!inviter || !isActiveSubAgent(inviter)) {
        throw new BusinessRuleError('Invalid referral code.', 'INVALID_REFERRAL_CODE');
    }

    const invitedQuery = User.findById(invitedUserId).select('_id referredBy referredByAgentId');
    const invitedUser = session ? await invitedQuery.session(session) : await invitedQuery;
    if (!invitedUser) throw new NotFoundError('Invited user');

    if (
        (invitedUser.referredBy && !sameId(invitedUser.referredBy, inviterUserId)) ||
        (invitedUser.referredByAgentId && !sameId(invitedUser.referredByAgentId, inviterUserId))
    ) {
        throw new BusinessRuleError('This user already has an inviter.', 'INVITER_ALREADY_SET');
    }

    const normalizedCode = normalizeCode(referralCode || getAgentCode(inviter));
    const registeredAt = new Date();
    const eligibleUntil = addReferralWindow(registeredAt);
    const [relationship] = await ReferralRelationship.create([{
        inviterUserId,
        invitedUserId,
        referralCode: normalizedCode,
        status: REFERRAL_RELATIONSHIP_STATUS.ACTIVE,
        registeredAt,
        eligibleUntil,
        metadata,
    }], session ? { session } : undefined);

    await User.updateOne(
        {
            _id: invitedUserId,
            $or: [{ referredBy: null }, { referredBy: { $exists: false } }, { referredBy: inviterUserId }],
        },
        {
            $set: {
                referredBy: inviterUserId,
                referredByAgentId: inviterUserId,
                referralCodeUsed: normalizedCode,
                referredAt: registeredAt,
                referralCommissionEligibleUntil: eligibleUntil,
                referralCommissionStoppedAt: null,
                referralCommissionStoppedReason: null,
            },
        },
        session ? { session } : undefined
    );

    return { relationship, idempotent: false };
};

const auditRelationshipCreated = (relationship, actor = {}) => {
    if (!relationship) return;

    void createAuditLog({
        actorId: actor.actorId || relationship.invitedUserId,
        actorRole: actor.actorRole || ACTOR_ROLES.CUSTOMER,
        action: REFERRAL_ACTIONS.RELATIONSHIP_CREATED,
        entityType: ENTITY_TYPES.REFERRAL_RELATIONSHIP,
        entityId: relationship._id,
        metadata: {
            inviterUserId: toIdString(relationship.inviterUserId),
            invitedUserId: toIdString(relationship.invitedUserId),
            referralCode: relationship.referralCode,
        },
        ipAddress: actor.ipAddress || null,
        userAgent: actor.userAgent || null,
    });
};

const buildDateFilter = ({ from, to } = {}) => {
    if (!from && !to) return undefined;
    const createdAt = {};
    if (from) createdAt.$gte = new Date(from);
    if (to) createdAt.$lte = new Date(to);
    return createdAt;
};

const listRelationships = async ({
    inviterUserId,
    invitedUserId,
    status,
    from,
    to,
    page = 1,
    limit = 20,
} = {}) => {
    const normalizedPage = parsePage(page);
    const normalizedLimit = parseLimit(limit);
    const skip = (normalizedPage - 1) * normalizedLimit;
    const filter = {};

    if (inviterUserId) filter.inviterUserId = inviterUserId;
    if (invitedUserId) filter.invitedUserId = invitedUserId;
    if (status) filter.status = status;
    const dateFilter = buildDateFilter({ from, to });
    if (dateFilter) filter.createdAt = dateFilter;

    const [relationships, total] = await Promise.all([
        ReferralRelationship.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(normalizedLimit)
            .populate('inviterUserId', 'name email referralCode')
            .populate('invitedUserId', 'name email referralCode')
            .lean(),
        ReferralRelationship.countDocuments(filter),
    ]);

    return {
        relationships,
        pagination: {
            page: normalizedPage,
            limit: normalizedLimit,
            total,
            pages: Math.ceil(total / normalizedLimit) || 1,
        },
    };
};

const listCommissions = async ({
    inviterUserId,
    invitedUserId,
    agentId,
    referredUserId,
    status,
    sourceType,
    from,
    to,
    page = 1,
    limit = 20,
    admin = false,
} = {}) => {
    const normalizedPage = parsePage(page);
    const normalizedLimit = parseLimit(limit);
    const skip = (normalizedPage - 1) * normalizedLimit;
    const filter = {};

    if (inviterUserId || agentId) filter.inviterUserId = inviterUserId || agentId;
    if (invitedUserId || referredUserId) filter.invitedUserId = invitedUserId || referredUserId;
    if (status) filter.status = status;
    if (sourceType) filter.sourceType = sourceType;
    const dateFilter = buildDateFilter({ from, to });
    if (dateFilter) filter.createdAt = dateFilter;

    const populateFields = admin ? 'name email referralCode' : 'name';
    const [commissions, total] = await Promise.all([
        ReferralCommission.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(normalizedLimit)
            .populate('inviterUserId', populateFields)
            .populate('invitedUserId', populateFields)
            .lean(),
        ReferralCommission.countDocuments(filter),
    ]);

    return {
        commissions,
        pagination: {
            page: normalizedPage,
            limit: normalizedLimit,
            total,
            pages: Math.ceil(total / normalizedLimit) || 1,
        },
    };
};

const getReferralLink = (referralCode) => {
    const baseUrl = (process.env.FRONTEND_URL || config.frontend.url || '').replace(/\/+$/, '');
    if (!baseUrl || !referralCode) return null;
    return `${baseUrl}/register?inviteCode=${encodeURIComponent(referralCode)}`;
};

const commissionActiveStatuses = [
    REFERRAL_COMMISSION_STATUS.PENDING,
    REFERRAL_COMMISSION_STATUS.AVAILABLE,
    REFERRAL_COMMISSION_STATUS.CREDITED,
];

const relationshipCommissionStatus = (relationship, now = new Date()) => {
    if (relationship?.stoppedAt) {
        return relationship.stoppedReason === REFERRAL_STOP_REASONS.PROMOTED_TO_SUB_AGENT
            ? 'stopped_promoted_to_sub_agent'
            : 'stopped';
    }
    if (relationship?.eligibleUntil && new Date(relationship.eligibleUntil).getTime() < now.getTime()) {
        return 'expired';
    }
    return 'active';
};

const serializeRelationshipUser = (user) => {
    if (!user || typeof user !== 'object') return null;
    return {
        id: toIdString(user._id || user.id),
        name: user.name || null,
        email: user.email || null,
        phone: user.phone || null,
        referralCode: user.referralCode || getAgentCode(user) || null,
        isSubAgent: user.isSubAgent === true,
        subAgentStatus: user.subAgentStatus || null,
    };
};

const getReferredUsers = async (agentId, { page = 1, limit = 50 } = {}) => {
    const normalizedPage = parsePage(page);
    const normalizedLimit = parseLimit(limit);
    const skip = (normalizedPage - 1) * normalizedLimit;
    const filter = { inviterUserId: agentId };

    const [relationships, total, totals] = await Promise.all([
        ReferralRelationship.find(filter)
            .sort({ registeredAt: -1, createdAt: -1 })
            .skip(skip)
            .limit(normalizedLimit)
            .populate('invitedUserId', 'name email phone referralCode isSubAgent subAgentStatus')
            .lean(),
        ReferralRelationship.countDocuments(filter),
        ReferralCommission.aggregate([
            {
                $match: {
                    inviterUserId: new mongoose.Types.ObjectId(toIdString(agentId)),
                    status: { $in: commissionActiveStatuses },
                },
            },
            {
                $group: {
                    _id: {
                        userId: '$invitedUserId',
                        currency: '$commissionCurrency',
                    },
                    total: { $sum: '$commissionAmount' },
                    count: { $sum: 1 },
                },
            },
        ]),
    ]);

    const totalsByUser = totals.reduce((acc, item) => {
        const userKey = toIdString(item._id.userId);
        acc[userKey] = acc[userKey] || [];
        acc[userKey].push({
            currency: item._id.currency,
            amount: toFiat(item.total),
            count: item.count,
        });
        return acc;
    }, {});

    const now = new Date();
    return {
        referredUsers: relationships.map((relationship) => {
            const user = serializeRelationshipUser(relationship.invitedUserId);
            return {
                id: toIdString(relationship._id),
                user,
                joinedAt: relationship.registeredAt || relationship.createdAt,
                referralCodeUsed: relationship.referralCode,
                commissionEligibleUntil: relationship.eligibleUntil || null,
                commissionStoppedAt: relationship.stoppedAt || null,
                commissionStoppedReason: relationship.stoppedReason || null,
                commissionStatus: relationshipCommissionStatus(relationship, now),
                totalCommission: totalsByUser[toIdString(relationship.invitedUserId)] || [],
            };
        }),
        pagination: {
            page: normalizedPage,
            limit: normalizedLimit,
            total,
            pages: Math.ceil(total / normalizedLimit) || 1,
        },
    };
};

const getReferralSummary = async (userId) => {
    const user = await User.findById(userId)
        .select('_id name email referralCode referredBy referredByAgentId currency isSubAgent subAgentStatus agentProfile')
        .populate('agentProfile.groupId', 'name percentage isActive')
        .lean();
    if (!user) throw new NotFoundError('User');

    const isAgent = isActiveSubAgent(user);
    const referralCode = isAgent ? getAgentCode(user) : '';

    const [relationship, invitedUsersCount, totals, recentCommissions] = await Promise.all([
        ReferralRelationship.findOne({
            invitedUserId: user._id,
        }).populate('inviterUserId', 'name referralCode agentProfile').lean(),
        isAgent ? ReferralRelationship.countDocuments({ inviterUserId: user._id }) : 0,
        isAgent ? ReferralCommission.aggregate([
            { $match: { inviterUserId: user._id, status: { $in: commissionActiveStatuses } } },
            { $group: { _id: '$commissionCurrency', total: { $sum: '$commissionAmount' }, count: { $sum: 1 } } },
        ]) : [],
        isAgent ? ReferralCommission.find({ inviterUserId: user._id })
            .sort({ earnedAt: -1, createdAt: -1 })
            .limit(5)
            .populate('invitedUserId', 'name email')
            .lean() : [],
    ]);

    return {
        isSubAgent: isAgent,
        agentProfile: {
            enabled: user.agentProfile?.enabled === true,
            code: referralCode,
            commissionPercent: getAgentCommissionPercent(user),
            approvedAt: user.agentProfile?.approvedAt || user.subAgentApprovedAt || null,
            approvedBy: toIdString(user.agentProfile?.approvedBy || user.subAgentApprovedBy),
            group: user.agentProfile?.groupId || null,
            status: user.agentProfile?.status || AGENT_PROFILE_STATUS.INACTIVE,
        },
        referralCode,
        referralLink: isAgent ? getReferralLink(referralCode) : null,
        inviter: relationship?.inviterUserId
            ? {
                id: relationship.inviterUserId._id.toString(),
                name: relationship.inviterUserId.name,
                referralCode: getAgentCode(relationship.inviterUserId),
            }
            : null,
        invitedUsersCount,
        totalCommission: totals.map((item) => ({
            currency: item._id,
            amount: toFiat(item.total),
            count: item.count,
        })),
        recentCommissions,
        settings: {
            enabled: isAgent,
            depositCommissionPercentage: getAgentCommissionPercent(user),
            applyTo: REFERRAL_APPLY_TO.EVERY_ELIGIBLE_WALLET_CREDIT,
            minSourceAmount: null,
            maxCommissionAmount: null,
        },
    };
};

const getActiveRelationshipForInvitedUser = async (invitedUser, { session = null } = {}) => {
    const referrerId = invitedUser.referredByAgentId || invitedUser.referredBy;
    if (!referrerId) return null;

    const relationshipQuery = ReferralRelationship.findOne({
        invitedUserId: invitedUser._id,
        inviterUserId: referrerId,
        status: REFERRAL_RELATIONSHIP_STATUS.ACTIVE,
        stoppedAt: null,
    });
    const relationship = session ? await relationshipQuery.session(session) : await relationshipQuery;
    if (relationship) return relationship;

    const inviterQuery = User.findById(referrerId)
        .select('_id referralCode agentProfile isSubAgent subAgentStatus deletedAt');
    const inviter = session ? await inviterQuery.session(session) : await inviterQuery;
    if (!inviter || !isActiveSubAgent(inviter) || sameId(inviter._id, invitedUser._id)) return null;

    try {
        const result = await createReferralRelationship({
            inviterUserId: inviter._id,
            invitedUserId: invitedUser._id,
            referralCode: getAgentCode(inviter),
            metadata: { source: 'lazy-referredBy-backfill' },
            session,
        });
        if (!result.idempotent) {
            auditRelationshipCreated(result.relationship, { actorRole: ACTOR_ROLES.SYSTEM, actorId: inviter._id });
        }
        return result.relationship;
    } catch (err) {
        if (err.code !== 11000) throw err;
        const fallbackQuery = ReferralRelationship.findOne({ invitedUserId: invitedUser._id });
        return session ? fallbackQuery.session(session) : fallbackQuery;
    }
};

const isEligibleWalletCredit = (transaction) => {
    if (!transaction) return false;
    if (transaction.status !== TRANSACTION_STATUS.COMPLETED) return false;
    if (transaction.type !== TRANSACTION_TYPES.CREDIT) return false;
    if (transaction.direction !== TRANSACTION_DIRECTIONS.CREDIT) return false;
    if (!ELIGIBLE_REFERRAL_SEMANTIC_TYPES[transaction.semanticType]) return false;
    const amount = Number(transaction.amount);
    return Number.isFinite(amount) && amount > 0;
};

const loadWalletTransaction = async (walletTransactionOrId) => {
    if (walletTransactionOrId && walletTransactionOrId._id) return walletTransactionOrId;
    return WalletTransaction.findById(walletTransactionOrId);
};

const calculateCommission = ({ sourceAmount, percentage }) => {
    const commissionAmount = toFiat(toDecimal(sourceAmount).times(toDecimal(percentage)).dividedBy(100));
    if (!Number.isFinite(commissionAmount) || commissionAmount <= 0) return 0;
    return commissionAmount;
};

const createPendingCommission = async ({
    sourceTransaction,
    relationship,
    agent,
    sourceType,
    commissionAmount,
    commissionCurrency,
    session,
}) => {
    const idempotencyKey = `referral:${sourceTransaction._id.toString()}`;
    const now = new Date();
    const commissionPercent = getAgentCommissionPercent(agent);
    const sourceAmount = Number(sourceTransaction.amount);
    const sourceCurrency = normalizeCurrency(sourceTransaction.currency);

    const [commission] = await ReferralCommission.create([{
        inviterUserId: relationship.inviterUserId,
        agentId: relationship.inviterUserId,
        invitedUserId: relationship.invitedUserId,
        referredUserId: relationship.invitedUserId,
        sourceWalletTransactionId: sourceTransaction._id,
        sourceType,
        sourceId: sourceTransaction.sourceId || null,
        sourceSemanticType: sourceTransaction.semanticType,
        sourceAmount,
        topupAmount: sourceAmount,
        sourceCurrency,
        topupCurrency: sourceCurrency,
        commissionPercentage: commissionPercent,
        commissionPercent,
        commissionAmount,
        commissionCurrency,
        status: REFERRAL_COMMISSION_STATUS.PENDING,
        idempotencyKey,
        earnedAt: now,
        metadata: {
            sourceWalletTransactionId: sourceTransaction._id.toString(),
            invitedUserId: relationship.invitedUserId.toString(),
            sourceType,
            sourceId: toIdString(sourceTransaction.sourceId),
            topupAmount: sourceAmount,
            topupCurrency: sourceCurrency,
            commissionPercent,
            relationshipId: relationship._id.toString(),
        },
    }], { session });

    return commission;
};

const emitCommissionSideEffects = (commission) => {
    if (!commission) return;

    if (commission.status === REFERRAL_COMMISSION_STATUS.PENDING) {
        void createAuditLog({
            actorId: commission.invitedUserId,
            actorRole: ACTOR_ROLES.SYSTEM,
            action: REFERRAL_ACTIONS.SUB_AGENT_COMMISSION_CREATED,
            entityType: ENTITY_TYPES.REFERRAL_COMMISSION,
            entityId: commission._id,
            metadata: {
                agentId: commission.inviterUserId.toString(),
                referredUserId: commission.invitedUserId.toString(),
                amount: commission.commissionAmount,
                currency: commission.commissionCurrency,
                sourceWalletTransactionId: commission.sourceWalletTransactionId.toString(),
                status: commission.status,
            },
        });

        void safeCreateNotification({
            userId: commission.inviterUserId,
            title: 'Sub-agent commission earned',
            message: `You earned ${commission.commissionAmount} ${commission.commissionCurrency} pending commission.`,
            type: NOTIFICATION_TYPES.WALLET,
            priority: NOTIFICATION_PRIORITIES.NORMAL,
            route: '/customer/sub-agent',
            entityType: 'referral_commission',
            entityId: commission._id,
            metadata: {
                eventKey: `sub-agent-commission:${commission._id.toString()}:created`,
                eventType: 'sub_agent_commission_created',
                referralCommissionId: commission._id.toString(),
                amount: commission.commissionAmount,
                currency: commission.commissionCurrency,
            },
        });
    }
};

const stopReferralCommissionForUser = async ({
    userId,
    reason = REFERRAL_STOP_REASONS.OTHER,
    stoppedAt = new Date(),
    actor = {},
    session = null,
} = {}) => {
    const userQuery = User.findById(userId)
        .select('_id referredBy referredByAgentId referralCommissionStoppedAt referralCommissionStoppedReason');
    const user = session ? await userQuery.session(session) : await userQuery;
    if (!user) throw new NotFoundError('User');

    const referrerId = user.referredByAgentId || user.referredBy;
    if (!referrerId) return { stopped: false, reason: 'NO_REFERRER' };
    if (user.referralCommissionStoppedAt) {
        return { stopped: false, reason: 'ALREADY_STOPPED' };
    }

    const update = {
        referralCommissionStoppedAt: stoppedAt,
        referralCommissionStoppedReason: reason,
    };

    await User.updateOne({ _id: user._id }, { $set: update }, session ? { session } : undefined);

    const relationshipQuery = ReferralRelationship.findOneAndUpdate(
        {
            invitedUserId: user._id,
            inviterUserId: referrerId,
            stoppedAt: null,
        },
        {
            $set: {
                stoppedAt,
                stoppedReason: reason,
            },
        },
        { new: true }
    );
    const relationship = session ? await relationshipQuery.session(session) : await relationshipQuery;

    void createAuditLog({
        actorId: actor.actorId || actor._id || actor.userId || referrerId,
        actorRole: actor.actorRole || actor.role || ACTOR_ROLES.SYSTEM,
        action: REFERRAL_ACTIONS.REFERRAL_COMMISSION_STOPPED,
        entityType: ENTITY_TYPES.REFERRAL_RELATIONSHIP,
        entityId: relationship?._id || user._id,
        metadata: {
            userId: toIdString(user._id),
            agentId: toIdString(referrerId),
            reason,
            stoppedAt,
        },
        ipAddress: actor.ipAddress || null,
        userAgent: actor.userAgent || null,
    });

    return { stopped: true, relationship };
};

const processWalletCredit = async (walletTransactionOrId) => {
    const sourceTransaction = await loadWalletTransaction(walletTransactionOrId);
    if (!isEligibleWalletCredit(sourceTransaction)) {
        return { processed: false, reason: 'INELIGIBLE_WALLET_TRANSACTION' };
    }

    const sourceType = ELIGIBLE_REFERRAL_SEMANTIC_TYPES[sourceTransaction.semanticType];
    const idempotencyKey = `referral:${sourceTransaction._id.toString()}`;
    const existing = await ReferralCommission.findOne({ idempotencyKey });
    if (existing) {
        return { processed: true, idempotent: true, commission: existing };
    }

    const invitedUser = await User.findById(sourceTransaction.userId)
        .select('_id referredBy referredByAgentId referralCommissionEligibleUntil referralCommissionStoppedAt isSubAgent subAgentStatus currency');
    if (!invitedUser) return { processed: false, reason: 'INVITED_USER_NOT_FOUND' };

    let relationship = await getActiveRelationshipForInvitedUser(invitedUser);
    if (!relationship) return { processed: false, reason: 'NO_ACTIVE_INVITER' };
    if (sameId(relationship.inviterUserId, invitedUser._id)) {
        return { processed: false, reason: 'SELF_REFERRAL_NOT_ALLOWED' };
    }

    const sourceTime = sourceTransaction.createdAt || sourceTransaction.updatedAt || new Date();
    const eligibleUntil = relationship.eligibleUntil || invitedUser.referralCommissionEligibleUntil;
    if (eligibleUntil && sourceTime.getTime() > new Date(eligibleUntil).getTime()) {
        await stopReferralCommissionForUser({
            userId: invitedUser._id,
            reason: REFERRAL_STOP_REASONS.EXPIRED,
            stoppedAt: new Date(eligibleUntil),
            actor: { actorRole: ACTOR_ROLES.SYSTEM },
        });
        return { processed: false, reason: 'REFERRAL_WINDOW_EXPIRED' };
    }
    if (
        invitedUser.referralCommissionStoppedAt &&
        sourceTime.getTime() >= new Date(invitedUser.referralCommissionStoppedAt).getTime()
    ) {
        return { processed: false, reason: 'REFERRAL_COMMISSION_STOPPED' };
    }
    if (relationship.stoppedAt && sourceTime.getTime() >= new Date(relationship.stoppedAt).getTime()) {
        return { processed: false, reason: 'REFERRAL_COMMISSION_STOPPED' };
    }
    if (invitedUser.isSubAgent === true && invitedUser.subAgentStatus === SUB_AGENT_STATUS.ACTIVE) {
        return { processed: false, reason: 'REFERRED_USER_PROMOTED_TO_SUB_AGENT' };
    }

    const agent = await User.findById(relationship.inviterUserId)
        .select('_id currency name email isSubAgent subAgentStatus agentProfile');
    if (!agent) return { processed: false, reason: 'INVITER_NOT_FOUND' };
    if (!isActiveSubAgent(agent)) return { processed: false, reason: 'AGENT_INACTIVE' };

    const sourceAmount = Number(sourceTransaction.amount);
    const sourceCurrency = normalizeCurrency(sourceTransaction.currency);
    const commissionPercent = getAgentCommissionPercent(agent);
    if (commissionPercent <= 0) return { processed: false, reason: 'COMMISSION_PERCENTAGE_ZERO' };

    const commissionAmount = calculateCommission({
        sourceAmount,
        percentage: commissionPercent,
    });
    if (commissionAmount <= 0) return { processed: false, reason: 'COMMISSION_TOO_SMALL' };

    const session = await mongoose.startSession();
    let commission;

    try {
        session.startTransaction();

        const duplicate = await ReferralCommission.findOne({ idempotencyKey }).session(session);
        if (duplicate) {
            await session.commitTransaction();
            return { processed: true, idempotent: true, commission: duplicate };
        }

        const relationshipInSession = await ReferralRelationship.findById(relationship._id).session(session);
        if (
            !relationshipInSession ||
            relationshipInSession.status !== REFERRAL_RELATIONSHIP_STATUS.ACTIVE ||
            relationshipInSession.stoppedAt
        ) {
            await session.commitTransaction();
            return { processed: false, reason: 'NO_ACTIVE_INVITER' };
        }
        relationship = relationshipInSession;

        commission = await createPendingCommission({
            sourceTransaction,
            relationship,
            agent,
            sourceType,
            commissionAmount,
            commissionCurrency: sourceCurrency,
            session,
        });

        await session.commitTransaction();
    } catch (err) {
        if (session.inTransaction()) await session.abortTransaction();
        if (err.code === 11000) {
            const duplicate = await ReferralCommission.findOne({ idempotencyKey });
            if (duplicate) {
                return { processed: true, idempotent: true, commission: duplicate };
            }
        }
        throw err;
    } finally {
        try { session.endSession(); } catch (_) { /* noop */ }
    }

    emitCommissionSideEffects(commission);

    return {
        processed: true,
        idempotent: false,
        commission,
    };
};

const processWalletCreditSafely = async (walletTransactionOrId) => {
    try {
        return await processWalletCredit(walletTransactionOrId);
    } catch (err) {
        console.error('[Referrals] Failed to process wallet credit:', err.message);
        return null;
    }
};

const getCommissionTotalsByAgent = async (agentIds = []) => {
    if (!agentIds.length) return {};
    const objectIds = agentIds.map((id) => new mongoose.Types.ObjectId(toIdString(id)));
    const rows = await ReferralCommission.aggregate([
        { $match: { inviterUserId: { $in: objectIds } } },
        {
            $group: {
                _id: {
                    agentId: '$inviterUserId',
                    status: '$status',
                    currency: '$commissionCurrency',
                },
                total: { $sum: '$commissionAmount' },
                count: { $sum: 1 },
            },
        },
    ]);

    return rows.reduce((acc, row) => {
        const agentId = toIdString(row._id.agentId);
        const status = row._id.status;
        acc[agentId] = acc[agentId] || {};
        acc[agentId][status] = acc[agentId][status] || [];
        acc[agentId][status].push({
            currency: row._id.currency,
            amount: toFiat(row.total),
            count: row.count,
        });
        return acc;
    }, {});
};

const serializeSubAgent = (user, totalsByAgent = {}) => {
    const id = toIdString(user._id || user.id);
    const profile = user.agentProfile || {};
    return {
        id,
        userId: id,
        name: user.name,
        email: user.email,
        phone: user.phone || null,
        code: getAgentCode(user),
        referralCode: getAgentCode(user),
        commissionPercent: getAgentCommissionPercent(user),
        group: profile.groupId || user.groupId || null,
        status: profile.status || (user.isSubAgent ? AGENT_PROFILE_STATUS.ACTIVE : AGENT_PROFILE_STATUS.INACTIVE),
        active: isActiveSubAgent(user),
        approvedAt: profile.approvedAt || user.subAgentApprovedAt || null,
        approvedBy: profile.approvedBy || user.subAgentApprovedBy || null,
        totalPendingCommissions: [
            ...(totalsByAgent[id]?.[REFERRAL_COMMISSION_STATUS.PENDING] || []),
            ...(totalsByAgent[id]?.[REFERRAL_COMMISSION_STATUS.AVAILABLE] || []),
            ...(totalsByAgent[id]?.[REFERRAL_COMMISSION_STATUS.CREDITED] || []),
        ],
        totalPaidCommissions: totalsByAgent[id]?.[REFERRAL_COMMISSION_STATUS.PAID] || [],
    };
};

const listSubAgents = async ({ status, page = 1, limit = 20 } = {}) => {
    const normalizedPage = parsePage(page);
    const normalizedLimit = parseLimit(limit);
    const skip = (normalizedPage - 1) * normalizedLimit;
    const filter = {
        isSubAgent: true,
        subAgentStatus: SUB_AGENT_STATUS.ACTIVE,
        deletedAt: null,
    };

    if (status) filter['agentProfile.status'] = status;

    const [users, total] = await Promise.all([
        User.find(filter)
            .select('name email phone referralCode groupId isSubAgent subAgentStatus subAgentApprovedAt subAgentApprovedBy agentProfile')
            .populate('groupId', 'name percentage isActive')
            .populate('agentProfile.groupId', 'name percentage isActive')
            .sort({ 'agentProfile.approvedAt': -1, subAgentApprovedAt: -1, createdAt: -1 })
            .skip(skip)
            .limit(normalizedLimit)
            .lean(),
        User.countDocuments(filter),
    ]);

    const totalsByAgent = await getCommissionTotalsByAgent(users.map((user) => user._id));

    return {
        subAgents: users.map((user) => serializeSubAgent(user, totalsByAgent)),
        pagination: {
            page: normalizedPage,
            limit: normalizedLimit,
            total,
            pages: Math.ceil(total / normalizedLimit) || 1,
        },
    };
};

const updateSubAgent = async (userId, patch = {}, actor = {}) => {
    const allowed = new Set(['commissionPercent', 'groupId', 'status', 'active']);
    Object.keys(patch || {}).forEach((key) => {
        if (!allowed.has(key)) {
            throw new BusinessRuleError(`Unknown sub-agent field '${key}'.`, 'INVALID_SUB_AGENT_UPDATE');
        }
    });

    const user = await User.findById(userId).select('_id isSubAgent subAgentStatus agentProfile groupId');
    if (!user || user.isSubAgent !== true || user.subAgentStatus !== SUB_AGENT_STATUS.ACTIVE) {
        throw new NotFoundError('Sub-agent');
    }

    const update = {};
    const auditActions = [];

    if (patch.commissionPercent !== undefined) {
        const commissionPercent = Number(patch.commissionPercent);
        if (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 100) {
            throw new BusinessRuleError('Commission percent must be between 0 and 100.', 'INVALID_SUB_AGENT_PERCENTAGE');
        }
        update['agentProfile.commissionPercent'] = commissionPercent;
        auditActions.push(REFERRAL_ACTIONS.SUB_AGENT_COMMISSION_PERCENT_UPDATED);
    }

    if (patch.groupId !== undefined) {
        const groupId = patch.groupId || null;
        if (!groupId) {
            throw new BusinessRuleError('groupId is required.', 'APPROVED_GROUP_REQUIRED');
        }
        const Group = require('../groups/group.model');
        const group = await Group.findOne({ _id: groupId, isActive: true, deletedAt: null }).select('_id');
        if (!group) throw new BusinessRuleError('Selected group is inactive or does not exist.', 'GROUP_INACTIVE');
        update.groupId = group._id;
        update['agentProfile.groupId'] = group._id;
        auditActions.push(REFERRAL_ACTIONS.SUB_AGENT_GROUP_UPDATED);
    }

    if (patch.status !== undefined || patch.active !== undefined) {
        const status = patch.status
            ? String(patch.status).trim().toLowerCase()
            : (patch.active === false ? AGENT_PROFILE_STATUS.INACTIVE : AGENT_PROFILE_STATUS.ACTIVE);
        if (!Object.values(AGENT_PROFILE_STATUS).includes(status)) {
            throw new BusinessRuleError('Invalid sub-agent status.', 'INVALID_SUB_AGENT_STATUS');
        }
        update['agentProfile.status'] = status;
        update['agentProfile.enabled'] = status === AGENT_PROFILE_STATUS.ACTIVE;
        auditActions.push(REFERRAL_ACTIONS.SUB_AGENT_STATUS_UPDATED);
    }

    if (!Object.keys(update).length) {
        return serializeSubAgent(await User.findById(userId).populate('groupId', 'name percentage isActive').lean());
    }

    const updated = await User.findByIdAndUpdate(userId, { $set: update }, { new: true })
        .select('name email phone referralCode groupId isSubAgent subAgentStatus subAgentApprovedAt subAgentApprovedBy agentProfile')
        .populate('groupId', 'name percentage isActive')
        .populate('agentProfile.groupId', 'name percentage isActive')
        .lean();

    auditActions.forEach((action) => {
        void createAuditLog({
            actorId: actor.actorId || actor._id || actor.userId,
            actorRole: actor.actorRole || actor.role || ACTOR_ROLES.ADMIN,
            action,
            entityType: ENTITY_TYPES.USER,
            entityId: updated._id,
            metadata: { patch: update },
            ipAddress: actor.ipAddress || null,
            userAgent: actor.userAgent || null,
        });
    });

    return serializeSubAgent(updated);
};

module.exports = {
    normalizeCode,
    generateUniqueReferralCode,
    ensureReferralCode,
    getReferralSettings,
    updateReferralSettings,
    resolveInviteCodeOrThrow,
    validateReferralCode,
    createReferralRelationship,
    auditRelationshipCreated,
    getReferralSummary,
    getReferredUsers,
    listRelationships,
    listCommissions,
    listSubAgents,
    updateSubAgent,
    stopReferralCommissionForUser,
    processWalletCredit,
    processWalletCreditSafely,
};
