'use strict';

const { Product } = require('../products/product.model');
const { validateDynamicFields } = require('./orderFields.validator');
const { ValidationError, NotFoundError } = require('../../shared/errors/AppError');
const catchAsync = require('../../shared/utils/catchAsync');
const {
    XENA_LEGACY_TARGET_FIELD_KEY,
    XENA_TARGET_FIELD_KEY,
    isXenaProductLike,
} = require('../providers/xena/xenaProductFields');

const getSubmittedDynamicData = (body = {}) => {
    if (body.dynamicData && typeof body.dynamicData === 'object' && !Array.isArray(body.dynamicData)) {
        return body.dynamicData;
    }

    if (body.orderFieldsValues && typeof body.orderFieldsValues === 'object' && !Array.isArray(body.orderFieldsValues)) {
        return body.orderFieldsValues;
    }

    return {};
};

const isXenaTargetField = (field = {}) => {
    const name = String(field.name || field.key || '').trim();
    return name === XENA_TARGET_FIELD_KEY || name === XENA_LEGACY_TARGET_FIELD_KEY;
};

const buildXenaAliasField = (field, name) => ({
    name,
    label: field?.label || 'Xena ID',
    type: 'text',
    required: field?.required !== false,
    options: Array.isArray(field?.options) ? field.options : [],
    min: field?.min ?? null,
    max: field?.max ?? null,
    isActive: field?.isActive !== false,
});

const normalizeXenaDynamicFields = (dynamicFields = []) => {
    const targetField = dynamicFields.find(isXenaTargetField);
    if (!targetField) return dynamicFields;

    return [
        ...dynamicFields.filter((field) => !isXenaTargetField(field)),
        buildXenaAliasField(targetField, XENA_TARGET_FIELD_KEY),
        buildXenaAliasField(targetField, XENA_LEGACY_TARGET_FIELD_KEY),
    ];
};

const normalizeXenaDynamicData = (values = {}) => {
    const normalized = values && typeof values === 'object' && !Array.isArray(values)
        ? { ...values }
        : {};
    const targetUid = normalized[XENA_TARGET_FIELD_KEY];
    const accountId = normalized[XENA_LEGACY_TARGET_FIELD_KEY];

    if ((targetUid === undefined || targetUid === null || targetUid === '') && accountId !== undefined) {
        normalized[XENA_TARGET_FIELD_KEY] = accountId;
    }
    if ((accountId === undefined || accountId === null || accountId === '') && targetUid !== undefined) {
        normalized[XENA_LEGACY_TARGET_FIELD_KEY] = targetUid;
    }

    return normalized;
};

const validateOrderDynamicFields = catchAsync(async (req, res, next) => {
    const { productId } = req.body;
    if (!productId) {
        throw new ValidationError('Product ID is required.');
    }

    const product = await Product.findById(productId)
        .select('dynamicFields orderFields provider providerProduct')
        .populate('provider', 'name slug code')
        .populate('providerProduct', 'externalProductId rawPayload');
    if (!product) {
        throw new NotFoundError('Product');
    }

    const isXena = isXenaProductLike(product);
    const dynamicFields = isXena
        ? normalizeXenaDynamicFields(Array.isArray(product.dynamicFields) ? product.dynamicFields : [])
        : Array.isArray(product.dynamicFields) ? product.dynamicFields : [];
    const activeFields = dynamicFields.filter((field) => field.isActive !== false);

    if (activeFields.length === 0) {
        req.validatedDynamicInput = null;
        return next();
    }

    const dynamicData = isXena
        ? normalizeXenaDynamicData(getSubmittedDynamicData(req.body))
        : getSubmittedDynamicData(req.body);
    req.validatedDynamicInput = validateDynamicFields(activeFields, dynamicData);

    return next();
});

module.exports = validateOrderDynamicFields;
