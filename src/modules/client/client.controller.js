'use strict';

const clientService = require('./client.service');
const catchAsync = require('../../shared/utils/catchAsync');

const CLIENT_ERROR_CODES = Object.freeze({
    INSUFFICIENT_FUNDS: 100,
    PRODUCT_NOT_AVAILABLE_FOR_API: 101,
    PRODUCT_INACTIVE: 101,
    NOT_FOUND: 101,
    QUANTITY_OUT_OF_RANGE: 102,
    INVALID_ORDER_FIELDS: 103,
    VALIDATION_ERROR: 123,
    NO_GROUP_ASSIGNED: 124,
    GROUP_INACTIVE: 125,
});

const formatClientOrder = (order) => ({
    order_id: order._id.toString(),
    status: order.status,
    price: order.totalPrice,
});

const getAuditContext = (req) => ({
    actorId: req.user._id,
    actorRole: 'CUSTOMER',
    ipAddress: req.ip || null,
    userAgent: req.get('User-Agent') || null,
});

const sendClientError = (err, res, next) => {
    if (err.code === 'INSUFFICIENT_FUNDS') {
        return res.status(err.statusCode || 422).json({
            success: false,
            error_code: 100,
            message: 'Insufficient balance',
            required: err.required,
            available: err.available,
        });
    }

    if (err.isOperational) {
        return res.status(err.statusCode || 400).json({
            success: false,
            error_code: CLIENT_ERROR_CODES[err.code] || 199,
            message: err.message,
            errors: err.errors || undefined,
        });
    }

    return next(err);
};

const getProfile = catchAsync(async (req, res) => {
    res.json(clientService.getProfile(req.user));
});

const getProducts = catchAsync(async (req, res) => {
    const products = await clientService.listProducts(req.user);
    res.json(products);
});

const createOrder = async (req, res, next) => {
    try {
        const { order, idempotent } = await clientService.createOrder({
            user: req.user,
            body: req.body,
            auditContext: getAuditContext(req),
        });

        return res.status(idempotent ? 200 : 201).json(formatClientOrder(order));
    } catch (err) {
        return sendClientError(err, res, next);
    }
};

const checkOrders = catchAsync(async (req, res) => {
    const orders = await clientService.checkOrders(req.user, req.query.orders);
    res.json(orders);
});

module.exports = {
    getProfile,
    getProducts,
    createOrder,
    checkOrders,
};
