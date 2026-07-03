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

/**
 * Safe rounding via integer math — kills IEEE-754 dust like 5.684e-14.
 * Number.toFixed(2) still leaks because it returns a string that Number()
 * re-parses, preserving intermediate float imprecision.
 */
const safeRound = (value, decimals = 2) => {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
};

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
        description: reason || `Admin manual credit (${userCurrency})`,
        metadata: {
            operation: 'ADD',
            reason,
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
            reason,
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
        description: reason || `Admin manual debit (${userCurrency})`,
        metadata: {
            operation: 'DEDUCT',
            reason,
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
            reason,
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
    addFunds,
    deductFunds,
    setBalance,
    adjustNegativeBalancesForInflation,
    adjustNegativeBalancesForDeflation,
};
