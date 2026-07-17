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
    LEDGER_TRANSACTION_TYPES,
    TRANSACTION_SOURCE_TYPES,
} = require('../wallet/walletTransaction.model');
const { creditWalletDirect } = require('../wallet/wallet.service');
const { createAuditLog } = require('../audit/audit.service');
const {
    REFERRAL_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
} = require('../audit/audit.constants');
const {
    safeCreateNotification,
    safeCreateAdminActorNotifications,
} = require('../notifications/notification.service');
const { NOTIFICATION_TYPES, NOTIFICATION_PRIORITIES } = require('../notifications/notification.model');
const { toDecimal, toFiat } = require('../../shared/utils/decimalPrecision');
const { getConversionRate } = require('../../services/currencyConverter.service');
const {
    NotFoundError,
    BusinessRuleError,
    AuthorizationError,
} = require('../../shared/errors/AppError');
const {
    ReferralRelationship,
    ReferralCommission,
    ReferralCommissionPayout,
} = require('./referral.model');
const {
    REFERRAL_RELATIONSHIP_STATUS,
    REFERRAL_COMMISSION_STATUS,
    REFERRAL_PAYOUT_METHODS,
    REFERRAL_PAYOUT_STATUS,
    REFERRAL_COMMISSION_PAYOUT_STATUS,
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

const getReferralCommissionOverride = (user) => {
    if (user?.referralCommissionPercentOverride === null || user?.referralCommissionPercentOverride === undefined) {
        return null;
    }

    const percent = Number(user.referralCommissionPercentOverride);
    return Number.isFinite(percent) ? percent : null;
};

const getReferralCommissionPercent = (user, settings = {}) => {
    const overridePercent = getReferralCommissionOverride(user);
    if (overridePercent !== null) return overridePercent;

    const settingsPercent = Number(settings.depositCommissionPercentage ?? DEFAULT_REFERRAL_SETTINGS.depositCommissionPercentage);
    return Number.isFinite(settingsPercent) ? settingsPercent : 0;
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
    if (!inviter) {
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
    if (!inviter) {
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

    const inviterQuery = User.findById(inviterUserId).select('_id referralCode agentProfile deletedAt');
    const inviter = session ? await inviterQuery.session(session) : await inviterQuery;
    if (!inviter || inviter.deletedAt) {
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
    return `${baseUrl}/register?ref=${encodeURIComponent(referralCode)}`;
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
        .select('_id name email referralCode referredBy referredByAgentId currency isSubAgent subAgentStatus agentProfile referralCommissionPercentOverride')
        .populate('agentProfile.groupId', 'name percentage isActive')
        .lean();
    if (!user) throw new NotFoundError('User');

    const referralCode = normalizeCode(await ensureReferralCode(userId));
    user.referralCode = referralCode;
    const isAgent = isActiveSubAgent(user);

    const [settings, relationship, invitedUsersCount, totals, recentCommissions] = await Promise.all([
        getReferralSettings({ persistDefault: false }),
        ReferralRelationship.findOne({
            invitedUserId: user._id,
        }).populate('inviterUserId', 'name referralCode agentProfile').lean(),
        ReferralRelationship.countDocuments({ inviterUserId: user._id }),
        ReferralCommission.aggregate([
            { $match: { inviterUserId: user._id, status: { $in: commissionActiveStatuses } } },
            { $group: { _id: '$commissionCurrency', total: { $sum: '$commissionAmount' }, count: { $sum: 1 } } },
        ]),
        ReferralCommission.find({ inviterUserId: user._id })
            .sort({ earnedAt: -1, createdAt: -1 })
            .limit(5)
            .populate('invitedUserId', 'name email')
            .lean(),
    ]);
    const effectiveCommissionPercent = getReferralCommissionPercent(user, settings);
    const overridePercent = getReferralCommissionOverride(user);

    return {
        isSubAgent: isAgent,
        agentProfile: {
            enabled: user.agentProfile?.enabled === true,
            code: referralCode,
            commissionPercent: effectiveCommissionPercent,
            approvedAt: user.agentProfile?.approvedAt || user.subAgentApprovedAt || null,
            approvedBy: toIdString(user.agentProfile?.approvedBy || user.subAgentApprovedBy),
            group: user.agentProfile?.groupId || null,
            status: user.agentProfile?.status || AGENT_PROFILE_STATUS.INACTIVE,
        },
        referralCode,
        referralLink: getReferralLink(referralCode),
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
        commissionPercentEffective: effectiveCommissionPercent,
        referralCommissionPercentOverride: overridePercent,
        usingDefaultCommission: overridePercent === null,
        settings: {
            enabled: settings.enabled,
            depositCommissionPercentage: effectiveCommissionPercent,
            defaultDepositCommissionPercentage: settings.depositCommissionPercentage,
            applyTo: REFERRAL_APPLY_TO.EVERY_ELIGIBLE_WALLET_CREDIT,
            minSourceAmount: settings.minSourceAmount,
            maxCommissionAmount: settings.maxCommissionAmount,
        },
    };
};

const payoutEligibleCommissionStatuses = [
    REFERRAL_COMMISSION_STATUS.PENDING,
    REFERRAL_COMMISSION_STATUS.AVAILABLE,
];

const availablePayoutStatusFilter = () => ({
    $or: [
        { payoutStatus: { $exists: false } },
        { payoutStatus: null },
        { payoutStatus: REFERRAL_COMMISSION_PAYOUT_STATUS.AVAILABLE },
    ],
});

const groupCommissionBalances = async (match) => {
    const rows = await ReferralCommission.aggregate([
        { $match: match },
        {
            $group: {
                _id: '$commissionCurrency',
                amount: { $sum: '$commissionAmount' },
                count: { $sum: 1 },
            },
        },
        { $sort: { _id: 1 } },
    ]);

    return rows.map((row) => ({
        currency: row._id,
        amount: toFiat(row.amount),
        count: row.count,
    }));
};

const getReferralPayoutBalances = async (userId) => {
    const inviterUserId = new mongoose.Types.ObjectId(toIdString(userId));
    const baseMatch = { inviterUserId };

    const [availableBalances, pendingPayoutBalances, paidPayoutBalances] = await Promise.all([
        groupCommissionBalances({
            ...baseMatch,
            status: { $in: payoutEligibleCommissionStatuses },
            ...availablePayoutStatusFilter(),
        }),
        groupCommissionBalances({
            ...baseMatch,
            status: { $in: payoutEligibleCommissionStatuses },
            payoutStatus: REFERRAL_COMMISSION_PAYOUT_STATUS.LOCKED,
        }),
        groupCommissionBalances({
            ...baseMatch,
            $or: [
                { status: REFERRAL_COMMISSION_STATUS.PAID },
                { payoutStatus: REFERRAL_COMMISSION_PAYOUT_STATUS.PAID },
            ],
        }),
    ]);

    return {
        availableBalances,
        pendingPayoutBalances,
        paidPayoutBalances,
    };
};

const serializePayoutUser = (user) => {
    if (!user || typeof user !== 'object') return user ? { id: toIdString(user) } : null;
    return {
        id: toIdString(user._id || user.id),
        name: user.name || null,
        email: user.email || null,
        phone: user.phone || null,
        referralCode: user.referralCode || null,
        currency: user.currency || null,
    };
};

const serializePayout = (payout, { admin = false } = {}) => {
    if (!payout) return null;
    const raw = typeof payout.toObject === 'function' ? payout.toObject() : payout;
    const lockedCommissionIds = Array.isArray(raw.lockedCommissionIds) ? raw.lockedCommissionIds : [];

    return {
        id: toIdString(raw._id || raw.id),
        userId: toIdString(raw.userId),
        user: admin ? serializePayoutUser(raw.userId) : undefined,
        method: raw.method,
        status: raw.status,
        requestedAmount: toFiat(raw.requestedAmount),
        requestedCurrency: normalizeCurrency(raw.requestedCurrency),
        lockedAmount: toFiat(raw.lockedAmount ?? raw.requestedAmount),
        lockedCurrency: raw.lockedCurrency ? normalizeCurrency(raw.lockedCurrency) : normalizeCurrency(raw.requestedCurrency),
        lockedCommissionIds: lockedCommissionIds.map(toIdString),
        lockedCommissionCount: lockedCommissionIds.length,
        payoutDetails: raw.payoutDetails || null,
        adminNotes: raw.adminNotes || null,
        rejectionReason: raw.rejectionReason || null,
        reviewedBy: admin ? serializePayoutUser(raw.reviewedBy) : toIdString(raw.reviewedBy),
        reviewedAt: raw.reviewedAt || null,
        paidBy: admin ? serializePayoutUser(raw.paidBy) : toIdString(raw.paidBy),
        paidAt: raw.paidAt || null,
        walletTransactionId: toIdString(raw.walletTransactionId),
        walletCreditAmount: raw.walletCreditAmount === null || raw.walletCreditAmount === undefined
            ? null
            : toFiat(raw.walletCreditAmount),
        walletCreditCurrency: raw.walletCreditCurrency ? normalizeCurrency(raw.walletCreditCurrency) : null,
        fxRateUsed: raw.fxRateUsed ?? null,
        fxSnapshotAt: raw.fxSnapshotAt || null,
        fxMetadata: raw.fxMetadata || undefined,
        metadata: admin ? raw.metadata || undefined : undefined,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
    };
};

const normalizePayoutDetails = (details = {}) => {
    const source = details && typeof details === 'object' && !Array.isArray(details) ? details : {};
    return ['methodName', 'accountName', 'accountNumber', 'phone', 'walletAddress', 'notes'].reduce((acc, key) => {
        const value = source[key];
        if (value === undefined || value === null) return acc;
        const normalized = String(value).trim();
        if (normalized) acc[key] = normalized.slice(0, 500);
        return acc;
    }, {});
};

const normalizePayoutMethod = (method) => {
    const normalized = String(method || '').trim().toLowerCase();
    if (!Object.values(REFERRAL_PAYOUT_METHODS).includes(normalized)) {
        throw new BusinessRuleError('Invalid referral payout method.', 'INVALID_REFERRAL_PAYOUT_METHOD');
    }
    return normalized;
};

const convertAmountBetweenCurrencies = async ({ amount, sourceCurrency, targetCurrency, reason = 'referral_payout' }) => {
    const source = normalizeCurrency(sourceCurrency);
    const target = normalizeCurrency(targetCurrency);
    const roundedAmount = toFiat(amount);
    const snapshotAt = new Date();

    if (source === target) {
        return {
            amount: roundedAmount,
            currency: target,
            fxRateUsed: 1,
            fxSnapshotAt: snapshotAt,
            fxMetadata: {
                sourceCurrency: source,
                sourceRate: 1,
                targetCurrency: target,
                targetRate: 1,
                conversion: 'same_currency',
                reason,
            },
        };
    }

    const [sourceRate, targetRate] = await Promise.all([
        getConversionRate(source),
        getConversionRate(target),
    ]);

    if (!sourceRate || sourceRate <= 0 || !targetRate || targetRate <= 0) {
        throw new BusinessRuleError('Currency conversion rate is unavailable for referral payout.', 'REFERRAL_PAYOUT_FX_UNAVAILABLE');
    }

    const fxRateUsed = Number(toDecimal(targetRate).dividedBy(toDecimal(sourceRate)).toDecimalPlaces(8).toNumber());
    const convertedAmount = toFiat(toDecimal(roundedAmount).times(toDecimal(fxRateUsed)));

    return {
        amount: convertedAmount,
        currency: target,
        fxRateUsed,
        fxSnapshotAt: snapshotAt,
        fxMetadata: {
            sourceCurrency: source,
            sourceRate,
            targetCurrency: target,
            targetRate,
            conversion: 'platform_rate',
            reason,
        },
    };
};

const getReferralPayoutSummary = async (userId) => {
    await ensureReferralCode(userId);
    const [balances, latestPayouts] = await Promise.all([
        getReferralPayoutBalances(userId),
        ReferralCommissionPayout.find({ userId })
            .sort({ createdAt: -1 })
            .limit(5)
            .lean(),
    ]);

    return {
        ...balances,
        latestPayouts: latestPayouts.map((payout) => serializePayout(payout)),
        supportsPartialAmount: false,
        payoutMode: 'full_currency_balance',
    };
};

const listReferralPayouts = async ({
    userId,
    status,
    method,
    currency,
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

    if (userId) filter.userId = userId;
    if (status) filter.status = status;
    if (method) filter.method = normalizePayoutMethod(method);
    if (currency) filter.requestedCurrency = normalizeCurrency(currency);
    const dateFilter = buildDateFilter({ from, to });
    if (dateFilter) filter.createdAt = dateFilter;

    const query = ReferralCommissionPayout.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(normalizedLimit);
    const populatedQuery = admin
        ? query
            .populate('userId', 'name email phone referralCode currency')
            .populate('reviewedBy', 'name email role')
            .populate('paidBy', 'name email role')
        : query;

    const [payouts, total] = await Promise.all([
        populatedQuery.lean(),
        ReferralCommissionPayout.countDocuments(filter),
    ]);

    return {
        payouts: payouts.map((payout) => serializePayout(payout, { admin })),
        pagination: {
            page: normalizedPage,
            limit: normalizedLimit,
            total,
            pages: Math.ceil(total / normalizedLimit) || 1,
        },
    };
};

const getReferralPayoutById = async (id, { userId, admin = false } = {}) => {
    const filter = { _id: id };
    if (userId) filter.userId = userId;
    const query = ReferralCommissionPayout.findOne(filter);
    const populatedQuery = admin
        ? query
            .populate('userId', 'name email phone referralCode currency')
            .populate('reviewedBy', 'name email role')
            .populate('paidBy', 'name email role')
        : query;
    const payout = await populatedQuery.lean();
    if (!payout) throw new NotFoundError('Referral payout request');
    return serializePayout(payout, { admin });
};

const emitPayoutRequestedSideEffects = ({ payout, userId, actor = {} }) => {
    void createAuditLog({
        actorId: actor.actorId || userId,
        actorRole: actor.actorRole || actor.role || ACTOR_ROLES.CUSTOMER,
        action: REFERRAL_ACTIONS.REFERRAL_PAYOUT_REQUESTED,
        entityType: ENTITY_TYPES.REFERRAL_PAYOUT,
        entityId: payout._id,
        metadata: {
            userId: toIdString(userId),
            amount: payout.requestedAmount,
            currency: payout.requestedCurrency,
            method: payout.method,
            lockedCommissionCount: payout.lockedCommissionIds?.length || 0,
        },
        ipAddress: actor.ipAddress || null,
        userAgent: actor.userAgent || null,
    });

    void safeCreateNotification({
        userId,
        title: 'Referral payout request submitted',
        message: `Your referral payout request for ${payout.requestedAmount} ${payout.requestedCurrency} was submitted.`,
        type: NOTIFICATION_TYPES.WALLET,
        priority: NOTIFICATION_PRIORITIES.NORMAL,
        route: '/customer/sub-agent',
        entityType: 'referral_payout',
        entityId: payout._id,
        metadata: {
            eventKey: `referral-payout:${payout._id.toString()}:submitted`,
            eventType: 'referral_payout_requested',
            payoutRequestId: payout._id.toString(),
        },
    });

    void safeCreateAdminActorNotifications({
        roles: [ROLES.ADMIN, ROLES.SUPERVISOR],
        permissions: ['referral_payouts.read'],
        title: 'New referral payout request',
        message: `A referral payout request for ${payout.requestedAmount} ${payout.requestedCurrency} needs review.`,
        type: NOTIFICATION_TYPES.WALLET,
        priority: NOTIFICATION_PRIORITIES.NORMAL,
        route: '/admin/sub-agents',
        entityType: 'referral_payout',
        entityId: payout._id,
        metadata: {
            eventKey: `referral-payout:${payout._id.toString()}:admin`,
            eventType: 'referral_payout_requested',
            payoutRequestId: payout._id.toString(),
            userId: toIdString(userId),
        },
    });
};

const createReferralPayoutRequest = async (userId, payload = {}, actor = {}) => {
    const method = normalizePayoutMethod(payload.method);
    const requestedCurrency = normalizeCurrency(payload.currency || payload.requestedCurrency);
    if (!requestedCurrency || requestedCurrency.length !== 3) {
        throw new BusinessRuleError('A valid payout currency is required.', 'INVALID_REFERRAL_PAYOUT_CURRENCY');
    }

    const payoutDetails = normalizePayoutDetails(payload.payoutDetails);
    if (method === REFERRAL_PAYOUT_METHODS.MANUAL_EXTERNAL && Object.keys(payoutDetails).length === 0) {
        throw new BusinessRuleError('Payout details are required for manual external payouts.', 'REFERRAL_PAYOUT_DETAILS_REQUIRED');
    }

    const providedAmount = payload.amount ?? payload.requestedAmount;
    const requestedAmount = providedAmount === undefined || providedAmount === null || providedAmount === ''
        ? null
        : toFiat(providedAmount);
    if (requestedAmount !== null && requestedAmount <= 0) {
        throw new BusinessRuleError('Referral payout amount must be greater than zero.', 'INVALID_REFERRAL_PAYOUT_AMOUNT');
    }

    const pending = await ReferralCommissionPayout.findOne({
        userId,
        requestedCurrency,
        status: REFERRAL_PAYOUT_STATUS.PENDING,
    }).lean();
    if (pending) {
        throw new BusinessRuleError('A payout request is already pending for this currency.', 'REFERRAL_PAYOUT_ALREADY_PENDING');
    }

    const session = await mongoose.startSession();
    let payoutId;

    try {
        session.startTransaction();

        const user = await User.findById(userId).select('_id name email currency').session(session);
        if (!user) throw new NotFoundError('User');

        const duplicatePending = await ReferralCommissionPayout.findOne({
            userId,
            requestedCurrency,
            status: REFERRAL_PAYOUT_STATUS.PENDING,
        }).session(session);
        if (duplicatePending) {
            throw new BusinessRuleError('A payout request is already pending for this currency.', 'REFERRAL_PAYOUT_ALREADY_PENDING');
        }

        const availableFilter = {
            inviterUserId: user._id,
            commissionCurrency: requestedCurrency,
            status: { $in: payoutEligibleCommissionStatuses },
            ...availablePayoutStatusFilter(),
        };
        const commissions = await ReferralCommission.find(availableFilter)
            .sort({ earnedAt: 1, createdAt: 1 })
            .session(session);

        if (!commissions.length) {
            throw new BusinessRuleError('No available referral commission balance for this currency.', 'NO_REFERRAL_PAYOUT_BALANCE');
        }

        const totalAvailable = toFiat(commissions.reduce((sum, commission) => (
            toDecimal(sum).plus(toDecimal(commission.commissionAmount)).toNumber()
        ), 0));
        const amountToWithdraw = requestedAmount === null ? totalAvailable : requestedAmount;
        if (amountToWithdraw <= 0) {
            throw new BusinessRuleError('Referral payout amount must be greater than zero.', 'INVALID_REFERRAL_PAYOUT_AMOUNT');
        }
        if (amountToWithdraw > totalAvailable) {
            throw new BusinessRuleError('Requested payout exceeds available referral commission balance.', 'INSUFFICIENT_REFERRAL_PAYOUT_BALANCE');
        }
        if (amountToWithdraw !== totalAvailable) {
            throw new BusinessRuleError('Partial referral payout is not supported yet. Request the full available balance for this currency.', 'REFERRAL_PAYOUT_FULL_BALANCE_REQUIRED');
        }

        const commissionIds = commissions.map((commission) => commission._id);
        payoutId = new mongoose.Types.ObjectId();
        const now = new Date();
        const [payout] = await ReferralCommissionPayout.create([{
            _id: payoutId,
            userId: user._id,
            method,
            status: REFERRAL_PAYOUT_STATUS.PENDING,
            requestedAmount: amountToWithdraw,
            requestedCurrency,
            lockedAmount: totalAvailable,
            lockedCurrency: requestedCurrency,
            lockedCommissionIds: commissionIds,
            payoutDetails: method === REFERRAL_PAYOUT_METHODS.MANUAL_EXTERNAL ? payoutDetails : undefined,
            idempotencyKey: `referral-payout-request:${payoutId.toString()}`,
            metadata: {
                supportsPartialAmount: false,
                payoutMode: 'full_currency_balance',
                lockedCommissionCount: commissionIds.length,
                commissionIds: commissionIds.map(toIdString),
            },
        }], { session });

        const updateResult = await ReferralCommission.updateMany(
            {
                _id: { $in: commissionIds },
                inviterUserId: user._id,
                commissionCurrency: requestedCurrency,
                status: { $in: payoutEligibleCommissionStatuses },
                ...availablePayoutStatusFilter(),
            },
            {
                $set: {
                    payoutStatus: REFERRAL_COMMISSION_PAYOUT_STATUS.LOCKED,
                    payoutRequestId: payout._id,
                    payoutLockedAt: now,
                },
                $unset: {
                    payoutReleasedAt: '',
                },
            },
            { session }
        );

        if ((updateResult.modifiedCount || updateResult.nModified || 0) !== commissionIds.length) {
            throw new BusinessRuleError('Referral commission balance changed while creating payout request.', 'REFERRAL_PAYOUT_LOCK_CONFLICT');
        }

        await session.commitTransaction();
        emitPayoutRequestedSideEffects({ payout, userId: user._id, actor });
    } catch (err) {
        if (session.inTransaction()) await session.abortTransaction();
        if (err.code === 11000) {
            throw new BusinessRuleError('A payout request is already pending for this currency.', 'REFERRAL_PAYOUT_ALREADY_PENDING');
        }
        throw err;
    } finally {
        try { session.endSession(); } catch (_) { /* noop */ }
    }

    return getReferralPayoutById(payoutId, { userId });
};

const emitPayoutReviewSideEffects = ({ payout, action, actor = {}, walletTransactionId = null }) => {
    const targetUserId = payout.userId?._id || payout.userId;

    void createAuditLog({
        actorId: actor.actorId || actor._id || actor.userId,
        actorRole: actor.actorRole || actor.role || ACTOR_ROLES.ADMIN,
        action,
        entityType: ENTITY_TYPES.REFERRAL_PAYOUT,
        entityId: payout._id,
        metadata: {
            userId: toIdString(payout.userId),
            amount: payout.requestedAmount,
            currency: payout.requestedCurrency,
            method: payout.method,
            walletTransactionId: walletTransactionId ? toIdString(walletTransactionId) : toIdString(payout.walletTransactionId),
        },
        ipAddress: actor.ipAddress || null,
        userAgent: actor.userAgent || null,
    });

    const paid = action === REFERRAL_ACTIONS.REFERRAL_PAYOUT_APPROVED_WALLET_CREDIT ||
        action === REFERRAL_ACTIONS.REFERRAL_PAYOUT_MARKED_PAID;
    void safeCreateNotification({
        userId: targetUserId,
        title: paid ? 'Referral payout paid' : 'Referral payout rejected',
        message: paid
            ? `Your referral payout request for ${payout.requestedAmount} ${payout.requestedCurrency} was paid.`
            : `Your referral payout request for ${payout.requestedAmount} ${payout.requestedCurrency} was rejected.`,
        type: NOTIFICATION_TYPES.WALLET,
        priority: NOTIFICATION_PRIORITIES.NORMAL,
        route: '/customer/sub-agent',
        entityType: 'referral_payout',
        entityId: payout._id,
        metadata: {
            eventKey: `referral-payout:${payout._id.toString()}:${paid ? 'paid' : 'rejected'}`,
            eventType: paid ? 'referral_payout_paid' : 'referral_payout_rejected',
            payoutRequestId: payout._id.toString(),
        },
    });
};

const markLockedCommissionsPaid = async ({ payout, now, walletTransactionId = null, session }) => {
    const update = {
        status: REFERRAL_COMMISSION_STATUS.PAID,
        payoutStatus: REFERRAL_COMMISSION_PAYOUT_STATUS.PAID,
        payoutPaidAt: now,
    };
    if (walletTransactionId) update.walletTransactionId = walletTransactionId;

    return ReferralCommission.updateMany(
        {
            _id: { $in: payout.lockedCommissionIds || [] },
            payoutRequestId: payout._id,
            payoutStatus: REFERRAL_COMMISSION_PAYOUT_STATUS.LOCKED,
        },
        { $set: update },
        { session }
    );
};

const approveReferralPayoutWalletCredit = async (payoutId, actor = {}) => {
    const session = await mongoose.startSession();
    let alreadyProcessed = false;
    let walletTransaction = null;

    try {
        session.startTransaction();
        const payout = await ReferralCommissionPayout.findById(payoutId).session(session);
        if (!payout) throw new NotFoundError('Referral payout request');
        if (payout.method !== REFERRAL_PAYOUT_METHODS.WALLET_CREDIT) {
            throw new BusinessRuleError('This payout request is not a wallet credit request.', 'INVALID_REFERRAL_PAYOUT_METHOD');
        }
        if (payout.status === REFERRAL_PAYOUT_STATUS.PAID) {
            walletTransaction = payout.walletTransactionId
                ? await WalletTransaction.findById(payout.walletTransactionId).session(session)
                : null;
            alreadyProcessed = true;
            await session.commitTransaction();
        } else {
            if (payout.status !== REFERRAL_PAYOUT_STATUS.PENDING) {
                throw new BusinessRuleError('Only pending payout requests can be approved.', 'REFERRAL_PAYOUT_NOT_PENDING');
            }

            const user = await User.findById(payout.userId).select('_id currency').session(session);
            if (!user) throw new NotFoundError('User');
            const walletCurrency = normalizeCurrency(user.currency || payout.requestedCurrency);
            const conversion = await convertAmountBetweenCurrencies({
                amount: payout.requestedAmount,
                sourceCurrency: payout.requestedCurrency,
                targetCurrency: walletCurrency,
                reason: 'referral_payout_wallet_credit',
            });

            const walletIdempotencyKey = `referral-payout:${payout._id.toString()}:wallet-credit`;
            walletTransaction = await WalletTransaction.findOne({ idempotencyKey: walletIdempotencyKey }).session(session);
            if (!walletTransaction) {
                const creditResult = await creditWalletDirect({
                    userId: payout.userId,
                    amount: conversion.amount,
                    currency: conversion.currency,
                    description: `Referral commission payout ${payout.requestedAmount} ${payout.requestedCurrency}`,
                    semanticType: LEDGER_TRANSACTION_TYPES.REFERRAL_COMMISSION_PAYOUT,
                    sourceType: TRANSACTION_SOURCE_TYPES.REFERRAL_PAYOUT,
                    sourceId: payout._id,
                    metadata: {
                        payoutRequestId: payout._id.toString(),
                        commissionIds: (payout.lockedCommissionIds || []).map(toIdString),
                        originalPayoutAmount: payout.requestedAmount,
                        originalPayoutCurrency: payout.requestedCurrency,
                        walletCreditAmount: conversion.amount,
                        walletCreditCurrency: conversion.currency,
                        fxRateUsed: conversion.fxRateUsed,
                        fxSnapshotAt: conversion.fxSnapshotAt,
                        fxMetadata: conversion.fxMetadata,
                    },
                    idempotencyKey: walletIdempotencyKey,
                    actorId: actor.actorId || actor._id || actor.userId || null,
                    actorRole: actor.actorRole || actor.role || ACTOR_ROLES.ADMIN,
                    session,
                });
                walletTransaction = creditResult.transaction;
            }

            const now = new Date();
            await markLockedCommissionsPaid({
                payout,
                now,
                walletTransactionId: walletTransaction._id,
                session,
            });

            payout.status = REFERRAL_PAYOUT_STATUS.PAID;
            payout.reviewedBy = actor.actorId || actor._id || actor.userId || null;
            payout.reviewedAt = now;
            payout.paidBy = actor.actorId || actor._id || actor.userId || null;
            payout.paidAt = now;
            payout.walletTransactionId = walletTransaction._id;
            payout.walletCreditAmount = conversion.amount;
            payout.walletCreditCurrency = conversion.currency;
            payout.fxRateUsed = conversion.fxRateUsed;
            payout.fxSnapshotAt = conversion.fxSnapshotAt;
            payout.fxMetadata = conversion.fxMetadata;
            await payout.save({ session });

            await session.commitTransaction();
        }
    } catch (err) {
        if (session.inTransaction()) await session.abortTransaction();
        if (err.code === 11000) {
            const existingPayout = await ReferralCommissionPayout.findById(payoutId);
            if (existingPayout?.status === REFERRAL_PAYOUT_STATUS.PAID) {
                return {
                    alreadyProcessed: true,
                    payout: serializePayout(existingPayout, { admin: true }),
                };
            }
        }
        throw err;
    } finally {
        try { session.endSession(); } catch (_) { /* noop */ }
    }

    const freshPayout = await ReferralCommissionPayout.findById(payoutId)
        .populate('userId', 'name email phone referralCode currency')
        .populate('reviewedBy', 'name email role')
        .populate('paidBy', 'name email role');

    if (!alreadyProcessed) {
        emitPayoutReviewSideEffects({
            payout: freshPayout,
            action: REFERRAL_ACTIONS.REFERRAL_PAYOUT_APPROVED_WALLET_CREDIT,
            actor,
            walletTransactionId: walletTransaction?._id,
        });
        void createAuditLog({
            actorId: actor.actorId || actor._id || actor.userId,
            actorRole: actor.actorRole || actor.role || ACTOR_ROLES.ADMIN,
            action: REFERRAL_ACTIONS.REFERRAL_PAYOUT_WALLET_CREDIT_CREATED,
            entityType: ENTITY_TYPES.WALLET,
            entityId: walletTransaction?._id,
            metadata: {
                payoutRequestId: toIdString(freshPayout?._id),
                userId: toIdString(freshPayout?.userId),
                amount: freshPayout?.walletCreditAmount,
                currency: freshPayout?.walletCreditCurrency,
            },
            ipAddress: actor.ipAddress || null,
            userAgent: actor.userAgent || null,
        });
    }

    return {
        alreadyProcessed,
        payout: serializePayout(freshPayout, { admin: true }),
        walletTransaction,
    };
};

const markReferralPayoutPaid = async (payoutId, { adminNotes = null } = {}, actor = {}) => {
    const session = await mongoose.startSession();
    let alreadyProcessed = false;

    try {
        session.startTransaction();
        const payout = await ReferralCommissionPayout.findById(payoutId).session(session);
        if (!payout) throw new NotFoundError('Referral payout request');
        if (payout.method !== REFERRAL_PAYOUT_METHODS.MANUAL_EXTERNAL) {
            throw new BusinessRuleError('This payout request is not a manual external payout request.', 'INVALID_REFERRAL_PAYOUT_METHOD');
        }
        if (payout.status === REFERRAL_PAYOUT_STATUS.PAID) {
            alreadyProcessed = true;
        } else {
            if (payout.status !== REFERRAL_PAYOUT_STATUS.PENDING) {
                throw new BusinessRuleError('Only pending payout requests can be marked paid.', 'REFERRAL_PAYOUT_NOT_PENDING');
            }
            const now = new Date();
            await markLockedCommissionsPaid({ payout, now, session });
            payout.status = REFERRAL_PAYOUT_STATUS.PAID;
            payout.reviewedBy = actor.actorId || actor._id || actor.userId || null;
            payout.reviewedAt = now;
            payout.paidBy = actor.actorId || actor._id || actor.userId || null;
            payout.paidAt = now;
            payout.adminNotes = adminNotes || payout.adminNotes || null;
            await payout.save({ session });
        }
        await session.commitTransaction();
    } catch (err) {
        if (session.inTransaction()) await session.abortTransaction();
        throw err;
    } finally {
        try { session.endSession(); } catch (_) { /* noop */ }
    }

    const payout = await ReferralCommissionPayout.findById(payoutId)
        .populate('userId', 'name email phone referralCode currency')
        .populate('reviewedBy', 'name email role')
        .populate('paidBy', 'name email role');
    if (!alreadyProcessed) {
        emitPayoutReviewSideEffects({
            payout,
            action: REFERRAL_ACTIONS.REFERRAL_PAYOUT_MARKED_PAID,
            actor,
        });
    }

    return {
        alreadyProcessed,
        payout: serializePayout(payout, { admin: true }),
    };
};

const rejectReferralPayout = async (payoutId, { reason, adminNotes = null } = {}, actor = {}) => {
    const rejectionReason = String(reason || '').trim();
    if (!rejectionReason) {
        throw new BusinessRuleError('Rejection reason is required.', 'REFERRAL_PAYOUT_REJECTION_REASON_REQUIRED');
    }

    const session = await mongoose.startSession();
    let alreadyProcessed = false;

    try {
        session.startTransaction();
        const payout = await ReferralCommissionPayout.findById(payoutId).session(session);
        if (!payout) throw new NotFoundError('Referral payout request');
        if (payout.status === REFERRAL_PAYOUT_STATUS.REJECTED) {
            alreadyProcessed = true;
        } else {
            if (payout.status === REFERRAL_PAYOUT_STATUS.PAID) {
                throw new BusinessRuleError('Paid payout requests cannot be rejected.', 'REFERRAL_PAYOUT_ALREADY_PAID');
            }
            if (payout.status !== REFERRAL_PAYOUT_STATUS.PENDING) {
                throw new BusinessRuleError('Only pending payout requests can be rejected.', 'REFERRAL_PAYOUT_NOT_PENDING');
            }

            const now = new Date();
            await ReferralCommission.updateMany(
                {
                    _id: { $in: payout.lockedCommissionIds || [] },
                    payoutRequestId: payout._id,
                    payoutStatus: REFERRAL_COMMISSION_PAYOUT_STATUS.LOCKED,
                },
                {
                    $set: {
                        payoutStatus: REFERRAL_COMMISSION_PAYOUT_STATUS.AVAILABLE,
                        payoutReleasedAt: now,
                    },
                    $unset: {
                        payoutRequestId: '',
                        payoutLockedAt: '',
                    },
                },
                { session }
            );

            payout.status = REFERRAL_PAYOUT_STATUS.REJECTED;
            payout.reviewedBy = actor.actorId || actor._id || actor.userId || null;
            payout.reviewedAt = now;
            payout.rejectionReason = rejectionReason;
            payout.adminNotes = adminNotes || null;
            await payout.save({ session });
        }
        await session.commitTransaction();
    } catch (err) {
        if (session.inTransaction()) await session.abortTransaction();
        throw err;
    } finally {
        try { session.endSession(); } catch (_) { /* noop */ }
    }

    const payout = await ReferralCommissionPayout.findById(payoutId)
        .populate('userId', 'name email phone referralCode currency')
        .populate('reviewedBy', 'name email role')
        .populate('paidBy', 'name email role');
    if (!alreadyProcessed) {
        emitPayoutReviewSideEffects({
            payout,
            action: REFERRAL_ACTIONS.REFERRAL_PAYOUT_REJECTED,
            actor,
        });
    }

    return {
        alreadyProcessed,
        payout: serializePayout(payout, { admin: true }),
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
        .select('_id referralCode agentProfile deletedAt');
    const inviter = session ? await inviterQuery.session(session) : await inviterQuery;
    if (!inviter || inviter.deletedAt || sameId(inviter._id, invitedUser._id)) return null;

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

const convertCommissionToReferrerCurrency = async ({
    commissionOriginalAmount,
    sourceCurrency,
    referrerCurrency,
} = {}) => {
    const originalCurrency = normalizeCurrency(sourceCurrency);
    const targetCurrency = normalizeCurrency(referrerCurrency);
    const originalAmount = toFiat(commissionOriginalAmount);
    const snapshotAt = new Date();

    if (originalCurrency === targetCurrency) {
        return {
            commissionAmount: originalAmount,
            commissionCurrency: targetCurrency,
            commissionOriginalAmount: originalAmount,
            commissionOriginalCurrency: originalCurrency,
            referrerCurrency: targetCurrency,
            agentCurrency: targetCurrency,
            fxRateUsed: 1,
            fxSnapshotAt: snapshotAt,
            fxMetadata: {
                sourceCurrency: originalCurrency,
                sourceRate: 1,
                targetCurrency,
                targetRate: 1,
                conversion: 'same_currency',
            },
        };
    }

    const [sourceRate, targetRate] = await Promise.all([
        getConversionRate(originalCurrency),
        getConversionRate(targetCurrency),
    ]);

    if (!sourceRate || sourceRate <= 0 || !targetRate || targetRate <= 0) {
        throw new BusinessRuleError('Currency conversion rate is unavailable for referral commission.', 'REFERRAL_COMMISSION_FX_UNAVAILABLE');
    }

    const fxRateUsed = Number(toDecimal(targetRate).dividedBy(toDecimal(sourceRate)).toDecimalPlaces(8).toNumber());
    const commissionAmount = toFiat(toDecimal(originalAmount).times(toDecimal(fxRateUsed)));

    return {
        commissionAmount,
        commissionCurrency: targetCurrency,
        commissionOriginalAmount: originalAmount,
        commissionOriginalCurrency: originalCurrency,
        referrerCurrency: targetCurrency,
        agentCurrency: targetCurrency,
        fxRateUsed,
        fxSnapshotAt: snapshotAt,
        fxMetadata: {
            sourceCurrency: originalCurrency,
            sourceRate,
            targetCurrency,
            targetRate,
            conversion: 'platform_rate',
        },
    };
};

const createPendingCommission = async ({
    sourceTransaction,
    relationship,
    sourceType,
    commissionPercent,
    commissionOriginalAmount,
    conversion,
    session,
}) => {
    const idempotencyKey = `referral:${sourceTransaction._id.toString()}`;
    const now = new Date();
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
        sourceTopupAmount: sourceAmount,
        sourceTopupCurrency: sourceCurrency,
        commissionPercentage: commissionPercent,
        commissionPercent,
        commissionOriginalAmount,
        commissionOriginalCurrency: sourceCurrency,
        commissionAmount: conversion.commissionAmount,
        commissionCurrency: conversion.commissionCurrency,
        referrerCurrency: conversion.referrerCurrency,
        agentCurrency: conversion.agentCurrency,
        fxRateUsed: conversion.fxRateUsed,
        fxSnapshotAt: conversion.fxSnapshotAt,
        fxMetadata: conversion.fxMetadata,
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
            commissionOriginalAmount,
            commissionOriginalCurrency: sourceCurrency,
            commissionAmount: conversion.commissionAmount,
            commissionCurrency: conversion.commissionCurrency,
            fxRateUsed: conversion.fxRateUsed,
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
            action: REFERRAL_ACTIONS.REFERRAL_COMMISSION_CREATED,
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
        .select('_id currency name email isSubAgent subAgentStatus agentProfile referralCommissionPercentOverride');
    if (!agent) return { processed: false, reason: 'INVITER_NOT_FOUND' };

    const settings = await getReferralSettings({ persistDefault: false });
    if (!settings.enabled) return { processed: false, reason: 'REFERRAL_SETTINGS_DISABLED' };
    if (agent.agentProfile?.status === AGENT_PROFILE_STATUS.INACTIVE) {
        return { processed: false, reason: 'AGENT_INACTIVE' };
    }

    const sourceAmount = Number(sourceTransaction.amount);
    const sourceCurrency = normalizeCurrency(sourceTransaction.currency);
    const commissionPercent = getReferralCommissionPercent(agent, settings);
    if (commissionPercent <= 0) return { processed: false, reason: 'COMMISSION_PERCENTAGE_ZERO' };

    const commissionOriginalAmount = calculateCommission({
        sourceAmount,
        percentage: commissionPercent,
    });
    if (commissionOriginalAmount <= 0) return { processed: false, reason: 'COMMISSION_TOO_SMALL' };

    const conversion = await convertCommissionToReferrerCurrency({
        commissionOriginalAmount,
        sourceCurrency,
        referrerCurrency: agent.currency || sourceCurrency,
    });
    if (conversion.commissionAmount <= 0) return { processed: false, reason: 'COMMISSION_TOO_SMALL_AFTER_FX' };

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
            sourceType,
            commissionPercent,
            commissionOriginalAmount,
            conversion,
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

const serializeSubAgent = (user, totalsByAgent = {}, referredCounts = {}, settings = DEFAULT_REFERRAL_SETTINGS) => {
    const id = toIdString(user._id || user.id);
    const profile = user.agentProfile || {};
    const overridePercent = getReferralCommissionOverride(user);
    const effectiveCommissionPercent = getReferralCommissionPercent(user, settings);
    const status = profile.status || (user.isSubAgent ? AGENT_PROFILE_STATUS.ACTIVE : AGENT_PROFILE_STATUS.ACTIVE);
    return {
        id,
        userId: id,
        name: user.name,
        email: user.email,
        phone: user.phone || null,
        code: getAgentCode(user),
        referralCode: getAgentCode(user),
        commissionPercent: effectiveCommissionPercent,
        commissionPercentEffective: effectiveCommissionPercent,
        referralCommissionPercentOverride: overridePercent,
        usingDefaultCommission: overridePercent === null,
        defaultCommissionPercent: settings.depositCommissionPercentage,
        legacyAgentCommissionPercent: getAgentCommissionPercent(user),
        group: profile.groupId || user.groupId || null,
        status,
        active: status !== AGENT_PROFILE_STATUS.INACTIVE,
        isSubAgent: user.isSubAgent === true,
        subAgentStatus: user.subAgentStatus || null,
        approvedAt: profile.approvedAt || user.subAgentApprovedAt || null,
        approvedBy: profile.approvedBy || user.subAgentApprovedBy || null,
        referredUsersCount: referredCounts[id] || 0,
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
    const [relationshipAgentIds, commissionAgentIds, overrideUsers, approvedSubAgents, referredCountRows, settings] = await Promise.all([
        ReferralRelationship.distinct('inviterUserId'),
        ReferralCommission.distinct('inviterUserId'),
        User.find({
            deletedAt: null,
            referralCommissionPercentOverride: { $ne: null },
        }).select('_id').lean(),
        User.find({
            deletedAt: null,
            isSubAgent: true,
            subAgentStatus: SUB_AGENT_STATUS.ACTIVE,
        }).select('_id').lean(),
        ReferralRelationship.aggregate([
            { $group: { _id: '$inviterUserId', count: { $sum: 1 } } },
        ]),
        getReferralSettings({ persistDefault: false }),
    ]);

    const referredCounts = referredCountRows.reduce((acc, row) => {
        acc[toIdString(row._id)] = row.count;
        return acc;
    }, {});

    const ids = [
        ...relationshipAgentIds,
        ...commissionAgentIds,
        ...overrideUsers.map((user) => user._id),
        ...approvedSubAgents.map((user) => user._id),
    ].reduce((acc, id) => {
        const key = toIdString(id);
        if (key) acc.set(key, id);
        return acc;
    }, new Map());

    let users = await User.find({
        _id: { $in: [...ids.values()] },
        deletedAt: null,
    })
        .select('name email phone referralCode groupId isSubAgent subAgentStatus subAgentApprovedAt subAgentApprovedBy agentProfile referralCommissionPercentOverride')
        .populate('groupId', 'name percentage isActive')
        .populate('agentProfile.groupId', 'name percentage isActive')
        .sort({ 'agentProfile.approvedAt': -1, subAgentApprovedAt: -1, createdAt: -1 })
        .lean();

    if (status) {
        const normalizedStatus = String(status).trim().toLowerCase();
        users = users.filter((user) => {
            const profileStatus = user.agentProfile?.status || AGENT_PROFILE_STATUS.ACTIVE;
            return profileStatus === normalizedStatus;
        });
    }

    const total = users.length;
    const pageUsers = users.slice(skip, skip + normalizedLimit);
    const totalsByAgent = await getCommissionTotalsByAgent(pageUsers.map((user) => user._id));

    return {
        subAgents: pageUsers.map((user) => serializeSubAgent(user, totalsByAgent, referredCounts, settings)),
        pagination: {
            page: normalizedPage,
            limit: normalizedLimit,
            total,
            pages: Math.ceil(total / normalizedLimit) || 1,
        },
    };
};

const updateSubAgent = async (userId, patch = {}, actor = {}) => {
    const allowed = new Set(['commissionPercent', 'referralCommissionPercentOverride', 'useDefault', 'groupId', 'status', 'active']);
    Object.keys(patch || {}).forEach((key) => {
        if (!allowed.has(key)) {
            throw new BusinessRuleError(`Unknown sub-agent field '${key}'.`, 'INVALID_SUB_AGENT_UPDATE');
        }
    });

    const user = await User.findById(userId).select('_id isSubAgent subAgentStatus agentProfile groupId referralCommissionPercentOverride');
    if (!user) throw new NotFoundError('User');

    const update = {};
    const auditActions = [];
    const requiresApprovedSubAgent = patch.groupId !== undefined || patch.status !== undefined || patch.active !== undefined;
    if (requiresApprovedSubAgent && (user.isSubAgent !== true || user.subAgentStatus !== SUB_AGENT_STATUS.ACTIVE)) {
        throw new NotFoundError('Sub-agent');
    }

    if (patch.useDefault === true) {
        update.referralCommissionPercentOverride = null;
        auditActions.push(REFERRAL_ACTIONS.REFERRAL_COMMISSION_PERCENT_RESET_TO_DEFAULT);
    } else if (patch.commissionPercent !== undefined || patch.referralCommissionPercentOverride !== undefined) {
        const rawPercent = patch.referralCommissionPercentOverride !== undefined
            ? patch.referralCommissionPercentOverride
            : patch.commissionPercent;
        const commissionPercent = Number(rawPercent);
        if (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 100) {
            throw new BusinessRuleError('Commission percent must be between 0 and 100.', 'INVALID_REFERRAL_PERCENTAGE');
        }
        update.referralCommissionPercentOverride = commissionPercent;
        if (user.isSubAgent === true) {
            update['agentProfile.commissionPercent'] = commissionPercent;
        }
        auditActions.push(REFERRAL_ACTIONS.REFERRAL_COMMISSION_PERCENT_UPDATED);
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
        const settings = await getReferralSettings({ persistDefault: false });
        return serializeSubAgent(await User.findById(userId).populate('groupId', 'name percentage isActive').lean(), {}, {}, settings);
    }

    const updated = await User.findByIdAndUpdate(userId, { $set: update }, { new: true })
        .select('name email phone referralCode groupId isSubAgent subAgentStatus subAgentApprovedAt subAgentApprovedBy agentProfile referralCommissionPercentOverride')
        .populate('groupId', 'name percentage isActive')
        .populate('agentProfile.groupId', 'name percentage isActive')
        .lean();
    const settings = await getReferralSettings({ persistDefault: false });

    auditActions.forEach((action) => {
        void createAuditLog({
            actorId: actor.actorId || actor._id || actor.userId,
            actorRole: actor.actorRole || actor.role || ACTOR_ROLES.ADMIN,
            action,
            entityType: ENTITY_TYPES.USER,
            entityId: updated._id,
            metadata: {
                patch: update,
                oldPercent: getReferralCommissionOverride(user),
                newPercent: updated.referralCommissionPercentOverride,
                usingDefault: updated.referralCommissionPercentOverride === null || updated.referralCommissionPercentOverride === undefined,
            },
            ipAddress: actor.ipAddress || null,
            userAgent: actor.userAgent || null,
        });
    });

    return serializeSubAgent(updated, {}, {}, settings);
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
    getReferralPayoutSummary,
    listReferralPayouts,
    getReferralPayoutById,
    createReferralPayoutRequest,
    approveReferralPayoutWalletCredit,
    markReferralPayoutPaid,
    rejectReferralPayout,
    getReferredUsers,
    listRelationships,
    listCommissions,
    listSubAgents,
    updateSubAgent,
    stopReferralCommissionForUser,
    processWalletCredit,
    processWalletCreditSafely,
};
