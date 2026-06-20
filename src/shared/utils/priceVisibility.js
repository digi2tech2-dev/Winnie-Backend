'use strict';

const SUPERVISOR_ROLE = 'SUPERVISOR';

const SENSITIVE_PRICING_FIELDS = new Set([
    'basePrice',
    'basePriceCoins',
    'providerPrice',
    'rawPrice',
    'price',
    'originalPrice',
    'original_price',
    'cost',
    'costPrice',
    'internalCost',
    'providerCost',
    'provider_cost',
    'supplierCost',
    'supplier_cost',
    'supplierPrice',
    'api_price',
    'provider_price',
    'product_price',
    'rate',
    'rateSnapshot',
    'basePriceSnapshot',
    'providerPriceSnapshot',
    'markupType',
    'markupValue',
    'markupPercentageSnapshot',
    'manualPriceAdjustment',
    'manualDelta',
    'enableManualPrice',
    'syncPriceWithProvider',
    'pricingMode',
    'provider',
    'supplier',
    'providerProduct',
    'providerProductId',
    'providerProductName',
    'providerProductCode',
    'providerMapping',
    'providerId',
    'providerName',
    'providerSlug',
    'supplierId',
    'supplierName',
    'supplierSlug',
    'supplierProduct',
    'supplierProductId',
    'supplierFieldMappings',
    'fallbackSupplierId',
    'supplierNotes',
    'providerQuantity',
    'externalProductId',
    'externalProductName',
    'externalId',
    'rawName',
    'orderFieldsMapping',
    'syncedProviderBasePrice',
    'supplierMarginType',
    'supplierMarginValue',
    'externalPricingMode',
    'rawPayload',
    'rawResponse',
    'providerRawResponse',
    'supplierResponseSnapshot',
    'providerResponseSnapshot',
    'profitUsd',
    'profitUsdSnapshot',
    'profit',
    'margin',
    'marginUsd',
    'netProfit',
    'totalProfitUsd',
]);

const isSupervisorRole = (userOrRole) => {
    const role = typeof userOrRole === 'string' ? userOrRole : userOrRole?.role;
    return String(role || '').trim().toUpperCase() === SUPERVISOR_ROLE;
};

const isObjectIdLike = (value) => (
    value
    && typeof value === 'object'
    && (
        value._bsontype === 'ObjectID'
        || value._bsontype === 'ObjectId'
        || typeof value.toHexString === 'function'
    )
);

const isPlainSanitizableObject = (value) => (
    value
    && typeof value === 'object'
    && !(value instanceof Date)
    && !Buffer.isBuffer(value)
    && !isObjectIdLike(value)
);

const toPlainObject = (value) => {
    if (value && typeof value.toObject === 'function') {
        return value.toObject({
            getters: true,
            virtuals: false,
            flattenMaps: true,
        });
    }

    if (value instanceof Map) {
        return Object.fromEntries(value);
    }

    return value;
};

const getSafeSellingPrice = (obj) => (
    obj.finalPrice
    ?? obj.sellingPrice
    ?? obj.displayPrice
    ?? obj.markedUpPriceUSD
    ?? obj.price
    ?? obj.totalPrice
    ?? obj.finalPriceCharged
    ?? obj.chargedAmount
    ?? obj.walletDeducted
);

const preserveSafeSellingAliases = (obj) => {
    const hasInternalBasePrice = obj.basePrice !== undefined || obj.basePriceCoins !== undefined;
    if (!hasInternalBasePrice) return;

    const safeSellingPrice = getSafeSellingPrice(obj);
    if (safeSellingPrice === undefined || safeSellingPrice === null) return;

    if (obj.finalPrice === undefined || obj.finalPrice === null) {
        obj.finalPrice = safeSellingPrice;
    }

    if (obj.sellingPrice === undefined || obj.sellingPrice === null) {
        obj.sellingPrice = safeSellingPrice;
    }
};

const sanitizePricingPayload = (payload) => {
    const plain = toPlainObject(payload);

    if (Array.isArray(plain)) {
        return plain.map(sanitizePricingPayload);
    }

    if (!isPlainSanitizableObject(plain)) {
        return plain;
    }

    const source = { ...plain };
    preserveSafeSellingAliases(source);

    return Object.entries(source).reduce((result, [key, value]) => {
        if (SENSITIVE_PRICING_FIELDS.has(key)) {
            return result;
        }

        result[key] = sanitizePricingPayload(value);
        return result;
    }, {});
};

const sanitizePricingForSupervisor = (payload, userOrRole) => (
    isSupervisorRole(userOrRole) ? sanitizePricingPayload(payload) : payload
);

const getSensitivePricingFieldNames = (payload) => {
    if (!payload || typeof payload !== 'object') {
        return [];
    }

    return Object.keys(payload).filter((key) => SENSITIVE_PRICING_FIELDS.has(key));
};

module.exports = {
    SENSITIVE_PRICING_FIELDS,
    isSupervisorRole,
    sanitizePricingPayload,
    sanitizePricingForSupervisor,
    getSensitivePricingFieldNames,
};
