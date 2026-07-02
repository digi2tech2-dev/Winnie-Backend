'use strict';

const paymentService = require('./payment.service');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendCreated, sendSuccess, sendPaginated } = require('../../shared/utils/apiResponse');

const requestMetaFrom = (req) => ({
    ipAddress: req.ip || null,
    userAgent: req.get('User-Agent') || null,
});

const actorFrom = (req) => ({
    actorId: req.user?._id,
    userId: req.user?._id,
    role: req.user?.role,
    actorRole: req.user?.role,
});

const createPaymentIntent = catchAsync(async (req, res) => {
    const result = await paymentService.createPaymentIntent({
        userId: req.user._id,
        amount: req.body.amount,
        currency: req.body.currency,
        gateway: req.body.gateway,
        returnUrl: req.body.returnUrl,
        cancelUrl: req.body.cancelUrl,
        idempotencyKey: req.get('Idempotency-Key') || req.body.idempotencyKey,
        requestMeta: requestMetaFrom(req),
    });

    sendCreated(res, {
        payment: paymentService.serializePayment(result.payment),
        checkout: result.checkout,
        idempotent: result.idempotent,
    }, 'Payment intent created.');
});

const getMyPayment = catchAsync(async (req, res) => {
    const payment = await paymentService.getPaymentById(req.params.id, {
        actor: actorFrom(req),
    });

    sendSuccess(res, { payment: paymentService.serializePayment(payment) }, 'Payment retrieved.');
});

const listMyPayments = catchAsync(async (req, res) => {
    const result = await paymentService.listPayments({
        userId: req.user._id,
        status: req.query.status,
        gateway: req.query.gateway,
        from: req.query.from,
        to: req.query.to,
        page: req.query.page,
        limit: req.query.limit,
    });

    sendPaginated(
        res,
        { payments: result.payments.map((payment) => paymentService.serializePayment(payment)) },
        result.pagination,
        'Payments retrieved.'
    );
});

const mockConfirmPayment = catchAsync(async (req, res) => {
    const result = await paymentService.confirmMockPayment(req.params.id, {
        actor: actorFrom(req),
        requestMeta: requestMetaFrom(req),
    });

    sendSuccess(res, {
        payment: paymentService.serializePayment(result.payment),
        alreadyProcessed: result.alreadyProcessed,
    }, 'Mock payment confirmed.');
});

const syncPaymentStatus = catchAsync(async (req, res) => {
    const result = await paymentService.syncPaymentStatus(req.params.id, {
        actor: actorFrom(req),
        requestMeta: requestMetaFrom(req),
        source: 'customer_return_page',
    });

    sendSuccess(res, {
        payment: paymentService.serializePayment(result.payment),
        alreadyProcessed: result.alreadyProcessed,
        providerStatus: result.providerStatus || null,
    }, 'Payment status synced.');
});

const adminSyncPaymentStatus = catchAsync(async (req, res) => {
    const result = await paymentService.syncPaymentStatus(req.params.id, {
        actor: actorFrom(req),
        requestMeta: requestMetaFrom(req),
        source: 'admin_reconciliation',
    });

    sendSuccess(res, {
        payment: paymentService.serializePayment(result.payment, { admin: true }),
        alreadyProcessed: result.alreadyProcessed,
        providerStatus: result.providerStatus || null,
    }, 'Payment status reconciled.');
});

const mockFailPayment = catchAsync(async (req, res) => {
    const result = await paymentService.failMockPayment(req.params.id, {
        actor: actorFrom(req),
        requestMeta: requestMetaFrom(req),
    });

    sendSuccess(res, {
        payment: paymentService.serializePayment(result.payment),
        alreadyProcessed: result.alreadyProcessed,
    }, 'Mock payment failed.');
});

const adminListPayments = catchAsync(async (req, res) => {
    const result = await paymentService.listPayments({
        status: req.query.status,
        gateway: req.query.gateway,
        from: req.query.from,
        to: req.query.to,
        page: req.query.page,
        limit: req.query.limit,
    });

    sendPaginated(
        res,
        { payments: result.payments.map((payment) => paymentService.serializePayment(payment, { admin: true })) },
        result.pagination,
        'Payments retrieved.'
    );
});

const adminGetPayment = catchAsync(async (req, res) => {
    const payment = await paymentService.getPaymentById(req.params.id, {
        actor: actorFrom(req),
        admin: true,
    });

    sendSuccess(res, {
        payment: paymentService.serializePayment(payment, { admin: true }),
    }, 'Payment retrieved.');
});

module.exports = {
    createPaymentIntent,
    getMyPayment,
    listMyPayments,
    syncPaymentStatus,
    mockConfirmPayment,
    mockFailPayment,
    adminListPayments,
    adminGetPayment,
    adminSyncPaymentStatus,
};
