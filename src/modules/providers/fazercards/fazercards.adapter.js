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

const normalizeCatalogProduct = (item = {}, options = {}) => {
    const externalProductId = asString(firstValue(
        item.sku_id,
        item.skuId,
        item.id,
        item.product_id,
        item.productId,
        item.card_id,
        item.key_id
    ));
    const title = asString(firstValue(item.title, item.name, item.product_name, item.display_name), 'Unknown FazerCards product');
    const category = asString(firstValue(item.category, item.category_slug, item.kind, item.type), 'unknown');
    const subCategory = asString(firstValue(item.subCategory, item.sub_category, item.brand, item.brand_name));
    const region = asString(firstValue(item.region, item.region_code, item.country, item.country_code, item.storefront));
    const platform = asString(firstValue(item.platform, item.platform_name, item.device));
    const currency = asString(firstValue(item.currency, item.price_currency, item.cost_currency), 'USD')?.toUpperCase();
    const costPrice = asString(firstValue(item.costPrice, item.cost_price, item.price_usd, item.wholesale_price, item.price, item.cost), '0');
    const stock = parseNumber(firstValue(item.stock, item.quantity_available, item.available_stock, item.qty), null);
    const explicitAvailable = parseBoolean(firstValue(item.available, item.is_available, item.active, item.enabled, item.status), null);
    const available = explicitAvailable !== null ? explicitAvailable : (stock === null ? true : stock > 0);
    const requiredFields = normalizeRequiredFields(item);
    const fulfillmentMode = classifyFulfillmentMode(item, requiredFields);
    const regionBlocked = isBlockedRegion(region, item, options.blockedRegions);
    const isCodeDelivery = fulfillmentMode === FULFILLMENT_MODES.CODE_DELIVERY;
    const isSupported = fulfillmentMode === FULFILLMENT_MODES.TOPUP_WITH_FIELDS && requiredFields.length > 0;
    const blockReason = regionBlocked
        ? 'BLOCKED_REGION'
        : isCodeDelivery
            ? 'CODE_DELIVERY_NOT_SUPPORTED_IN_PHASE_1'
            : !isSupported
                ? 'UNSUPPORTED_FULFILLMENT_MODE'
                : null;

    return {
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        externalProductId: externalProductId || `unknown:${Buffer.from(JSON.stringify(item)).toString('base64url').slice(0, 32)}`,
        rawName: title,
        title,
        category,
        subCategory,
        region,
        platform,
        currency,
        costPrice,
        rawPrice: costPrice,
        available,
        stock,
        minQty: parseNumber(firstValue(item.min_order_quantity, item.minQty, item.min_qty, item.min), 1) || 1,
        maxQty: parseNumber(firstValue(item.max_order_quantity, item.maxQty, item.max_qty, item.max), 9999) || 9999,
        isActive: available,
        rawPayload: sanitizePayload(item),
        fulfillmentMode,
        isSupported,
        isBlocked: Boolean(blockReason),
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

    async fetchCatalogPage(params = {}) {
        const { data, requestId, status } = await this.client.fetchCatalogPage(params);
        const items = Array.isArray(data?.items)
            ? data.items
            : Array.isArray(data?.products)
                ? data.products
                : Array.isArray(data)
                    ? data
                    : [];

        if (!Array.isArray(items)) {
            throw new BusinessRuleError('FazerCards catalog response is malformed.', 'FAZERCARDS_MALFORMED_RESPONSE');
        }

        return {
            ok: data?.ok !== false,
            items,
            meta: data?.meta || {
                total: data?.total ?? null,
                limit: data?.limit ?? params.limit ?? null,
                next_cursor: data?.next_cursor ?? data?.nextCursor ?? null,
                has_more: data?.has_more ?? data?.hasMore ?? false,
            },
            requestId,
            status,
            raw: data,
        };
    }

    normalizeCatalogProduct(item) {
        return normalizeCatalogProduct(item, this.options);
    }

    async getProducts() {
        const page = await this.fetchCatalogPage({ limit: this.options.limit || 100 });
        return page.items.map((item) => this.normalizeCatalogProduct(item));
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
    normalizeCatalogProduct,
    classifyFulfillmentMode,
    normalizeRequiredFields,
    isBlockedRegion,
};
