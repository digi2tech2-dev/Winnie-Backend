'use strict';

const crypto = require('crypto');

const { Product } = require('../products/product.model');
const { Category } = require('../categories/category.model');
const { Order } = require('../orders/order.model');
const orderService = require('../orders/order.service');
const { getNextSequence } = require('../orders/counter.model');
const { calculateFinalPrice, getProductFinalUnitPrice } = require('../orders/pricing.service');
const { resolveUserPricingGroup } = require('../groups/group.service');
const { validateDynamicFields } = require('../orders/orderFields.validator');
const { ClientCompatError, ERROR_CODES } = require('./clientCompat.errors');
const {
    getActiveFields,
    mapProduct,
    mapCreatedOrder,
    mapCheckedOrder,
    parseProductIds,
    extractOrderFieldsFromQuery,
} = require('./clientCompat.mappers');

const FAZER_CARDS_CUSTOMER_PRODUCT_FILTER = {
    $or: [
        { providerCode: { $ne: 'FAZER_CARDS' } },
        { providerCode: 'FAZER_CARDS', visibleInStore: { $ne: false }, customerPurchaseEnabled: true, status: 'available' },
    ],
};

const CLIENT_API_PRODUCT_FILTER = {
    isActive: true,
    visibleInStore: { $ne: false },
    isPaused: { $ne: true },
    status: 'available',
    customerPurchaseEnabled: true,
    isAvailableForApi: { $ne: false },
    deletedAt: null,
    $and: [FAZER_CARDS_CUSTOMER_PRODUCT_FILTER],
};

const PRODUCT_SELECT = [
    'compatProductId', 'name', 'image', 'category', 'minQty', 'maxQty',
    'basePrice', 'finalPrice', 'providerPrice', 'orderFields', 'dynamicFields',
    'displayOrder', 'isActive', 'visibleInStore', 'isPaused', 'status',
    'customerPurchaseEnabled', 'isAvailableForApi', 'deletedAt', 'providerCode',
].join(' ');

const ensureProductCompatId = async (product) => {
    if (product?.compatProductId) return Number(product.compatProductId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const compatProductId = await getNextSequence('compatProductId', 999);
        try {
            const updated = await Product.findOneAndUpdate(
                { _id: product._id, $or: [{ compatProductId: null }, { compatProductId: { $exists: false } }] },
                { $set: { compatProductId } },
                { new: true, lean: true }
            );
            if (updated?.compatProductId) return Number(updated.compatProductId);
            const existing = await Product.findById(product._id).select('compatProductId').lean();
            if (existing?.compatProductId) return Number(existing.compatProductId);
        } catch (err) {
            if (err.code !== 11000) throw err;
        }
    }
    throw new ClientCompatError('Unable to assign product compatibility ID', ERROR_CODES.INTERNAL, 500);
};

const ensureCategoryCompatId = async (category) => {
    if (!category) return 0;
    if (category.compatCategoryId) return Number(category.compatCategoryId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const compatCategoryId = await getNextSequence('compatCategoryId', 1);
        try {
            const updated = await Category.findOneAndUpdate(
                { _id: category._id, $or: [{ compatCategoryId: null }, { compatCategoryId: { $exists: false } }] },
                { $set: { compatCategoryId } },
                { new: true, lean: true }
            );
            if (updated?.compatCategoryId) return Number(updated.compatCategoryId);
            const existing = await Category.findById(category._id).select('compatCategoryId').lean();
            if (existing?.compatCategoryId) return Number(existing.compatCategoryId);
        } catch (err) {
            if (err.code !== 11000) throw err;
        }
    }
    throw new ClientCompatError('Unable to assign category compatibility ID', ERROR_CODES.INTERNAL, 500);
};

const ensureCompatOrderId = async (orderOrId) => {
    const orderId = orderOrId?._id || orderOrId;
    if (orderOrId?.compatOrderId) return orderOrId.compatOrderId;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const compatOrderId = `ID_${crypto.randomBytes(8).toString('hex')}`;
        try {
            const updated = await Order.findOneAndUpdate(
                { _id: orderId, $or: [{ compatOrderId: null }, { compatOrderId: { $exists: false } }] },
                { $set: { compatOrderId } },
                { new: true, lean: true }
            );
            if (updated?.compatOrderId) return updated.compatOrderId;
            const existing = await Order.findById(orderId).select('compatOrderId').lean();
            if (existing?.compatOrderId) return existing.compatOrderId;
        } catch (err) {
            if (err.code !== 11000) throw err;
        }
    }
    throw new ClientCompatError('Unable to assign order compatibility ID', ERROR_CODES.INTERNAL, 500);
};

const ensureCompatIds = async (products, categories) => {
    for (const category of categories) {
        if (!category.compatCategoryId) category.compatCategoryId = await ensureCategoryCompatId(category);
    }
    for (const product of products) {
        if (!product.compatProductId) product.compatProductId = await ensureProductCompatId(product);
    }
};

const loadCategories = () => Category.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean();

const categoryMaps = (categories) => ({
    byMongoId: new Map(categories.map((category) => [String(category._id), category])),
    byCompatId: new Map(categories.map((category) => [Number(category.compatCategoryId), category])),
});

const priceProductUsd = async (product, user) => {
    const groupPricing = await resolveUserPricingGroup(user);
    return calculateFinalPrice(getProductFinalUnitPrice(product), groupPricing.percentage);
};

const getProfile = (user) => ({
    balance: String(user.walletBalance ?? 0),
    email: user.email || null,
    currency: String(user.currency || 'USD').toUpperCase(),
});

const listProducts = async (user, { productsId = '', base = false } = {}) => {
    const [products, categories] = await Promise.all([
        Product.find(CLIENT_API_PRODUCT_FILTER).select(PRODUCT_SELECT).sort({ displayOrder: 1, name: 1 }).lean(),
        loadCategories(),
    ]);
    await ensureCompatIds(products, categories);
    const requestedIds = parseProductIds(productsId);
    const filteredProducts = requestedIds.length
        ? products.filter((product) => requestedIds.includes(Number(product.compatProductId)))
        : products;
    const { byMongoId } = categoryMaps(categories);
    const groupPricing = await resolveUserPricingGroup(user);
    return filteredProducts.map((product) => mapProduct({
        product,
        category: byMongoId.get(String(product.category || '')) || null,
        priceUsd: calculateFinalPrice(getProductFinalUnitPrice(product), groupPricing.percentage),
        minimal: base,
    }));
};

const mapCategory = (category, parentId) => ({
    id: Number(category.compatCategoryId),
    name: category.name || '',
    parent_id: parentId,
    image: category.image || '',
    available: category.isActive !== false,
});

const getContent = async (user, parentId) => {
    const numericParentId = Number(parentId);
    if (!Number.isInteger(numericParentId) || numericParentId < 0) {
        throw new ClientCompatError('Validation error', ERROR_CODES.VALIDATION, 400);
    }
    const [products, categories] = await Promise.all([
        Product.find(CLIENT_API_PRODUCT_FILTER).select(PRODUCT_SELECT).sort({ displayOrder: 1, name: 1 }).lean(),
        loadCategories(),
    ]);
    await ensureCompatIds(products, categories);
    const { byMongoId, byCompatId } = categoryMaps(categories);
    const selectedParent = numericParentId === 0 ? null : byCompatId.get(numericParentId);
    const parentMongoId = selectedParent ? String(selectedParent._id) : null;
    const childCategories = categories
        .filter((category) => (numericParentId === 0
            ? !category.parentCategory
            : String(category.parentCategory || '') === parentMongoId))
        .map((category) => mapCategory(category, numericParentId));
    const groupPricing = await resolveUserPricingGroup(user);
    const directProducts = products
        .filter((product) => (numericParentId === 0
            ? !String(product.category || '').trim()
            : String(product.category || '') === parentMongoId))
        .map((product) => mapProduct({
            product,
            category: byMongoId.get(String(product.category || '')) || null,
            priceUsd: calculateFinalPrice(getProductFinalUnitPrice(product), groupPricing.percentage),
        }));
    return { status: 'OK', data: { categories: childCategories, products: directProducts } };
};

const findOrderableProduct = async (compatProductId) => {
    const numericId = Number(compatProductId);
    if (!Number.isInteger(numericId) || numericId <= 0) {
        throw new ClientCompatError('Product deleted or not found', ERROR_CODES.PRODUCT_NOT_FOUND, 404);
    }
    const product = await Product.findOne({ compatProductId: numericId }).select(PRODUCT_SELECT);
    if (!product || product.deletedAt) {
        throw new ClientCompatError('Product deleted or not found', ERROR_CODES.PRODUCT_NOT_FOUND, 404);
    }
    const available = await Product.exists({ _id: product._id, ...CLIENT_API_PRODUCT_FILTER });
    if (!available) throw new ClientCompatError('Product not available now', ERROR_CODES.PRODUCT_NOT_AVAILABLE, 400);
    return product;
};

const normalizeParams = (product, params) => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
        throw new ClientCompatError('params must be an object', ERROR_CODES.VALIDATION, 400);
    }
    const activeFields = getActiveFields(product);
    if (activeFields.length === 0 && Object.keys(params).length > 0) {
        throw new ClientCompatError('Unknown order field(s)', ERROR_CODES.VALIDATION, 400);
    }
    const activeDynamicFields = (Array.isArray(product.dynamicFields) ? product.dynamicFields : [])
        .filter((field) => field && field.isActive !== false);
    if (activeDynamicFields.length > 0) return validateDynamicFields(activeDynamicFields, params);
    return null;
};

const validateQuantity = (qty, product) => {
    const quantity = Number(qty);
    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new ClientCompatError('Quantity not allowed', ERROR_CODES.QUANTITY_NOT_ALLOWED, 400);
    }
    if (quantity < Number(product.minQty || 1)) {
        throw new ClientCompatError('Quantity is too small', ERROR_CODES.QUANTITY_TOO_SMALL, 400);
    }
    if (quantity > Number(product.maxQty || quantity)) {
        throw new ClientCompatError('Quantity is too large', ERROR_CODES.QUANTITY_TOO_LARGE, 400);
    }
    return quantity;
};

const loadCompatOrder = (orderId) => Order.findById(orderId).populate('productId', 'name').lean();

const createCompatOrder = async ({ user, compatProductId, qty, orderUuid, params, auditContext, apiKeyPrefix }) => {
    const idempotencyKey = String(orderUuid || '').trim();
    if (!idempotencyKey || idempotencyKey.length > 191) {
        throw new ClientCompatError('order_uuid is required and must not exceed 191 characters', ERROR_CODES.VALIDATION, 400);
    }

    const existing = await Order.findOne({ userId: user._id, idempotencyKey }).lean();
    if (existing) {
        if (!existing.compatOrderId) await ensureCompatOrderId(existing._id);
        return { status: 'OK', data: mapCreatedOrder(await loadCompatOrder(existing._id)) };
    }

    const product = await findOrderableProduct(compatProductId);
    const quantity = validateQuantity(qty, product);
    const customerInput = normalizeParams(product, params);
    const orderFieldsValues = customerInput ? customerInput.values : params;
    const { order } = await orderService.createOrder({
        userId: user._id,
        productId: product._id,
        quantity,
        idempotencyKey,
        source: 'client_api',
        apiKeyPrefix,
        externalOrderId: idempotencyKey,
        orderFieldsValues,
        customerInput,
        auditContext,
    });
    await ensureCompatOrderId(order);
    return { status: 'OK', data: mapCreatedOrder(await loadCompatOrder(order._id)) };
};

const placeCanonicalOrder = ({ user, body, auditContext, apiKeyPrefix }) => {
    if (body?.product_id === undefined || body?.product_id === null || String(body.product_id).trim() === '') {
        throw new ClientCompatError('product_id is required', ERROR_CODES.VALIDATION, 400);
    }
    return createCompatOrder({
        user,
        compatProductId: body.product_id,
        qty: body.qty,
        orderUuid: body.order_uuid,
        params: body.params || {},
        auditContext,
        apiKeyPrefix,
    });
};

const placeLegacyOrder = ({ user, productId, query, auditContext, apiKeyPrefix }) => createCompatOrder({
    user,
    compatProductId: productId,
    qty: query.qty,
    orderUuid: query.order_uuid,
    params: extractOrderFieldsFromQuery(query),
    auditContext,
    apiKeyPrefix,
});

const listOrders = async (user, ids, { byUuid = false } = {}) => {
    if (!Array.isArray(ids) || ids.length === 0) {
        throw new ClientCompatError('Validation error', ERROR_CODES.VALIDATION, 400);
    }
    const numericOrderNumbers = ids.map(Number).filter((id) => Number.isInteger(id));
    const filter = byUuid
        ? { userId: user._id, idempotencyKey: { $in: ids } }
        : { userId: user._id, $or: [{ compatOrderId: { $in: ids } }, { orderNumber: { $in: numericOrderNumbers } }] };
    const orders = await Order.find(filter).populate('productId', 'name').lean();
    for (const order of orders) {
        if (!order.compatOrderId) order.compatOrderId = await ensureCompatOrderId(order._id);
    }
    const byReference = new Map();
    for (const order of orders) {
        if (order.compatOrderId) byReference.set(order.compatOrderId, order);
        if (order.orderNumber !== undefined) byReference.set(String(order.orderNumber), order);
        if (byUuid && order.idempotencyKey) byReference.set(order.idempotencyKey, order);
    }
    return {
        status: 'OK',
        data: ids.map((id) => byReference.get(String(id))).filter(Boolean).map(mapCheckedOrder),
    };
};

module.exports = {
    getProfile,
    listProducts,
    getContent,
    placeCanonicalOrder,
    placeLegacyOrder,
    listOrders,
    ensureProductCompatId,
    ensureCategoryCompatId,
    ensureCompatOrderId,
    priceProductUsd,
};
