'use strict';

const { Router } = require('express');
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');
const { authorizeRoles } = authorize;
const requireActiveUser = require('../../shared/middlewares/requireActiveUser');
const validate = require('../../shared/middlewares/validate');
const paymentController = require('./payment.controller');
const {
    createPaymentIntentValidation,
    paymentIdValidation,
    listPaymentsValidation,
} = require('./payment.validation');

const router = Router();

router.use(authenticate, requireActiveUser);

router.post(
    '/intents',
    authorize('CUSTOMER'),
    createPaymentIntentValidation,
    validate,
    paymentController.createPaymentIntent
);

router.get(
    '/',
    authorize('CUSTOMER'),
    listPaymentsValidation,
    validate,
    paymentController.listMyPayments
);

router.post(
    '/:id/sync-status',
    authorizeRoles('CUSTOMER', 'ADMIN'),
    paymentIdValidation,
    validate,
    paymentController.syncPaymentStatus
);

router.post(
    '/:id/mock-confirm',
    authorizeRoles('CUSTOMER', 'ADMIN'),
    paymentIdValidation,
    validate,
    paymentController.mockConfirmPayment
);

router.post(
    '/:id/mock-fail',
    authorizeRoles('CUSTOMER', 'ADMIN'),
    paymentIdValidation,
    validate,
    paymentController.mockFailPayment
);

router.get(
    '/:id',
    authorize('CUSTOMER'),
    paymentIdValidation,
    validate,
    paymentController.getMyPayment
);

module.exports = router;
