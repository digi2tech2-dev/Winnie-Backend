'use strict';

const axios = require('axios');
const config = require('../../../config/config');
const { BusinessRuleError } = require('../../../shared/errors/AppError');
const { redactSecretText } = require('../../../shared/utils/secretEncryption');

const FAZERCARDS_ERROR_CODES = Object.freeze({
    DISABLED: 'FAZERCARDS_DISABLED',
    MISSING_API_KEY: 'FAZERCARDS_MISSING_API_KEY',
    HTTP_ERROR: 'FAZERCARDS_HTTP_ERROR',
    TIMEOUT: 'FAZERCARDS_TIMEOUT',
    NETWORK_ERROR: 'FAZERCARDS_NETWORK_ERROR',
    MALFORMED_RESPONSE: 'FAZERCARDS_MALFORMED_RESPONSE',
    SUBSCRIPTION_INACTIVE: 'FAZERCARDS_SUBSCRIPTION_INACTIVE',
});

const SENSITIVE_KEY_PATTERN = /api[-_]?key|authorization|token|secret|password|credential/i;

const redactKnownSecrets = (value, secrets = []) => {
    if (value === null || value === undefined) return value;
    let text = redactSecretText(value);
    for (const secret of secrets) {
        if (!secret) continue;
        text = text.split(String(secret)).join('[REDACTED]');
    }
    return text;
};

const sanitizePayload = (value, depth = 0, secrets = []) => {
    if (value === null || value === undefined) return value;
    if (depth > 8) return '[REDACTED_DEPTH_LIMIT]';
    if (Array.isArray(value)) return value.map((item) => sanitizePayload(item, depth + 1, secrets));
    if (typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
                key,
                SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizePayload(child, depth + 1, secrets),
            ])
        );
    }
    if (typeof value === 'string') return redactKnownSecrets(value, secrets);
    return value;
};

const extractRequestId = (data, headers = {}) => (
    headers['x-request-id']
    || headers['request-id']
    || data?.requestId
    || null
);

const safeMessage = (err, secrets = []) => (
    redactKnownSecrets(
        err.response?.data?.error
        || err.response?.data?.message
        || err.message
        || 'FazerCards request failed',
        secrets
    )
);

const getProviderCode = (data = {}) => String(data?.code || data?.error_code || data?.errorCode || '').trim().toLowerCase();

const makeSubscriptionInactiveError = () => new BusinessRuleError(
    'FazerCards subscription is inactive. Renew it to sync top-up catalog.',
    FAZERCARDS_ERROR_CODES.SUBSCRIPTION_INACTIVE
);

const wrapFazerCardsError = (err, context = 'request', secrets = []) => {
    if (err instanceof BusinessRuleError && err.code?.startsWith('FAZERCARDS_')) {
        return err;
    }

    const status = err.response?.status ?? null;
    if (getProviderCode(err.response?.data) === 'subscription_inactive') {
        const wrapped = makeSubscriptionInactiveError();
        wrapped.statusCode = 422;
        wrapped.httpStatus = status;
        wrapped.context = context;
        wrapped.requestId = extractRequestId(err.response?.data, err.response?.headers);
        wrapped.safeUpstreamMessage = safeMessage(err, secrets);
        wrapped.providerBody = sanitizePayload(err.response?.data ?? null, 0, secrets);
        return wrapped;
    }

    const isTimeout = err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '');
    const code = isTimeout
        ? FAZERCARDS_ERROR_CODES.TIMEOUT
        : status
            ? FAZERCARDS_ERROR_CODES.HTTP_ERROR
            : FAZERCARDS_ERROR_CODES.NETWORK_ERROR;

    const wrapped = new BusinessRuleError(
        code === FAZERCARDS_ERROR_CODES.TIMEOUT
            ? 'FazerCards request timed out.'
            : status
                ? `FazerCards returned HTTP ${status}.`
                : 'FazerCards network request failed.',
        code
    );
    wrapped.statusCode = status === 429 ? 429 : 422;
    wrapped.httpStatus = status;
    wrapped.context = context;
    wrapped.requestId = extractRequestId(err.response?.data, err.response?.headers);
    wrapped.safeUpstreamMessage = safeMessage(err, secrets);
    wrapped.providerBody = sanitizePayload(err.response?.data ?? null, 0, secrets);
    return wrapped;
};

class FazerCardsClient {
    constructor(options = {}) {
        const cfg = config.providers.fazerCards;
        const resolvedEnabled = Object.prototype.hasOwnProperty.call(options, 'enabled')
            ? options.enabled
            : cfg.enabled;
        const resolvedApiKey = Object.prototype.hasOwnProperty.call(options, 'apiKey')
            ? options.apiKey
            : cfg.apiKey;

        if (!resolvedEnabled) {
            throw new BusinessRuleError('FazerCards integration is disabled.', FAZERCARDS_ERROR_CODES.DISABLED);
        }
        if (!resolvedApiKey) {
            throw new BusinessRuleError('FazerCards API key is not configured.', FAZERCARDS_ERROR_CODES.MISSING_API_KEY);
        }
        this.redactSecrets = [resolvedApiKey];

        const resolvedBaseUrl = String(options.baseUrl || cfg.apiBaseUrl).replace(/\/+$/, '');
        const resolvedTimeout = Number(options.timeoutMs || cfg.timeoutMs);

        this.http = axios.create({
            baseURL: resolvedBaseUrl,
            timeout: Number.isFinite(resolvedTimeout) && resolvedTimeout > 0 ? resolvedTimeout : 20_000,
            headers: {
                'X-API-Key': resolvedApiKey,
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
        });
    }

    async request(method, path, { params, data, headers, context } = {}) {
        try {
            const response = await this.http.request({ method, url: path, params, data, headers });
            const safeData = sanitizePayload(response.data, 0, this.redactSecrets);
            if (getProviderCode(safeData) === 'subscription_inactive') {
                throw makeSubscriptionInactiveError();
            }
            return {
                data: safeData,
                status: response.status,
                requestId: extractRequestId(response.data, response.headers),
            };
        } catch (err) {
            throw wrapFazerCardsError(err, context, this.redactSecrets);
        }
    }

    getAccount() {
        return this.request('get', '/me', { context: 'account' });
    }

    getBalance() {
        return this.request('get', '/balance', { context: 'balance' });
    }

    fetchTopupCategoriesPage({ limit = 100, cursor } = {}) {
        const params = { limit };
        if (cursor) params.cursor = cursor;
        return this.request('get', '/topups', { params, context: 'topups' });
    }

    fetchTopupOffers({ categoryId } = {}) {
        return this.request('get', '/topups/offers', {
            params: { category_id: categoryId },
            context: 'topup_offers',
        });
    }

    createTopupOrder({ categoryId, offerId, fields, idempotencyKey } = {}) {
        return this.request('post', '/topups/order', {
            data: {
                category_id: categoryId,
                offer_id: offerId,
                fields: fields || {},
            },
            headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
            context: 'topup_order',
        });
    }
}

module.exports = {
    FazerCardsClient,
    FAZERCARDS_ERROR_CODES,
    sanitizePayload,
    redactKnownSecrets,
    wrapFazerCardsError,
    makeSubscriptionInactiveError,
};
