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
    STATUS_ENDPOINT_UNCONFIRMED: 'FAZERCARDS_STATUS_ENDPOINT_UNCONFIRMED',
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

const getHeaderValue = (headers = {}, name) => {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name) || headers.get(String(name).toLowerCase());
    return headers[name] || headers[String(name).toLowerCase()] || null;
};

const parseRetryAfterSeconds = (...values) => {
    for (const value of values) {
        const parsed = Number.parseInt(String(value ?? ''), 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
        const retryAt = Date.parse(String(value ?? ''));
        if (Number.isFinite(retryAt) && retryAt > Date.now()) {
            return Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
        }
    }
    return null;
};

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
    if (status === 429) {
        wrapped.retryAfterSeconds = parseRetryAfterSeconds(
            getHeaderValue(err.response?.headers, 'retry-after'),
            err.response?.data?.retryAfterSeconds,
            err.response?.data?.retry_after,
            err.response?.data?.retryAfter
        );
    }
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
        this.topupOrderStatusPath = Object.prototype.hasOwnProperty.call(options, 'topupOrderStatusPath')
            ? options.topupOrderStatusPath
            : cfg.topupOrderStatusPath;

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

    fetchCatalogPath(path, params = {}, context = 'catalog_family') {
        return this.request('get', path, { params, context });
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

    createGiftCardOrder({ categoryId, cardId, quantity, idempotencyKey } = {}) {
        return this.request('post', '/giftcards/order', {
            data: {
                category_id: categoryId,
                card_id: cardId,
                quantity,
            },
            headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
            context: 'giftcard_order',
        });
    }

    createGameKeyOrder({ gameId, keyId, quantity, idempotencyKey } = {}) {
        return this.request('post', '/gamekeys/order', {
            data: {
                game_id: gameId,
                key_id: keyId,
                quantity,
            },
            headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
            context: 'gamekey_order',
        });
    }

    buyTelegramStars({ telegram_username, quantity, idempotencyKey } = {}) {
        return this.request('post', '/telegram/stars/buy', {
            data: {
                telegram_username,
                quantity,
            },
            headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
            context: 'telegram_stars_buy',
        });
    }

    buyTelegramPremium({ telegram_username, months, idempotencyKey } = {}) {
        return this.request('post', '/telegram/premium/buy', {
            data: {
                telegram_username,
                months,
            },
            headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
            context: 'telegram_premium_buy',
        });
    }

    checkSteamTopupLogin({ steamLogin } = {}) {
        return this.request('post', '/steam-topup/check-login', {
            data: { steamLogin },
            context: 'steam_topup_check_login',
        });
    }

    buySteamTopup({ steamLogin, currency, amount, idempotencyKey } = {}) {
        return this.request('post', '/steam-topup/order', {
            data: {
                steamLogin,
                currency,
                amount,
            },
            headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
            context: 'steam_topup_order',
        });
    }

    listSteamGiftGames(params = {}) {
        return this.request('get', '/steam-gifts/games', {
            params,
            context: 'steam_gifts_games',
        });
    }

    getSteamGiftGame(appid) {
        const id = String(appid || '').trim();
        if (!id) {
            throw new BusinessRuleError('FazerCards Steam Gift appid is required.', 'FAZERCARDS_STEAM_GIFT_APPID_REQUIRED');
        }

        return this.request('get', `/steam-gifts/games/${encodeURIComponent(id)}`, {
            context: 'steam_gifts_game',
        });
    }

    buySteamGift({ invite_url, sub_id, app_id, region, idempotencyKey } = {}) {
        return this.request('post', '/steam-gifts/order', {
            data: {
                invite_url,
                sub_id,
                app_id,
                region,
            },
            headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
            context: 'steam_gift_order',
        });
    }

    createManualServiceOrder({ manual_service_id, product_id, fields, idempotencyKey } = {}) {
        return this.request('post', '/manual-services/order', {
            data: {
                manual_service_id,
                product_id,
                fields: fields || {},
            },
            headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
            context: 'manual_service_order',
        });
    }

    getManualServiceChat(providerOrderId) {
        const id = String(providerOrderId || '').trim();
        if (!id) {
            throw new BusinessRuleError('FazerCards manual service order id is required.', 'FAZERCARDS_PROVIDER_ORDER_ID_REQUIRED');
        }

        return this.request('get', `/manual-services/orders/${encodeURIComponent(id)}/chat`, {
            context: 'manual_service_chat',
        });
    }

    sendManualServiceChat(providerOrderId, { message, attachment } = {}) {
        const id = String(providerOrderId || '').trim();
        if (!id) {
            throw new BusinessRuleError('FazerCards manual service order id is required.', 'FAZERCARDS_PROVIDER_ORDER_ID_REQUIRED');
        }
        if (attachment) {
            throw new BusinessRuleError(
                'FazerCards manual service chat attachments require multipart support verification.',
                'FAZERCARDS_MANUAL_SERVICE_ATTACHMENT_NEEDS_VERIFY'
            );
        }

        return this.request('post', `/manual-services/orders/${encodeURIComponent(id)}/chat`, {
            data: { message },
            context: 'manual_service_chat_message',
        });
    }

    getOrder(orderId) {
        const id = String(orderId || '').trim();
        if (!id) {
            throw new BusinessRuleError('FazerCards order id is required.', 'FAZERCARDS_PROVIDER_ORDER_ID_REQUIRED');
        }

        return this.request('get', `/orders/${encodeURIComponent(id)}`, {
            context: 'order_status',
        });
    }

    listOrders(params = {}) {
        return this.request('get', '/orders', {
            params,
            context: 'orders',
        });
    }

    getTopupOrderStatus({ providerOrderId } = {}) {
        const id = String(providerOrderId || '').trim();
        if (!id) {
            throw new BusinessRuleError('FazerCards providerOrderId is required.', 'FAZERCARDS_PROVIDER_ORDER_ID_REQUIRED');
        }

        const configuredPath = String(this.topupOrderStatusPath || '').trim();
        if (!configuredPath) return this.getOrder(id);

        const normalizedPath = configuredPath.startsWith('/') ? configuredPath : `/${configuredPath}`;
        const hasPlaceholder = normalizedPath.includes('{providerOrderId}');
        const path = hasPlaceholder
            ? normalizedPath.split('{providerOrderId}').join(encodeURIComponent(id))
            : normalizedPath;

        return this.request('get', path, {
            params: hasPlaceholder ? undefined : { order_id: id },
            context: 'topup_order_status',
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
