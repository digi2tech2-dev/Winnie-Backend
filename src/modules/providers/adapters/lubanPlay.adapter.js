'use strict';

const axios = require('axios');
const { BaseProviderAdapter } = require('./base.adapter');
const { redactSecretText } = require('../../../shared/utils/secretEncryption');

const DEFAULT_TIMEOUT_MS = 30_000;
const GIFT_CARD_MAX_QTY = 50;
const TOPUP_MAX_QTY = 20;
const DEFINITIVE_CREATE_ORDER_ERROR_CODES = new Set([
    'MISSING_PRODUCT_ID',
    'MISSING_GAME_ID',
    'MISSING_PACKAGE_ID',
    'MISSING_PLAYER_ID',
    'INVALID_QUANTITY',
    'MISSING_CLIENT_REFERENCE',
    'MISSING_AMOUNT',
    'INVALID_AMOUNT',
    'PRODUCT_NOT_AVAILABLE',
    'GAME_NOT_FOUND',
    'PACKAGE_NOT_FOUND',
    'INSUFFICIENT_BALANCE',
]);

const text = (value) => String(value ?? '').trim();
const normaliseBaseUrl = (baseUrl) => text(baseUrl).replace(/\/+$/, '');
const isAvailable = (value) => text(value).toLowerCase() === 'available';
const isUsd = (value) => text(value).toUpperCase() === 'USD';
const numberLike = (value) => value !== null && value !== undefined && text(value) !== '' && Number.isFinite(Number(value));
// Preserve the supplier's decimal strings for pricing.  Number() equality is
// not safe for high-precision prices, but it is still useful for validation.
const comparableDecimal = (value) => {
    if (!numberLike(value)) return null;
    const raw = text(value);
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(raw)) return null;
    const negative = raw.startsWith('-');
    const unsigned = raw.replace(/^[+-]/, '');
    const [whole, fraction = ''] = unsigned.split('.');
    const normalizedWhole = whole.replace(/^0+(?=\d)/, '') || '0';
    const normalizedFraction = fraction.replace(/0+$/, '');
    return `${negative ? '-' : ''}${normalizedWhole}${normalizedFraction ? `.${normalizedFraction}` : ''}`;
};
const sameDecimal = (left, right) => {
    const normalizedLeft = comparableDecimal(left);
    return normalizedLeft !== null && normalizedLeft === comparableDecimal(right);
};

const sanitize = (value) => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== 'object') return typeof value === 'string' ? redactSecretText(value) : value;
    return Object.entries(value).reduce((safe, [key, item]) => {
        safe[key] = /^(?:card_code|code|pin|serial_number)$/i.test(key) ? '[REDACTED]' : sanitize(item);
        return safe;
    }, {});
};

const extractCodes = (payload) => {
    const list = payload?.data?.codes ?? payload?.codes ?? [];
    if (!Array.isArray(list)) return [];
    return list.map((item) => ({
        code: item?.card_code ?? item?.code ?? null,
        pin: item?.pin ?? null,
        serial: item?.serial_number ?? item?.serial ?? null,
        expirationDate: item?.expiration_date ?? item?.expires_at ?? null,
    })).filter((item) => item.code || item.pin || item.serial);
};

const normaliseStatus = (value) => {
    switch (text(value).toLowerCase()) {
        case 'delivered': return 'Delivered';
        case 'processing': return 'Pending';
        case 'failed': return 'Failed';
        case 'refunded': return 'Refunded';
        default: return 'Pending';
    }
};

const getEnvelopeData = (payload) => payload?.data && typeof payload.data === 'object' ? payload.data : {};

class LubanPlayAdapter extends BaseProviderAdapter {
    constructor(provider, options = {}) {
        super(provider, options);
        const token = this._resolveToken();
        const baseURL = normaliseBaseUrl(provider.baseUrl);
        if (!baseURL) throw new Error('[LubanPlay] provider.baseUrl is required');
        if (!token) throw new Error('[LubanPlay] Bearer API key (apiToken/apiKey) is required');

        this._client = options.httpClient || axios.create({
            baseURL,
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
            },
        });
        // Sandbox permits 60 package-list requests/minute.  A sequential,
        // conservative default keeps a full sync inside that boundary without
        // introducing a supplier-specific scheduler.  Tests may set this to 0.
        this._packageRequestDelayMs = Math.max(0, Number(options.packageRequestDelayMs ?? 1_000) || 0);
    }

    _providerError(data, status = null) {
        const error = new Error(text(data?.message) || 'Luban Play rejected the request');
        error.providerBody = sanitize(data);
        error.providerCode = data?.code || null;
        error.requestId = data?.request_id || null;
        error.statusCode = status;
        // Only documented no-order rejections can enter the refund path. A
        // 202/409/429/500 may follow a received request or an idempotency
        // collision, so it must be reconciled by client_reference instead.
        error.definitive = DEFINITIVE_CREATE_ORDER_ERROR_CODES.has(String(data?.code || '').trim().toUpperCase());
        return error;
    }

    async _post(path, body = {}) {
        const form = new URLSearchParams();
        for (const [key, value] of Object.entries(body)) {
            if (value !== undefined && value !== null && value !== '') form.append(key, String(value));
        }
        try {
            const { data } = await this._client.post(path, form.toString());
            if (data?.success !== true) throw this._providerError(data);
            return data;
        } catch (error) {
            if (error.providerBody) throw error;
            const bodyData = error?.response?.data;
            if (bodyData?.success === false) throw this._providerError(bodyData, error.response?.status ?? null);
            throw error;
        }
    }

    async getBalance() {
        const payload = await this._post('/balance');
        const data = getEnvelopeData(payload);
        return { balances: data.balances || {}, environment: data.environment || null, requestId: payload.request_id || null };
    }

    _giftDto(item) {
        const eligible = item?.type === 'giftcard'
            && isAvailable(item.status)
            && isUsd(item.currency)
            && item.amount_required !== true
            && ((numberLike(item.price) && sameDecimal(item.face_value_min, item.face_value_max))
                || (sameDecimal(item.price_min, item.price_max) && sameDecimal(item.face_value_min, item.face_value_max)));
        const price = item.price ?? item.price_min ?? '0';
        return this._validateDTO({
            externalProductId: `LUBAN_GIFTCARD:${text(item.product_id)}`,
            rawName: text(item.name) || `Luban gift card ${text(item.product_id)}`,
            rawPrice: String(price),
            minQty: 1,
            maxQty: GIFT_CARD_MAX_QTY,
            currency: text(item.currency).toUpperCase() || null,
            available: isAvailable(item.status),
            isActive: eligible,
            category: 'giftcard',
            rawPayload: { ...item, lubanKind: 'giftcard', lubanEligible: eligible },
        });
    }

    _topupDto(game, packageItem) {
        const eligible = isAvailable(game.status) && isAvailable(packageItem.status)
            && isUsd(packageItem.currency) && numberLike(packageItem.price);
        return this._validateDTO({
            externalProductId: `LUBAN_TOPUP:${text(game.game_id)}:${text(packageItem.package_id)}`,
            rawName: text(packageItem.name) || `${text(game.name)} top-up`,
            rawPrice: String(packageItem.price ?? '0'),
            minQty: 1,
            maxQty: TOPUP_MAX_QTY,
            currency: text(packageItem.currency).toUpperCase() || null,
            available: isAvailable(game.status) && isAvailable(packageItem.status),
            isActive: eligible,
            category: 'game_topup',
            rawPayload: {
                ...packageItem,
                lubanKind: 'topup',
                game_id: game.game_id,
                game_name: game.name,
                external_game_id: game.external_game_id,
                delivery_type: game.delivery_type,
                server_type: game.server_type,
                lubanEligible: eligible,
            },
        });
    }

    async getProducts() {
        const [giftPayload, gamesPayload] = await Promise.all([
            this._post('/products'),
            this._post('/topupProducts'),
        ]);
        if (!Array.isArray(giftPayload.data)) {
            throw new Error('[LubanPlay] /products returned an invalid catalog envelope');
        }
        if (!Array.isArray(gamesPayload.data)) {
            throw new Error('[LubanPlay] /topupProducts returned an invalid catalog envelope');
        }
        const giftCards = giftPayload.data.filter((item) => item?.type === 'giftcard');
        for (const giftCard of giftCards) {
            if (!text(giftCard?.product_id)) {
                throw new Error('[LubanPlay] /products contained a gift card without product_id');
            }
        }
        const games = gamesPayload.data;
        const packagePayloads = [];
        for (let index = 0; index < games.length; index += 1) {
            if (index > 0 && this._packageRequestDelayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, this._packageRequestDelayMs));
            }
            const game = games[index];
            if (!text(game?.game_id)) {
                throw new Error('[LubanPlay] /topupProducts contained a game without game_id');
            }
            packagePayloads.push({ game, payload: await this._post('/topupPackages', { game_id: game.game_id }) });
        }
        const topups = packagePayloads.flatMap(({ game, payload }) => {
            const data = getEnvelopeData(payload);
            if (!data || Array.isArray(data) || !Array.isArray(data.packages)) {
                throw new Error(`[LubanPlay] /topupPackages returned an invalid package envelope for game ${text(game.game_id)}`);
            }
            if (data.game_id !== undefined && text(data.game_id) !== text(game.game_id)) {
                throw new Error(`[LubanPlay] /topupPackages returned a mismatched game_id for game ${text(game.game_id)}`);
            }
            if (data.packages.some((item) => !text(item?.package_id))) {
                throw new Error(`[LubanPlay] /topupPackages contained a package without package_id for game ${text(game.game_id)}`);
            }
            const effectiveGame = { ...game, ...data };
            return data.packages.map((item) => this._topupDto(effectiveGame, item));
        });
        return [...giftCards.map((item) => this._giftDto(item)), ...topups];
    }

    _orderPayload(params = {}) {
        const raw = params.providerProduct?.rawPayload || {};
        const reference = text(params.lubanClientReference || params.referenceId || params.localOrderId);
        if (!reference) throw new Error('[LubanPlay] stable client_reference is required');
        const quantity = Number(params.quantity ?? params.amount ?? 1);
        const kind = raw.lubanKind;
        if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > (kind === 'giftcard' ? GIFT_CARD_MAX_QTY : TOPUP_MAX_QTY)) {
            throw new Error('[LubanPlay] quantity is outside the documented range');
        }
        return { raw, reference, quantity, kind };
    }

    async placeOrder(params = {}) {
        let request;
        try {
            request = this._orderPayload(params);
            const { raw, reference, quantity, kind } = request;
            let payload;
            if (kind === 'giftcard') {
                payload = await this._post('/createOrder', { product_id: raw.product_id, quantity, client_reference: reference });
            } else if (kind === 'topup') {
                const values = params.params || {};
                const playerId = values.player_id ?? values.playerId;
                const serverId = values.server_id ?? values.serverId;
                if (!text(playerId)) throw new Error('[LubanPlay] player_id is required for game top-ups');
                payload = await this._post('/createTopupOrder', {
                    game_id: raw.game_id,
                    package_id: raw.package_id,
                    player_id: playerId,
                    server_id: serverId,
                    quantity,
                    client_reference: reference,
                });
            } else {
                throw new Error('[LubanPlay] provider product kind is unsupported');
            }
            return this._normaliseOrder(payload, { kind, reference });
        } catch (error) {
            if (error?.definitive || /required|outside the documented range|unsupported/i.test(error.message || '')) {
                return { success: false, providerOrderId: null, providerStatus: 'Failed', providerRequestId: error.requestId || null, rawResponse: error.providerBody || { message: error.message }, errorMessage: error.message };
            }
            return { success: false, manualReview: true, providerOrderId: null, providerStatus: 'Unknown', providerRequestId: error.requestId || null, rawResponse: error.providerBody || { transport: error.code || null }, errorMessage: 'Luban Play placement outcome is uncertain; reconcile by client_reference.' };
        }
    }

    _normaliseOrder(payload, { kind = null, reference = null } = {}) {
        const data = getEnvelopeData(payload);
        return {
            found: true,
            success: true,
            providerOrderId: data.order_id ? String(data.order_id) : null,
            providerStatus: normaliseStatus(data.status),
            providerRequestId: payload.request_id || null,
            referenceId: data.client_reference || reference,
            deliveryCodes: kind === 'giftcard' ? extractCodes(payload) : [],
            rawResponse: sanitize(payload),
            errorMessage: null,
        };
    }

    async checkOrderByReference(referenceId, kind) {
        if (!text(referenceId)) throw new Error('[LubanPlay] client_reference is required');
        try {
            const payload = await this._post(kind === 'topup' ? '/queryTopupOrder' : '/queryOrder', { client_reference: referenceId });
            return this._normaliseOrder(payload, { kind, reference: referenceId });
        } catch (error) {
            if (error?.statusCode === 404 || error?.providerCode === 'ORDER_NOT_FOUND') {
                return { found: false, providerOrderId: null, providerStatus: 'Pending', referenceId };
            }
            throw error;
        }
    }

    async checkOrder(orderId, options = {}) {
        const kind = options.kind || 'giftcard';
        const payload = await this._post(kind === 'topup' ? '/queryTopupOrder' : '/queryOrder', { order_id: orderId });
        return this._normaliseOrder(payload, { kind });
    }

    async checkOrders(orderIds) {
        if (!Array.isArray(orderIds) || orderIds.length === 0) return [];
        return Promise.all(orderIds.map(async (orderId) => {
            // The documentation does not promise an order-id prefix.  Try the
            // gift-card family first and switch only on the documented 404.
            try {
                return await this.checkOrder(text(orderId), { kind: 'giftcard' });
            } catch (error) {
                if (error?.statusCode !== 404 && error?.providerCode !== 'ORDER_NOT_FOUND') throw error;
                return this.checkOrder(text(orderId), { kind: 'topup' });
            }
        }));
    }
}

module.exports = { LubanPlayAdapter, GIFT_CARD_MAX_QTY, TOPUP_MAX_QTY };
