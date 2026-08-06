'use strict';

const config = require('../../../config/config');
const { BaseProviderAdapter } = require('../adapters/base.adapter');
const { FULFILLMENT_MODES } = require('../providerProduct.model');
const { PROVIDER_CODES } = require('../provider.constants');
const { BusinessRuleError } = require('../../../shared/errors/AppError');
const { FazerCardsClient, sanitizePayload } = require('./fazercards.client');

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

const stableHash = (value) => Buffer.from(JSON.stringify(value || {})).toString('base64url').slice(0, 32);

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
    const offerId = asString(firstValue(offer.offer_id, offer.offerId, offer.id, offer.sku_id, offer.skuId));
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

    async placeOrder() {
        throw new BusinessRuleError('FazerCards order execution is not implemented in this phase.', 'FAZERCARDS_ORDER_EXECUTION_NOT_IMPLEMENTED');
    }

    async checkOrder() {
        throw new BusinessRuleError('FazerCards order status checks are not implemented in this phase.', 'FAZERCARDS_ORDER_EXECUTION_NOT_IMPLEMENTED');
    }

    async checkOrders() {
        throw new BusinessRuleError('FazerCards order status checks are not implemented in this phase.', 'FAZERCARDS_ORDER_EXECUTION_NOT_IMPLEMENTED');
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
};
