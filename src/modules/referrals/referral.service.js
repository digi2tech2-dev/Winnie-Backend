'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../../config/config');
const { User, ROLES } = require('../users/user.model');
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
const { safeCreateNotification } = require('../notifications/notification.service');
const { NOTIFICATION_TYPES, NOTIFICATION_PRIORITIES } = require('../notifications/notification.model');
const { getConversionRate } = require('../../services/currencyConverter.service');
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
        const query = User.exists({ referralCode });
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

    const query = User.findOne({ referralCode, deletedAt: null })
        .select('_id name email referralCode currency role status');
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
            referralCode: inviter.referralCode,
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

    const invitedQuery = User.findById(invitedUserId).select('_id referredBy');
    const invitedUser = session ? await invitedQuery.session(session) : await invitedQuery;
    if (!invitedUser) throw new NotFoundError('Invited user');

    if (invitedUser.referredBy && !sameId(invitedUser.referredBy, inviterUserId)) {
        throw new BusinessRuleError('This user already has an inviter.', 'INVITER_ALREADY_SET');
    }

    const normalizedCode = normalizeCode(referralCode);
    const [relationship] = await ReferralRelationship.create([{
        inviterUserId,
        invitedUserId,
        referralCode: normalizedCode,
        status: REFERRAL_RELATIONSHIP_STATUS.ACTIVE,
        registeredAt: new Date(),
        metadata,
    }], session ? { session } : undefined);

    await User.updateOne(
        {
            _id: invitedUserId,
            $or: [{ referredBy: null }, { referredBy: { $exists: false } }, { referredBy: inviterUserId }],
        },
        { $set: { referredBy: inviterUserId } },
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
    status,
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

    if (inviterUserId) filter.inviterUserId = inviterUserId;
    if (invitedUserId) filter.invitedUserId = invitedUserId;
    if (status) filter.status = status;
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

const getReferralSummary = async (userId) => {
    const user = await User.findById(userId).select('_id name email referralCode referredBy currency');
    if (!user) throw new NotFoundError('User');

    const referralCode = await ensureReferralCode(user);
    const [relationship, invitedUsersCount, totals, recentCommissions, settings] = await Promise.all([
        ReferralRelationship.findOne({
            invitedUserId: user._id,
            status: REFERRAL_RELATIONSHIP_STATUS.ACTIVE,
        }).populate('inviterUserId', 'name referralCode').lean(),
        ReferralRelationship.countDocuments({
            inviterUserId: user._id,
            status: REFERRAL_RELATIONSHIP_STATUS.ACTIVE,
        }),
        ReferralCommission.aggregate([
            { $match: { inviterUserId: user._id, status: REFERRAL_COMMISSION_STATUS.CREDITED } },
            { $group: { _id: '$commissionCurrency', total: { $sum: '$commissionAmount' }, count: { $sum: 1 } } },
        ]),
        ReferralCommission.find({ inviterUserId: user._id })
            .sort({ createdAt: -1 })
            .limit(5)
            .populate('invitedUserId', 'name')
            .lean(),
        getReferralSettings(),
    ]);

    return {
        referralCode,
        referralLink: getReferralLink(referralCode),
        inviter: relationship?.inviterUserId
            ? {
                id: relationship.inviterUserId._id.toString(),
                name: relationship.inviterUserId.name,
                referralCode: relationship.inviterUserId.referralCode,
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
            enabled: settings.enabled,
            depositCommissionPercentage: settings.depositCommissionPercentage,
            applyTo: settings.applyTo,
            minSourceAmount: settings.minSourceAmount,
            maxCommissionAmount: settings.maxCommissionAmount,
        },
    };
};

const getActiveRelationshipForInvitedUser = async (invitedUser, { session = null } = {}) => {
    const relationshipQuery = ReferralRelationship.findOne({
        invitedUserId: invitedUser._id,
        status: REFERRAL_RELATIONSHIP_STATUS.ACTIVE,
    });
    let relationship = session ? await relationshipQuery.session(session) : await relationshipQuery;
    if (relationship) return relationship;

    if (!invitedUser.referredBy) return null;

    const inviterQuery = User.findById(invitedUser.referredBy).select('_id referralCode');
    const inviter = session ? await inviterQuery.session(session) : await inviterQuery;
    if (!inviter || sameId(inviter._id, invitedUser._id)) return null;

    const referralCode = await ensureReferralCode(inviter, { session });
    try {
        const result = await createReferralRelationship({
            inviterUserId: inviter._id,
            invitedUserId: invitedUser._id,
            referralCode,
            metadata: { source: 'lazy-referredBy-backfill' },
            session,
        });
        relationship = result.relationship;
        if (!result.idempotent) auditRelationshipCreated(relationship, { actorRole: ACTOR_ROLES.SYSTEM, actorId: inviter._id });
        return relationship;
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

const calculateCommission = async ({ sourceAmount, sourceCurrency, inviterCurrency, percentage, maxCommissionAmount }) => {
    const sourceCommission = toFiat(toDecimal(sourceAmount).times(toDecimal(percentage)).dividedBy(100));
    if (!Number.isFinite(sourceCommission) || sourceCommission <= 0) {
        return { amount: 0, currency: inviterCurrency, conversion: null, reason: 'COMMISSION_TOO_SMALL' };
    }

    const fromCurrency = normalizeCurrency(sourceCurrency);
    const toCurrency = normalizeCurrency(inviterCurrency);
    let commissionAmount = sourceCommission;
    let conversion = null;

    if (fromCurrency !== toCurrency) {
        const fromRate = await getConversionRate(fromCurrency);
        const toRate = await getConversionRate(toCurrency);
        const amountInUsd = toDecimal(sourceCommission).dividedBy(fromRate);
        commissionAmount = toFiat(amountInUsd.times(toRate));
        conversion = {
            fromCurrency,
            toCurrency,
            fromRate,
            toRate,
            sourceCommission,
            amountInUsd: Number(amountInUsd.toDecimalPlaces(6).toNumber()),
        };
    }

    if (maxCommissionAmount !== null && commissionAmount > maxCommissionAmount) {
        commissionAmount = maxCommissionAmount;
    }

    if (!Number.isFinite(commissionAmount) || commissionAmount <= 0) {
        return { amount: 0, currency: toCurrency, conversion, reason: 'COMMISSION_TOO_SMALL' };
    }

    return { amount: commissionAmount, currency: toCurrency, conversion, reason: null };
};

const createSkippedCommission = async ({
    sourceTransaction,
    relationship,
    sourceType,
    percentage,
    commissionCurrency,
    reason,
    metadata = {},
    session,
}) => {
    const idempotencyKey = `referral:${sourceTransaction._id.toString()}`;
    const [commission] = await ReferralCommission.create([{
        inviterUserId: relationship.inviterUserId,
        invitedUserId: relationship.invitedUserId,
        sourceWalletTransactionId: sourceTransaction._id,
        sourceType,
        sourceId: sourceTransaction.sourceId || null,
        sourceSemanticType: sourceTransaction.semanticType,
        sourceAmount: Number(sourceTransaction.amount),
        sourceCurrency: normalizeCurrency(sourceTransaction.currency),
        commissionPercentage: percentage,
        commissionAmount: 0,
        commissionCurrency: normalizeCurrency(commissionCurrency || sourceTransaction.currency),
        status: REFERRAL_COMMISSION_STATUS.SKIPPED,
        idempotencyKey,
        metadata: { skipReason: reason, ...metadata },
    }], { session });

    return commission;
};

const createCreditedCommission = async ({
    sourceTransaction,
    relationship,
    inviter,
    sourceType,
    settings,
    commissionAmount,
    commissionCurrency,
    conversion,
    session,
}) => {
    const commissionId = new mongoose.Types.ObjectId();
    const idempotencyKey = `referral:${sourceTransaction._id.toString()}`;
    const now = new Date();

    const [commission] = await ReferralCommission.create([{
        _id: commissionId,
        inviterUserId: relationship.inviterUserId,
        invitedUserId: relationship.invitedUserId,
        sourceWalletTransactionId: sourceTransaction._id,
        sourceType,
        sourceId: sourceTransaction.sourceId || null,
        sourceSemanticType: sourceTransaction.semanticType,
        sourceAmount: Number(sourceTransaction.amount),
        sourceCurrency: normalizeCurrency(sourceTransaction.currency),
        commissionPercentage: settings.depositCommissionPercentage,
        commissionAmount,
        commissionCurrency,
        status: REFERRAL_COMMISSION_STATUS.CREDITED,
        idempotencyKey,
        creditedAt: now,
        metadata: {
            sourceWalletTransactionId: sourceTransaction._id.toString(),
            invitedUserId: relationship.invitedUserId.toString(),
            sourceType,
            sourceId: toIdString(sourceTransaction.sourceId),
            sourceAmount: Number(sourceTransaction.amount),
            sourceCurrency: normalizeCurrency(sourceTransaction.currency),
            percentage: settings.depositCommissionPercentage,
            conversion,
        },
    }], { session });

    const creditResult = await creditWalletDirect({
        userId: inviter._id,
        amount: commissionAmount,
        reference: null,
        semanticType: LEDGER_TRANSACTION_TYPES.REFERRAL_COMMISSION,
        sourceType: TRANSACTION_SOURCE_TYPES.REFERRAL,
        sourceId: commission._id,
        currency: commissionCurrency,
        description: `Referral commission for ${sourceTransaction.semanticType}`,
        metadata: {
            referralCommissionId: commission._id.toString(),
            invitedUserId: relationship.invitedUserId.toString(),
            sourceWalletTransactionId: sourceTransaction._id.toString(),
            sourceType,
            sourceId: toIdString(sourceTransaction.sourceId),
            sourceAmount: Number(sourceTransaction.amount),
            sourceCurrency: normalizeCurrency(sourceTransaction.currency),
            percentage: settings.depositCommissionPercentage,
        },
        idempotencyKey,
        actorId: relationship.invitedUserId,
        actorRole: ACTOR_ROLES.SYSTEM,
        session,
    });

    commission.walletTransactionId = creditResult.transaction._id;
    await commission.save({ session });

    return { commission, transaction: creditResult.transaction };
};

const emitCommissionSideEffects = (commission, transaction = null) => {
    if (!commission) return;

    if (commission.status === REFERRAL_COMMISSION_STATUS.CREDITED) {
        void createAuditLog({
            actorId: commission.invitedUserId,
            actorRole: ACTOR_ROLES.SYSTEM,
            action: REFERRAL_ACTIONS.COMMISSION_CREDITED,
            entityType: ENTITY_TYPES.REFERRAL_COMMISSION,
            entityId: commission._id,
            metadata: {
                inviterUserId: commission.inviterUserId.toString(),
                invitedUserId: commission.invitedUserId.toString(),
                amount: commission.commissionAmount,
                currency: commission.commissionCurrency,
                sourceWalletTransactionId: commission.sourceWalletTransactionId.toString(),
                walletTransactionId: toIdString(commission.walletTransactionId || transaction?._id),
            },
        });

        void safeCreateNotification({
            userId: commission.inviterUserId,
            title: 'Referral commission credited',
            message: `Your wallet was credited with ${commission.commissionAmount} ${commission.commissionCurrency}.`,
            type: NOTIFICATION_TYPES.WALLET,
            priority: NOTIFICATION_PRIORITIES.NORMAL,
            route: '/wallet',
            entityType: 'referral_commission',
            entityId: commission._id,
            metadata: {
                eventKey: `referral:${commission._id.toString()}:credited`,
                eventType: 'referral_commission_credited',
                referralCommissionId: commission._id.toString(),
                walletTransactionId: toIdString(commission.walletTransactionId || transaction?._id),
                amount: commission.commissionAmount,
                currency: commission.commissionCurrency,
            },
        });
    } else if (commission.status === REFERRAL_COMMISSION_STATUS.SKIPPED) {
        void createAuditLog({
            actorId: commission.invitedUserId,
            actorRole: ACTOR_ROLES.SYSTEM,
            action: REFERRAL_ACTIONS.COMMISSION_SKIPPED,
            entityType: ENTITY_TYPES.REFERRAL_COMMISSION,
            entityId: commission._id,
            metadata: {
                inviterUserId: commission.inviterUserId.toString(),
                invitedUserId: commission.invitedUserId.toString(),
                sourceWalletTransactionId: commission.sourceWalletTransactionId.toString(),
                reason: commission.metadata?.skipReason || null,
            },
        });
    }
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

    const invitedUser = await User.findById(sourceTransaction.userId).select('_id referredBy currency');
    if (!invitedUser) return { processed: false, reason: 'INVITED_USER_NOT_FOUND' };

    let relationship = await getActiveRelationshipForInvitedUser(invitedUser);
    if (!relationship) return { processed: false, reason: 'NO_ACTIVE_INVITER' };
    if (sameId(relationship.inviterUserId, invitedUser._id)) {
        return { processed: false, reason: 'SELF_REFERRAL_NOT_ALLOWED' };
    }

    const inviter = await User.findById(relationship.inviterUserId).select('_id currency name email');
    if (!inviter) return { processed: false, reason: 'INVITER_NOT_FOUND' };

    const settings = await getReferralSettings();
    const sourceAmount = Number(sourceTransaction.amount);
    const sourceCurrency = normalizeCurrency(sourceTransaction.currency);
    const inviterCurrency = normalizeCurrency(inviter.currency);

    let planned = {
        status: REFERRAL_COMMISSION_STATUS.CREDITED,
        amount: 0,
        currency: inviterCurrency,
        conversion: null,
        skipReason: null,
    };

    if (!settings.enabled) {
        planned = { ...planned, status: REFERRAL_COMMISSION_STATUS.SKIPPED, skipReason: 'REFERRALS_DISABLED' };
    } else if (settings.depositCommissionPercentage <= 0) {
        planned = { ...planned, status: REFERRAL_COMMISSION_STATUS.SKIPPED, skipReason: 'COMMISSION_PERCENTAGE_ZERO' };
    } else if (settings.minSourceAmount !== null && sourceAmount < settings.minSourceAmount) {
        planned = { ...planned, status: REFERRAL_COMMISSION_STATUS.SKIPPED, skipReason: 'SOURCE_AMOUNT_BELOW_MINIMUM' };
    } else {
        try {
            const calculated = await calculateCommission({
                sourceAmount,
                sourceCurrency,
                inviterCurrency,
                percentage: settings.depositCommissionPercentage,
                maxCommissionAmount: settings.maxCommissionAmount,
            });
            if (calculated.reason) {
                planned = {
                    ...planned,
                    status: REFERRAL_COMMISSION_STATUS.SKIPPED,
                    amount: calculated.amount,
                    currency: calculated.currency,
                    conversion: calculated.conversion,
                    skipReason: calculated.reason,
                };
            } else {
                planned = {
                    ...planned,
                    amount: calculated.amount,
                    currency: calculated.currency,
                    conversion: calculated.conversion,
                };
            }
        } catch (err) {
            planned = {
                ...planned,
                status: REFERRAL_COMMISSION_STATUS.SKIPPED,
                skipReason: 'CURRENCY_CONVERSION_UNAVAILABLE',
                conversion: { error: err.message },
            };
        }
    }

    const session = await mongoose.startSession();
    let commission;
    let transaction;

    try {
        session.startTransaction();

        const duplicate = await ReferralCommission.findOne({ idempotencyKey }).session(session);
        if (duplicate) {
            await session.commitTransaction();
            return { processed: true, idempotent: true, commission: duplicate };
        }

        const relationshipInSession = await ReferralRelationship.findById(relationship._id).session(session);
        if (!relationshipInSession || relationshipInSession.status !== REFERRAL_RELATIONSHIP_STATUS.ACTIVE) {
            await session.commitTransaction();
            return { processed: false, reason: 'NO_ACTIVE_INVITER' };
        }
        relationship = relationshipInSession;

        if (planned.status === REFERRAL_COMMISSION_STATUS.SKIPPED) {
            commission = await createSkippedCommission({
                sourceTransaction,
                relationship,
                sourceType,
                percentage: settings.depositCommissionPercentage,
                commissionCurrency: planned.currency,
                reason: planned.skipReason,
                metadata: { conversion: planned.conversion },
                session,
            });
        } else {
            const result = await createCreditedCommission({
                sourceTransaction,
                relationship,
                inviter,
                sourceType,
                settings,
                commissionAmount: planned.amount,
                commissionCurrency: planned.currency,
                conversion: planned.conversion,
                session,
            });
            commission = result.commission;
            transaction = result.transaction;
        }

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

    emitCommissionSideEffects(commission, transaction);

    return {
        processed: true,
        idempotent: false,
        commission,
        transaction,
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
    listRelationships,
    listCommissions,
    processWalletCredit,
    processWalletCreditSafely,
};
