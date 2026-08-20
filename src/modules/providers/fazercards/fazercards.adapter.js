'use strict';

const config = require('../../../config/config');
const { BaseProviderAdapter } = require('../adapters/base.adapter');
const { FULFILLMENT_MODES } = require('../providerProduct.model');
const { PROVIDER_CODES } = require('../provider.constants');
const { BusinessRuleError } = require('../../../shared/errors/AppError');
const { FazerCardsClient, sanitizePayload } = require('./fazercards.client');
const {
    NORMALIZED_STATUSES,
    parseFazerCardsOrderPayload,
} = require('./fazercardsStatus.service');

const asString = (value, fallback = null) => {
    if (value === null || value === undefined || value === '') return fallback;
    return String(value);
};

const firstValue = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

const normalizeText = (value) => String(value || '').trim().toUpperCase();

const parseBoolean = (value, fallback = null) => {
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === '1') return true;
    if (value === 0 || value === '0') return false;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', 'yes', 'available', 'active', 'in_stock', 'enabled'].includes(normalized)) return true;
        if (['false', 'no', 'unavailable', 'inactive', 'out_of_stock', 'disabled'].includes(normalized)) return false;
    }
    return fallback;
};

const parseNumber = (value, fallback = null) => {
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const getConfiguredMaxOrderUsd = () => {
    const max = Number(config.providers.fazerCards.maxOrderUsd);
    return Number.isFinite(max) && max > 0 ? max : null;
};

const stableHash = (value) => Buffer.from(JSON.stringify(value || {})).toString('base64url').slice(0, 32);

const toPlainObject = (value) => {
    if (!value) return value;
    if (typeof value.toObject === 'function') return value.toObject();
    return value;
};

const normalizeProviderCode = (value) => String(value || '').trim().toUpperCase();

const buildManualReviewResult = ({
    providerOrderId = null,
    providerStatus = 'Unknown',
    providerRequestId = null,
    providerIdempotencyKey = null,
    providerErrorCode,
    providerErrorMessage,
    providerMessage = null,
    rawResponse = null,
}) => ({
    success: false,
    manualReview: true,
    providerOrderId,
    providerStatus,
    providerRequestId,
    providerIdempotencyKey,
    providerErrorCode,
    providerErrorMessage,
    providerMessage,
    rawResponse: rawResponse || { errorCode: providerErrorCode, message: providerErrorMessage },
    errorMessage: providerErrorMessage,
});

const buildRejectedResult = ({
    providerStatus = 'Cancelled',
    providerIdempotencyKey = null,
    providerErrorCode,
    providerErrorMessage,
    rawResponse = null,
}) => ({
    success: false,
    providerOrderId: null,
    providerStatus,
    providerIdempotencyKey,
    providerErrorCode,
    providerErrorMessage,
    rawResponse: rawResponse || { errorCode: providerErrorCode, message: providerErrorMessage },
    errorMessage: providerErrorMessage,
});

const extractStructuredExternalProductParts = (externalProductId) => {
    const value = asString(externalProductId);
    if (!value || !value.startsWith('FAZER_TOPUP:')) return {};
    const [, categoryId, offerId] = value.split(':');
    return {
        categoryId: asString(categoryId),
        offerId: asString(offerId),
    };
};

const extractTopupIdentifiers = (providerProduct = {}) => {
    const externalParts = extractStructuredExternalProductParts(providerProduct.externalProductId);
    return {
        categoryId: asString(firstValue(
            providerProduct.category,
            providerProduct.rawPayload?.category?.category_id,
            providerProduct.rawPayload?.category?.categoryId,
            providerProduct.rawPayload?.category?.id,
            externalParts.categoryId
        )),
        offerId: asString(firstValue(
            providerProduct.offerId,
            providerProduct.rawPayload?.offer?.offer_id,
            providerProduct.rawPayload?.offer?.offerId,
            providerProduct.rawPayload?.offer?.id,
            externalParts.offerId
        )),
    };
};

const requiredFieldKey = (field) => asString(typeof field === 'string'
    ? field
    : firstValue(field?.key, field?.name, field?.id, field?.code));

const buildTopupFields = (params = {}, requiredFields = []) => {
    const source = params && typeof params === 'object' ? params : {};
    const output = {};
    const missing = [];

    for (const field of requiredFields) {
        const key = requiredFieldKey(field);
        if (!key) continue;
        const required = typeof field === 'string' ? true : field.required !== false;
        const raw = source[key];
        const isMissing = raw === undefined || raw === null || raw === '';
        if (required && isMissing) {
            missing.push(key);
            continue;
        }
        if (!isMissing) output[key] = String(raw);
    }

    return { fields: output, missing };
};

const normalizeTopupOrderStatus = (rawStatus) => {
    const normalized = String(rawStatus || '').trim().toLowerCase();
    if (['completed', 'complete', 'success', 'succeeded', 'done', 'fulfilled'].includes(normalized)) return { status: 'Completed', known: true, terminalFailure: false };
    if (['processing', 'pending', 'in_progress', 'in progress', 'inprogress'].includes(normalized)) return { status: 'Pending', known: true, terminalFailure: false };
    if (['failed', 'error', 'cancelled', 'canceled', 'refunded'].includes(normalized)) return { status: 'Cancelled', known: true, terminalFailure: true };
    return { status: rawStatus ? String(rawStatus) : 'Unknown', known: false, terminalFailure: false };
};

const extractTopupOrderNode = (data = {}) => (
    data?.order
    || data?.data?.order
    || data?.topup_order
    || data?.topupOrder
    || {}
);

const extractTopupOrderId = (data = {}, order = {}) => firstValue(
    order?.id,
    order?.order_id,
    order?.orderId,
    order?.topup_order_id,
    order?.topupOrderId,
    data?.order_id,
    data?.orderId
);

const extractTopupProviderRequestId = (data = {}, requestId = null) => firstValue(
    requestId,
    data?.requestId,
    data?.request_id,
    data?.traceId,
    data?.trace_id
);

const normalizeRequiredFields = (item = {}) => {
    const rawFields = firstValue(
        item.required_fields,
        item.requiredFields,
        item.fields,
        item.form_fields,
        item.inputs,
        item.customer_fields
    );
    const fields = [];

    if (Array.isArray(rawFields)) {
        for (const field of rawFields) {
            if (typeof field === 'string') {
                fields.push({ key: field, label: field, required: true, type: 'text' });
            } else if (field && typeof field === 'object') {
                const key = asString(firstValue(field.key, field.name, field.id, field.code));
                if (key) {
                    fields.push({
                        key,
                        label: asString(firstValue(field.label, field.title, field.name), key),
                        required: field.required !== false,
                        type: asString(field.type, 'text'),
                        options: Array.isArray(field.options) ? field.options : [],
                    });
                }
            }
        }
    }

    const flags = [
        ['player_id', item.requires_player_id ?? item.requiresPlayerId],
        ['account_id', item.requires_account_id ?? item.requiresAccountId],
        ['server', item.requires_server ?? item.requiresServer],
        ['zone', item.requires_zone ?? item.requiresZone],
        ['region', item.requires_region ?? item.requiresRegion],
    ];
    for (const [key, flag] of flags) {
        if (parseBoolean(flag, false) && !fields.some((field) => field.key === key)) {
            fields.push({ key, label: key, required: true, type: 'text' });
        }
    }

    return fields;
};

const classifyFulfillmentMode = (item = {}, requiredFields = []) => {
    const haystack = [
        item.fulfillmentMode,
        item.fulfillment_mode,
        item.delivery_type,
        item.product_type,
        item.kind,
        item.type,
        item.category,
        item.category_slug,
        item.name,
        item.title,
        item.description,
    ].map((value) => String(value || '').toLowerCase()).join(' ');

    const hasTargetField = requiredFields.some((field) => (
        /player|account|uid|user|server|zone|region/.test(String(field.key || field.name || '').toLowerCase())
    ));

    if (hasTargetField && /top[-_\s]?up|recharge|mobile|stars|premium|game/.test(haystack)) {
        return FULFILLMENT_MODES.TOPUP_WITH_FIELDS;
    }
    if (/gift[-_\s]?card|code|voucher|pin|key|steam[-_\s]?gift|game[-_\s]?key/.test(haystack)) {
        return FULFILLMENT_MODES.CODE_DELIVERY;
    }
    return FULFILLMENT_MODES.UNKNOWN;
};

const isBlockedRegion = (region, item = {}, blockedRegions = config.providers.fazerCards.blockedRegions) => {
    const tokens = [
        region,
        item.region,
        item.region_code,
        item.country,
        item.country_code,
        item.storefront,
        item.name,
        item.title,
    ].map(normalizeText).filter(Boolean);

    return blockedRegions.some((blocked) => (
        tokens.some((token) => token === blocked || token.includes(` ${blocked} `) || token.includes(`(${blocked})`))
    ));
};

const normalizeTopupMeta = (data = {}, params = {}) => ({
    total: data?.meta?.total ?? data?.total ?? null,
    limit: data?.meta?.limit ?? data?.limit ?? params.limit ?? null,
    next_cursor: data?.meta?.next_cursor ?? data?.meta?.nextCursor ?? data?.next_cursor ?? data?.nextCursor ?? null,
    has_more: Boolean(data?.meta?.has_more ?? data?.meta?.hasMore ?? data?.has_more ?? data?.hasMore ?? false),
});

const normalizeTopupCategoryPage = (data = {}, params = {}) => {
    const items = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.categories)
            ? data.categories
            : Array.isArray(data)
                ? data
                : [];

    return {
        ok: data?.ok !== false,
        items,
        meta: normalizeTopupMeta(data, params),
        malformed: !Array.isArray(data?.items) && !Array.isArray(data?.categories) && !Array.isArray(data),
    };
};

const normalizeTopupOffersResponse = (data = {}) => {
    const offers = Array.isArray(data?.offers)
        ? data.offers
        : Array.isArray(data?.items)
            ? data.items
            : [];
    const fields = Array.isArray(data?.fields) ? data.fields : [];
    const category = {
        category_id: firstValue(data?.category_id, data?.categoryId, data?.category?.category_id),
        name: firstValue(data?.name, data?.category_name, data?.categoryName, data?.category?.name),
        note: data?.note,
    };

    return {
        ok: data?.ok !== false,
        category,
        offers,
        fields,
        note: data?.note,
        malformed: !Array.isArray(data?.offers),
        raw: data,
    };
};

const normalizeTopupOfferProduct = ({ category = {}, offer = {}, fields = [] } = {}, options = {}) => {
    const categoryId = asString(firstValue(category.category_id, category.categoryId, category.id));
    const categoryName = asString(firstValue(category.name, category.title, category.display_name), categoryId || 'Unknown FazerCards category');
    const offerId = asString(firstValue(
        offer.offer_id,
        offer.offerId,
        offer.id,
        offer.product_id,
        offer.productId,
        offer.sku_id,
        offer.skuId
    ));
    const offerName = asString(firstValue(offer.name, offer.title, offer.display_name), offerId || 'Unknown FazerCards offer');
    const name = `${categoryName} - ${offerName}`;
    const priceSource = firstValue(offer.price_usd, offer.priceUsd, offer.cost_usd, offer.costUsd);
    const costPrice = parseNumber(priceSource, null);
    const rawFields = Array.isArray(fields) ? fields : [];
    const requiredFields = normalizeRequiredFields({ fields: rawFields });
    const region = asString(firstValue(
        offer.region,
        offer.region_code,
        offer.country,
        offer.country_code,
        offer.storefront,
        category.region,
        category.region_code,
        category.country,
        category.country_code,
        category.storefront
    ));
    const platform = asString(firstValue(offer.platform, offer.platform_name, category.platform, category.platform_name));
    const regionBlocked = isBlockedRegion(region, { ...category, ...offer, title: name }, options.blockedRegions);
    const hasValidPrice = priceSource !== undefined && priceSource !== null && priceSource !== '' && Number.isFinite(costPrice);
    const problems = [];

    if (!categoryId) problems.push('MISSING_CATEGORY_ID');
    if (!offerId) problems.push('MISSING_OFFER_ID');
    if (!hasValidPrice) problems.push('INVALID_PRICE_USD');
    if (!Array.isArray(fields) || requiredFields.length === 0) problems.push('MISSING_REQUIRED_FIELDS');
    if (regionBlocked) problems.push('BLOCKED_REGION');

    const isSupported = problems.length === 0;
    const blockReason = problems[0] || null;
    const externalProductId = categoryId && offerId
        ? `FAZER_TOPUP:${categoryId}:${offerId}`
        : `FAZER_TOPUP:${categoryId || 'unknown_category'}:${offerId || `unknown_offer:${stableHash({ category, offer })}`}`;

    return {
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        familyKey: 'TOPUPS',
        supportLevel: 'FULL_TOPUP_SUPPORTED',
        executionBlocked: false,
        externalProductId,
        name,
        rawName: name,
        category: categoryId || 'unknown',
        categoryName,
        offerId,
        offerName,
        subCategory: null,
        region,
        platform,
        currency: 'USD',
        costPrice,
        rawPrice: hasValidPrice ? String(priceSource) : '0',
        available: true,
        stock: null,
        minQty: parseNumber(firstValue(offer.min_order_quantity, offer.minQty, offer.min_qty, offer.min), 1) || 1,
        maxQty: parseNumber(firstValue(offer.max_order_quantity, offer.maxQty, offer.max_qty, offer.max), 9999) || 9999,
        isActive: true,
        rawPayload: {
            category: sanitizePayload(category),
            offer: sanitizePayload(offer),
            fields: sanitizePayload(rawFields),
        },
        fulfillmentMode: FULFILLMENT_MODES.TOPUP_WITH_FIELDS,
        isSupported,
        isBlocked: !isSupported,
        blockReason,
        requiredFields,
    };
};

class FazerCardsAdapter extends BaseProviderAdapter {
    constructor(provider, options = {}) {
        super(provider, options);

        const clientOptions = {
            baseUrl: options.baseUrl || provider.baseUrl || config.providers.fazerCards.apiBaseUrl,
            apiKey: options.apiKey || this._resolveToken() || config.providers.fazerCards.apiKey,
            timeoutMs: options.timeoutMs || config.providers.fazerCards.timeoutMs,
            topupOrderStatusPath: options.topupOrderStatusPath || config.providers.fazerCards.topupOrderStatusPath,
        };
        if (Object.prototype.hasOwnProperty.call(options, 'enabled')) {
            clientOptions.enabled = options.enabled;
        }

        this.client = options.client || new FazerCardsClient(clientOptions);
    }

    async getAccount() {
        const { data, requestId, status } = await this.client.getAccount();
        return { ok: data?.ok !== false, account: data, requestId, status };
    }

    async getBalance() {
        const { data, requestId, status } = await this.client.getBalance();
        return {
            ok: data?.ok !== false,
            balance: data?.balance ?? null,
            currency: data?.currency ?? 'USD',
            raw: data,
            requestId,
            status,
        };
    }

    async health() {
        const startedAt = Date.now();
        const account = await this.getAccount();
        return {
            success: true,
            provider: 'FazerCards',
            latencyMs: Date.now() - startedAt,
            account,
            testedAt: new Date().toISOString(),
        };
    }

    async fetchTopupCategoriesPage(params = {}) {
        const { data, requestId, status } = await this.client.fetchTopupCategoriesPage(params);
        const page = normalizeTopupCategoryPage(data, params);
        return {
            ...page,
            requestId,
            status,
            raw: data,
        };
    }

    async fetchTopupOffers(categoryId) {
        if (!categoryId) {
            throw new BusinessRuleError('FazerCards top-up category_id is required.', 'FAZERCARDS_MALFORMED_RESPONSE');
        }
        const { data, requestId, status } = await this.client.fetchTopupOffers({ categoryId });
        return {
            ...normalizeTopupOffersResponse(data),
            requestId,
            status,
        };
    }

    async fetchCatalogPath(path, params = {}, context = 'catalog_family') {
        const { data, requestId, status } = await this.client.fetchCatalogPath(path, params, context);
        return { data, requestId, status };
    }

    async fetchSteamGiftGame(appid) {
        const { data, requestId, status } = await this.client.getSteamGiftGame(appid);
        return { data, requestId, status };
    }

    async fetchSteamGiftGames(params = {}) {
        const { data, requestId, status } = await this.client.listSteamGiftGames(params);
        return { data, requestId, status };
    }

    normalizeTopupOfferProduct(input) {
        return normalizeTopupOfferProduct(input, this.options);
    }

    async getProducts() {
        const page = await this.fetchTopupCategoriesPage({ limit: this.options.limit || 100 });
        const products = [];
        for (const category of page.items) {
            const categoryId = asString(firstValue(category.category_id, category.categoryId, category.id));
            if (!categoryId) continue;
            const offerPage = await this.fetchTopupOffers(categoryId);
            const mergedCategory = { ...category, ...offerPage.category };
            for (const offer of offerPage.offers) {
                products.push(this.normalizeTopupOfferProduct({
                    category: mergedCategory,
                    offer,
                    fields: offerPage.fields,
                }));
            }
        }
        return products;
    }

    async placeOrder(params = {}) {
        const orderId = String(firstValue(params.localOrderId, params.orderId, params.order_id) || '').trim();
        const providerIdempotencyKey = orderId ? `fazercards:topup:${orderId}` : null;
        const product = toPlainObject(params.product);
        const providerProduct = toPlainObject(params.providerProduct);

        if (!orderId) {
            return buildManualReviewResult({
                providerIdempotencyKey,
                providerErrorCode: 'FAZERCARDS_ORDER_ID_MISSING',
                providerErrorMessage: 'Local order id is required for FazerCards idempotency.',
            });
        }

        if (!product) {
            return buildRejectedResult({
                providerIdempotencyKey,
                providerErrorCode: 'FAZERCARDS_PRODUCT_REQUIRED',
                providerErrorMessage: 'Product is required for FazerCards top-up execution.',
            });
        }

        if (!providerProduct) {
            return buildRejectedResult({
                providerIdempotencyKey,
                providerErrorCode: 'FAZERCARDS_PROVIDER_PRODUCT_REQUIRED',
                providerErrorMessage: 'Product is not linked to a FazerCards ProviderProduct.',
            });
        }

        const providerCode = normalizeProviderCode(firstValue(product.providerCode, providerProduct.providerCode));
        if (providerCode !== PROVIDER_CODES.FAZER_CARDS) {
            return buildRejectedResult({
                providerIdempotencyKey,
                providerErrorCode: 'FAZERCARDS_PROVIDER_PRODUCT_REQUIRED',
                providerErrorMessage: 'Product is not linked to FazerCards.',
            });
        }

        if (product.providerExecutionEnabled !== true) {
            return buildManualReviewResult({
                providerIdempotencyKey,
                providerErrorCode: 'FAZERCARDS_PROVIDER_EXECUTION_DISABLED',
                providerErrorMessage: 'FazerCards provider execution is disabled for this product.',
            });
        }

        const productMode = firstValue(product.fulfillmentMode, product.providerProductFulfillmentMode, providerProduct.fulfillmentMode);
        if (providerProduct.fulfillmentMode !== FULFILLMENT_MODES.TOPUP_WITH_FIELDS
            || (productMode && productMode !== FULFILLMENT_MODES.TOPUP_WITH_FIELDS)) {
            return buildRejectedResult({
                providerIdempotencyKey,
                providerErrorCode: 'FAZERCARDS_UNSUPPORTED_FULFILLMENT_MODE',
                providerErrorMessage: 'Only FazerCards TOPUP_WITH_FIELDS products can be executed.',
            });
        }

        if (providerProduct.isSupported !== true) {
            return buildRejectedResult({
                providerIdempotencyKey,
                providerErrorCode: 'FAZERCARDS_PROVIDER_PRODUCT_UNSUPPORTED',
                providerErrorMessage: 'Unsupported FazerCards ProviderProduct cannot be executed.',
            });
        }

        if (providerProduct.isBlocked === true) {
            return buildRejectedResult({
                providerIdempotencyKey,
                providerErrorCode: 'FAZERCARDS_PROVIDER_PRODUCT_BLOCKED',
                providerErrorMessage: 'Blocked FazerCards ProviderProduct cannot be executed.',
            });
        }

        const rawCost = firstValue(providerProduct.costPrice, providerProduct.rawPrice);
        const cost = Number(rawCost);
        if (rawCost === undefined || rawCost === null || rawCost === '' || !Number.isFinite(cost) || cost <= 0) {
            return buildRejectedResult({
                providerIdempotencyKey,
                providerErrorCode: 'FAZERCARDS_PROVIDER_PRODUCT_INVALID_COST',
                providerErrorMessage: 'FazerCards ProviderProduct has an invalid cost price.',
            });
        }

        const { categoryId, offerId } = extractTopupIdentifiers(providerProduct);
        if (!categoryId || !offerId) {
            return buildRejectedResult({
                providerIdempotencyKey,
                providerErrorCode: !categoryId ? 'FAZERCARDS_CATEGORY_ID_MISSING' : 'FAZERCARDS_OFFER_ID_MISSING',
                providerErrorMessage: 'FazerCards top-up category_id and offer_id are required.',
            });
        }

        const requiredFields = Array.isArray(providerProduct.requiredFields) ? providerProduct.requiredFields : [];
        if (requiredFields.length === 0) {
            return buildRejectedResult({
                providerIdempotencyKey,
                providerErrorCode: 'FAZERCARDS_REQUIRED_FIELDS_MISSING',
                providerErrorMessage: 'FazerCards ProviderProduct is missing required customer fields.',
            });
        }

        const { fields, missing } = buildTopupFields(params.params, requiredFields);
        if (missing.length > 0) {
            return buildRejectedResult({
                providerIdempotencyKey,
                providerErrorCode: 'FAZERCARDS_CUSTOMER_FIELDS_MISSING',
                providerErrorMessage: `Missing FazerCards customer field(s): ${missing.join(', ')}.`,
                rawResponse: { missingFields: missing },
            });
        }

        if (config.providers.fazerCards.enabled !== true) {
            return buildManualReviewResult({
                providerIdempotencyKey,
                providerErrorCode: 'FAZERCARDS_DISABLED',
                providerErrorMessage: 'FazerCards integration is disabled.',
                rawResponse: { gate: 'FAZERCARDS_ENABLED' },
            });
        }

        if (config.providers.fazerCards.realOrdersEnabled !== true) {
            return buildManualReviewResult({
                providerIdempotencyKey,
                providerErrorCode: 'FAZERCARDS_REAL_ORDERS_DISABLED',
                providerErrorMessage: 'FazerCards real orders are disabled by global safety gate.',
                rawResponse: { gate: 'FAZERCARDS_REAL_ORDERS_ENABLED' },
            });
        }

        const maxOrderUsd = getConfiguredMaxOrderUsd();
        if (maxOrderUsd !== null && cost > maxOrderUsd) {
            return buildManualReviewResult({
                providerIdempotencyKey,
                providerErrorCode: 'FAZERCARDS_MAX_COST_GUARD',
                providerErrorMessage: 'FazerCards order blocked by max cost guard.',
                rawResponse: { gate: 'FAZERCARDS_MAX_ORDER_USD', costPrice: cost, maxOrderUsd },
            });
        }

        let balanceResult;
        try {
            balanceResult = await this.getBalance();
        } catch (err) {
            return buildManualReviewResult({
                providerIdempotencyKey,
                providerRequestId: err.requestId || null,
                providerErrorCode: 'FAZERCARDS_BALANCE_UNKNOWN',
                providerErrorMessage: 'FazerCards balance could not be checked; provider execution requires manual review.',
                rawResponse: err.providerBody || {
                    errorCode: err.code || 'FAZERCARDS_BALANCE_UNKNOWN',
                    message: err.safeUpstreamMessage || err.message,
                },
            });
        }

        const balance = parseNumber(balanceResult?.balance, null);
        if (!Number.isFinite(balance)) {
            return buildManualReviewResult({
                providerIdempotencyKey,
                providerRequestId: balanceResult?.requestId || null,
                providerErrorCode: 'FAZERCARDS_BALANCE_UNKNOWN',
                providerErrorMessage: 'FazerCards balance response did not include a valid balance.',
                rawResponse: balanceResult?.raw || { balance: balanceResult?.balance ?? null },
            });
        }

        if (balance < cost) {
            return buildRejectedResult({
                providerIdempotencyKey,
                providerStatus: 'Cancelled',
                providerErrorCode: 'FAZERCARDS_INSUFFICIENT_PROVIDER_BALANCE',
                providerErrorMessage: 'FazerCards balance is insufficient for this top-up order.',
                rawResponse: {
                    gate: 'FAZERCARDS_BALANCE_PREFLIGHT',
                    balance,
                    costPrice: cost,
                    currency: balanceResult?.currency || providerProduct.currency || 'USD',
                },
            });
        }

        let response;
        try {
            response = await this.client.createTopupOrder({
                categoryId,
                offerId,
                fields,
                idempotencyKey: providerIdempotencyKey,
            });
        } catch (err) {
            const httpStatus = Number(err.httpStatus || err.statusCode || 0);
            const retryUnsafe = err.code === 'FAZERCARDS_TIMEOUT'
                || err.code === 'FAZERCARDS_NETWORK_ERROR'
                || httpStatus === 0
                || httpStatus === 429
                || httpStatus >= 500;

            if (retryUnsafe) {
                return buildManualReviewResult({
                    providerIdempotencyKey,
                    providerRequestId: err.requestId || null,
                    providerErrorCode: err.code || 'FAZERCARDS_TOPUP_ORDER_UNKNOWN',
                    providerErrorMessage: 'FazerCards top-up order outcome is uncertain and requires manual review.',
                    rawResponse: err.providerBody || {
                        errorCode: err.code || 'FAZERCARDS_TOPUP_ORDER_UNKNOWN',
                        message: err.safeUpstreamMessage || err.message,
                    },
                });
            }

            return buildRejectedResult({
                providerIdempotencyKey,
                providerErrorCode: err.code || 'FAZERCARDS_TOPUP_ORDER_REJECTED',
                providerErrorMessage: err.safeUpstreamMessage || err.message || 'FazerCards top-up order was rejected.',
                rawResponse: err.providerBody || { errorCode: err.code, message: err.safeUpstreamMessage || err.message },
            });
        }

        const data = response?.data || {};
        const order = extractTopupOrderNode(data);
        const providerOrderId = asString(extractTopupOrderId(data, order));
        const rawStatus = firstValue(order?.status, data?.status, order?.state, data?.state);
        const mapped = normalizeTopupOrderStatus(rawStatus);
        const providerRequestId = extractTopupProviderRequestId(data, response?.requestId);

        const baseResult = {
            providerOrderId,
            providerStatus: mapped.status,
            providerRequestId,
            providerIdempotencyKey,
            providerMessage: firstValue(order?.message, data?.message, null),
            providerErrorCode: firstValue(order?.errorCode, order?.error_code, data?.errorCode, data?.error_code, null),
            providerErrorMessage: firstValue(order?.errorMessage, order?.error_message, data?.errorMessage, data?.error_message, null),
            rawResponse: data,
            errorMessage: firstValue(order?.errorMessage, order?.error_message, data?.errorMessage, data?.error_message, null),
        };

        if (!mapped.known) {
            return buildManualReviewResult({
                ...baseResult,
                providerErrorCode: baseResult.providerErrorCode || 'FAZERCARDS_TOPUP_ORDER_UNKNOWN_STATUS',
                providerErrorMessage: baseResult.providerErrorMessage || 'FazerCards top-up order returned an unknown status.',
            });
        }

        if (!providerOrderId) {
            return buildManualReviewResult({
                ...baseResult,
                providerErrorCode: baseResult.providerErrorCode || 'FAZERCARDS_TOPUP_ORDER_ID_MISSING',
                providerErrorMessage: baseResult.providerErrorMessage || 'FazerCards top-up order response did not include order.id.',
            });
        }

        if (mapped.terminalFailure) {
            return {
                ...baseResult,
                success: false,
                providerStatus: 'Cancelled',
                providerErrorCode: baseResult.providerErrorCode || 'FAZERCARDS_TOPUP_ORDER_FAILED',
                providerErrorMessage: baseResult.providerErrorMessage || 'FazerCards top-up order failed.',
                errorMessage: baseResult.errorMessage || 'FazerCards top-up order failed.',
            };
        }

        return {
            ...baseResult,
            success: true,
        };
    }

    async getTopupOrderStatus({ providerOrderId } = {}) {
        const normalizedProviderOrderId = asString(providerOrderId);
        if (!normalizedProviderOrderId) {
            return buildManualReviewResult({
                providerErrorCode: 'FAZERCARDS_ORDER_NOT_SENT',
                providerErrorMessage: 'FazerCards providerOrderId is required for status checks.',
            });
        }

        let response;
        try {
            response = await this.client.getTopupOrderStatus({ providerOrderId: normalizedProviderOrderId });
        } catch (err) {
            const statusUnknown = err.code === 'FAZERCARDS_TIMEOUT'
                || err.code === 'FAZERCARDS_NETWORK_ERROR'
                || err.code === 'FAZERCARDS_HTTP_ERROR';
            const errorCode = statusUnknown
                ? 'FAZERCARDS_STATUS_UNKNOWN'
                : err.code || 'FAZERCARDS_STATUS_UNKNOWN';
            return buildManualReviewResult({
                providerOrderId: normalizedProviderOrderId,
                providerRequestId: err.requestId || null,
                providerErrorCode: errorCode,
                providerErrorMessage: err.code === 'FAZERCARDS_STATUS_ENDPOINT_UNCONFIRMED'
                    ? 'FazerCards top-up order status endpoint is not confirmed/configured.'
                    : 'FazerCards top-up status is unknown and requires manual review.',
                rawResponse: err.providerBody || {
                    errorCode,
                    message: err.safeUpstreamMessage || err.message,
                },
            });
        }

        const data = response?.data || {};
        const parsed = parseFazerCardsOrderPayload(data, {
            fallbackProviderOrderId: normalizedProviderOrderId,
            requestId: response?.requestId,
        });
        const baseResult = {
            providerOrderId: parsed.providerOrderId || normalizedProviderOrderId,
            providerStatus: parsed.providerStatus,
            providerRequestId: parsed.providerRequestId,
            providerMessage: parsed.providerMessage,
            providerErrorCode: parsed.providerErrorCode,
            providerErrorMessage: parsed.providerErrorMessage,
            rawResponse: data,
            errorMessage: parsed.providerErrorMessage || parsed.errorMessage,
            normalizedStatus: parsed.normalizedStatus,
        };

        if (!parsed.knownStatus || !parsed.providerOrderId) {
            return buildManualReviewResult({
                ...baseResult,
                providerErrorCode: baseResult.providerErrorCode || 'FAZERCARDS_STATUS_UNKNOWN',
                providerErrorMessage: baseResult.providerErrorMessage || 'FazerCards top-up order returned an unknown status.',
            });
        }

        if (parsed.normalizedStatus === NORMALIZED_STATUSES.FAILED || parsed.normalizedStatus === NORMALIZED_STATUSES.REFUNDED) {
            return {
                ...baseResult,
                success: false,
                providerStatus: parsed.providerStatus,
                providerErrorCode: baseResult.providerErrorCode || 'FAZERCARDS_TOPUP_ORDER_FAILED',
                providerErrorMessage: baseResult.providerErrorMessage || 'FazerCards top-up order failed.',
                errorMessage: baseResult.errorMessage || 'FazerCards top-up order failed.',
            };
        }

        return {
            ...baseResult,
            success: true,
        };
    }

    async getOrderStatus({ providerOrderId } = {}) {
        return this.getTopupOrderStatus({ providerOrderId });
    }

    async checkOrder(providerOrderId) {
        return this.getOrderStatus({ providerOrderId });
    }

    async checkOrders(orderIds = []) {
        const ids = Array.isArray(orderIds) ? orderIds : [];
        return Promise.all(ids.map((providerOrderId) => this.checkOrder(providerOrderId)));
    }
}

module.exports = {
    FazerCardsAdapter,
    normalizeTopupOfferProduct,
    normalizeTopupCategoryPage,
    normalizeTopupOffersResponse,
    classifyFulfillmentMode,
    normalizeRequiredFields,
    isBlockedRegion,
    extractTopupIdentifiers,
    buildTopupFields,
    normalizeTopupOrderStatus,
};
