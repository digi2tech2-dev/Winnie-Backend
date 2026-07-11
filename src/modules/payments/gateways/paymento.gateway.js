'use strict';

const axios = require('axios');
const PaymentGatewayInterface = require('./gateway.interface');
const { PAYMENT_GATEWAYS, PAYMENT_STATUSES } = require('../payment.constants');
const { BusinessRuleError } = require('../../../shared/errors/AppError');
const config = require('../../../config/config');

const CUSTOMER_UNAVAILABLE_MESSAGE = 'USDT wallet top-up is temporarily unavailable. Please try again later or use manual deposit.';
const DEFAULT_TIMEOUT_MS = 10000;
const DIAGNOSTIC_LOG_ENVS = new Set(['development', 'test']);

const SENSITIVE_RESPONSE_KEYS = new Set([
    'access_token',
    'accesstoken',
    'api_key',
    'apikey',
    'auth',
    'authorization',
    'privatekey',
    'secret',
    'signature',
    'token',
]);

const trim = (value) => String(value || '').trim();
const normalizeBaseUrl = (value) => trim(value).replace(/\/+$/, '');
const normalizeCurrency = (value, fallback = 'USD') => trim(value || fallback).toUpperCase();

const boolFromEnv = (value, fallback = false) => {
    if (value === undefined || value === null || value === '') return fallback;
    return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const assertHttpUrl = (url, code) => {
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported protocol');
    } catch (_) {
        throw new BusinessRuleError(CUSTOMER_UNAVAILABLE_MESSAGE, code);
    }
};

const withQueryParam = (url, key, value) => {
    if (!value) return url;
    try {
        const parsed = new URL(url);
        if (!parsed.searchParams.has(key)) parsed.searchParams.set(key, String(value));
        return parsed.toString();
    } catch (_) {
        return url;
    }
};

const getPaymentoConfig = () => {
    const paymentoConfig = config.payments.paymento || {};
    const runtimeConfig = {
        enabled: boolFromEnv(process.env.PAYMENTO_ENABLED, paymentoConfig.enabled),
        apiBaseUrl: normalizeBaseUrl(process.env.PAYMENTO_API_BASE_URL || paymentoConfig.apiBaseUrl || 'https://api.paymento.io'),
        apiKey: trim(process.env.PAYMENTO_API_KEY || paymentoConfig.apiKey),
        returnUrl: trim(process.env.PAYMENTO_RETURN_URL || paymentoConfig.returnUrl),
        cancelUrl: trim(process.env.PAYMENTO_CANCEL_URL || paymentoConfig.cancelUrl),
        pendingUrl: trim(process.env.PAYMENTO_PENDING_URL || paymentoConfig.pendingUrl),
        ipnUrl: trim(process.env.PAYMENTO_IPN_URL || paymentoConfig.ipnUrl),
        fiatCurrency: normalizeCurrency(process.env.PAYMENTO_FIAT_CURRENCY || paymentoConfig.fiatCurrency || 'USD'),
        allowedCrypto: trim(process.env.PAYMENTO_ALLOWED_CRYPTO || paymentoConfig.allowedCrypto || 'USDT').toUpperCase(),
        riskSpeed: parseFloat(process.env.PAYMENTO_RISK_SPEED || paymentoConfig.riskSpeed || '1') || 1,
        createPath: trim(process.env.PAYMENTO_CREATE_PATH || paymentoConfig.createPath || '/v1/payment/request'),
        verifyPath: trim(process.env.PAYMENTO_VERIFY_PATH || paymentoConfig.verifyPath || '/v1/payment/verify'),
        timeoutMs: parseInt(process.env.PAYMENTO_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS,
    };

    if (!runtimeConfig.enabled || !runtimeConfig.apiBaseUrl || !runtimeConfig.apiKey || !runtimeConfig.fiatCurrency) {
        throw new BusinessRuleError(CUSTOMER_UNAVAILABLE_MESSAGE, 'PAYMENTO_CONFIG_MISSING');
    }

    if (!runtimeConfig.allowedCrypto) {
        throw new BusinessRuleError(CUSTOMER_UNAVAILABLE_MESSAGE, 'PAYMENTO_CONFIG_MISSING');
    }

    assertHttpUrl(runtimeConfig.apiBaseUrl, 'PAYMENTO_CONFIG_MISSING');
    assertHttpUrl(runtimeConfig.returnUrl, 'PAYMENTO_CONFIG_MISSING');
    assertHttpUrl(runtimeConfig.cancelUrl, 'PAYMENTO_CONFIG_MISSING');
    assertHttpUrl(runtimeConfig.pendingUrl, 'PAYMENTO_CONFIG_MISSING');
    assertHttpUrl(runtimeConfig.ipnUrl, 'PAYMENTO_CONFIG_MISSING');

    return runtimeConfig;
};

const buildHttpClient = (paymentoConfig) => axios.create({
    baseURL: paymentoConfig.apiBaseUrl,
    timeout: paymentoConfig.timeoutMs,
});

const getRuntimeEnv = () => process.env.NODE_ENV || config.env || 'development';
const shouldLogDiagnostics = () => DIAGNOSTIC_LOG_ENVS.has(getRuntimeEnv());
const shouldLogRawCreateResponse = () => getRuntimeEnv() === 'development';

const sanitizePaymentoValue = (value, knownSecrets = []) => {
    if (Array.isArray(value)) return value.map((item) => sanitizePaymentoValue(item, knownSecrets));

    if (value && typeof value === 'object') {
        return Object.entries(value).reduce((safe, [key, childValue]) => {
            const normalizedKey = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
            safe[key] = SENSITIVE_RESPONSE_KEYS.has(normalizedKey)
                ? '[REDACTED]'
                : sanitizePaymentoValue(childValue, knownSecrets);
            return safe;
        }, {});
    }

    if (typeof value === 'string') {
        return knownSecrets.reduce((safeValue, secret) => safeValue.split(secret).join('[REDACTED]'), value);
    }

    return value;
};

const extractPaymentoErrorCode = (data) => data?.code || data?.errorCode || data?.error?.code || null;
const extractPaymentoErrorMessage = (data, err) => (
    data?.message ||
    data?.error_description ||
    data?.errorDescription ||
    data?.error?.message ||
    err?.message ||
    null
);

const logPaymentoFailure = (err, operation, knownSecrets = []) => {
    if (!shouldLogDiagnostics()) return;

    const responseBody = sanitizePaymentoValue(
        err?.response?.data ?? err?.providerResponse ?? null,
        knownSecrets
    );
    const safeLog = {
        operation,
        httpStatus: err?.response?.status || null,
        paymentoErrorCode: extractPaymentoErrorCode(responseBody),
        paymentoErrorMessage: sanitizePaymentoValue(extractPaymentoErrorMessage(responseBody, err), knownSecrets),
        responseBody,
    };

    console.warn('[payments.paymento.failed]', JSON.stringify(safeLog, null, 2));
};

const firstPresent = (...values) => {
    for (const value of values) {
        const text = trim(value);
        if (text) return text;
    }
    return null;
};

const parsePaymentoResponseData = (data, { plainStringKey = 'token' } = {}) => {
    if (!data) return {};
    if (typeof data !== 'string') return data;

    const text = trim(data);
    if (!text) return {};

    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? parsed : { [plainStringKey]: String(parsed) };
    } catch (_) {
        return { [plainStringKey]: text };
    }
};

const extractCheckoutUrl = (data = {}) => firstPresent(
    data.checkoutUrl,
    data.checkout_url,
    data.paymentUrl,
    data.payment_url,
    data.hostedUrl,
    data.hosted_url,
    data.url,
    data.data?.checkoutUrl,
    data.data?.checkout_url,
    data.data?.paymentUrl,
    data.data?.payment_url,
    data.result?.checkoutUrl,
    data.result?.checkout_url
);

const extractPaymentoToken = (data = {}) => firstPresent(
    data.token,
    data.checkoutToken,
    data.data?.token,
    data.data?.body,
    data.body?.token,
    data.body,
    data.result?.token
);

const buildPaymentoCheckoutUrl = (token) => {
    if (!token) return null;

    const checkoutBaseUrl = process.env.PAYMENTO_CHECKOUT_BASE_URL || 'https://app.paymento.io/gateway';
    return `${checkoutBaseUrl}?token=${encodeURIComponent(token)}`;
};

const logPaymentoCreateRawResponse = (response, knownSecrets = []) => {
    if (!shouldLogRawCreateResponse()) return;

    console.log('[Paymento.createPayment.rawResponse]', {
        responseType: typeof response?.data,
        data: sanitizePaymentoValue(response?.data, knownSecrets),
    });
};

const parsePaymentoCreateResponse = (raw) => {
    let token = null;
    let checkoutUrl = null;
    let data = raw;

    if (typeof raw === 'string') {
        token = raw.trim();
        data = token ? { token } : {};
    }

    if (raw && typeof raw === 'object') {
        token = raw.body ??
            raw.token ??
            raw.checkoutToken ??
            raw.data?.token ??
            raw.data?.body ??
            null;

        checkoutUrl = raw.checkoutUrl ??
            raw.checkout_url ??
            raw.data?.checkoutUrl ??
            raw.data?.checkout_url ??
            null;
    }

    if (token && typeof token === 'string') {
        token = token.trim();
    } else if (token !== null && token !== undefined) {
        token = null;
    }

    if (checkoutUrl && typeof checkoutUrl === 'string') {
        checkoutUrl = checkoutUrl.trim();
    } else if (checkoutUrl !== null && checkoutUrl !== undefined) {
        checkoutUrl = null;
    }

    if (raw && typeof raw === 'object') {
        token = token || extractPaymentoToken(raw);
        checkoutUrl = checkoutUrl || extractCheckoutUrl(raw);
    }

    checkoutUrl = checkoutUrl || buildPaymentoCheckoutUrl(token);

    return {
        data,
        token: token || null,
        checkoutUrl: checkoutUrl || null,
    };
};

const createInvalidPaymentoResponseError = (raw, knownSecrets = []) => {
    const err = new Error('Paymento create-payment response did not include a token or checkout URL.');
    err.code = 'PAYMENTO_CREATE_PAYMENT_INVALID_RESPONSE';
    err.providerResponse = sanitizePaymentoValue(raw, knownSecrets);
    return err;
};

const extractProviderPaymentId = (data = {}) => firstPresent(
    data.paymentId,
    data.payment_id,
    data.id,
    data._id,
    data.uuid,
    data.data?.paymentId,
    data.data?.payment_id,
    data.data?.id,
    data.data?._id,
    data.data?.uuid,
    data.result?.paymentId,
    data.result?.payment_id,
    data.result?.id
);

const extractProviderReference = (data = {}) => firstPresent(
    data.reference,
    data.ref,
    data.merchantReference,
    data.merchant_reference,
    data.orderReference,
    data.order_reference,
    data.data?.reference,
    data.data?.ref,
    data.data?.merchantReference,
    data.data?.merchant_reference,
    data.result?.reference,
    data.result?.merchantReference,
    data.result?.merchant_reference
);

const normalizeProviderStatus = (value) => String(value ?? '').trim();
const normalizeStatusToken = (value) => normalizeProviderStatus(value)
    .replace(/[^a-z0-9]+/gi, '')
    .toUpperCase();

const mapPaymentoStatus = (value) => {
    const token = normalizeStatusToken(value);

    if (['0', 'INITIALIZE', 'INITIALIZED', 'INITIATED'].includes(token)) return PAYMENT_STATUSES.INITIATED;
    if (['1', 'PENDING'].includes(token)) return PAYMENT_STATUSES.PENDING;
    if (['2', 'PARTIALPAID', 'PARTIALLYPAID'].includes(token)) return PAYMENT_STATUSES.PENDING;
    if (['3', 'WAITINGTOCONFIRM', 'WAITINGCONFIRMATION', 'CONFIRMING'].includes(token)) return PAYMENT_STATUSES.PENDING;
    if (['4', 'TIMEOUT', 'TIMEDOUT', 'EXPIRED'].includes(token)) return PAYMENT_STATUSES.EXPIRED;
    if (['5', 'USERCANCELED', 'USERCANCELLED', 'CANCELED', 'CANCELLED'].includes(token)) return PAYMENT_STATUSES.CANCELED;
    if (['7', 'PAID', 'SUCCESS', 'SUCCESSFUL', 'COMPLETED'].includes(token)) return PAYMENT_STATUSES.SUCCEEDED;
    if (['8', 'APPROVE', 'APPROVED'].includes(token)) return PAYMENT_STATUSES.SUCCEEDED;
    if (['9', 'REJECT', 'REJECTED', 'FAILED', 'FAIL'].includes(token)) return PAYMENT_STATUSES.FAILED;

    return PAYMENT_STATUSES.PENDING;
};

const extractProviderStatus = (data = {}) => firstPresent(
    data.status,
    data.state,
    data.paymentStatus,
    data.payment_status,
    data.statusName,
    data.status_name,
    data.statusCode,
    data.status_code,
    data.data?.status,
    data.data?.state,
    data.data?.paymentStatus,
    data.data?.payment_status,
    data.data?.statusName,
    data.data?.status_name,
    data.data?.statusCode,
    data.data?.status_code,
    data.result?.status,
    data.result?.state,
    data.result?.paymentStatus,
    data.result?.payment_status
);

const buildAuthHeaders = (paymentoConfig) => ({
    'Api-key': paymentoConfig.apiKey,
    Accept: 'text/plain',
    'Content-Type': 'application/json',
});

const safeGatewayMetadata = ({
    paymentId,
    userId,
    data,
    checkoutUrl,
    gatewayAmount,
    gatewayCurrency,
    requestedAmount,
    requestedCurrency,
    feePercent,
    feeAmount,
    payableAmount,
    payableCurrency,
    allowedCrypto,
    providerStatus = null,
    returnUrl,
    cancelUrl,
    pendingUrl,
    ipnUrl,
    riskSpeed,
}) => ({
    provider: PAYMENT_GATEWAYS.PAYMENTO,
    mode: 'hosted_usdt_checkout',
    paymentId: paymentId?.toString?.() || paymentId || null,
    userId: userId?.toString?.() || userId || null,
    gatewayPaymentId: extractProviderPaymentId(data),
    gatewayReference: extractProviderReference(data),
    providerStatus: providerStatus || null,
    checkoutUrlPresent: Boolean(checkoutUrl),
    gatewayAmount,
    gatewayCurrency,
    requestedAmount,
    requestedCurrency,
    feePercent,
    feeAmount,
    payableAmount,
    payableCurrency,
    allowedCrypto,
    returnUrl,
    cancelUrl,
    pendingUrl,
    ipnUrl,
    riskSpeed,
});

class PaymentoGateway extends PaymentGatewayInterface {
    constructor() {
        super(PAYMENT_GATEWAYS.PAYMENTO);
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
        const paymentoConfig = getPaymentoConfig();
        const id = paymentId.toString();
        const normalizedGatewayCurrency = normalizeCurrency(gatewayCurrency || paymentoConfig.fiatCurrency);
        const normalizedRequestedCurrency = normalizeCurrency(requestedCurrency || currency);
        const chargeAmount = gatewayAmount ?? totalAmount;
        const returnUrl = withQueryParam(paymentoConfig.returnUrl, 'paymentId', id);
        const cancelUrl = withQueryParam(paymentoConfig.cancelUrl, 'paymentId', id);
        const pendingUrl = withQueryParam(paymentoConfig.pendingUrl, 'paymentId', id);
        const client = buildHttpClient(paymentoConfig);
        const payload = {
            fiatAmount: String(Number(chargeAmount).toFixed(2)),
            fiatCurrency: normalizedGatewayCurrency,
            ReturnUrl: returnUrl,
            orderId: id,
            Speed: Number(paymentoConfig.riskSpeed) === 0 ? 0 : 1,
            additionalData: [
                { key: 'paymentId', value: id },
                { key: 'userId', value: userId?.toString?.() || String(userId || '') },
                { key: 'requestedAmount', value: String(requestedAmount ?? totalAmount) },
                { key: 'requestedCurrency', value: normalizedRequestedCurrency },
                { key: 'feePercent', value: String(feePercent) },
                { key: 'feeAmount', value: String(feeAmount) },
                { key: 'payableAmount', value: String(totalAmount) },
                { key: 'payableCurrency', value: normalizedRequestedCurrency },
                { key: 'allowedCrypto', value: paymentoConfig.allowedCrypto },
            ],
        };

        try {
            const response = await client.post(paymentoConfig.createPath, payload, {
                headers: buildAuthHeaders(paymentoConfig),
            });
            logPaymentoCreateRawResponse(response, [paymentoConfig.apiKey]);

            const raw = response?.data;
            const {
                data,
                token: paymentoToken,
                checkoutUrl,
            } = parsePaymentoCreateResponse(raw);

            if (!paymentoToken && !checkoutUrl) {
                throw createInvalidPaymentoResponseError(raw, [paymentoConfig.apiKey]);
            }

            return {
                gatewayPaymentId: paymentoToken || extractProviderPaymentId(data),
                gatewayReference: extractProviderReference(data) || id,
                checkoutUrl,
                status: PAYMENT_STATUSES.REQUIRES_ACTION,
                metadata: safeGatewayMetadata({
                    paymentId: id,
                    userId,
                    data,
                    checkoutUrl,
                    gatewayAmount: chargeAmount,
                    gatewayCurrency: normalizedGatewayCurrency,
                    requestedAmount: requestedAmount ?? totalAmount,
                    requestedCurrency: normalizedRequestedCurrency,
                    feePercent,
                    feeAmount,
                    payableAmount: totalAmount,
                    payableCurrency: normalizedRequestedCurrency,
                    allowedCrypto: paymentoConfig.allowedCrypto,
                    providerStatus: extractProviderStatus(data),
                    returnUrl,
                    cancelUrl,
                    pendingUrl,
                    ipnUrl: paymentoConfig.ipnUrl,
                    riskSpeed: paymentoConfig.riskSpeed,
                }),
                gatewayCurrencyConversion,
            };
        } catch (err) {
            if (err instanceof BusinessRuleError) throw err;
            logPaymentoFailure(err, 'createPaymentIntent', [paymentoConfig.apiKey]);
            if (err.code === 'PAYMENTO_CREATE_PAYMENT_INVALID_RESPONSE') {
                const invalidResponseError = new BusinessRuleError(err.message, err.code);
                invalidResponseError.providerResponse = err.providerResponse;
                throw invalidResponseError;
            }
            throw new BusinessRuleError(CUSTOMER_UNAVAILABLE_MESSAGE, 'PAYMENTO_CREATE_PAYMENT_FAILED');
        }
    }

    async getPaymentStatus(payment) {
        const paymentoConfig = getPaymentoConfig();
        const providerRef = payment.gatewayPaymentId ||
            payment.gatewayReference ||
            payment.metadata?.gatewayMetadata?.gatewayPaymentId ||
            payment.metadata?.gatewayMetadata?.gatewayReference ||
            payment._id?.toString?.();

        if (!providerRef) {
            throw new BusinessRuleError(CUSTOMER_UNAVAILABLE_MESSAGE, 'PAYMENTO_PAYMENT_STATUS_FAILED');
        }

        const client = buildHttpClient(paymentoConfig);
        const payload = {
            token: providerRef,
        };

        try {
            const response = await client.post(paymentoConfig.verifyPath, payload, {
                headers: buildAuthHeaders(paymentoConfig),
            });
            const data = parsePaymentoResponseData(response?.data, { plainStringKey: 'status' });
            const providerStatus = extractProviderStatus(data);

            return {
                status: mapPaymentoStatus(providerStatus),
                providerStatus: normalizeProviderStatus(providerStatus),
                gatewayPaymentId: payment.gatewayPaymentId || extractPaymentoToken(data) || extractProviderPaymentId(data) || null,
                gatewayReference: extractProviderReference(data) || payment.gatewayReference || null,
                metadata: safeGatewayMetadata({
                    paymentId: payment._id,
                    userId: payment.userId,
                    data,
                    checkoutUrl: extractCheckoutUrl(data),
                    gatewayAmount: payment.metadata?.gatewayCurrencyConversion?.gatewayAmount,
                    gatewayCurrency: payment.metadata?.gatewayCurrencyConversion?.gatewayCurrency || paymentoConfig.fiatCurrency,
                    requestedAmount: payment.amount,
                    requestedCurrency: payment.currency,
                    allowedCrypto: paymentoConfig.allowedCrypto,
                    providerStatus,
                    returnUrl: payment.metadata?.gatewayMetadata?.returnUrl || null,
                    cancelUrl: payment.metadata?.gatewayMetadata?.cancelUrl || null,
                    pendingUrl: payment.metadata?.gatewayMetadata?.pendingUrl || null,
                    ipnUrl: payment.metadata?.gatewayMetadata?.ipnUrl || null,
                    riskSpeed: paymentoConfig.riskSpeed,
                }),
            };
        } catch (err) {
            if (err instanceof BusinessRuleError) throw err;
            logPaymentoFailure(err, 'getPaymentStatus', [paymentoConfig.apiKey]);
            throw new BusinessRuleError(CUSTOMER_UNAVAILABLE_MESSAGE, 'PAYMENTO_PAYMENT_STATUS_FAILED');
        }
    }
}

module.exports = PaymentoGateway;
module.exports.mapPaymentoStatus = mapPaymentoStatus;
module.exports.getPaymentoConfig = getPaymentoConfig;
