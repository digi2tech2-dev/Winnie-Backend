'use strict';

const { ORDER_STATUS } = require('../orders/order.model');

const toCompatNumber = (value, fallback = 0) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Number(numeric.toFixed(6)) : fallback;
};

const mapStatus = (status) => {
    switch (status) {
        case ORDER_STATUS.COMPLETED:
            return 'accept';
        case ORDER_STATUS.FAILED:
        case ORDER_STATUS.CANCELED:
            return 'reject';
        case ORDER_STATUS.PENDING:
        case ORDER_STATUS.PROCESSING:
        case ORDER_STATUS.MANUAL_REVIEW:
        case ORDER_STATUS.PARTIAL:
        default:
            return 'wait';
    }
};

const getActiveFields = (product = {}) => {
    const dynamicFields = Array.isArray(product.dynamicFields) ? product.dynamicFields : [];
    const activeDynamicFields = dynamicFields.filter((field) => field && field.isActive !== false);
    if (activeDynamicFields.length > 0) return activeDynamicFields.map((field) => ({ ...field, key: field.name }));

    return (Array.isArray(product.orderFields) ? product.orderFields : [])
        .filter((field) => field && field.isActive !== false)
        .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
};

const getFieldKey = (field = {}) => String(field.key || field.name || '').trim();
const getFieldLabel = (field = {}) => String(field.label || field.name || field.key || '').trim();

const mapFields = (product) => getActiveFields(product)
    .map((field) => {
        const key = getFieldKey(field);
        const label = getFieldLabel(field);
        if (!key || !label) return null;
        return {
            key,
            label,
            type: String(field.type || 'text'),
            required: field.required !== false,
            options: Array.isArray(field.options) ? field.options : [],
        };
    })
    .filter(Boolean);

const mapQuantity = (product = {}) => {
    const min = Number(product.minQty || 1);
    const max = Number(product.maxQty || min);
    if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
        return {
            qty_values: { min: String(min), max: String(max) },
            product_type: 'amount',
            aliases: { min, max, minQty: min, maxQty: max, min_quantity: min, max_quantity: max },
        };
    }
    if (Number.isFinite(min) && Number.isFinite(max) && min === max && min !== 1) {
        return {
            qty_values: [String(min)],
            product_type: 'package',
            aliases: { min, max, minQty: min, maxQty: max, min_quantity: min, max_quantity: max },
        };
    }
    return {
        qty_values: null,
        product_type: 'package',
        aliases: { min: 1, max: 1, minQty: 1, maxQty: 1, min_quantity: 1, max_quantity: 1 },
    };
};

const mapProduct = ({ product, category, priceUsd, minimal = false }) => {
    const price = toCompatNumber(priceUsd);
    const priceAliases = {
        price,
        cost: price,
        rate: price,
        api_price: price,
        provider_price: price,
        base_price: price,
        original_price: price,
        currency: 'USD',
    };
    if (minimal) return { id: Number(product.compatProductId), name: product.name, ...priceAliases };

    const quantity = mapQuantity(product);
    return {
        id: Number(product.compatProductId),
        name: product.name,
        ...priceAliases,
        available: product.isActive !== false && !product.deletedAt,
        product_type: quantity.product_type,
        parent_id: Number(category?.compatCategoryId || 0),
        category_name: category?.name || '',
        category_img: category?.image || '',
        qty_values: quantity.qty_values,
        params: mapFields(product).map((field) => field.label),
        fields: mapFields(product),
        ...quantity.aliases,
    };
};

const getOrderData = (order = {}) => {
    const values = order.customerInput?.values || {};
    if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
    return values instanceof Map ? Object.fromEntries(values.entries()) : { ...values };
};

const orderPrice = (order = {}) => order.chargedAmount ?? order.totalPrice ?? 0;

const formatDateTime = (value) => {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return '';
    const pad = (part) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const mapCreatedOrder = (order = {}) => ({
    order_id: order.compatOrderId,
    order_uuid: order.idempotencyKey || null,
    status: mapStatus(order.status),
    price: toCompatNumber(orderPrice(order)),
    currency: String(order.currency || 'USD').toUpperCase(),
    data: getOrderData(order),
    replay_api: null,
});

const mapCheckedOrder = (order = {}) => ({
    order_id: order.compatOrderId,
    order_uuid: order.idempotencyKey || null,
    quantity: Number(order.quantity || 0),
    data: getOrderData(order),
    created_at: formatDateTime(order.createdAt),
    product_name: order.productId?.name || null,
    price: String(orderPrice(order)),
    status: mapStatus(order.status),
    replay_api: null,
});

const parseDelimited = (value) => String(value || '').trim()
    .replace(/^\[/, '').replace(/\]$/, '')
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);

const parseProductIds = (value) => parseDelimited(value)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);

const extractOrderFieldsFromQuery = (query = {}) => {
    const ignored = new Set(['qty', 'order_uuid', 'price', 'cost', 'currency', 'api-token', 'api_token', 'x-api-key']);
    return Object.entries(query).reduce((fields, [key, value]) => {
        if (ignored.has(key) || value === undefined || value === null || value === '') return fields;
        fields[key] = Array.isArray(value) ? value[value.length - 1] : String(value);
        return fields;
    }, {});
};

module.exports = {
    mapStatus,
    getActiveFields,
    mapProduct,
    mapCreatedOrder,
    mapCheckedOrder,
    parseDelimited,
    parseProductIds,
    extractOrderFieldsFromQuery,
};
