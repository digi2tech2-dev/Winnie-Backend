'use strict';

const mongoose = require('mongoose');

const { Product } = require('../products/product.model');
const { Order } = require('../orders/order.model');
const orderService = require('../orders/order.service');
const { resolveUserPricingGroup } = require('../groups/group.service');
const { calculateFinalPrice, getProductFinalUnitPrice } = require('../orders/pricing.service');
const { validateDynamicFields } = require('../orders/orderFields.validator');
const { BusinessRuleError } = require('../../shared/errors/AppError');

const RESERVED_ORDER_KEYS = new Set([
    'productId',
    'qty',
    'quantity',
    'order_uuid',
    'dynamicData',
    'orderFieldsValues',
]);

const getProfile = (user) => ({
    balance: user.walletBalance,
    currency: user.currency,
    email: user.email,
});

const mapParamField = (field, source = 'dynamicFields') => {
    const name = source === 'orderFields' ? field.key : field.name;

    const param = {
        name,
        label: field.label,
        required: field.required !== false,
        type: field.type,
    };

    if (Array.isArray(field.options) && field.options.length > 0) {
        param.options = field.options;
    }
    if (field.min !== null && field.min !== undefined) param.min = field.min;
    if (field.max !== null && field.max !== undefined) param.max = field.max;

    return param;
};

const getProductParams = (product) => {
    const dynamicFields = Array.isArray(product.dynamicFields) ? product.dynamicFields : [];
    const activeDynamicFields = dynamicFields.filter((field) => field.isActive !== false);

    if (activeDynamicFields.length > 0) {
        return activeDynamicFields.map((field) => mapParamField(field));
    }

    const orderFields = Array.isArray(product.orderFields) ? product.orderFields : [];
    return orderFields
        .filter((field) => field.isActive !== false)
        .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
        .map((field) => mapParamField(field, 'orderFields'));
};

const mapProductForApi = (product, markupPercentage) => {
    const productFinalUnitPriceUsd = getProductFinalUnitPrice(product);
    const price = calculateFinalPrice(productFinalUnitPriceUsd, markupPercentage);

    return {
        id: product._id.toString(),
        name: product.name,
        price,
        min_qty: product.minQty,
        max_qty: product.maxQty,
        product_type: product.executionType,
        params: getProductParams(product),
    };
};

const listProducts = async (user) => {
    const groupPricing = await resolveUserPricingGroup(user);
    const markupPercentage = groupPricing.percentage;

    const products = await Product.find({
        isActive: true,
        isAvailableForApi: { $ne: false },
        deletedAt: null,
    })
        .select('name basePrice finalPrice minQty maxQty executionType dynamicFields orderFields displayOrder')
        .sort({ displayOrder: 1, name: 1 });

    return products.map((product) => mapProductForApi(product, markupPercentage));
};

const extractDynamicParams = (body = {}) => {
    const params = {};

    if (body.dynamicData && typeof body.dynamicData === 'object' && !Array.isArray(body.dynamicData)) {
        Object.assign(params, body.dynamicData);
    }

    if (body.orderFieldsValues && typeof body.orderFieldsValues === 'object' && !Array.isArray(body.orderFieldsValues)) {
        Object.assign(params, body.orderFieldsValues);
    }

    for (const [key, value] of Object.entries(body)) {
        if (!RESERVED_ORDER_KEYS.has(key)) {
            params[key] = value;
        }
    }

    return params;
};

const findExistingClientOrder = (userId, idempotencyKey) => (
    Order.findOne({ userId, idempotencyKey })
);

const getApiProductForOrder = async (productId) => {
    const product = await Product.findOne({
        _id: productId,
        isActive: true,
        isAvailableForApi: { $ne: false },
        deletedAt: null,
    }).select('dynamicFields orderFields');

    if (!product) {
        throw new BusinessRuleError('Product is not available for API.', 'PRODUCT_NOT_AVAILABLE_FOR_API');
    }

    return product;
};

const createOrder = async ({ user, body, auditContext = null }) => {
    const userId = user._id;
    const productId = body.productId;
    const quantity = parseInt(body.qty, 10);
    const idempotencyKey = String(body.order_uuid).trim();

    const existingOrder = await findExistingClientOrder(userId, idempotencyKey);
    if (existingOrder) {
        return { order: existingOrder, idempotent: true };
    }

    const product = await getApiProductForOrder(productId);
    const dynamicParams = extractDynamicParams(body);
    const activeDynamicFields = (Array.isArray(product.dynamicFields) ? product.dynamicFields : [])
        .filter((field) => field.isActive !== false);

    let customerInput = null;
    let orderFieldsValues = null;

    if (activeDynamicFields.length > 0) {
        customerInput = validateDynamicFields(activeDynamicFields, dynamicParams);
        orderFieldsValues = customerInput.values;
    } else if (Object.keys(dynamicParams).length > 0) {
        orderFieldsValues = dynamicParams;
    }

    return orderService.createOrder({
        userId,
        productId,
        quantity,
        idempotencyKey,
        orderFieldsValues,
        customerInput,
        auditContext,
    });
};

const parseOrderRefs = (orders) => {
    const raw = Array.isArray(orders) ? orders.join(',') : String(orders || '');
    return [...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean))];
};

const checkOrders = async (user, orders) => {
    const refs = parseOrderRefs(orders);
    if (refs.length === 0) return [];

    const objectIds = refs.filter((ref) => mongoose.Types.ObjectId.isValid(ref));
    const clauses = [{ idempotencyKey: { $in: refs } }];
    if (objectIds.length > 0) clauses.push({ _id: { $in: objectIds } });

    const matchedOrders = await Order.find({
        userId: user._id,
        $or: clauses,
    })
        .select('quantity totalPrice status createdAt idempotencyKey')
        .lean();

    const orderByRef = new Map();
    for (const order of matchedOrders) {
        const formatted = {
            order_id: order._id.toString(),
            quantity: order.quantity,
            price: order.totalPrice,
            status: order.status,
            created_at: order.createdAt,
        };

        orderByRef.set(order._id.toString(), formatted);
        if (order.idempotencyKey) orderByRef.set(order.idempotencyKey, formatted);
    }

    return refs.map((ref) => orderByRef.get(ref)).filter(Boolean);
};

module.exports = {
    getProfile,
    listProducts,
    createOrder,
    checkOrders,
};
