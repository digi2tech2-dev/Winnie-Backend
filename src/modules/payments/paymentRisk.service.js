'use strict';

const { Payment } = require('./payment.model');
const { PAYMENT_PURPOSES } = require('./payment.constants');
const { Setting } = require('../admin/setting.model');
const { createAuditLog } = require('../audit/audit.service');
const {
    ACTOR_ROLES,
    ENTITY_TYPES,
    PAYMENT_ACTIONS,
} = require('../audit/audit.constants');
const { convertUserCurrencyToUsd } = require('../../services/currencyConverter.service');
const { BusinessRuleError } = require('../../shared/errors/AppError');
const {
    PAYMENT_RISK_BASE_CURRENCY,
    PAYMENT_RISK_LIMITS_SETTING_KEY,
    normalizePaymentRiskLimits,
} = require('./paymentRisk.config');

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

const roundMoney = (value, decimals = 2) => {
    const factor = Math.pow(10, decimals);
    return Math.round(Number(value) * factor) / factor;
};

class PaymentRiskLimitError extends BusinessRuleError {
    constructor(message, reason) {
        super(message, 'PAYMENT_RISK_LIMIT_REACHED');
        this.details = { reason };
    }
}

const getPaymentRiskLimits = async () => {
    const setting = await Setting.findOne({ key: PAYMENT_RISK_LIMITS_SETTING_KEY }).lean();
    return normalizePaymentRiskLimits(setting?.value, { allowMissing: true });
};

const amountToBaseCurrency = async (amount, currency) => {
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
        throw new BusinessRuleError('Payment risk amount must be a non-negative number.', 'INVALID_PAYMENT_AMOUNT');
    }

    const conversion = await convertUserCurrencyToUsd(parsedAmount, currency);
    return roundMoney(conversion.usdAmount, 6);
};

const paymentAmountToBaseCurrency = async (payment) => {
    const snapshot = payment?.metadata?.risk;
    if (
        snapshot?.baseCurrency === PAYMENT_RISK_BASE_CURRENCY &&
        Number.isFinite(Number(snapshot.amountBaseCurrency))
    ) {
        return roundMoney(Number(snapshot.amountBaseCurrency), 6);
    }

    return amountToBaseCurrency(payment.amount, payment.currency);
};

const isExceeded = (value, limit) => Number(value) > Number(limit);

const buildBlock = ({
    amountBaseCurrency,
    baseCurrency,
    customerMessage,
    matchedLimit,
    reason,
    stats,
    action,
}) => ({
    allowed: false,
    action,
    amountBaseCurrency,
    baseCurrency,
    customerMessage,
    matchedLimit,
    reason,
    stats,
});

const evaluatePaymentRisk = async ({
    user,
    amount,
    currency,
    gateway = null,
    now = new Date(),
} = {}) => {
    const settings = await getPaymentRiskLimits();
    const normalizedNow = now instanceof Date ? now : new Date(now);
    const baseCurrency = PAYMENT_RISK_BASE_CURRENCY;
    const amountBaseCurrency = await amountToBaseCurrency(amount, currency);

    const allowedResult = {
        allowed: true,
        amountBaseCurrency,
        baseCurrency,
        settings,
    };

    if (!settings.enabled) {
        return allowedResult;
    }

    const common = {
        amountBaseCurrency,
        baseCurrency,
        customerMessage: settings.customerMessage,
        action: settings.action,
    };

    if (isExceeded(amountBaseCurrency, settings.maxSingleAmount)) {
        return buildBlock({
            ...common,
            reason: 'MAX_SINGLE_AMOUNT',
            matchedLimit: settings.maxSingleAmount,
            stats: { requestedAmount: amountBaseCurrency },
        });
    }

    const createdAt = user?.createdAt ? new Date(user.createdAt) : null;
    const accountAgeHours = createdAt
        ? (normalizedNow.getTime() - createdAt.getTime()) / ONE_HOUR_MS
        : Number.POSITIVE_INFINITY;
    const isNewAccount = accountAgeHours < settings.newAccountHours;

    if (isNewAccount && isExceeded(amountBaseCurrency, settings.newAccountSingleAmount)) {
        return buildBlock({
            ...common,
            reason: 'NEW_ACCOUNT_SINGLE_AMOUNT',
            matchedLimit: settings.newAccountSingleAmount,
            stats: { accountAgeHours: roundMoney(accountAgeHours, 4), requestedAmount: amountBaseCurrency },
        });
    }

    const hourlyWindowStart = new Date(normalizedNow.getTime() - ONE_HOUR_MS);
    const dailyWindowStart = new Date(normalizedNow.getTime() - ONE_DAY_MS);

    const recentPayments = await Payment.find({
        userId: user._id,
        purpose: PAYMENT_PURPOSES.WALLET_TOPUP,
        createdAt: { $gte: dailyWindowStart },
    })
        .select('amount currency metadata createdAt')
        .lean();

    const paymentAmounts = await Promise.all(
        recentPayments.map(async (payment) => ({
            amountBaseCurrency: await paymentAmountToBaseCurrency(payment),
            createdAt: new Date(payment.createdAt),
        }))
    );

    const hourlyPayments = paymentAmounts.filter((payment) => payment.createdAt >= hourlyWindowStart);
    const hourlyAmount = roundMoney(
        hourlyPayments.reduce((sum, payment) => sum + payment.amountBaseCurrency, 0) + amountBaseCurrency,
        6
    );
    const dailyAmount = roundMoney(
        paymentAmounts.reduce((sum, payment) => sum + payment.amountBaseCurrency, 0) + amountBaseCurrency,
        6
    );
    const hourlyAttempts = hourlyPayments.length + 1;
    const dailyAttempts = paymentAmounts.length + 1;

    if (isExceeded(hourlyAmount, settings.hourlyAmountLimit)) {
        return buildBlock({
            ...common,
            reason: 'HOURLY_AMOUNT_LIMIT',
            matchedLimit: settings.hourlyAmountLimit,
            stats: { hourlyAmount },
        });
    }

    if (isExceeded(dailyAmount, settings.dailyAmountLimit)) {
        return buildBlock({
            ...common,
            reason: 'DAILY_AMOUNT_LIMIT',
            matchedLimit: settings.dailyAmountLimit,
            stats: { dailyAmount },
        });
    }

    if (isNewAccount && isExceeded(dailyAmount, settings.newAccountDailyAmount)) {
        return buildBlock({
            ...common,
            reason: 'NEW_ACCOUNT_DAILY_AMOUNT',
            matchedLimit: settings.newAccountDailyAmount,
            stats: { accountAgeHours: roundMoney(accountAgeHours, 4), dailyAmount },
        });
    }

    if (isExceeded(hourlyAttempts, settings.hourlyAttemptLimit)) {
        return buildBlock({
            ...common,
            reason: 'HOURLY_ATTEMPT_LIMIT',
            matchedLimit: settings.hourlyAttemptLimit,
            stats: { hourlyAttempts },
        });
    }

    if (isExceeded(dailyAttempts, settings.dailyAttemptLimit)) {
        return buildBlock({
            ...common,
            reason: 'DAILY_ATTEMPT_LIMIT',
            matchedLimit: settings.dailyAttemptLimit,
            stats: { dailyAttempts },
        });
    }

    return {
        ...allowedResult,
        gateway,
        settings,
    };
};

const logPaymentRiskBlock = ({
    userId,
    amount,
    currency,
    gateway,
    riskResult,
    requestMeta = {},
} = {}) => {
    void createAuditLog({
        actorId: userId,
        actorRole: ACTOR_ROLES.CUSTOMER,
        action: PAYMENT_ACTIONS.RISK_BLOCKED,
        entityType: ENTITY_TYPES.PAYMENT,
        entityId: null,
        metadata: {
            userId: userId?.toString?.() || userId,
            amount,
            currency,
            gateway,
            amountBaseCurrency: riskResult?.amountBaseCurrency,
            baseCurrency: riskResult?.baseCurrency,
            reasonCode: riskResult?.reason,
            matchedLimit: riskResult?.matchedLimit,
            action: riskResult?.action,
        },
        ipAddress: requestMeta.ipAddress || null,
        userAgent: requestMeta.userAgent || null,
    });
};

module.exports = {
    PaymentRiskLimitError,
    amountToBaseCurrency,
    evaluatePaymentRisk,
    getPaymentRiskLimits,
    logPaymentRiskBlock,
};
