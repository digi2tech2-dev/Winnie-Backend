'use strict';

const axios = require('axios');
const Decimal = require('decimal.js');
const PaymentGatewayInterface = require('./gateway.interface');
const { PAYMENT_GATEWAYS, PAYMENT_STATUSES } = require('../payment.constants');
const { BusinessRuleError } = require('../../../shared/errors/AppError');
const config = require('../../../config/config');

const CUSTOMER_UNAVAILABLE_MESSAGE = 'Online payment is temporarily unavailable. Please try again later or use manual deposit.';
const DEFAULT_TIMEOUT_MS = 10000;
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
const DEFAULT_MINOR_UNITS = 2;
const DIAGNOSTIC_LOG_ENVS = new Set(['development', 'test']);
const SENSITIVE_RESPONSE_KEYS = new Set([
    'access_token',
    'accesstoken',
    'auth',
    'api_key',
    'apikey',
    'authorization',
    'cardnumber',
    'cvv',
    'cvc',
    'expiry',
    'expirydate',
    'pan',
    'securitycode',
    'token',
]);

const trim = (value) => String(value || '').trim();

const boolFromEnv = (value, fallback = false) => {
    if (value === undefined || value === null || value === '') return fallback;
    return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const defaultBaseUrlForEnv = (env) => (
    env === 'live'
        ? 'https://api-gateway.ngenius-payments.com'
        : 'https://api-gateway.sandbox.ngenius-payments.com'
);

const normalizeBaseUrl = (value) => trim(value).replace(/\/+$/, '');

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
        if (!parsed.searchParams.has(key)) {
            parsed.searchParams.set(key, String(value));
        }
        return parsed.toString();
    } catch (_) {
        return url;
    }
};

const getNetworkConfig = () => {
    const environment = trim(process.env.NETWORK_INTERNATIONAL_ENV || config.payments.networkInternational.env || 'sandbox')
        .toLowerCase();
    const baseUrl = normalizeBaseUrl(
        process.env.NETWORK_INTERNATIONAL_BASE_URL ||
        config.payments.networkInternational.baseUrl ||
        defaultBaseUrlForEnv(environment)
    );
    const networkConfig = {
        enabled: boolFromEnv(
            process.env.NETWORK_INTERNATIONAL_ENABLED,
            config.payments.networkInternational.enabled
        ),
        environment,
        baseUrl,
        apiKey: trim(process.env.NETWORK_INTERNATIONAL_API_KEY || config.payments.networkInternational.apiKey),
        outletRef: trim(process.env.NETWORK_INTERNATIONAL_OUTLET_REF || config.payments.networkInternational.outletRef),
        currency: trim(process.env.NETWORK_INTERNATIONAL_CURRENCY || config.payments.networkInternational.currency || 'AED')
            .toUpperCase(),
        returnUrl: trim(process.env.NETWORK_INTERNATIONAL_RETURN_URL || config.payments.networkInternational.returnUrl),
        cancelUrl: trim(process.env.NETWORK_INTERNATIONAL_CANCEL_URL || config.payments.networkInternational.cancelUrl),
        timeoutMs: parseInt(process.env.NETWORK_INTERNATIONAL_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS,
    };

    if (!networkConfig.enabled || !networkConfig.apiKey || !networkConfig.outletRef || !networkConfig.currency) {
        throw new BusinessRuleError(CUSTOMER_UNAVAILABLE_MESSAGE, 'NETWORK_PAYMENT_CONFIG_MISSING');
    }

    assertHttpUrl(networkConfig.baseUrl, 'NETWORK_PAYMENT_CONFIG_MISSING');
    assertHttpUrl(networkConfig.returnUrl, 'NETWORK_PAYMENT_CONFIG_MISSING');
    assertHttpUrl(networkConfig.cancelUrl, 'NETWORK_PAYMENT_CONFIG_MISSING');

    return networkConfig;
};

const toMinorUnits = (amount, currency) => {
    const decimals = MINOR_UNITS_BY_CURRENCY[currency] ?? DEFAULT_MINOR_UNITS;

    const value = new Decimal(amount || 0);
    if (!value.isFinite() || value.lessThanOrEqualTo(0)) {
        throw new BusinessRuleError('Payment amount must be greater than zero.', 'INVALID_PAYMENT_AMOUNT');
    }

    return value.times(new Decimal(10).pow(decimals)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
};

const buildHttpClient = (networkConfig) => axios.create({
    baseURL: networkConfig.baseUrl,
    timeout: networkConfig.timeoutMs,
});

const getRuntimeEnv = () => process.env.NODE_ENV || config.env || 'development';

const shouldLogDiagnostics = () => DIAGNOSTIC_LOG_ENVS.has(getRuntimeEnv());

const endpointPathFromError = (err, fallbackPath) => {
    const rawUrl = err?.config?.url || fallbackPath || '';
    if (!rawUrl) return null;

    try {
        return redactNetworkEndpointPath(new URL(rawUrl, 'https://network.local').pathname);
    } catch (_) {
        return redactNetworkEndpointPath(String(rawUrl).split('?')[0]);
    }
};

const redactNetworkEndpointPath = (path) => String(path || '')
    .replace(/\/transactions\/outlets\/[^/]+\/orders/gi, '/transactions/outlets/[REDACTED]/orders');

const buildKnownSecretList = (...values) => values
    .map((value) => String(value || '').trim())
    .filter((value) => value.length >= 4);

const redactKnownSecrets = (value, knownSecrets = []) => knownSecrets.reduce(
    (safeValue, secret) => safeValue.split(secret).join('[REDACTED]'),
    String(value)
);

const sanitizeNetworkValue = (value, knownSecrets = []) => {
    if (Array.isArray(value)) {
        return value.map((item) => sanitizeNetworkValue(item, knownSecrets));
    }

    if (value && typeof value === 'object') {
        return Object.entries(value).reduce((safe, [key, childValue]) => {
            const normalizedKey = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
            if (SENSITIVE_RESPONSE_KEYS.has(normalizedKey)) {
                safe[key] = '[REDACTED]';
            } else {
                safe[key] = sanitizeNetworkValue(childValue, knownSecrets);
            }
            return safe;
        }, {});
    }

    if (typeof value === 'string') {
        return redactKnownSecrets(value, knownSecrets);
    }

    return value;
};

const extractNetworkErrorCode = (data) => (
    data?.code ||
    data?.errorCode ||
    data?.error?.code ||
    data?.errors?.[0]?.code ||
    null
);

const extractNetworkErrorMessage = (data, err) => (
    data?.message ||
    data?.error_description ||
    data?.errorDescription ||
    data?.error?.message ||
    data?.errors?.[0]?.message ||
    err?.message ||
    null
);

const logNetworkCreateOrderFailure = (err, endpointPath, knownSecrets = []) => {
    if (!shouldLogDiagnostics()) return;

const responseBody = sanitizeNetworkValue(err?.response?.data || null, knownSecrets);

const safeNetworkErrorLog = {
    endpointPath: endpointPathFromError(err, endpointPath),
    httpStatus: err?.response?.status || null,
    networkErrorCode: extractNetworkErrorCode(responseBody),
    networkErrorMessage: sanitizeNetworkValue(extractNetworkErrorMessage(responseBody, err), knownSecrets),
    responseBody,
};

console.warn(
    '[payments.networkInternational.createOrder.failed]',
    JSON.stringify(safeNetworkErrorLog, null, 2)
);
};

const extractCheckoutUrl = (data = {}) => (
    data?._links?.payment?.href ||
    data?._links?.['cnp:payment-link']?.href ||
    data?.paymentLink ||
    data?.checkoutUrl ||
    ''
);

const extractProviderState = (data = {}) => {
    const payments = data?._embedded?.payment || data?._embedded?.payments || data?.payments;
    if (Array.isArray(payments) && payments.length > 0) {
        const latest = payments[payments.length - 1];
        return latest?.state || latest?.status || data?.state || data?.status || null;
    }

    return data?.state || data?.status || null;
};

const normalizeProviderState = (state) => String(state || '').trim().toUpperCase();

const mapProviderStatus = (state) => {
    const normalized = normalizeProviderState(state);

    if (['PURCHASED', 'CAPTURED', 'SUCCESS', 'SUCCESSFUL'].includes(normalized)) {
        return PAYMENT_STATUSES.SUCCEEDED;
    }

    if (['FAILED', 'DECLINED', 'REJECTED'].includes(normalized)) {
        return PAYMENT_STATUSES.FAILED;
    }

    if (['CANCELLED', 'CANCELED', 'VOIDED'].includes(normalized)) {
        return PAYMENT_STATUSES.CANCELED;
    }

    if (['EXPIRED', 'TIMED_OUT', 'TIMEOUT'].includes(normalized)) {
        return PAYMENT_STATUSES.EXPIRED;
    }

    if (['STARTED', 'AWAIT_3DS', 'AWAITING_3DS', 'INITIATED'].includes(normalized)) {
        return PAYMENT_STATUSES.REQUIRES_ACTION;
    }

    return PAYMENT_STATUSES.PENDING;
};

const safeGatewayMetadata = ({
    amountMinor,
    gatewayAmount,
    gatewayCurrency,
    checkoutUrl,
    data,
    environment,
    providerState,
    feePercent,
    feeAmount,
    payableAmount,
    payableCurrency,
}) => ({
    provider: PAYMENT_GATEWAYS.NETWORK_INTERNATIONAL,
    mode: 'hosted_payment_page',
    environment,
    feePercent,
    feeAmount,
    payableAmount,
    payableCurrency,
    gatewayAmount,
    gatewayCurrency,
    amountMinor,
    orderId: data?._id || null,
    orderReference: data?.reference || null,
    providerState: providerState || null,
    checkoutUrlPresent: Boolean(checkoutUrl),
});

class NetworkInternationalGateway extends PaymentGatewayInterface {
    constructor() {
        super(PAYMENT_GATEWAYS.NETWORK_INTERNATIONAL);
    }

    async getAccessToken(networkConfig = getNetworkConfig()) {
        const client = buildHttpClient(networkConfig);

        try {
            const response = await client.post('/identity/auth/access-token', {}, {
                headers: {
                    Authorization: `Basic ${networkConfig.apiKey}`,
                    'Content-Type': 'application/vnd.ni-identity.v1+json',
                    Accept: 'application/vnd.ni-identity.v1+json',
                },
            });
            const token = response?.data?.access_token || response?.data?.accessToken;
            if (!token) {
                throw new Error('Network access-token response did not include a token.');
            }
            return token;
        } catch (_) {
            throw new BusinessRuleError(CUSTOMER_UNAVAILABLE_MESSAGE, 'NETWORK_ACCESS_TOKEN_FAILED');
        }
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
        const networkConfig = getNetworkConfig();
        const normalizedGatewayCurrency = String(gatewayCurrency || networkConfig.currency || '').trim().toUpperCase();
        const normalizedRequestedCurrency = String(requestedCurrency || currency || '').trim().toUpperCase();

        if (normalizedGatewayCurrency !== networkConfig.currency) {
            throw new BusinessRuleError(
                `Online card payment currently supports ${networkConfig.currency} only.`,
                'NETWORK_UNSUPPORTED_CURRENCY'
            );
        }

        const chargeAmount = gatewayAmount ?? totalAmount;
        const amountMinor = toMinorUnits(chargeAmount, normalizedGatewayCurrency);
        const token = await this.getAccessToken(networkConfig);
        const client = buildHttpClient(networkConfig);
        const id = paymentId.toString();
        const returnUrl = withQueryParam(networkConfig.returnUrl, 'paymentId', id);
        const cancelUrl = withQueryParam(networkConfig.cancelUrl, 'paymentId', id);
        const createOrderEndpointPath = `/transactions/outlets/${encodeURIComponent(networkConfig.outletRef)}/orders`;
        const payload = {
            action: 'SALE',
            amount: {
                currencyCode: normalizedGatewayCurrency,
                value: amountMinor,
            },
            merchantOrderReference: id,
            merchantAttributes: {
                redirectUrl: returnUrl,
                cancelUrl,
            },
        };

        console.warn('[network.createOrder.outbound]', JSON.stringify({
            requestedAmount: requestedAmount ?? totalAmount,
            requestedCurrency: normalizedRequestedCurrency,
            feePercent,
            feeAmount,
            payableAmount: totalAmount,
            payableCurrency: normalizedRequestedCurrency,
            gatewayAmount: chargeAmount,
            gatewayCurrency: normalizedGatewayCurrency,
            configuredNetworkCurrency: networkConfig.currency,
            amountMinor,
            networkPayloadAmount: payload.amount,
        }, null, 2));

        try {
            const response = await client.post(
                createOrderEndpointPath,
                payload,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/vnd.ni-payment.v2+json',
                        Accept: 'application/vnd.ni-payment.v2+json',
                    },
                }
            );
            const data = response?.data || {};
            const checkoutUrl = extractCheckoutUrl(data);
            const providerState = extractProviderState(data);

            if (!checkoutUrl) {
                throw new Error('Network create-order response did not include a checkout URL.');
            }

            return {
                gatewayPaymentId: data._id || data.reference || null,
                gatewayReference: data.reference || data._id || id,
                checkoutUrl,
                status: PAYMENT_STATUSES.REQUIRES_ACTION,
                metadata: {
                    ...safeGatewayMetadata({
                        amountMinor,
                        gatewayAmount: chargeAmount,
                        gatewayCurrency: normalizedGatewayCurrency,
                        feePercent,
                        feeAmount,
                        payableAmount: totalAmount,
                        payableCurrency: normalizedRequestedCurrency,
                        checkoutUrl,
                        data,
                        environment: networkConfig.environment,
                        providerState,
                    }),
                    userId: userId?.toString?.() || userId || null,
                    paymentId: id,
                    requestedAmount: requestedAmount ?? totalAmount,
                    requestedCurrency: normalizedRequestedCurrency,
                    feePercent,
                    feeAmount,
                    payableAmount: totalAmount,
                    payableCurrency: normalizedRequestedCurrency,
                    returnUrl,
                    cancelUrl,
                },
                gatewayCurrencyConversion,
            };
        } catch (err) {
            if (err instanceof BusinessRuleError) throw err;
            logNetworkCreateOrderFailure(
                err,
                '/transactions/outlets/[REDACTED]/orders',
                buildKnownSecretList(networkConfig.apiKey, networkConfig.outletRef, token)
            );
            throw new BusinessRuleError(CUSTOMER_UNAVAILABLE_MESSAGE, 'NETWORK_CREATE_ORDER_FAILED');
        }
    }

    async getPaymentStatus(payment) {
        const networkConfig = getNetworkConfig();
        const token = await this.getAccessToken(networkConfig);
        const orderReference = payment.gatewayReference || payment.gatewayPaymentId;

        if (!orderReference) {
            throw new BusinessRuleError(CUSTOMER_UNAVAILABLE_MESSAGE, 'NETWORK_PAYMENT_STATUS_FAILED');
        }

        const client = buildHttpClient(networkConfig);

        try {
            const response = await client.get(
                `/transactions/outlets/${encodeURIComponent(networkConfig.outletRef)}/orders/${encodeURIComponent(orderReference)}`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: 'application/vnd.ni-payment.v2+json',
                    },
                }
            );
            const data = response?.data || {};
            const providerState = extractProviderState(data);

            return {
                status: mapProviderStatus(providerState),
                providerStatus: normalizeProviderState(providerState),
                gatewayPaymentId: data._id || payment.gatewayPaymentId || null,
                gatewayReference: data.reference || payment.gatewayReference || null,
                metadata: safeGatewayMetadata({
                    amountMinor: data?.amount?.value || null,
                    gatewayAmount: data?.amount?.value != null ? null : undefined,
                    gatewayCurrency: data?.amount?.currencyCode || networkConfig.currency,
                    checkoutUrl: extractCheckoutUrl(data),
                    data,
                    environment: networkConfig.environment,
                    providerState,
                }),
            };
        } catch (err) {
            if (err instanceof BusinessRuleError) throw err;
            throw new BusinessRuleError(CUSTOMER_UNAVAILABLE_MESSAGE, 'NETWORK_PAYMENT_STATUS_FAILED');
        }
    }
}

module.exports = NetworkInternationalGateway;
