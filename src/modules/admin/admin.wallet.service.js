'use strict';

/**
 * admin.wallet.service.js
 *
 * Admin manual wallet adjustments.
 *
 * Uses sequential await operations — compatible with standalone MongoDB
 * instances (no replica set required).
 */

const { User, ROLES } = require('../users/user.model');
const mongoose = require('mongoose');
const {
    WalletTransaction,
    TRANSACTION_TYPES,
    LEDGER_TRANSACTION_TYPES,
    TRANSACTION_DIRECTIONS,
    TRANSACTION_SOURCE_TYPES,
} = require('../wallet/walletTransaction.model');
const { NotFoundError, BusinessRuleError, AuthorizationError } = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { ADMIN_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');
const { notifyManualWalletAdjustment } = require('../notifications/notification.events');

const MAX_ADJUSTMENT = 100_000;  // guard against fat-finger typos
const MAX_REASON_LENGTH = 500;

/**
 * Safe rounding via integer math — kills IEEE-754 dust like 5.684e-14.
 * Number.toFixed(2) still leaks because it returns a string that Number()
 * re-parses, preserving intermediate float imprecision.
 */
const safeRound = (value, decimals = 2) => {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
};

function normalizeAdjustmentReason(reason) {
    const normalized = String(reason || '').trim();
    if (!normalized) {
        throw new BusinessRuleError(
            'Adjustment reason is required.',
            'ADJUSTMENT_REASON_REQUIRED'
        );
    }
    if (normalized.length > MAX_REASON_LENGTH) {
        throw new BusinessRuleError(
            `Adjustment reason cannot exceed ${MAX_REASON_LENGTH} characters.`,
            'ADJUSTMENT_REASON_TOO_LONG'
        );
    }
    return normalized;
}

function normalizeActorRole(role) {
    const normalized = String(role || ACTOR_ROLES.ADMIN).toUpperCase();
    return ACTOR_ROLES[normalized] || normalized;
}

function normalizeActorContext(actorContext) {
    const isContextObject = actorContext && typeof actorContext === 'object' && (
        Object.prototype.hasOwnProperty.call(actorContext, 'actorId') ||
        Object.prototype.hasOwnProperty.call(actorContext, 'actorRole') ||
        Object.prototype.hasOwnProperty.call(actorContext, 'role') ||
        Object.prototype.hasOwnProperty.call(actorContext, 'ipAddress') ||
        Object.prototype.hasOwnProperty.call(actorContext, 'userAgent')
    );

    if (!isContextObject) {
        return {
            actorId: actorContext || null,
            actorRole: ACTOR_ROLES.ADMIN,
            ipAddress: null,
            userAgent: null,
        };
    }

    return {
        actorId: actorContext.actorId || actorContext._id || actorContext.id || actorContext.userId || null,
        actorRole: normalizeActorRole(actorContext.actorRole || actorContext.role),
        ipAddress: actorContext.ipAddress || null,
        userAgent: actorContext.userAgent || null,
    };
}

function isSameId(left, right) {
    return String(left || '') === String(right || '');
}

function isSupervisorActor(actor) {
    return actor.actorRole === ACTOR_ROLES.SUPERVISOR || actor.actorRole === ROLES.SUPERVISOR;
}

function assertSupervisorWalletAccess({ actor, targetUser, operation }) {
    if (!isSupervisorActor(actor)) return;

    if (operation !== 'ADD') {
        throw new AuthorizationError('Supervisors can only add balance to customer wallets.');
    }

    if (isSameId(actor.actorId, targetUser?._id)) {
        throw new AuthorizationError('Supervisors cannot adjust their own wallet balance.');
    }

    if (targetUser?.role !== ROLES.CUSTOMER) {
        throw new AuthorizationError('Supervisors can only add balance to customer wallets.');
    }
}

function assertAdminOnlyWalletOperation(actor, operationLabel) {
    if (isSupervisorActor(actor)) {
        throw new AuthorizationError(`${operationLabel} is restricted to admins.`);
    }
}

// ─── List wallets (summary of all users) ─────────────────────────────────────

const listWallets = async ({ page = 1, limit = 20 } = {}) => {
    limit = Math.min(limit, 100);
    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
        User.find({ deletedAt: null })
            .select('name email walletBalance creditLimit creditUsed currency role status')
            .sort({ walletBalance: -1 })
            .skip(skip)
            .limit(limit),
        User.countDocuments({ deletedAt: null }),
    ]);

    return { wallets: users, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

// ─── Get one user's wallet ─────────────────────────────────────────────────────

const getWallet = async (userId) => {
    const user = await User.findById(userId)
        .select('name email walletBalance creditLimit creditUsed currency status role groupId')
        .populate('groupId', 'name percentage isActive');
    if (!user) throw new NotFoundError('User');

    // Fetch recent transactions WITH populated references so the frontend
    // store is never overwritten with unpopulated/missing transaction data.
    const recentTransactions = await WalletTransaction.find({ userId })
        .sort({ createdAt: -1 })
        .limit(20)
        .populate('reference', 'orderNumber customerInput status totalPrice');

    return { user, recentTransactions };
};

// ─── Transaction history ───────────────────────────────────────────────────────

const getTransactionHistory = async (userId, { page = 1, limit = 20 } = {}) => {
    const user = await User.findById(userId).select('_id');
    if (!user) throw new NotFoundError('User');

    limit = Math.min(limit, 100);
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
        WalletTransaction.find({ userId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('reference', 'orderNumber customerInput status totalPrice'),
        WalletTransaction.countDocuments({ userId }),
    ]);

    return { transactions, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

const toObjectId = (value) => (
    mongoose.Types.ObjectId.isValid(String(value || ''))
        ? new mongoose.Types.ObjectId(String(value))
        : null
);

const buildDateRange = ({ dateFrom, dateTo }) => {
    const range = {};
    if (dateFrom) {
        const from = new Date(dateFrom);
        if (!Number.isNaN(from.getTime())) range.$gte = from;
    }
    if (dateTo) {
        const to = new Date(dateTo);
        if (!Number.isNaN(to.getTime())) {
            const looksLikeDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(dateTo)) ||
                (dateTo instanceof Date && to.getHours() === 0 && to.getMinutes() === 0 &&
                    to.getSeconds() === 0 && to.getMilliseconds() === 0);
            if (looksLikeDateOnly) {
                to.setHours(23, 59, 59, 999);
            }
            range.$lte = to;
        }
    }
    return Object.keys(range).length ? range : null;
};

const adminAdjustmentMatch = {
    $or: [
        { semanticType: LEDGER_TRANSACTION_TYPES.ADMIN_ADJUSTMENT },
        { sourceType: TRANSACTION_SOURCE_TYPES.ADMIN_ADJUSTMENT },
        { 'metadata.semanticType': LEDGER_TRANSACTION_TYPES.ADMIN_ADJUSTMENT },
        { 'metadata.sourceType': TRANSACTION_SOURCE_TYPES.ADMIN_ADJUSTMENT },
        { type: LEDGER_TRANSACTION_TYPES.ADMIN_ADJUSTMENT },
    ],
};

const normalizedAdminAdjustmentFields = {
    idString: { $toString: '$_id' },
    normalizedAmount: { $abs: { $ifNull: ['$amount', 0] } },
    normalizedOperation: {
        $let: {
            vars: {
                amountValue: { $ifNull: ['$amount', 0] },
                directionValue: { $toUpper: { $ifNull: ['$direction', ''] } },
                operationValue: { $toUpper: { $ifNull: ['$metadata.operation', ''] } },
                typeValue: { $toUpper: { $ifNull: ['$type', ''] } },
            },
            in: {
                $switch: {
                    branches: [
                        { case: { $in: ['$$operationValue', ['ADD', 'CREDIT', 'ADMIN_ADD', 'ADD_FUNDS']] }, then: 'ADD' },
                        { case: { $in: ['$$operationValue', ['DEDUCT', 'DEBIT', 'ADMIN_DEDUCT', 'DEDUCT_FUNDS']] }, then: 'DEDUCT' },
                        { case: { $eq: ['$$directionValue', TRANSACTION_DIRECTIONS.CREDIT] }, then: 'ADD' },
                        { case: { $eq: ['$$directionValue', TRANSACTION_DIRECTIONS.DEBIT] }, then: 'DEDUCT' },
                        { case: { $eq: ['$$typeValue', TRANSACTION_TYPES.CREDIT] }, then: 'ADD' },
                        { case: { $eq: ['$$typeValue', TRANSACTION_TYPES.DEBIT] }, then: 'DEDUCT' },
                        { case: { $lt: ['$$amountValue', 0] }, then: 'DEDUCT' },
                    ],
                    default: 'ADD',
                },
            },
        },
    },
};

const listAdminAdjustments = async (filters = {}) => {
    const page = Math.max(parseInt(filters.page ?? 1, 10), 1);
    const limit = Math.min(Math.max(parseInt(filters.limit ?? 20, 10), 1), 100);
    const skip = (page - 1) * limit;
    const type = String(filters.type || 'all').toLowerCase();
    const sort = String(filters.sort || 'newest').toLowerCase();

    const match = { ...adminAdjustmentMatch };

    if (filters.currency) {
        match.currency = String(filters.currency).trim().toUpperCase();
    }

    const userObjectId = toObjectId(filters.userId);
    if (userObjectId) match.userId = userObjectId;

    const actorObjectId = toObjectId(filters.adminId || filters.actorId);
    if (actorObjectId) match.actorId = actorObjectId;

    const minAmount = Number(filters.minAmount);
    const maxAmount = Number(filters.maxAmount);
    if (Number.isFinite(minAmount) || Number.isFinite(maxAmount)) {
        match.amount = {};
        if (Number.isFinite(minAmount)) match.amount.$gte = minAmount;
        if (Number.isFinite(maxAmount)) match.amount.$lte = maxAmount;
    }

    const dateRange = buildDateRange(filters);
    if (dateRange) match.createdAt = dateRange;

    const sortStage = {
        oldest: { createdAt: 1, _id: 1 },
        amount_desc: { amount: -1, createdAt: -1 },
        amount_asc: { amount: 1, createdAt: -1 },
        newest: { createdAt: -1, _id: -1 },
    }[sort] || { createdAt: -1, _id: -1 };

    const pipeline = [
        { $match: match },
        { $addFields: normalizedAdminAdjustmentFields },
    ];

    if (type === 'add' || type === 'credit') pipeline.push({ $match: { normalizedOperation: 'ADD' } });
    if (type === 'deduct' || type === 'debit') pipeline.push({ $match: { normalizedOperation: 'DEDUCT' } });

    pipeline.push(
        {
            $lookup: {
                from: 'users',
                localField: 'userId',
                foreignField: '_id',
                as: 'user',
            },
        },
        { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: 'users',
                localField: 'actorId',
                foreignField: '_id',
                as: 'actor',
            },
        },
        { $unwind: { path: '$actor', preserveNullAndEmptyArrays: true } },
    );

    const search = String(filters.search || '').trim();
    if (search) {
        const searchRegex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        pipeline.push({
            $match: {
                $or: [
                    { idString: searchRegex },
                    { description: searchRegex },
                    { reason: searchRegex },
                    { note: searchRegex },
                    { 'metadata.reason': searchRegex },
                    { 'metadata.note': searchRegex },
                    { 'user.name': searchRegex },
                    { 'user.email': searchRegex },
                    { 'actor.name': searchRegex },
                    { 'actor.email': searchRegex },
                ],
            },
        });
    }

    pipeline.push({
        $facet: {
            items: [
                { $sort: sortStage },
                { $skip: skip },
                { $limit: limit },
                {
                    $project: {
                        _id: 0,
                        id: '$idString',
                        user: {
                            id: { $toString: '$user._id' },
                            name: '$user.name',
                            email: '$user.email',
                        },
                        actor: {
                            id: { $toString: '$actor._id' },
                            name: '$actor.name',
                            email: '$actor.email',
                        },
                        action: '$normalizedOperation',
                        amount: '$normalizedAmount',
                        currency: 1,
                        beforeBalance: '$balanceBefore',
                        afterBalance: '$balanceAfter',
                        reason: { $ifNull: ['$reason', { $ifNull: ['$metadata.reason', '$description'] }] },
                        note: { $ifNull: ['$note', '$metadata.note'] },
                        createdAt: 1,
                    },
                },
            ],
            total: [{ $count: 'count' }],
            summary: [
                {
                    $group: {
                        _id: { $ifNull: ['$currency', 'USD'] },
                        totalAdded: {
                            $sum: { $cond: [{ $eq: ['$normalizedOperation', 'ADD'] }, '$normalizedAmount', 0] },
                        },
                        totalDeducted: {
                            $sum: { $cond: [{ $eq: ['$normalizedOperation', 'DEDUCT'] }, '$normalizedAmount', 0] },
                        },
                        count: { $sum: 1 },
                    },
                },
                {
                    $project: {
                        _id: 0,
                        currency: '$_id',
                        totalAdded: { $round: ['$totalAdded', 2] },
                        totalAdditions: { $round: ['$totalAdded', 2] },
                        totalDeducted: { $round: ['$totalDeducted', 2] },
                        totalDeductions: { $round: ['$totalDeducted', 2] },
                        net: { $round: [{ $subtract: ['$totalAdded', '$totalDeducted'] }, 2] },
                        count: 1,
                    },
                },
                { $sort: { currency: 1 } },
            ],
        },
    });

    const [result = {}] = await WalletTransaction.aggregate(pipeline);
    const total = result.total?.[0]?.count || 0;
    const totalsByCurrency = (result.summary || []).map((item) => ({
        currency: item.currency || 'USD',
        totalAdded: safeRound(item.totalAdded || 0),
        totalAdditions: safeRound(item.totalAdditions || item.totalAdded || 0),
        totalDeducted: safeRound(item.totalDeducted || 0),
        totalDeductions: safeRound(item.totalDeductions || item.totalDeducted || 0),
        net: safeRound(item.net || 0),
        count: item.count || 0,
    }));
    const selectedCurrency = filters.currency ? String(filters.currency).trim().toUpperCase() : '';
    const singleCurrencySummary = selectedCurrency
        ? (totalsByCurrency.find((item) => item.currency === selectedCurrency) || {
            currency: selectedCurrency,
            totalAdded: 0,
            totalAdditions: 0,
            totalDeducted: 0,
            totalDeductions: 0,
            net: 0,
            count: 0,
        })
        : (totalsByCurrency.length === 1 ? totalsByCurrency[0] : null);

    const summary = singleCurrencySummary
        ? {
            ...singleCurrencySummary,
            count: total,
            mode: 'single',
            totalsByCurrency,
        }
        : {
            currency: null,
            mode: 'grouped',
            totalAdded: null,
            totalAdditions: null,
            totalDeducted: null,
            totalDeductions: null,
            net: 0,
            count: total,
            totalsByCurrency,
        };

    return {
        items: result.items || [],
        pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
        summary,
    };
};

// ─── Manual Add ───────────────────────────────────────────────────────────────

/**
 * Admin: add funds to a user's wallet balance.
 *
 * IMPORTANT: The `amount` parameter is always in the USER'S LOCAL CURRENCY
 * (the same currency as their walletBalance). No USD conversion is applied.
 * The admin dashboard displays balances in local currency, so the input
 * is naturally in the same denomination.
 *
 * No MongoDB transactions — uses atomic findOneAndUpdate + sequential create.
 */
const addFunds = async (userId, amount, reason, actorContext) => {
    const actor = normalizeActorContext(actorContext);
    const parsedAmount = safeRound(Number(amount));
    const normalizedReason = normalizeAdjustmentReason(reason);

    if (parsedAmount <= 0 || parsedAmount > MAX_ADJUSTMENT) {
        throw new BusinessRuleError(
            `Adjustment amount must be between 0.01 and ${MAX_ADJUSTMENT}.`,
            'INVALID_ADJUSTMENT_AMOUNT'
        );
    }

    // Fetch user first to compute credit repayment
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User');
    assertSupervisorWalletAccess({ actor, targetUser: user, operation: 'ADD' });

    const userCurrency = user.currency || 'USD';
    const balanceBefore = safeRound(user.walletBalance || 0);
    const creditLimit = safeRound(Math.abs(Number(user.creditLimit || 0)));
    const creditUsedBefore = safeRound(user.creditUsed || 0);

    // If user has drawn credit (creditUsed > 0), adding funds repays credit first.
    // Example: balance=-50, creditUsed=50, add 80 → creditUsed=0, balance=30
    let creditRepaid = 0;

    const balanceAfter = safeRound(balanceBefore + parsedAmount);
    const creditUsedAfter = balanceAfter < 0
        ? safeRound(Math.min(Math.abs(balanceAfter), creditLimit))
        : 0;
    creditRepaid = safeRound(Math.max(0, creditUsedBefore - creditUsedAfter));

    // Atomic update
    await User.findByIdAndUpdate(userId, {
        $set: {
            walletBalance: balanceAfter,
            creditUsed: creditUsedAfter,
        },
    });

    // Create the wallet transaction record
    const transaction = await WalletTransaction.create({
        userId,
        type: TRANSACTION_TYPES.CREDIT,
        semanticType: LEDGER_TRANSACTION_TYPES.ADMIN_ADJUSTMENT,
        sourceType: TRANSACTION_SOURCE_TYPES.ADMIN_ADJUSTMENT,
        direction: TRANSACTION_DIRECTIONS.CREDIT,
        amount: parsedAmount,
        balanceBefore,
        balanceAfter,
        reference: null,
        currency: userCurrency,
        status: 'COMPLETED',
        description: normalizedReason,
        reason: normalizedReason,
        note: normalizedReason,
        metadata: {
            operation: 'ADD',
            reason: normalizedReason,
            note: normalizedReason,
            creditRepaid,
            creditUsedBefore,
            creditUsedAfter,
        },
        actorId: actor.actorId,
        actorRole: actor.actorRole,
    });

    // Audit (fire-and-forget)
    createAuditLog({
        actorId: actor.actorId,
        actorRole: actor.actorRole,
        action: ADMIN_ACTIONS.WALLET_ADJUSTED,
        entityType: ENTITY_TYPES.WALLET,
        entityId: userId,
        metadata: {
            type: 'ADD',
            amount: parsedAmount,
            currency: userCurrency,
            reason: normalizedReason,
            userId,
            balanceBefore,
            balanceAfter,
            creditRepaid,
            transactionId: transaction._id,
        },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
    });

    notifyManualWalletAdjustment({
        userId,
        operation: 'ADD',
        amount: parsedAmount,
        currency: userCurrency,
        transactionId: transaction._id,
        balanceBefore,
        balanceAfter,
        actorRole: actor.actorRole,
    });

    const updatedUser = await User.findById(userId)
        .select('name email walletBalance creditLimit creditUsed currency status role');

    return { transaction, user: updatedUser };
};

/**
 * Admin: deduct funds from a user's wallet balance.
 *
 * IMPORTANT: The `amount` parameter is always in the USER'S LOCAL CURRENCY
 * (the same currency as their walletBalance). No USD conversion is applied.
 *
 * CREDIT LIMIT ENFORCEMENT:
 *   available = walletBalance + (creditLimit - creditUsed)
 *   Deduction allowed only if: amount <= available
 *   newBalance = walletBalance - amount (can go negative up to -creditLimit)
 */
const deductFunds = async (userId, amount, reason, actorContext) => {
    const actor = normalizeActorContext(actorContext);
    const parsedAmount = safeRound(Number(amount));
    const normalizedReason = normalizeAdjustmentReason(reason);

    if (parsedAmount <= 0 || parsedAmount > MAX_ADJUSTMENT) {
        throw new BusinessRuleError(
            `Adjustment amount must be between 0.01 and ${MAX_ADJUSTMENT}.`,
            'INVALID_ADJUSTMENT_AMOUNT'
        );
    }

    // Fetch user to check credit limit
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User');
    assertAdminOnlyWalletOperation(actor, 'Wallet deduction');

    const userCurrency = user.currency || 'USD';
    const balanceBefore = safeRound(user.walletBalance || 0);
    const creditLimit = safeRound(Math.abs(Number(user.creditLimit || 0)));
    const creditUsedBefore = safeRound(user.creditUsed || 0);
    const availableCredit = safeRound(creditLimit - creditUsedBefore);
    const totalAvailable = safeRound(balanceBefore + availableCredit);

    if (parsedAmount > totalAvailable) {
        throw new BusinessRuleError(
            `Insufficient funds. Available: ${totalAvailable.toFixed(2)} ${userCurrency} ` +
            `(balance: ${balanceBefore.toFixed(2)}, available credit: ${availableCredit.toFixed(2)}).`,
            'INSUFFICIENT_BALANCE'
        );
    }

    // Calculate new balance and credit usage
    const balanceAfter = safeRound(balanceBefore - parsedAmount);

    const creditUsedAfter = balanceAfter < 0
        ? safeRound(Math.min(Math.abs(balanceAfter), creditLimit))
        : 0;
    const creditDrawn = safeRound(Math.max(0, creditUsedAfter - creditUsedBefore));

    // Atomic update
    await User.findByIdAndUpdate(userId, {
        $set: {
            walletBalance: balanceAfter,
            creditUsed: creditUsedAfter,
        },
    });

    // Create the wallet transaction record
    const transaction = await WalletTransaction.create({
        userId,
        type: TRANSACTION_TYPES.DEBIT,
        semanticType: LEDGER_TRANSACTION_TYPES.ADMIN_ADJUSTMENT,
        sourceType: TRANSACTION_SOURCE_TYPES.ADMIN_ADJUSTMENT,
        direction: TRANSACTION_DIRECTIONS.DEBIT,
        amount: parsedAmount,
        balanceBefore,
        balanceAfter,
        reference: null,
        currency: userCurrency,
        status: 'COMPLETED',
        description: normalizedReason,
        reason: normalizedReason,
        note: normalizedReason,
        metadata: {
            operation: 'DEDUCT',
            reason: normalizedReason,
            note: normalizedReason,
            creditDrawn,
            creditUsedBefore,
            creditUsedAfter,
        },
        actorId: actor.actorId,
        actorRole: actor.actorRole,
    });

    // Audit (fire-and-forget)
    createAuditLog({
        actorId: actor.actorId,
        actorRole: actor.actorRole,
        action: ADMIN_ACTIONS.WALLET_ADJUSTED,
        entityType: ENTITY_TYPES.WALLET,
        entityId: userId,
        metadata: {
            type: 'DEDUCT',
            amount: parsedAmount,
            currency: userCurrency,
            reason: normalizedReason,
            userId,
            balanceBefore,
            balanceAfter,
            creditDrawn,
            creditUsedBefore,
            creditUsedAfter,
            transactionId: transaction._id,
        },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
    });

    notifyManualWalletAdjustment({
        userId,
        operation: 'DEDUCT',
        amount: parsedAmount,
        currency: userCurrency,
        transactionId: transaction._id,
        balanceBefore,
        balanceAfter,
        actorRole: actor.actorRole,
    });

    const updatedUser = await User.findById(userId)
        .select('name email walletBalance creditLimit creditUsed currency status role');

    return { transaction, user: updatedUser };
};

// ─── Admin Force Set Balance ──────────────────────────────────────────────────

/**
 * Admin: forcefully set a user's wallet balance to an exact value.
 *
 * This bypasses credit limit checks — it is an admin override.
 * The amount parameter IS the desired new balance (can be negative).
 * Credit usage is recalculated based on the new balance.
 */
const setBalance = async (userId, targetBalance, reason, actorContext) => {
    const actor = normalizeActorContext(actorContext);
    const newBalance = safeRound(Number(targetBalance));

    if (!Number.isFinite(newBalance)) {
        throw new BusinessRuleError('Target balance must be a valid number.', 'INVALID_AMOUNT');
    }

    if (Math.abs(newBalance) > MAX_ADJUSTMENT * 10) {
        throw new BusinessRuleError(
            `Target balance magnitude exceeds maximum (${MAX_ADJUSTMENT * 10}).`,
            'INVALID_ADJUSTMENT_AMOUNT'
        );
    }

    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User');
    assertAdminOnlyWalletOperation(actor, 'Setting exact wallet balance');

    const userCurrency = user.currency || 'USD';
    const balanceBefore = safeRound(user.walletBalance || 0);
    const creditLimit = safeRound(Math.abs(Number(user.creditLimit || 0)));

    // Recalculate credit usage based on the new balance
    // If newBalance < 0, creditUsed = min(|newBalance|, creditLimit)
    const creditUsedAfter = newBalance < 0
        ? safeRound(Math.min(Math.abs(newBalance), creditLimit))
        : 0;

    // Atomic update
    await User.findByIdAndUpdate(userId, {
        $set: {
            walletBalance: newBalance,
            creditUsed: creditUsedAfter,
        },
    });

    // Determine transaction type based on direction
    const delta = safeRound(newBalance - balanceBefore);
    const txType = delta >= 0 ? TRANSACTION_TYPES.CREDIT : TRANSACTION_TYPES.DEBIT;
    const txDirection = delta >= 0 ? TRANSACTION_DIRECTIONS.CREDIT : TRANSACTION_DIRECTIONS.DEBIT;

    // Create the wallet transaction record
    const transaction = await WalletTransaction.create({
        userId,
        type: txType,
        semanticType: LEDGER_TRANSACTION_TYPES.ADMIN_ADJUSTMENT,
        sourceType: TRANSACTION_SOURCE_TYPES.ADMIN_ADJUSTMENT,
        direction: txDirection,
        amount: safeRound(Math.abs(delta)),
        balanceBefore,
        balanceAfter: newBalance,
        reference: null,
        currency: userCurrency,
        status: 'COMPLETED',
        description: reason || `Admin set balance to ${newBalance} (${userCurrency})`,
        metadata: {
            operation: 'SET',
            reason,
            targetBalance: newBalance,
            delta,
            creditUsedAfter,
        },
        actorId: actor.actorId,
        actorRole: actor.actorRole,
    });

    // Audit (fire-and-forget)
    createAuditLog({
        actorId: actor.actorId,
        actorRole: actor.actorRole,
        action: ADMIN_ACTIONS.WALLET_ADJUSTED,
        entityType: ENTITY_TYPES.WALLET,
        entityId: userId,
        metadata: {
            type: 'SET',
            targetBalance: newBalance,
            delta,
            currency: userCurrency,
            reason,
            userId,
            balanceBefore,
            balanceAfter: newBalance,
            creditUsedAfter,
            transactionId: transaction._id,
        },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
    });

    notifyManualWalletAdjustment({
        userId,
        operation: 'SET',
        amount: newBalance,
        currency: userCurrency,
        transactionId: transaction._id,
        balanceBefore,
        balanceAfter: newBalance,
        actorRole: actor.actorRole,
    });

    return { transaction, user: { walletBalance: newBalance, creditUsed: creditUsedAfter } };
};

// ─── Bulk Debt Adjustment (Currency Devaluation) ─────────────────────────────

/**
 * Adjust all negative wallet balances by a percentage increase to account
 * for currency devaluation (debt pegging).
 *
 * For each user with walletBalance < 0:
 *   adjustment = |walletBalance| × (percentageIncrease / 100)
 *   newBalance = walletBalance - adjustment  (more negative)
 *
 * A DEBT_ADJUSTMENT transaction is created for each affected user
 * with a clear description so the user understands the deduction.
 *
 * @param {number} percentageIncrease - e.g. 5 for a 5% devaluation
 * @param {string|ObjectId} adminId       - the admin who triggered this action
 * @param {string}          [currencyCode] - ISO 4217 code to filter users by (e.g. 'EGP')
 * @returns {{ usersAdjusted, totalAdjustment, totalUsersInDebt, errors }}
 */
const adjustNegativeBalancesForInflation = async (percentageIncrease, actorContext, currencyCode = null) => {
    const actor = normalizeActorContext(actorContext);
    assertAdminOnlyWalletOperation(actor, 'Debt adjustment');

    if (percentageIncrease <= 0 || percentageIncrease > 100) {
        throw new BusinessRuleError(
            'Percentage must be between 0.01 and 100.',
            'INVALID_PERCENTAGE'
        );
    }

    const multiplier = percentageIncrease / 100;

    // Build query — filter by currency if provided
    const query = { walletBalance: { $lt: 0 }, deletedAt: null };
    if (currencyCode) {
        query.currency = currencyCode.toUpperCase();
    }

    const usersInDebt = await User.find(query).select('_id walletBalance creditLimit creditUsed currency');

    if (usersInDebt.length === 0) {
        return { usersAdjusted: 0, totalAdjustment: 0, totalUsersInDebt: 0, errors: [] };
    }

    let usersAdjusted = 0;
    let totalAdjustment = 0;
    const errors = [];

    for (const user of usersInDebt) {
        try {
            const balanceBefore = safeRound(user.walletBalance);
            const adjustment = safeRound(Math.abs(balanceBefore) * multiplier);

            // Skip negligible adjustments (less than 0.01)
            if (adjustment < 0.01) continue;

            const balanceAfter = safeRound(balanceBefore - adjustment);
            const creditLimit = safeRound(Math.abs(Number(user.creditLimit || 0)));
            const creditUsedBefore = safeRound(user.creditUsed || 0);

            // Recalculate credit usage: if balance goes deeper negative,
            // creditUsed increases by the adjustment (capped at creditLimit)
            const creditUsedAfter = balanceAfter < 0
                ? safeRound(Math.min(Math.abs(balanceAfter), creditLimit))
                : 0;

            // Atomic balance update
            await User.findByIdAndUpdate(user._id, {
                $set: {
                    walletBalance: balanceAfter,
                    creditUsed: creditUsedAfter,
                },
            });

            // Create auditable wallet transaction
            await WalletTransaction.create({
                userId: user._id,
                type: TRANSACTION_TYPES.DEBT_ADJUSTMENT,
                semanticType: LEDGER_TRANSACTION_TYPES.DEBT_ADJUSTMENT,
                sourceType: TRANSACTION_SOURCE_TYPES.DEBT_ADJUSTMENT,
                direction: TRANSACTION_DIRECTIONS.DEBIT,
                amount: adjustment,
                balanceBefore,
                balanceAfter,
                reference: null,
                currency: user.currency || currencyCode || 'USD',
                status: 'COMPLETED',
                description: `Debt adjustment due to ${currencyCode || 'currency'} rate increase (${percentageIncrease}%)`,
                metadata: {
                    operation: 'INFLATION',
                    percentageIncrease,
                    currencyCode,
                    creditUsedBefore,
                    creditUsedAfter,
                },
                actorId: actor.actorId,
                actorRole: actor.actorRole,
            });


            usersAdjusted++;
            totalAdjustment = safeRound(totalAdjustment + adjustment);
        } catch (err) {
            errors.push({ userId: user._id.toString(), error: err.message });
        }
    }

    // Single audit log for the bulk operation
    createAuditLog({
        actorId: actor.actorId,
        actorRole: actor.actorRole,
        action: ADMIN_ACTIONS.DEBT_ADJUSTED,
        entityType: ENTITY_TYPES.WALLET,
        entityId: null,
        metadata: {
            type: 'BULK_DEBT_ADJUSTMENT',
            percentageIncrease,
            usersAdjusted,
            totalAdjustment,
            totalUsersInDebt: usersInDebt.length,
            errors: errors.length > 0 ? errors : undefined,
        },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
    });
    return { usersAdjusted, totalAdjustment, totalUsersInDebt: usersInDebt.length, errors };
};

// ─── Bulk Debt Relief (Currency Appreciation) ────────────────────────────────

/**
 * Adjust all negative wallet balances by a percentage decrease to account
 * for currency appreciation (debt relief).
 *
 * For each user with walletBalance < 0:
 *   adjustment = |walletBalance| × (percentageDecrease / 100)
 *   newBalance = walletBalance + adjustment  (less negative)
 *
 * A DEBT_ADJUSTMENT transaction is created for each affected user
 * with a clear description so the user understands the credit.
 *
 * @param {number} percentageDecrease - e.g. 5 for a 5% appreciation
 * @param {string|ObjectId} adminId   - the admin who triggered this action
 * @param {string}          [currencyCode] - ISO 4217 code to filter users by
 * @returns {{ usersAdjusted, totalAdjustment, totalUsersInDebt, errors }}
 */
const adjustNegativeBalancesForDeflation = async (percentageDecrease, actorContext, currencyCode = null) => {
    const actor = normalizeActorContext(actorContext);
    assertAdminOnlyWalletOperation(actor, 'Debt adjustment');

    if (percentageDecrease <= 0 || percentageDecrease > 100) {
        throw new BusinessRuleError(
            'Percentage must be between 0.01 and 100.',
            'INVALID_PERCENTAGE'
        );
    }

    const multiplier = percentageDecrease / 100;

    // Build query — filter by currency if provided
    const query = { walletBalance: { $lt: 0 }, deletedAt: null };
    if (currencyCode) {
        query.currency = currencyCode.toUpperCase();
    }

    const usersInDebt = await User.find(query).select('_id walletBalance creditLimit creditUsed currency');

    if (usersInDebt.length === 0) {
        return { usersAdjusted: 0, totalAdjustment: 0, totalUsersInDebt: 0, errors: [] };
    }

    let usersAdjusted = 0;
    let totalAdjustment = 0;
    const errors = [];

    for (const user of usersInDebt) {
        try {
            const balanceBefore = safeRound(user.walletBalance);
            const adjustment = safeRound(Math.abs(balanceBefore) * multiplier);

            // Skip negligible adjustments (less than 0.01)
            if (adjustment < 0.01) continue;

            // ADD the adjustment (debt relief — balance moves toward 0)
            const balanceAfter = safeRound(balanceBefore + adjustment);
            const creditLimit = safeRound(Math.abs(Number(user.creditLimit || 0)));

            // Recalculate credit usage
            const creditUsedAfter = balanceAfter < 0
                ? safeRound(Math.min(Math.abs(balanceAfter), creditLimit))
                : 0;

            // Atomic balance update
            await User.findByIdAndUpdate(user._id, {
                $set: {
                    walletBalance: balanceAfter,
                    creditUsed: creditUsedAfter,
                },
            });

            // Create auditable wallet transaction
            await WalletTransaction.create({
                userId: user._id,
                type: TRANSACTION_TYPES.DEBT_ADJUSTMENT,
                semanticType: LEDGER_TRANSACTION_TYPES.DEBT_ADJUSTMENT,
                sourceType: TRANSACTION_SOURCE_TYPES.DEBT_ADJUSTMENT,
                direction: TRANSACTION_DIRECTIONS.CREDIT,
                amount: adjustment,
                balanceBefore,
                balanceAfter,
                reference: null,
                currency: user.currency || currencyCode || 'USD',
                status: 'COMPLETED',
                description: `Debt relief due to ${currencyCode || 'currency'} rate decrease (${percentageDecrease}%)`,
                metadata: {
                    operation: 'DEFLATION',
                    percentageDecrease,
                    currencyCode,
                    creditUsedAfter,
                },
                actorId: actor.actorId,
                actorRole: actor.actorRole,
            });

            usersAdjusted++;
            totalAdjustment = safeRound(totalAdjustment + adjustment);
        } catch (err) {
            errors.push({ userId: user._id.toString(), error: err.message });
        }
    }

    // Single audit log for the bulk operation
    createAuditLog({
        actorId: actor.actorId,
        actorRole: actor.actorRole,
        action: ADMIN_ACTIONS.DEBT_ADJUSTED,
        entityType: ENTITY_TYPES.WALLET,
        entityId: null,
        metadata: {
            type: 'BULK_DEBT_DEFLATION',
            percentageDecrease,
            usersAdjusted,
            totalAdjustment,
            totalUsersInDebt: usersInDebt.length,
            errors: errors.length > 0 ? errors : undefined,
        },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
    });

    return { usersAdjusted, totalAdjustment, totalUsersInDebt: usersInDebt.length, errors };
};

module.exports = {
    listWallets,
    getWallet,
    getTransactionHistory,
    listAdminAdjustments,
    addFunds,
    deductFunds,
    setBalance,
    adjustNegativeBalancesForInflation,
    adjustNegativeBalancesForDeflation,
};
