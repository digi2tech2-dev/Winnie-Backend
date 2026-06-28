'use strict';

const mongoose = require('mongoose');
const { Payment } = require('./payment.model');
const {
    PAYMENT_PURPOSES,
    PAYMENT_GATEWAYS,
    PAYMENT_METHODS,
    PAYMENT_STATUSES,
    ACTIVE_PAYMENT_STATUSES,
    isAllowedPaymentTransition,
} = require('./payment.constants');
const { getPaymentGateway, normalizeGatewayKey } = require('./gateways/gateway.factory');
const { Currency } = require('../currency/currency.model');
const { User, ROLES } = require('../users/user.model');
const { creditWalletDirect } = require('../wallet/wallet.service');
const { processWalletCreditSafely } = require('../referrals/referral.service');
const {
    LEDGER_TRANSACTION_TYPES,
    TRANSACTION_SOURCE_TYPES,
} = require('../wallet/walletTransaction.model');
const { createAuditLog } = require('../audit/audit.service');
const {
    PAYMENT_ACTIONS,
    WALLET_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
} = require('../audit/audit.constants');
const { notifyPaymentSucceeded } = require('../notifications/notification.events');
const config = require('../../config/config');
const {
    AuthorizationError,
    BusinessRuleError,
    ConflictError,
    NotFoundError,
} = require('../../shared/errors/AppError');

const safeRound = (value, decimals = 2) => {
    const factor = Math.pow(10, decimals);
    return Math.round(Number(value) * factor) / factor;
};

const getRuntimePaymentConfig = () => {
    const allowedGateways = (process.env.PAYMENT_ALLOWED_GATEWAYS || config.payments.allowedGateways.join(','))
        .split(',')
        .map((gateway) => gateway.trim().toUpperCase())
        .filter(Boolean);

    return {
        enabled: process.env.PAYMENTS_ENABLED !== undefined
            ? process.env.PAYMENTS_ENABLED !== 'false'
            : config.payments.enabled,
        defaultGateway: (process.env.PAYMENT_DEFAULT_GATEWAY || config.payments.defaultGateway).toUpperCase(),
        allowedGateways,
        minAmount: parseFloat(process.env.PAYMENT_MIN_AMOUNT || config.payments.minAmount || '1'),
        maxAmount: parseFloat(process.env.PAYMENT_MAX_AMOUNT || config.payments.maxAmount || '10000'),
        env: process.env.NODE_ENV || config.env,
    };
};

const normalizeCurrency = (currency) => String(currency || 'USD').trim().toUpperCase();

const normalizeIdempotencyKey = (key) => {
    const normalized = String(key || '').trim();
    return normalized ? normalized.slice(0, 160) : undefined;
};

const assertPaymentsEnabled = () => {
    if (!getRuntimePaymentConfig().enabled) {
        throw new BusinessRuleError('Payments are currently disabled.', 'PAYMENTS_DISABLED');
    }
};

const assertNonProductionMockFlow = () => {
    if (getRuntimePaymentConfig().env === 'production') {
        throw new BusinessRuleError(
            'Mock payment confirmation is disabled in production.',
            'MOCK_PAYMENTS_DISABLED_IN_PRODUCTION'
        );
    }
};

const assertGatewayAllowed = (gateway) => {
    const runtimeConfig = getRuntimePaymentConfig();
    if (!runtimeConfig.allowedGateways.includes(gateway)) {
        throw new BusinessRuleError(
            `Payment gateway '${gateway}' is not enabled for this environment.`,
            'PAYMENT_GATEWAY_NOT_ALLOWED'
        );
    }
};

const assertAmountAllowed = (amount) => {
    const runtimeConfig = getRuntimePaymentConfig();
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new BusinessRuleError('Payment amount must be greater than zero.', 'INVALID_PAYMENT_AMOUNT');
    }
    if (amount < runtimeConfig.minAmount) {
        throw new BusinessRuleError(
            `Payment amount must be at least ${runtimeConfig.minAmount}.`,
            'PAYMENT_AMOUNT_TOO_LOW'
        );
    }
    if (amount > runtimeConfig.maxAmount) {
        throw new BusinessRuleError(
            `Payment amount cannot exceed ${runtimeConfig.maxAmount}.`,
            'PAYMENT_AMOUNT_TOO_HIGH'
        );
    }
};

const assertCurrencySupported = async (currency) => {
    const currencyCount = await Currency.countDocuments();
    if (currencyCount === 0 && currency === 'USD') return;

    const activeCurrency = await Currency.findOne({ code: currency, isActive: true }).select('_id');
    if (!activeCurrency) {
        throw new BusinessRuleError(
            `Currency '${currency}' is not supported for online payments.`,
            'PAYMENT_CURRENCY_NOT_SUPPORTED'
        );
    }
};

const assertWalletCurrencyMatch = (user, currency) => {
    const walletCurrency = normalizeCurrency(user.currency || 'USD');
    if (currency !== walletCurrency) {
        throw new BusinessRuleError(
            `Payment currency '${currency}' must match wallet currency '${walletCurrency}' in Phase 2.2.`,
            'PAYMENT_CURRENCY_MISMATCH'
        );
    }
};

const assertPaymentOwnerOrAdmin = (payment, actor) => {
    const actorRole = String(actor?.role || actor?.actorRole || '').toUpperCase();
    if (actorRole === ROLES.ADMIN || actorRole === ACTOR_ROLES.ADMIN) return;

    if (String(payment.userId) !== String(actor?.userId || actor?._id || actor?.actorId)) {
        throw new AuthorizationError('You do not have access to this payment.');
    }
};

const buildCheckoutResponse = (payment) => ({
    url: payment.checkoutUrl,
    mode: payment.gateway === PAYMENT_GATEWAYS.MOCK ? 'mock' : 'gateway',
});

const serializePayment = (payment, { admin = false } = {}) => {
    const doc = payment?.toObject ? payment.toObject() : payment;
    if (!doc) return null;

    const response = {
        id: doc._id?.toString?.() || doc.id,
        userId: doc.userId?.toString?.() || doc.userId,
        purpose: doc.purpose,
        gateway: doc.gateway,
        method: doc.method,
        amount: doc.amount,
        feeAmount: doc.feeAmount,
        totalAmount: doc.totalAmount,
        currency: doc.currency,
        status: doc.status,
        gatewayPaymentId: doc.gatewayPaymentId,
        gatewayReference: doc.gatewayReference,
        checkoutUrl: doc.checkoutUrl,
        returnUrl: doc.returnUrl,
        cancelUrl: doc.cancelUrl,
        expiresAt: doc.expiresAt,
        succeededAt: doc.succeededAt,
        failedAt: doc.failedAt,
        canceledAt: doc.canceledAt,
        creditedAt: doc.creditedAt,
        walletTransactionId: doc.walletTransactionId?.toString?.() || doc.walletTransactionId,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };

    if (admin) {
        response.metadata = doc.metadata || {};
        response.createdByIp = doc.createdByIp || null;
        response.userAgent = doc.userAgent || null;
        response.idempotencyKey = doc.idempotencyKey || null;
    }

    return response;
};

const createPaymentIntent = async ({
    userId,
    amount,
    currency,
    gateway,
    returnUrl = null,
    cancelUrl = null,
    idempotencyKey = null,
    requestMeta = {},
} = {}) => {
    assertPaymentsEnabled();

    const normalizedGateway = normalizeGatewayKey(gateway || getRuntimePaymentConfig().defaultGateway);
    assertGatewayAllowed(normalizedGateway);

    const parsedAmount = safeRound(amount);
    assertAmountAllowed(parsedAmount);

    const normalizedCurrency = normalizeCurrency(currency);
    await assertCurrencySupported(normalizedCurrency);

    const user = await User.findById(userId).select('currency status role');
    if (!user) throw new NotFoundError('User');
    assertWalletCurrencyMatch(user, normalizedCurrency);

    const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey);
    if (normalizedIdempotencyKey) {
        const existing = await Payment.findOne({ idempotencyKey: normalizedIdempotencyKey });
        if (existing) {
            if (String(existing.userId) !== String(userId)) {
                throw new ConflictError('This payment idempotency key is already in use.');
            }
            return {
                payment: existing,
                checkout: buildCheckoutResponse(existing),
                idempotent: true,
            };
        }
    }

    const paymentId = new mongoose.Types.ObjectId();
    const feeAmount = 0;
    const totalAmount = safeRound(parsedAmount + feeAmount);

    const gatewayAdapter = getPaymentGateway(normalizedGateway);
    const intent = await gatewayAdapter.createPaymentIntent({
        paymentId,
        userId,
        amount: parsedAmount,
        feeAmount,
        totalAmount,
        currency: normalizedCurrency,
        returnUrl,
        cancelUrl,
    });

    const paymentPayload = {
        _id: paymentId,
        userId,
        purpose: PAYMENT_PURPOSES.WALLET_TOPUP,
        gateway: normalizedGateway,
        method: PAYMENT_METHODS.CARD,
        amount: parsedAmount,
        feeAmount,
        totalAmount,
        currency: normalizedCurrency,
        status: intent.status || PAYMENT_STATUSES.REQUIRES_ACTION,
        gatewayPaymentId: intent.gatewayPaymentId || null,
        gatewayReference: intent.gatewayReference || null,
        checkoutUrl: intent.checkoutUrl || null,
        returnUrl: returnUrl || null,
        cancelUrl: cancelUrl || null,
        expiresAt: intent.expiresAt || null,
        idempotencyKey: normalizedIdempotencyKey,
        metadata: {
            mode: normalizedGateway === PAYMENT_GATEWAYS.MOCK ? 'mock' : 'placeholder',
            gatewayMetadata: intent.metadata || {},
        },
        createdByIp: requestMeta.ipAddress || null,
        userAgent: requestMeta.userAgent || null,
    };

    let payment;
    try {
        payment = await Payment.create(paymentPayload);
    } catch (err) {
        if (err.code === 11000 && normalizedIdempotencyKey) {
            const existing = await Payment.findOne({ idempotencyKey: normalizedIdempotencyKey });
            if (existing && String(existing.userId) === String(userId)) {
                return {
                    payment: existing,
                    checkout: buildCheckoutResponse(existing),
                    idempotent: true,
                };
            }
        }
        throw err;
    }

    void createAuditLog({
        actorId: userId,
        actorRole: ACTOR_ROLES.CUSTOMER,
        action: PAYMENT_ACTIONS.INTENT_CREATED,
        entityType: ENTITY_TYPES.PAYMENT,
        entityId: payment._id,
        metadata: {
            purpose: payment.purpose,
            gateway: payment.gateway,
            amount: payment.amount,
            totalAmount: payment.totalAmount,
            currency: payment.currency,
            status: payment.status,
        },
        ipAddress: requestMeta.ipAddress || null,
        userAgent: requestMeta.userAgent || null,
    });

    return {
        payment,
        checkout: buildCheckoutResponse(payment),
        idempotent: false,
    };
};

const getPaymentById = async (paymentId, { actor, admin = false } = {}) => {
    const payment = await Payment.findById(paymentId);
    if (!payment) throw new NotFoundError('Payment');

    if (!admin) {
        assertPaymentOwnerOrAdmin(payment, actor);
    }

    return payment;
};

const buildListFilter = ({ userId, status, gateway, from, to } = {}) => {
    const filter = {};
    if (userId) filter.userId = userId;
    if (status) filter.status = String(status).trim().toUpperCase();
    if (gateway) filter.gateway = normalizeGatewayKey(gateway);
    if (from || to) {
        filter.createdAt = {};
        if (from) filter.createdAt.$gte = new Date(from);
        if (to) filter.createdAt.$lte = new Date(to);
    }
    return filter;
};

const listPayments = async ({
    userId = null,
    status,
    gateway,
    from,
    to,
    page = 1,
    limit = 20,
} = {}) => {
    const normalizedLimit = Math.min(parseInt(limit, 10) || 20, 100);
    const normalizedPage = Math.max(parseInt(page, 10) || 1, 1);
    const skip = (normalizedPage - 1) * normalizedLimit;
    const filter = buildListFilter({ userId, status, gateway, from, to });

    const [payments, total] = await Promise.all([
        Payment.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(normalizedLimit),
        Payment.countDocuments(filter),
    ]);

    return {
        payments,
        pagination: {
            page: normalizedPage,
            limit: normalizedLimit,
            total,
            pages: Math.ceil(total / normalizedLimit),
        },
    };
};

const assertMockPaymentCanBeChanged = (payment) => {
    if (payment.gateway !== PAYMENT_GATEWAYS.MOCK) {
        throw new BusinessRuleError(
            'Only MOCK payments can use the development confirmation endpoints.',
            'PAYMENT_GATEWAY_NOT_MOCK'
        );
    }

    if (payment.status === PAYMENT_STATUSES.SUCCEEDED && payment.creditedAt) return;

    if ([PAYMENT_STATUSES.FAILED, PAYMENT_STATUSES.CANCELED, PAYMENT_STATUSES.EXPIRED].includes(payment.status)) {
        throw new BusinessRuleError(
            `Payment cannot be confirmed from status '${payment.status}'.`,
            'INVALID_PAYMENT_STATUS_TRANSITION'
        );
    }

    if (!isAllowedPaymentTransition(payment.status, PAYMENT_STATUSES.SUCCEEDED)) {
        throw new BusinessRuleError(
            `Payment cannot transition from '${payment.status}' to SUCCEEDED.`,
            'INVALID_PAYMENT_STATUS_TRANSITION'
        );
    }
};

const confirmMockPayment = async (paymentId, { actor, requestMeta = {} } = {}) => {
    assertPaymentsEnabled();
    assertNonProductionMockFlow();

    const initialPayment = await Payment.findById(paymentId);
    if (!initialPayment) throw new NotFoundError('Payment');
    assertPaymentOwnerOrAdmin(initialPayment, actor);
    assertMockPaymentCanBeChanged(initialPayment);

    if (initialPayment.walletTransactionId && initialPayment.creditedAt) {
        return { payment: initialPayment, alreadyProcessed: true };
    }

    const gatewayAdapter = getPaymentGateway(initialPayment.gateway);
    await gatewayAdapter.confirmMockPayment(initialPayment);

    const session = await mongoose.startSession();
    let creditedPayment;
    let transaction;

    try {
        session.startTransaction();

        const now = new Date();
        const payment = await Payment.findOneAndUpdate(
            {
                _id: initialPayment._id,
                gateway: PAYMENT_GATEWAYS.MOCK,
                status: { $in: [...ACTIVE_PAYMENT_STATUSES, PAYMENT_STATUSES.SUCCEEDED] },
                creditedAt: null,
                walletTransactionId: null,
            },
            {
                $set: {
                    status: PAYMENT_STATUSES.SUCCEEDED,
                    succeededAt: initialPayment.succeededAt || now,
                },
            },
            { new: true, session }
        );

        if (!payment) {
            const current = await Payment.findById(initialPayment._id).session(session);
            if (current?.walletTransactionId && current?.creditedAt) {
                await session.commitTransaction();
                return { payment: current, alreadyProcessed: true };
            }
            throw new BusinessRuleError(
                'Payment is not in a creditable state.',
                'PAYMENT_NOT_CREDITABLE'
            );
        }

        const creditResult = await creditWalletDirect({
            userId: payment.userId,
            amount: payment.amount,
            reference: null,
            semanticType: LEDGER_TRANSACTION_TYPES.CARD_PAYMENT_SUCCESS,
            sourceType: TRANSACTION_SOURCE_TYPES.PAYMENT,
            sourceId: payment._id,
            currency: payment.currency,
            description: `Card payment wallet top-up #${payment._id.toString().slice(-6)}`,
            metadata: {
                paymentId: payment._id.toString(),
                gateway: payment.gateway,
                gatewayPaymentId: payment.gatewayPaymentId,
                purpose: payment.purpose,
            },
            idempotencyKey: `payment:${payment._id.toString()}:wallet-credit`,
            actorId: actor?.actorId || actor?._id || actor?.userId || payment.userId,
            actorRole: actor?.actorRole || actor?.role || ACTOR_ROLES.CUSTOMER,
            session,
        });

        transaction = creditResult.transaction;
        payment.walletTransactionId = transaction._id;
        payment.creditedAt = now;
        creditedPayment = await payment.save({ session });

        await session.commitTransaction();
    } catch (err) {
        if (session.inTransaction()) {
            await session.abortTransaction();
        }
        throw err;
    } finally {
        try { session.endSession(); } catch (_) { /* session already ended */ }
    }

    await processWalletCreditSafely(transaction);

    void createAuditLog({
        actorId: actor?.actorId || actor?._id || actor?.userId || creditedPayment.userId,
        actorRole: actor?.actorRole || actor?.role || ACTOR_ROLES.CUSTOMER,
        action: PAYMENT_ACTIONS.SUCCEEDED,
        entityType: ENTITY_TYPES.PAYMENT,
        entityId: creditedPayment._id,
        metadata: {
            gateway: creditedPayment.gateway,
            amount: creditedPayment.amount,
            currency: creditedPayment.currency,
            walletTransactionId: creditedPayment.walletTransactionId,
        },
        ipAddress: requestMeta.ipAddress || null,
        userAgent: requestMeta.userAgent || null,
    });

    void createAuditLog({
        actorId: creditedPayment.userId,
        actorRole: ACTOR_ROLES.CUSTOMER,
        action: WALLET_ACTIONS.CREDIT,
        entityType: ENTITY_TYPES.WALLET,
        entityId: creditedPayment.userId,
        metadata: {
            paymentId: creditedPayment._id,
            gateway: creditedPayment.gateway,
            amount: creditedPayment.amount,
            currency: creditedPayment.currency,
            walletTransactionId: creditedPayment.walletTransactionId,
            reason: LEDGER_TRANSACTION_TYPES.CARD_PAYMENT_SUCCESS,
        },
        ipAddress: requestMeta.ipAddress || null,
        userAgent: requestMeta.userAgent || null,
    });

    notifyPaymentSucceeded(creditedPayment, { transactionId: transaction?._id });

    return { payment: creditedPayment, transaction, alreadyProcessed: false };
};

const failMockPayment = async (paymentId, { actor, requestMeta = {} } = {}) => {
    assertPaymentsEnabled();
    assertNonProductionMockFlow();

    const initialPayment = await Payment.findById(paymentId);
    if (!initialPayment) throw new NotFoundError('Payment');
    assertPaymentOwnerOrAdmin(initialPayment, actor);

    if (initialPayment.gateway !== PAYMENT_GATEWAYS.MOCK) {
        throw new BusinessRuleError(
            'Only MOCK payments can use the development failure endpoint.',
            'PAYMENT_GATEWAY_NOT_MOCK'
        );
    }

    if (initialPayment.walletTransactionId || initialPayment.creditedAt || initialPayment.status === PAYMENT_STATUSES.SUCCEEDED) {
        throw new BusinessRuleError('A succeeded payment cannot be failed.', 'PAYMENT_ALREADY_SUCCEEDED');
    }

    if (initialPayment.status === PAYMENT_STATUSES.FAILED) {
        return { payment: initialPayment, alreadyProcessed: true };
    }

    if (!isAllowedPaymentTransition(initialPayment.status, PAYMENT_STATUSES.FAILED)) {
        throw new BusinessRuleError(
            `Payment cannot transition from '${initialPayment.status}' to FAILED.`,
            'INVALID_PAYMENT_STATUS_TRANSITION'
        );
    }

    const gatewayAdapter = getPaymentGateway(initialPayment.gateway);
    await gatewayAdapter.failMockPayment(initialPayment);

    const payment = await Payment.findOneAndUpdate(
        {
            _id: initialPayment._id,
            status: { $in: ACTIVE_PAYMENT_STATUSES },
            walletTransactionId: null,
            creditedAt: null,
        },
        {
            $set: {
                status: PAYMENT_STATUSES.FAILED,
                failedAt: new Date(),
            },
        },
        { new: true }
    );

    if (!payment) {
        const current = await Payment.findById(initialPayment._id);
        if (current?.status === PAYMENT_STATUSES.FAILED) {
            return { payment: current, alreadyProcessed: true };
        }
        throw new BusinessRuleError('Payment is not fail-able.', 'PAYMENT_NOT_FAILABLE');
    }

    void createAuditLog({
        actorId: actor?.actorId || actor?._id || actor?.userId || payment.userId,
        actorRole: actor?.actorRole || actor?.role || ACTOR_ROLES.CUSTOMER,
        action: PAYMENT_ACTIONS.FAILED,
        entityType: ENTITY_TYPES.PAYMENT,
        entityId: payment._id,
        metadata: {
            gateway: payment.gateway,
            amount: payment.amount,
            currency: payment.currency,
            reason: 'MOCK_PAYMENT_FAILED',
        },
        ipAddress: requestMeta.ipAddress || null,
        userAgent: requestMeta.userAgent || null,
    });

    return { payment, alreadyProcessed: false };
};

module.exports = {
    createPaymentIntent,
    getPaymentById,
    listPayments,
    confirmMockPayment,
    failMockPayment,
    serializePayment,
};
