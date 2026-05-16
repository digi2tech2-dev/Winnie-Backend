'use strict';

const { Product } = require('../products/product.model');
const { validateDynamicFields } = require('./orderFields.validator');
const { ValidationError, NotFoundError } = require('../../shared/errors/AppError');
const catchAsync = require('../../shared/utils/catchAsync');

const getSubmittedDynamicData = (body = {}) => {
    if (body.dynamicData && typeof body.dynamicData === 'object' && !Array.isArray(body.dynamicData)) {
        return body.dynamicData;
    }

    if (body.orderFieldsValues && typeof body.orderFieldsValues === 'object' && !Array.isArray(body.orderFieldsValues)) {
        return body.orderFieldsValues;
    }

    return {};
};

const validateOrderDynamicFields = catchAsync(async (req, res, next) => {
    const { productId } = req.body;
    if (!productId) {
        throw new ValidationError('Product ID is required.');
    }

    const product = await Product.findById(productId).select('dynamicFields');
    if (!product) {
        throw new NotFoundError('Product');
    }

    const dynamicFields = Array.isArray(product.dynamicFields) ? product.dynamicFields : [];
    const activeFields = dynamicFields.filter((field) => field.isActive !== false);

    if (activeFields.length === 0) {
        req.validatedDynamicInput = null;
        return next();
    }

    const dynamicData = getSubmittedDynamicData(req.body);
    req.validatedDynamicInput = validateDynamicFields(activeFields, dynamicData);

    return next();
});

module.exports = validateOrderDynamicFields;
