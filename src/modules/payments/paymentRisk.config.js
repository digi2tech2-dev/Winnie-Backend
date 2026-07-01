'use strict';

const Joi = require('joi');
const { BusinessRuleError } = require('../../shared/errors/AppError');

const PAYMENT_RISK_LIMITS_SETTING_KEY = 'paymentRiskLimits';
const PAYMENT_RISK_BASE_CURRENCY = 'USD';

const PAYMENT_RISK_ACTIONS = Object.freeze({
    BLOCK_ONLINE_PAYMENT: 'BLOCK_ONLINE_PAYMENT',
});

const DEFAULT_PAYMENT_RISK_LIMITS = Object.freeze({
    enabled: true,
    maxSingleAmount: 1000,
    hourlyAmountLimit: 1000,
    dailyAmountLimit: 1500,
    hourlyAttemptLimit: 3,
    dailyAttemptLimit: 5,
    newAccountHours: 24,
    newAccountSingleAmount: 100,
    newAccountDailyAmount: 200,
    action: PAYMENT_RISK_ACTIONS.BLOCK_ONLINE_PAYMENT,
    customerMessage: 'Your online top-up limit has been reached. Please use manual deposit or contact support.',
});

const numberLimit = Joi.number().min(0).required();

const paymentRiskLimitsSchema = Joi.object({
    enabled: Joi.boolean().required(),
    maxSingleAmount: numberLimit,
    hourlyAmountLimit: numberLimit,
    dailyAmountLimit: numberLimit,
    hourlyAttemptLimit: Joi.number().integer().min(0).required(),
    dailyAttemptLimit: Joi.number().integer().min(0).required(),
    newAccountHours: Joi.number().min(0).required(),
    newAccountSingleAmount: numberLimit,
    newAccountDailyAmount: numberLimit,
    action: Joi.string().valid(PAYMENT_RISK_ACTIONS.BLOCK_ONLINE_PAYMENT).required(),
    customerMessage: Joi.string().trim().min(1).max(300).required(),
}).required();

const isPlainObject = (value) => (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
);

const cleanCustomerMessage = (message) => {
    const cleaned = String(message || '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return cleaned || DEFAULT_PAYMENT_RISK_LIMITS.customerMessage;
};

const getDefaultPaymentRiskLimits = () => ({ ...DEFAULT_PAYMENT_RISK_LIMITS });

const normalizePaymentRiskLimits = (
    value,
    { currentValue = null, allowMissing = true } = {}
) => {
    if ((value === undefined || value === null) && allowMissing) {
        return getDefaultPaymentRiskLimits();
    }

    if (!isPlainObject(value)) {
        throw new BusinessRuleError(
            'paymentRiskLimits value must be an object.',
            'INVALID_PAYMENT_RISK_LIMITS'
        );
    }

    const baseValue = isPlainObject(currentValue) ? currentValue : {};
    const candidate = {
        ...DEFAULT_PAYMENT_RISK_LIMITS,
        ...baseValue,
        ...value,
    };

    candidate.customerMessage = cleanCustomerMessage(candidate.customerMessage);

    const { error, value: normalized } = paymentRiskLimitsSchema.validate(candidate, {
        abortEarly: false,
        convert: true,
    });

    if (error) {
        throw new BusinessRuleError(
            `Invalid paymentRiskLimits setting: ${error.details.map((detail) => detail.message).join('; ')}`,
            'INVALID_PAYMENT_RISK_LIMITS'
        );
    }

    normalized.customerMessage = cleanCustomerMessage(normalized.customerMessage);
    return normalized;
};

module.exports = {
    PAYMENT_RISK_ACTIONS,
    PAYMENT_RISK_BASE_CURRENCY,
    PAYMENT_RISK_LIMITS_SETTING_KEY,
    DEFAULT_PAYMENT_RISK_LIMITS,
    getDefaultPaymentRiskLimits,
    normalizePaymentRiskLimits,
};
