'use strict';

const axios = require('axios');
const Decimal = require('decimal.js');
const PaymentGatewayInterface = require('./gateway.interface');
const { PAYMENT_GATEWAYS, PAYMENT_STATUSES } = require('../payment.constants');
const { BusinessRuleError } = require('../../../shared/errors/AppError');
const config = require('../../../config/config');

const CUSTOMER_UNAVAILABLE_MESSAGE = 'Ziina wallet top-up is temporarily unavailable. Please try again later or use manual deposit.';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_API_BASE_URL = 'https://api-v2.ziina.com/api';
const DEFAULT_MINOR_UNITS = 2;
const MINOR_UNITS_BY_CURRENCY = Object.freeze({
    BHD: 3,
    JOD: 3,
    KWD: 3,
    OMR: 3,
    TND: 3,
    CLP: 0,
    JPY: 0,
    KRW: 0,
});
const DIAGNOSTIC_LOG_ENVS = new Set(['development', 'test']);
const SENSITIVE_RESPONSE_KEYS = new Set([
    'access_token',
    'accesstoken',
    'api_key',
    'apikey',
    'auth',
    'authorization',
    'secret',
    'signature',
    'token',
]);

const trim = (value) => String(value || '').trim();
const normalizeBaseUrl = (value) => trim(value).replace(/\/+$/, '');
const normalizeCurrency = (value, fallback = 'AED') => trim(value || fallback).toUpperCase();
const getRuntimeEnv = () => process.env.NODE_ENV || config.env || 'development';
const shouldLogDiagnostics = () => DIAGNOSTIC_LOG_ENVS.has(getRuntimeEnv());
const shouldLogRawCreateResponse = () => getRuntimeEnv() === 'development';

const boolFromEnv = (value, fallback = false) => {
    if (value === undefined || value === null || value === '') return fallback;
    return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const assertHttpUrl = (url, code, { requireHttpsInProduction = false } = {}) => {
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported protocol');
        if (requireHttpsInProduction && getRuntimeEnv() === 'production' && parsed.protocol !== 'https:') {
            throw new Error('HTTPS required');
        }
    } catch (_) {
        throw new BusinessRuleError(CUSTOMER_UNAVAILABLE_MESSAGE, code);
    }
};

const toMinorUnits = (amount, currency) => {
    const decimals = MINOR_UNITS_BY_CURRENCY[currency] ?? DEFAULT_MINOR_UNITS;
    const value = new Decimal(amount || 0);
    if (!value.isFinite() || value.lte(0)) {
        throw new BusinessRuleError('Payment amount must be greater than zero.', 'INVALID_PAYMENT_AMOUNT');
    }
    return value.times(new Decimal(10).pow(decimals)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
};

const replacePaymentIntentPlaceholder = (url, paymentIntentId) => (
    paymentIntentId ? String(url || '').replace(/\{PAYMENT_INTENT_ID\}/g, encodeURIComponent(paymentIntentId)) : url
);

const getZiinaConfig = () => {
    const ziinaConfig = config.payments.ziina || {};
    const runtimeConfig = {
        enabled: boolFromEnv(process.env.ZIINA_ENABLED, ziinaConfig.enabled),
        apiBaseUrl: normalizeBaseUrl(process.env.ZIINA_API_BASE_URL || ziinaConfig.apiBaseUrl || DEFAULT_API_BASE_URL),
        accessToken: trim(process.env.ZIINA_ACCESS_TOKEN || ziinaConfig.accessToken),
        currency: normalizeCurrency(process.env.ZIINA_CURRENCY || ziinaConfig.currency || 'AED'),
        testMode: boolFromEnv(process.env.ZIINA_TEST_MODE, ziinaConfig.testMode),
        successUrl: trim(process.env.ZIINA_SUCCESS_URL || ziinaConfig.successUrl),
        cancelUrl: trim(process.env.ZIINA_CANCEL_URL || ziinaConfig.cancelUrl),
        failureUrl: trim(process.env.ZIINA_FAILURE_URL || ziinaConfig.failureUrl),
        webhookUrl: trim(process.env.ZIINA_WEBHOOK_URL || ziinaConfig.webhookUrl),
        timeoutMs: parseInt(process.env.ZIINA_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS,
    };

    if (
        !runtimeConfig.enabled ||
        !runtimeConfig.accessToken ||
        !runtimeConfig.apiBaseUrl ||
        !runtimeConfig.currency ||
        !runtimeConfig.successUrl ||
        !runtimeConfig.cancelUrl ||
        !runtimeConfig.failureUrl
    ) {
        throw new BusinessRuleError(CUSTOMER_UNAVAILABLE_MESSAGE, 'ZIINA_CONFIGURATION_ERROR');
    }

    assertHttpUrl(runtimeConfig.apiBaseUrl, 'ZIINA_CONFIGURATION_ERROR');
    assertHttpUrl(runtimeConfig.successUrl, 'ZIINA_CONFIGURATION_ERROR', { requireHttpsInProduction: true });
    assertHttpUrl(runtimeConfig.cancelUrl, 'ZIINA_CONFIGURATION_ERROR', { requireHttpsInProduction: true });
    assertHttpUrl(runtimeConfig.failureUrl, 'ZIINA_CONFIGURATION_ERROR', { requireHttpsInProduction: true });
    if (runtimeConfig.webhookUrl) {
        assertHttpUrl(runtimeConfig.webhookUrl, 'ZIINA_CONFIGURATION_ERROR', { requireHttpsInProduction: true });
    }

    return runtimeConfig;
};

const buildHttpClient = (ziinaConfig) => axios.create({
    baseURL: ziinaConfig.apiBaseUrl,
    timeout: ziinaConfig.timeoutMs,
});

const buildAuthHeaders = (ziinaConfig) => ({
    Authorization: `Bearer ${ziinaConfig.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
});

const sanitizeZiinaValue = (value, knownSecrets = []) => {
    if (Array.isArray(value)) return value.map((item) => sanitizeZiinaValue(item, knownSecrets));
    if (value && typeof value === 'object') {
        return Object.entries(value).reduce((safe, [key, childValue]) => {
            const normalizedKey = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
            safe[key] = SENSITIVE_RESPONSE_KEYS.has(normalizedKey)
                ? '[REDACTED]'
                : sanitizeZiinaValue(childValue, knownSecrets);
            return safe;
        }, {});
    }
    if (typeof value === 'string') {
        return knownSecrets.reduce((safeValue, secret) => safeValue.split(secret).join('[REDACTED]'), value);
    }
    return value;
};

const logOutboundCreate = ({ amountMinor, gatewayAmount, gatewayCurrency, ziinaConfig }) => {
    if (!shouldLogDiagnostics()) return;
    console.warn('[Ziina.createPayment.outbound]', {
        amountMinor,
        gatewayAmount,
        gatewayCurrency,
        hasAccessToken: Boolean(ziinaConfig.accessToken),
        baseUrl: ziinaConfig.apiBaseUrl,
        successUrlIsHttps: ziinaConfig.successUrl.startsWith('https://'),
        cancelUrlIsHttps: ziinaConfig.cancelUrl.startsWith('https://'),
        failureUrlIsHttps: ziinaConfig.failureUrl.startsWith('https://'),
        testMode: Boolean(ziinaConfig.testMode),
    });
};

const logCreateRawResponse = (response, knownSecrets = []) => {
    if (!shouldLogRawCreateResponse()) return;
    console.log('[Ziina.createPayment.rawResponse]', {
        status: response?.status || null,
        data: sanitizeZiinaValue(response?.data, knownSecrets),
    });
};

const logCreateFailure = (err, knownSecrets = []) => {
    if (!shouldLogDiagnostics()) return;
    console.warn('[payments.ziina.failed]', JSON.stringify({
        operation: 'createPaymentIntent',
        httpStatus: err?.response?.status || null,
        responseBody: sanitizeZiinaValue(err?.response?.data ?? err?.providerResponse ?? null, knownSecrets),
        errorMessage: sanitizeZiinaValue(err?.message || 'Ziina create payment failed.', knownSecrets),
    }, null, 2));
};

const mapZiinaStatus = (status) => {
    const normalized = String(status || '').trim().toLowerCase();
    if (normalized === 'completed') return PAYMENT_STATUSES.SUCCEEDED;
    if (normalized === 'failed') return PAYMENT_STATUSES.FAILED;
    if (normalized === 'requires_user_action') return PAYMENT_STATUSES.REQUIRES_ACTION;
    return PAYMENT_STATUSES.PENDING;
};

const safeGatewayMetadata = ({
    data,
    paymentId,
    userId,
    checkoutUrl,
    amountMinor,
    gatewayAmount,
    gatewayCurrency,
    requestedAmount,
    requestedCurrency,
    feePercent,
    feeAmount,
    payableAmount,
    payableCurrency,
    providerStatus = null,
    successUrl,
    cancelUrl,
    failureUrl,
    testMode,
}) => ({
    provider: PAYMENT_GATEWAYS.ZIINA,
    mode: 'ziina_hosted_checkout',
    paymentId: paymentId?.toString?.() || paymentId || null,
    userId: userId?.toString?.() || userId || null,
    gatewayPaymentId: data?.id || null,
    gatewayReference: data?.id || null,
    providerStatus: providerStatus || data?.status || null,
    checkoutUrlPresent: Boolean(checkoutUrl),
    embeddedUrlPresent: Boolean(data?.embedded_url),
    amountMinor,
    gatewayAmount,
    gatewayCurrency,
    requestedAmount,
    requestedCurrency,
    feePercent,
    feeAmount,
    payableAmount,
    payableCurrency,
    successUrl,
    cancelUrl,
    failureUrl,
    testMode: Boolean(testMode),
    latestError: data?.latest_error || null,
    providerResponse: sanitizeZiinaValue(data),
});

class ZiinaGateway extends PaymentGatewayInterface {
    constructor() {
        super(PAYMENT_GATEWAYS.ZIINA);
    }

    async createPaymentIntent({
        paymentId,
        userId,
        totalAmount,
        currency,
        feePercent = 0,
        feeAmount = 0,
        gatewayAmount,
        gatewayCurrency,
        requestedAmount,
        requestedCurrency,
        gatewayCurrencyConversion,
    } = {}) {
        const ziinaConfig = getZiinaConfig();
        const normalizedGatewayCurrency = normalizeCurrency(gatewayCurrency || ziinaConfig.currency);
        const normalizedRequestedCurrency = normalizeCurrency(requestedCurrency || currency);
        const chargeAmount = gatewayAmount ?? totalAmount;
        const decimalChargeAmount = new Decimal(chargeAmount || 0);

        if (normalizedGatewayCurrency === 'AED' && decimalChargeAmount.lt(2)) {
            const error = new BusinessRuleError('Minimum Ziina payment amount is 2 AED', 'ZIINA_MINIMUM_AMOUNT_NOT_MET');
            error.messages = {
                en: 'Minimum Ziina payment amount is 2 AED',
                ar: 'الحد الأدنى للدفع عبر Ziina هو 2 AED',
            };
            throw error;
        }

        const amountMinor = toMinorUnits(chargeAmount, normalizedGatewayCurrency);
        const id = paymentId.toString();
        const successUrl = replacePaymentIntentPlaceholder(ziinaConfig.successUrl, null);
        const cancelUrl = replacePaymentIntentPlaceholder(ziinaConfig.cancelUrl, null);
        const failureUrl = replacePaymentIntentPlaceholder(ziinaConfig.failureUrl, null);
        const payload = {
            amount: amountMinor,
            currency_code: normalizedGatewayCurrency,
            message: `Winnie wallet top-up ${id}`,
            success_url: successUrl,
            cancel_url: cancelUrl,
            failure_url: failureUrl,
            test: Boolean(ziinaConfig.testMode),
            allow_tips: false,
        };

        logOutboundCreate({
            amountMinor,
            gatewayAmount: Number(chargeAmount),
            gatewayCurrency: normalizedGatewayCurrency,
            ziinaConfig,
        });

        try {
            const client = buildHttpClient(ziinaConfig);
            const response = await client.post('/payment_intent', payload, {
                headers: buildAuthHeaders(ziinaConfig),
            });
            logCreateRawResponse(response, [ziinaConfig.accessToken]);

            const data = response?.data || {};
            const checkoutUrl = trim(data.redirect_url);
            if (!checkoutUrl) {
                const err = new Error('Ziina create-payment response did not include redirect_url.');
                err.code = 'ZIINA_CREATE_PAYMENT_INVALID_RESPONSE';
                err.providerResponse = sanitizeZiinaValue(data, [ziinaConfig.accessToken]);
                throw err;
            }

            return {
                gatewayPaymentId: data.id || null,
                gatewayReference: data.id || id,
                checkoutUrl,
                status: PAYMENT_STATUSES.REQUIRES_ACTION,
                metadata: safeGatewayMetadata({
                    data,
                    paymentId: id,
                    userId,
                    checkoutUrl,
                    amountMinor,
                    gatewayAmount: Number(chargeAmount),
                    gatewayCurrency: normalizedGatewayCurrency,
                    requestedAmount: requestedAmount ?? totalAmount,
                    requestedCurrency: normalizedRequestedCurrency,
                    feePercent,
                    feeAmount,
                    payableAmount: totalAmount,
                    payableCurrency: normalizedRequestedCurrency,
                    successUrl,
                    cancelUrl,
                    failureUrl,
                    testMode: ziinaConfig.testMode,
                }),
                gatewayCurrencyConversion,
            };
        } catch (err) {
            if (err instanceof BusinessRuleError) throw err;
            logCreateFailure(err, [ziinaConfig.accessToken]);
            if (err.code === 'ZIINA_CREATE_PAYMENT_INVALID_RESPONSE') {
                const invalidResponseError = new BusinessRuleError(err.message, err.code);
                invalidResponseError.providerResponse = err.providerResponse;
                throw invalidResponseError;
            }
            throw new BusinessRuleError(CUSTOMER_UNAVAILABLE_MESSAGE, 'ZIINA_CREATE_PAYMENT_FAILED');
        }
    }

    async getPaymentStatus(payment) {
        const ziinaConfig = getZiinaConfig();
        const providerPaymentId = payment.gatewayPaymentId ||
            payment.gatewayReference ||
            payment.metadata?.gatewayMetadata?.gatewayPaymentId;

        if (!providerPaymentId) {
            throw new BusinessRuleError(CUSTOMER_UNAVAILABLE_MESSAGE, 'ZIINA_PAYMENT_STATUS_FAILED');
        }

        try {
            const client = buildHttpClient(ziinaConfig);
            const response = await client.get(`/payment_intent/${encodeURIComponent(providerPaymentId)}`, {
                headers: buildAuthHeaders(ziinaConfig),
            });
            const data = response?.data || {};
            const providerStatus = String(data.status || '').trim();

            if (shouldLogDiagnostics()) {
                console.warn('[Ziina.verify.rawResponse]', {
                    providerPaymentId,
                    status: providerStatus,
                    amount: data.amount ?? null,
                    currency_code: data.currency_code || null,
                });
            }

            return {
                status: mapZiinaStatus(providerStatus),
                providerStatus,
                gatewayPaymentId: data.id || payment.gatewayPaymentId || null,
                gatewayReference: data.id || payment.gatewayReference || null,
                metadata: safeGatewayMetadata({
                    data,
                    paymentId: payment._id,
                    userId: payment.userId,
                    checkoutUrl: data.redirect_url || payment.checkoutUrl,
                    amountMinor: data.amount ?? payment.metadata?.gatewayMetadata?.amountMinor ?? null,
                    gatewayAmount: payment.metadata?.gatewayCurrencyConversion?.gatewayAmount,
                    gatewayCurrency: data.currency_code || payment.metadata?.gatewayCurrencyConversion?.gatewayCurrency || ziinaConfig.currency,
                    requestedAmount: payment.amount,
                    requestedCurrency: payment.currency,
                    feePercent: payment.feePercent,
                    feeAmount: payment.feeAmount,
                    payableAmount: payment.totalAmount,
                    payableCurrency: payment.currency,
                    providerStatus,
                    successUrl: payment.metadata?.gatewayMetadata?.successUrl || null,
                    cancelUrl: payment.metadata?.gatewayMetadata?.cancelUrl || null,
                    failureUrl: payment.metadata?.gatewayMetadata?.failureUrl || null,
                    testMode: ziinaConfig.testMode,
                }),
            };
        } catch (err) {
            if (err instanceof BusinessRuleError) throw err;
            throw new BusinessRuleError(CUSTOMER_UNAVAILABLE_MESSAGE, 'ZIINA_PAYMENT_STATUS_FAILED');
        }
    }
}

module.exports = ZiinaGateway;
module.exports.getZiinaConfig = getZiinaConfig;
module.exports.mapZiinaStatus = mapZiinaStatus;
module.exports.toMinorUnits = toMinorUnits;
