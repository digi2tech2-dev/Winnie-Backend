'use strict';

const XENA_PROVIDER_CODE = 'xena-recharge';
const XENA_EXTERNAL_PRODUCT_ID = 'xena-dynamic-recharge';
const XENA_TARGET_FIELD_KEY = 'target_uid';
const XENA_LEGACY_TARGET_FIELD_KEY = 'account_id';

const normalizeText = (value) => String(value || '').trim().toLowerCase();
const toPlain = (value) => (value && typeof value.toObject === 'function' ? value.toObject() : value);

const isXenaProviderLike = (provider = {}) => {
    const plain = toPlain(provider) || {};
    return [
        plain.code,
        plain.slug,
        plain.name,
        plain.providerCode,
        plain.displayName,
    ].some((value) => {
        const normalized = normalizeText(value);
        return normalized === XENA_PROVIDER_CODE || normalized === 'xena recharge';
    });
};

const isXenaProviderProductLike = (providerProduct = {}) => {
    const plain = toPlain(providerProduct) || {};
    const rawPayload = plain.rawPayload && typeof plain.rawPayload === 'object' ? plain.rawPayload : {};
    return normalizeText(plain.externalProductId) === XENA_EXTERNAL_PRODUCT_ID
        || normalizeText(rawPayload.externalProductId) === XENA_EXTERNAL_PRODUCT_ID
        || normalizeText(rawPayload.providerCode) === XENA_PROVIDER_CODE
        || rawPayload.synthetic === true;
};

const isXenaProductLike = (product = {}) => {
    const plain = toPlain(product) || {};
    return normalizeText(plain.providerCode) === XENA_PROVIDER_CODE
        || normalizeText(plain.providerSlug) === XENA_PROVIDER_CODE
        || normalizeText(plain.providerName) === 'xena recharge'
        || normalizeText(plain.providerProductExternalId) === XENA_EXTERNAL_PRODUCT_ID
        || isXenaProviderLike(plain.provider)
        || isXenaProviderProductLike(plain.providerProduct);
};

const isXenaTargetKey = (key) => {
    const normalized = normalizeText(key);
    return normalized === XENA_TARGET_FIELD_KEY || normalized === XENA_LEGACY_TARGET_FIELD_KEY;
};

const canonicalLabel = (field = {}) => {
    if (normalizeText(field.key || field.name) === XENA_LEGACY_TARGET_FIELD_KEY) {
        return 'Xena ID';
    }

    const label = String(field.label || '').trim();
    return label && normalizeText(label) !== XENA_LEGACY_TARGET_FIELD_KEY ? label : 'Xena ID';
};

const canonicalOrderField = (field = {}) => ({
    ...field,
    id: field.id || XENA_TARGET_FIELD_KEY,
    key: XENA_TARGET_FIELD_KEY,
    label: canonicalLabel(field),
    type: 'text',
    required: true,
    isActive: field.isActive !== false,
});

const canonicalDynamicField = (field = {}) => ({
    ...field,
    name: XENA_TARGET_FIELD_KEY,
    label: canonicalLabel(field),
    type: 'text',
    required: true,
    isActive: field.isActive !== false,
});

const canonicalizeOrderFields = (fields = []) => {
    let usedTarget = false;
    return (Array.isArray(fields) ? fields : [])
        .map((field) => {
            const plain = toPlain(field) || {};
            if (!isXenaTargetKey(plain.key || plain.name)) return plain;
            if (usedTarget) return null;
            usedTarget = true;
            return canonicalOrderField(plain);
        })
        .filter(Boolean);
};

const canonicalizeDynamicFields = (fields = []) => {
    let usedTarget = false;
    return (Array.isArray(fields) ? fields : [])
        .map((field) => {
            const plain = toPlain(field) || {};
            if (!isXenaTargetKey(plain.name || plain.key)) return plain;
            if (usedTarget) return null;
            usedTarget = true;
            return canonicalDynamicField(plain);
        })
        .filter(Boolean);
};

const dynamicFieldsFromOrderFields = (orderFields = []) => (
    canonicalizeOrderFields(orderFields).map((field) => ({
        name: field.key,
        label: field.label,
        type: field.type,
        required: field.required !== false,
        options: Array.isArray(field.options) ? field.options : [],
        min: field.min ?? null,
        max: field.max ?? null,
        isActive: field.isActive !== false,
    }))
);

const canonicalizeXenaProductUpdate = (updates = {}, productContext = {}) => {
    if (!isXenaProductLike(productContext)) return updates;

    const next = { ...updates };
    if (Array.isArray(next.orderFields)) {
        next.orderFields = canonicalizeOrderFields(next.orderFields);
        next.dynamicFields = dynamicFieldsFromOrderFields(next.orderFields);
    } else if (Array.isArray(next.dynamicFields)) {
        next.dynamicFields = canonicalizeDynamicFields(next.dynamicFields);
    }

    return next;
};

const canonicalizeXenaProductForResponse = (product = {}) => {
    if (!isXenaProductLike(product)) return product;

    const plain = toPlain(product) || {};
    return {
        ...plain,
        orderFields: canonicalizeOrderFields(plain.orderFields),
        dynamicFields: Array.isArray(plain.orderFields) && plain.orderFields.length
            ? dynamicFieldsFromOrderFields(plain.orderFields)
            : canonicalizeDynamicFields(plain.dynamicFields),
        providerCode: XENA_PROVIDER_CODE,
        providerProductExternalId: XENA_EXTERNAL_PRODUCT_ID,
    };
};

module.exports = {
    XENA_EXTERNAL_PRODUCT_ID,
    XENA_LEGACY_TARGET_FIELD_KEY,
    XENA_PROVIDER_CODE,
    XENA_TARGET_FIELD_KEY,
    canonicalizeXenaProductForResponse,
    canonicalizeXenaProductUpdate,
    isXenaProductLike,
};
