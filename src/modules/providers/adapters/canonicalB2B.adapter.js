'use strict';

/**
 * CanonicalB2BAdapter
 *
 * Reads another deployment's Canonical B2B API. `provider.baseUrl` is the
 * complete API base (for example, https://supplier.example/client/api), not
 * an origin to which this adapter may append paths.
 *
 * This adapter deliberately only translates remote API contracts. Wiring
 * placement/recovery into Winnie fulfillment belongs to a later stage.
 */

const axios = require('axios');
const { BaseProviderAdapter } = require('./base.adapter');
const { redactSecretText } = require('../../../shared/utils/secretEncryption');

const DEFAULT_TIMEOUT_MS = 180_000;
const SECRET_KEY = /token|api[_-]?key|authorization|password|secret|cookie|username/i;
const TRANSPORT_KEY = /^(?:headers?|request(?:headers?|config)?|response(?:headers?|config)?|axios(?:config)?|transport|http(?:client)?)$/i;
const INTERNAL_PARAM_KEY = /^(?:_.*|internal.*|fulfillment.*|_id|id|order(?:id|number|uuid)?|provider(?:id|orderid)?|referenceid|idempotencykey|(?:base|provider)?price|wallet(?:balance)?|balance|currency|metadata|raw(?:payload|response)?|request(?:headers?)?|response(?:headers?)?|user(?:id)?|customerid)$/i;

const sanitize = (value) => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== 'object') {
        return typeof value === 'string' ? redactSecretText(value) : value;
    }

    return Object.entries(value).reduce((safe, [key, item]) => {
        safe[key] = SECRET_KEY.test(key) || TRANSPORT_KEY.test(key) ? '[REDACTED]' : sanitize(item);
        return safe;
    }, {});
};

const normaliseBaseUrl = (baseUrl) => String(baseUrl || '').trim().replace(/\/+$/, '');

const assertCanonicalBaseUrl = (baseUrl) => {
    const normalized = normaliseBaseUrl(baseUrl);
    let parsed;
    try {
        parsed = new URL(normalized);
    } catch (_) {
        throw new Error('[CanonicalB2B] provider.baseUrl must be an absolute /client/api URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)
        || parsed.search
        || parsed.hash
        || !/\/client\/api$/i.test(parsed.pathname)) {
        throw new Error('[CanonicalB2B] provider.baseUrl must be the complete /client/api base URL');
    }
    return normalized;
};

const getErrorDetails = (error) => ({
    httpStatus: error?.response?.status ?? error?.statusCode ?? null,
    body: sanitize(error?.response?.data ?? error?.providerBody ?? null),
    message: redactSecretText(String(error?.message || 'Provider request failed')),
    code: error?.code || null,
});

const normaliseCanonicalStatus = (rawStatus) => {
    switch (String(rawStatus ?? '').toLowerCase().trim()) {
        case 'accept':
            return { providerStatus: 'accept', unifiedStatus: 'COMPLETED' };
        case 'reject':
            return { providerStatus: 'reject', unifiedStatus: 'FAILED' };
        case 'wait':
            return { providerStatus: 'wait', unifiedStatus: 'PENDING' };
        default:
            return { providerStatus: 'wait', unifiedStatus: 'PENDING' };
    }
};

const hasExplicitRejectStatus = (data) => {
    const nestedStatus = String(data?.data?.status ?? '').toLowerCase().trim();
    const topStatus = String(data?.status ?? '').toLowerCase().trim();
    return nestedStatus === 'reject' || topStatus === 'reject';
};

const canonicalErrorCode = (data) => {
    const code = data?.code ?? data?.data?.code;
    if (code === undefined || code === null || String(code).trim() === '') return null;
    const numericCode = Number(code);
    return Number.isFinite(numericCode) ? numericCode : null;
};

const isDefinitiveCanonicalRejection = (data, httpStatus = null) => {
    if (hasExplicitRejectStatus(data)) return true;
    if (httpStatus != null && httpStatus >= 500) return false;
    const code = canonicalErrorCode(data);
    if (code === 500) return false;
    return code !== null || data?.success === false;
};

const isUncertainPlacementError = (error) => {
    const details = getErrorDetails(error);
    if (hasExplicitRejectStatus(details.body)) return false;
    if (details.httpStatus == null || details.httpStatus >= 500) return true;
    return !isDefinitiveCanonicalRejection(details.body, details.httpStatus);
};

const makeFailureResult = ({ message, rawResponse, status = 'reject', providerOrderId = null }) => ({
    success: false,
    providerOrderId,
    providerStatus: status,
    unifiedStatus: status === 'reject' ? 'FAILED' : 'PENDING',
    rawResponse: sanitize(rawResponse),
    errorMessage: redactSecretText(String(message || 'Provider request failed')),
});

const makeUncertainPlacementResult = (referenceId, error) => {
    const details = getErrorDetails(error);
    return {
        success: true,
        providerOrderId: null,
        providerStatus: 'PLACEMENT_UNCERTAIN',
        unifiedStatus: 'PENDING',
        referenceId,
        rawResponse: {
            placement: 'uncertain',
            referenceId,
            httpStatus: details.httpStatus,
            upstreamCode: details.body?.code ?? null,
            transportCode: details.code,
            message: redactSecretText(String(details.body?.message ?? details.message)),
        },
        errorMessage: null,
    };
};

const readProducts = (data) => {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.data?.products)) return data.data.products;
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data?.products)) return data.products;
    return null;
};

const readCheckItems = (data) => {
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data)) return data;
    return [];
};

const normaliseQuantity = (qtyValues) => {
    if (qtyValues && typeof qtyValues === 'object' && !Array.isArray(qtyValues)) {
        const min = Number(qtyValues.min);
        const max = Number(qtyValues.max);
        if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max >= min) {
            return { minQty: min, maxQty: max };
        }
    }

    if (Array.isArray(qtyValues)) {
        const values = qtyValues.map(Number).filter((value) => Number.isFinite(value) && value > 0);
        if (values.length) return { minQty: Math.min(...values), maxQty: Math.max(...values) };
    }

    return { minQty: 1, maxQty: 1 };
};

const cleanCustomerParams = (params) => {
    const sources = [];
    if (params.params && typeof params.params === 'object' && !Array.isArray(params.params)) sources.push(params.params);
    if (params.customerParams && typeof params.customerParams === 'object' && !Array.isArray(params.customerParams)) {
        sources.push(params.customerParams);
    }

    const direct = Object.fromEntries(Object.entries(params).filter(([key]) => ![
        'externalProductId', 'providerProductId', 'productId', 'quantity', 'amount', 'qty',
        'referenceId', 'orderNumber', 'idempotencyKey', 'orderUuid', 'order_uuid',
        'params', 'customerParams', 'price', 'basePrice', 'providerPrice', 'walletBalance',
        'balance', 'currency', 'providerCode', 'providerOrderId', 'localOrderId',
        'retryMetadata', 'retryCount', 'attempt', 'attemptNumber', 'rawPayload', 'rawResponse',
        'metadata', 'fulfillment',
    ].includes(key)));
    sources.push(direct);

    return sources.reduce((result, source) => {
        for (const [key, value] of Object.entries(source)) {
            if (INTERNAL_PARAM_KEY.test(key) || SECRET_KEY.test(key) || value === undefined || value === null) continue;
            if (typeof value === 'object' && !Array.isArray(value)) continue;
            result[key] = value;
        }
        return result;
    }, {});
};

class CanonicalB2BAdapter extends BaseProviderAdapter {
    constructor(provider, options = {}) {
        super(provider, options);

        const token = this._resolveToken();
        const baseURL = assertCanonicalBaseUrl(provider.baseUrl);
        if (!token) throw new Error('[CanonicalB2B] api token (apiToken / apiKey) is required');

        this._client = options.httpClient || axios.create({
            baseURL,
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            headers: {
                'api-token': token,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
        });
    }

    async getBalance() {
        const { data } = await this._client.get('/profile');
        const profile = data?.data && typeof data.data === 'object' && !Array.isArray(data.data)
            ? data.data
            : data;
        return {
            balance: profile?.balance,
            currency: profile?.currency,
            email: profile?.email,
            rawResponse: sanitize(data),
        };
    }

    async getProducts() {
        const { data } = await this._client.get('/products');
        const products = readProducts(data);
        if (!products) throw new Error('[CanonicalB2B] GET /products returned an invalid product list');

        return products.map((product) => {
            const currency = product.currency == null ? '' : String(product.currency).trim().toUpperCase();
            if (currency && currency !== 'USD') {
                throw new Error(
                    `[CanonicalB2B] Product ${product.id ?? '<unknown>'} declares ${currency}; the provider price pipeline supports USD only.`
                );
            }
            const { minQty, maxQty } = normaliseQuantity(product.qty_values);
            return this._validateDTO({
                externalProductId: String(product.id ?? ''),
                rawName: String(product.name || 'Unknown'),
                rawPrice: String(product.price),
                minQty,
                maxQty,
                isActive: product.available !== false,
                available: product.available !== false,
                category: product.parent_id == null ? null : String(product.parent_id),
                categoryName: product.category_name ?? null,
                currency: 'USD',
                rawPayload: sanitize(product),
            });
        });
    }

    _normaliseCheckItem(item) {
        if (!item || item.order_id == null) return null;
        const status = normaliseCanonicalStatus(item.status);
        return {
            providerOrderId: item.order_id,
            ...status,
            rawResponse: sanitize(item),
        };
    }

    async checkOrders(orderIds) {
        if (!Array.isArray(orderIds) || orderIds.length === 0) return [];
        const { data } = await this._client.get('/check', { params: { orders: orderIds.join(',') } });
        const requested = new Set(orderIds.map(String));
        return readCheckItems(data)
            .map((item) => this._normaliseCheckItem(item))
            .filter((item) => item && requested.has(String(item.providerOrderId)));
    }

    async checkOrder(orderId) {
        const results = await this.checkOrders([orderId]);
        return results.find((result) => String(result.providerOrderId) === String(orderId)) || null;
    }

    async checkOrderByReference(referenceId) {
        const reference = String(referenceId || '').trim();
        if (!reference) throw new Error('[CanonicalB2B] referenceId is required for reference lookup');
        const { data } = await this._client.get('/check', { params: { uuids: reference } });
        const item = readCheckItems(data)
            .find((candidate) => String(candidate?.order_uuid || '') === reference);
        const normalized = this._normaliseCheckItem(item);
        return normalized ? { found: true, ...normalized } : { found: false, rawResponse: sanitize(data) };
    }

    async placeOrder(params = {}) {
        const externalProductId = String(params.externalProductId ?? params.providerProductId ?? '').trim();
        const quantity = params.quantity ?? params.amount ?? params.qty;
        const referenceId = String(params.referenceId ?? '').trim();
        if (!/^\d+$/.test(externalProductId) || Number(externalProductId) <= 0) {
            return makeFailureResult({
                message: 'Canonical B2B product ID must be a positive numeric compatibility ID',
                rawResponse: { validation: 'invalid_product_id' },
            });
        }
        if (!referenceId) {
            return makeFailureResult({
                message: 'Canonical B2B referenceId is required',
                rawResponse: { validation: 'missing_reference_id' },
            });
        }

        const payload = {
            product_id: Number(externalProductId),
            qty: quantity,
            order_uuid: referenceId,
            params: cleanCustomerParams(params),
        };

        try {
            const { data } = await this._client.post('/orders', payload);
            const order = data?.data;
            if (isDefinitiveCanonicalRejection(data)) {
                return makeFailureResult({
                    message: redactSecretText(String(order?.message ?? data?.message ?? 'Canonical B2B provider rejected the order')),
                    rawResponse: data,
                    providerOrderId: order?.order_id ?? null,
                });
            }
            if (String(data?.status ?? '').toUpperCase() !== 'OK' || !order?.order_id) {
                return makeUncertainPlacementResult(referenceId, {
                    providerBody: data,
                    message: 'Canonical B2B placement response is malformed or incomplete',
                });
            }
            const status = normaliseCanonicalStatus(order.status);
            if (status.providerStatus === 'reject') {
                return makeFailureResult({
                    message: redactSecretText(String(order.message ?? data?.message ?? 'Canonical B2B provider rejected the order')),
                    rawResponse: data,
                    providerOrderId: order.order_id,
                });
            }
            return {
                success: true,
                providerOrderId: order.order_id,
                ...status,
                rawResponse: sanitize(data),
                errorMessage: null,
            };
        } catch (error) {
            if (isUncertainPlacementError(error)) {
                return makeUncertainPlacementResult(referenceId, error);
            }
            const details = getErrorDetails(error);
            return makeFailureResult({
                message: redactSecretText(String(details.body?.message ?? details.message)),
                rawResponse: {
                    httpStatus: details.httpStatus,
                    code: details.body?.code ?? null,
                    message: redactSecretText(String(details.body?.message ?? details.message)),
                },
            });
        }
    }
}

module.exports = {
    CanonicalB2BAdapter,
    assertCanonicalBaseUrl,
    cleanCustomerParams,
    normaliseCanonicalStatus,
    normaliseBaseUrl,
    sanitize,
};
