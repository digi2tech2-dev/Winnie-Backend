'use strict';

const { DepositRequest, DEPOSIT_STATUS } = require('./deposit.model');
const { User } = require('../users/user.model');
const { assertIdentityVerificationNotRequired } = require('../users/identityVerification.guard');
const { creditWalletDirect } = require('../wallet/wallet.service');
const { processWalletCreditSafely } = require('../referrals/referral.service');
const {
    safeCreateNotification,
    safeCreateAdminActorNotifications,
} = require('../notifications/notification.service');
const {
    notifyDepositRequested,
    notifyDepositApproved,
    notifyDepositRejected,
} = require('../notifications/notification.events');
const {
    NotFoundError,
    BusinessRuleError,
    AuthorizationError,
    AntiScamConfirmationRequiredError,
} = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { DEPOSIT_ACTIONS, WALLET_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');
const { getDepositRate } = require('../../services/currencyConverter.service');
const { localToUsd, usdToLocal } = require('../../shared/utils/currencyMath');

const ANTI_SCAM_CONFIRMATION_REQUIRED_MESSAGE =
    'Please confirm the anti-scam safety warning before continuing.';

const isTruthyConfirmation = (value) => (
    value === true || String(value || '').trim().toLowerCase() === 'true'
);

const assertAntiScamConfirmation = ({ antiScamConfirmed, termsAccepted } = {}) => {
    if (!isTruthyConfirmation(antiScamConfirmed) || !isTruthyConfirmation(termsAccepted)) {
        throw new AntiScamConfirmationRequiredError(ANTI_SCAM_CONFIRMATION_REQUIRED_MESSAGE);
    }
};

const toMoney = (value) => Number(Number(value || 0).toFixed(2));

const resolveDepositCreditSnapshot = async ({
    deposit,
    finalAmount,
    finalCurrency,
    walletCurrency,
    adminOverrideApplied = false,
}) => {
    const sourceCurrency = String(finalCurrency || deposit.currency || 'USD').toUpperCase();
    const targetCurrency = String(walletCurrency || deposit.walletCurrency || 'USD').toUpperCase();
    const legacyFallback = !deposit.depositRateSnapshot || adminOverrideApplied;
    const fallbackSourceRate = deposit.exchangeRate || await getDepositRate(sourceCurrency);
    const sourceRate = legacyFallback
        ? Number(fallbackSourceRate)
        : Number(deposit.depositRateSnapshot);
    const canUseWalletSnapshot = !adminOverrideApplied
        && deposit.walletCurrency
        && String(deposit.walletCurrency).toUpperCase() === targetCurrency
        && Number(deposit.walletDepositRateSnapshot) > 0;
    const walletRate = canUseWalletSnapshot
        ? Number(deposit.walletDepositRateSnapshot)
        : await getDepositRate(targetCurrency);

    if (sourceCurrency === targetCurrency) {
        return {
            sourceAmount: finalAmount,
            sourceCurrency,
            walletAmount: toMoney(finalAmount),
            walletCurrency: targetCurrency,
            usdEquivalent: localToUsd(finalAmount, sourceRate),
            sourceDepositRate: sourceRate,
            walletDepositRate: walletRate,
            rateType: 'deposit',
            legacyFallback,
            conversionNote: `${finalAmount} ${sourceCurrency} (direct wallet credit)`,
        };
    }

    const usdEquivalent = adminOverrideApplied || !Number(deposit.usdEquivalent || deposit.amountUsd)
        ? localToUsd(finalAmount, sourceRate)
        : Number(deposit.usdEquivalent || deposit.amountUsd);
    const walletAmount = usdToLocal(usdEquivalent, walletRate);

    return {
        sourceAmount: finalAmount,
        sourceCurrency,
        walletAmount,
        walletCurrency: targetCurrency,
        usdEquivalent,
        sourceDepositRate: sourceRate,
        walletDepositRate: walletRate,
        rateType: 'deposit',
        legacyFallback,
        conversionNote: `${finalAmount} ${sourceCurrency} -> ${usdEquivalent} USD -> ${walletAmount} ${targetCurrency}`,
    };
};

const createDepositRequest = async ({
    userId,
    paymentMethodId,
    requestedAmount,
    currency,
    exchangeRate,
    amountUsd,
    depositRateSnapshot = null,
    walletCurrency = null,
    walletDepositRateSnapshot = null,
    expectedWalletCreditAmount = null,
    usdEquivalent = null,
    rateType = 'deposit',
    legacyFallback = false,
    receiptImage,
    notes = null,
    customFieldSnapshot = [],
    customFieldValues = {},
    customFieldFiles = {},
    antiScamConfirmed = false,
    termsAccepted = false,
    antiScamConfirmedAt = null,
    auditContext = null,
}) => {
    assertAntiScamConfirmation({ antiScamConfirmed, termsAccepted });

    const user = await User.findById(userId).select('_id role identityVerificationRequired');
    if (!user) throw new NotFoundError('User');
    assertIdentityVerificationNotRequired(user);

    const existingPending = await DepositRequest.findOne({
        userId,
        status: DEPOSIT_STATUS.PENDING,
    });
    if (existingPending) {
        throw new BusinessRuleError(
            'You already have a pending deposit request. Please wait for it to be processed.',
            'DUPLICATE_PENDING_DEPOSIT'
        );
    }

    const deposit = await DepositRequest.create({
        userId,
        paymentMethodId,
        requestedAmount: toMoney(requestedAmount),
        currency,
        exchangeRate,
        amountUsd: toMoney(amountUsd),
        depositRateSnapshot,
        walletCurrency,
        walletDepositRateSnapshot,
        expectedWalletCreditAmount: expectedWalletCreditAmount == null ? null : toMoney(expectedWalletCreditAmount),
        usdEquivalent: usdEquivalent == null ? toMoney(amountUsd) : Number(Number(usdEquivalent).toFixed(6)),
        rateType,
        legacyFallback,
        receiptImage,
        notes,
        customFieldSnapshot: Array.isArray(customFieldSnapshot) ? customFieldSnapshot : [],
        customFieldValues: customFieldValues && typeof customFieldValues === 'object' ? customFieldValues : {},
        customFieldFiles: customFieldFiles && typeof customFieldFiles === 'object' ? customFieldFiles : {},
        status: DEPOSIT_STATUS.PENDING,
    });

    const baseMetadata = {
        userId: userId.toString(),
        paymentMethodId,
        requestedAmount: deposit.requestedAmount,
        currency,
        exchangeRate,
        amountUsd: deposit.amountUsd,
        depositRateSnapshot: deposit.depositRateSnapshot,
        walletCurrency: deposit.walletCurrency,
        walletDepositRateSnapshot: deposit.walletDepositRateSnapshot,
        expectedWalletCreditAmount: deposit.expectedWalletCreditAmount,
        usdEquivalent: deposit.usdEquivalent,
        rateType: deposit.rateType,
        legacyFallback: deposit.legacyFallback,
        customFieldKeys: Object.keys(deposit.customFieldValues || {}),
        customFieldFileKeys: Object.keys(deposit.customFieldFiles || {}),
        antiScamConfirmed: true,
        termsAccepted: true,
        antiScamConfirmedAt: antiScamConfirmedAt || null,
    };

    createAuditLog({
        actorId: auditContext?.actorId ?? userId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.CUSTOMER,
        action: DEPOSIT_ACTIONS.REQUESTED,
        entityType: ENTITY_TYPES.DEPOSIT,
        entityId: deposit._id,
        metadata: baseMetadata,
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    void safeCreateNotification({
        userId,
        title: 'Deposit request received',
        message: `Your deposit request for ${deposit.requestedAmount} ${deposit.currency} was received and is pending review.`,
        type: 'deposit',
        priority: 'normal',
        route: '/wallet',
        entityType: 'topup',
        entityId: deposit._id,
        metadata: {
            eventKey: `user:${userId.toString()}:topup:${deposit._id.toString()}:requested`,
            eventType: 'topup_requested',
            depositId: deposit._id.toString(),
            requestedAmount: deposit.requestedAmount,
            currency: deposit.currency,
            amountUsd: deposit.amountUsd,
            usdEquivalent: deposit.usdEquivalent,
            expectedWalletCreditAmount: deposit.expectedWalletCreditAmount,
            walletCurrency: deposit.walletCurrency,
            status: deposit.status,
        },
    });

    void safeCreateAdminActorNotifications({
        roles: ['ADMIN', 'SUPERVISOR'],
        permissions: ['topups.review'],
        permissionMode: 'any',
        title: 'New deposit request',
        message: `A new deposit request for ${deposit.requestedAmount} ${deposit.currency} is waiting for review.`,
        type: 'deposit',
        priority: 'high',
        route: `/admin/payments?topupId=${deposit._id.toString()}`,
        entityType: 'topup',
        entityId: deposit._id,
        metadata: {
            eventKey: `topup:${deposit._id.toString()}:requested`,
            eventType: 'topup_requested',
            depositId: deposit._id.toString(),
            userId: userId.toString(),
            requestedAmount: deposit.requestedAmount,
            currency: deposit.currency,
            amountUsd: deposit.amountUsd,
            usdEquivalent: deposit.usdEquivalent,
            expectedWalletCreditAmount: deposit.expectedWalletCreditAmount,
            walletCurrency: deposit.walletCurrency,
            status: deposit.status,
        },
    });

    notifyDepositRequested(deposit);
    return deposit;
};

const approveDeposit = async (depositId, adminId, adminOverrides = {}, auditContext = null) => {
    const existing = await DepositRequest.findById(depositId);
    if (!existing) throw new NotFoundError('DepositRequest');

    if (existing.status === DEPOSIT_STATUS.APPROVED) {
        throw new BusinessRuleError(
            'This deposit request has already been approved.',
            'DEPOSIT_ALREADY_APPROVED'
        );
    }
    if (existing.status === DEPOSIT_STATUS.REJECTED) {
        throw new BusinessRuleError(
            'A rejected deposit cannot be approved. Create a new request.',
            'DEPOSIT_ALREADY_REJECTED'
        );
    }

    const finalAmount = toMoney(adminOverrides.amount ?? existing.requestedAmount);
    const finalCurrency = (adminOverrides.currency || existing.currency || 'USD').toUpperCase();
    if (finalAmount <= 0) {
        throw new BusinessRuleError('Deposit amount must be greater than zero.', 'INVALID_AMOUNT');
    }

    const $setFields = {
        status: DEPOSIT_STATUS.APPROVED,
        reviewedBy: adminId,
        reviewedAt: new Date(),
    };
    if (adminOverrides.amount != null) $setFields.requestedAmount = finalAmount;
    if (adminOverrides.currency) $setFields.currency = finalCurrency;
    if (adminOverrides.adminNotes) $setFields.adminNotes = String(adminOverrides.adminNotes).trim();

    const updated = await DepositRequest.findOneAndUpdate(
        { _id: depositId, status: DEPOSIT_STATUS.PENDING },
        { $set: $setFields },
        { new: true }
    );

    if (!updated) {
        throw new BusinessRuleError(
            'This deposit request has already been approved.',
            'DEPOSIT_ALREADY_APPROVED'
        );
    }

    const userDoc = await User.findById(updated.userId).select('currency');
    const walletCurrency = (userDoc?.currency ?? 'USD').toUpperCase();
    const adminOverrideApplied = !!(adminOverrides.amount || adminOverrides.currency);
    const creditSnapshot = await resolveDepositCreditSnapshot({
        deposit: updated,
        finalAmount,
        finalCurrency,
        walletCurrency,
        adminOverrideApplied,
    });

    const actorId = auditContext?.actorId ?? adminId;
    const actorRole = auditContext?.actorRole ?? ACTOR_ROLES.ADMIN;
    const ipAddress = auditContext?.ipAddress ?? null;
    const userAgent = auditContext?.userAgent ?? null;
    const walletCreditAmount = creditSnapshot.walletAmount;

    const creditResult = await creditWalletDirect({
        userId: updated.userId,
        amount: walletCreditAmount,
        reference: updated._id,
        sourceId: updated._id,
        currency: walletCurrency,
        description: `Deposit #${updated._id.toString().slice(-6)} (${finalAmount} ${finalCurrency})`,
        metadata: {
            depositId: updated._id.toString(),
            sourceAmount: creditSnapshot.sourceAmount,
            sourceCurrency: creditSnapshot.sourceCurrency,
            walletAmount: walletCreditAmount,
            walletCurrency: creditSnapshot.walletCurrency,
            usdEquivalent: creditSnapshot.usdEquivalent,
            rateType: creditSnapshot.rateType,
            depositRateSnapshot: creditSnapshot.sourceDepositRate,
            walletDepositRateSnapshot: creditSnapshot.walletDepositRate,
            legacyFallback: creditSnapshot.legacyFallback,
            finalAmount,
            finalCurrency,
            walletCreditAmount,
            conversionNote: creditSnapshot.conversionNote,
        },
        idempotencyKey: `deposit:${updated._id.toString()}:approved`,
        actorId,
        actorRole,
    });

    await processWalletCreditSafely(creditResult.transaction);

    createAuditLog({
        actorId, actorRole, ipAddress, userAgent,
        action: DEPOSIT_ACTIONS.APPROVED,
        entityType: ENTITY_TYPES.DEPOSIT,
        entityId: updated._id,
        metadata: {
            userId: updated.userId.toString(),
            finalAmount,
            finalCurrency,
            originalRequestedAmount: existing.requestedAmount,
            originalCurrency: existing.currency,
            adminOverrideApplied,
            walletCurrency,
            walletCreditAmount,
            usdEquivalent: creditSnapshot.usdEquivalent,
            rateType: creditSnapshot.rateType,
            depositRateSnapshot: creditSnapshot.sourceDepositRate,
            walletDepositRateSnapshot: creditSnapshot.walletDepositRate,
            legacyFallback: creditSnapshot.legacyFallback,
            conversionNote: creditSnapshot.conversionNote,
            reviewedBy: adminId.toString(),
        },
    });

    createAuditLog({
        actorId, actorRole, ipAddress, userAgent,
        action: WALLET_ACTIONS.CREDIT,
        entityType: ENTITY_TYPES.WALLET,
        entityId: updated.userId,
        metadata: {
            depositId: updated._id.toString(),
            walletCurrency,
            walletCreditAmount,
            usdEquivalent: creditSnapshot.usdEquivalent,
            rateType: creditSnapshot.rateType,
            depositRateSnapshot: creditSnapshot.sourceDepositRate,
            legacyFallback: creditSnapshot.legacyFallback,
            reason: 'DEPOSIT_APPROVED',
        },
    });

    const populated = await DepositRequest.findById(updated._id)
        .populate('userId', 'name email avatar currency walletBalance')
        .populate('reviewedBy', 'name email');

    notifyDepositApproved(populated || updated, {
        walletCreditAmount,
        walletCurrency,
    });

    return populated;
};

const rejectDeposit = async (depositId, adminId, adminNotes = null, auditContext = null) => {
    const deposit = await DepositRequest.findById(depositId);
    if (!deposit) throw new NotFoundError('DepositRequest');

    if (deposit.status === DEPOSIT_STATUS.REJECTED) {
        throw new BusinessRuleError(
            'This deposit request has already been rejected.',
            'DEPOSIT_ALREADY_REJECTED'
        );
    }
    if (deposit.status === DEPOSIT_STATUS.APPROVED) {
        throw new BusinessRuleError(
            'An approved deposit cannot be rejected. It has already been credited.',
            'DEPOSIT_ALREADY_APPROVED'
        );
    }

    deposit.status = DEPOSIT_STATUS.REJECTED;
    deposit.reviewedBy = adminId;
    deposit.reviewedAt = new Date();
    if (adminNotes) deposit.adminNotes = adminNotes;
    await deposit.save();

    createAuditLog({
        actorId: auditContext?.actorId ?? adminId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.ADMIN,
        action: DEPOSIT_ACTIONS.REJECTED,
        entityType: ENTITY_TYPES.DEPOSIT,
        entityId: deposit._id,
        metadata: {
            userId: deposit.userId.toString(),
            requestedAmount: deposit.requestedAmount,
            currency: deposit.currency,
            amountUsd: deposit.amountUsd,
            adminNotes: adminNotes || null,
            reviewedBy: adminId.toString(),
        },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    notifyDepositRejected(deposit);
    return deposit;
};

const listDeposits = async ({ page = 1, limit = 20, status, search } = {}) => {
    const filter = {};
    if (status) filter.status = String(status).toUpperCase();

    if (search && String(search).trim()) {
        const regex = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const matchingUsers = await User.find({
            $or: [{ name: regex }, { email: regex }],
        }).select('_id').lean();
        filter.userId = { $in: matchingUsers.map((u) => u._id) };
    }

    const skip = (page - 1) * limit;
    const [deposits, total, summaryStats] = await Promise.all([
        DepositRequest.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('userId', 'name email walletBalance currency')
            .populate('reviewedBy', 'name email'),
        DepositRequest.countDocuments(filter),
        DepositRequest.aggregate([
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    pending: { $sum: { $cond: [{ $eq: ['$status', DEPOSIT_STATUS.PENDING] }, 1, 0] } },
                    approved: { $sum: { $cond: [{ $eq: ['$status', DEPOSIT_STATUS.APPROVED] }, 1, 0] } },
                },
            },
        ]).then((r) => r[0] || { total: 0, pending: 0, approved: 0 }),
    ]);

    return {
        deposits,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        summary: {
            totalDeposits: summaryStats.total,
            pendingCount: summaryStats.pending,
            approvedCount: summaryStats.approved,
        },
    };
};

const listMyDeposits = async (userId, { page = 1, limit = 20, status } = {}) => {
    const filter = { userId };
    if (status) filter.status = status;

    const skip = (page - 1) * limit;
    const [deposits, total] = await Promise.all([
        DepositRequest.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        DepositRequest.countDocuments(filter),
    ]);

    return {
        deposits,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

const getDepositById = async (depositId, requestingUserId = null) => {
    const deposit = await DepositRequest.findById(depositId)
        .populate('userId', 'name email')
        .populate('reviewedBy', 'name email');

    if (!deposit) throw new NotFoundError('DepositRequest');

    if (requestingUserId && deposit.userId._id.toString() !== requestingUserId.toString()) {
        throw new AuthorizationError('You do not have permission to view this deposit request.');
    }

    return deposit;
};

const updatePendingDeposit = async (depositId, data, adminId) => {
    const deposit = await DepositRequest.findById(depositId);
    if (!deposit) throw new NotFoundError('Deposit request');

    if (deposit.status !== DEPOSIT_STATUS.PENDING) {
        throw new BusinessRuleError(
            `Cannot update a ${deposit.status.toLowerCase()} deposit. Only PENDING deposits can be edited.`,
            'DEPOSIT_NOT_PENDING'
        );
    }

    const before = {
        requestedAmount: deposit.requestedAmount,
        amountUsd: deposit.amountUsd,
        usdEquivalent: deposit.usdEquivalent,
        expectedWalletCreditAmount: deposit.expectedWalletCreditAmount,
    };

    if (data.requestedAmount !== undefined) {
        deposit.requestedAmount = toMoney(data.requestedAmount);
        const sourceRate = Number(deposit.depositRateSnapshot || deposit.exchangeRate);
        deposit.amountUsd = toMoney(deposit.requestedAmount / sourceRate);
        deposit.usdEquivalent = Number((deposit.requestedAmount / sourceRate).toFixed(6));
        if (deposit.currency && deposit.walletCurrency && deposit.currency === deposit.walletCurrency) {
            deposit.expectedWalletCreditAmount = deposit.requestedAmount;
        } else if (deposit.walletDepositRateSnapshot) {
            deposit.expectedWalletCreditAmount = usdToLocal(deposit.usdEquivalent, deposit.walletDepositRateSnapshot);
        }
    }

    await deposit.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: DEPOSIT_ACTIONS.UPDATED,
        entityType: ENTITY_TYPES.DEPOSIT,
        entityId: deposit._id,
        metadata: {
            before,
            after: {
                requestedAmount: deposit.requestedAmount,
                amountUsd: deposit.amountUsd,
                usdEquivalent: deposit.usdEquivalent,
                expectedWalletCreditAmount: deposit.expectedWalletCreditAmount,
            },
        },
    });

    return deposit;
};

module.exports = {
    createDepositRequest,
    approveDeposit,
    rejectDeposit,
    listDeposits,
    listMyDeposits,
    getDepositById,
    updatePendingDeposit,
};
