'use strict';

const { Router } = require('express');

const apiAuth = require('../../shared/middlewares/apiAuth');
const { clientApiLimiter } = require('../../shared/middlewares/rateLimiter');
const clientController = require('./client.controller');
const {
    createClientOrderValidation,
    checkOrdersValidation,
    validateClientRequest,
} = require('./client.validation');

const router = Router();

router.use(apiAuth);
router.use(clientApiLimiter);

router.get('/profile', clientController.getProfile);
router.get('/products', clientController.getProducts);

router.post(
    '/orders',
    createClientOrderValidation,
    validateClientRequest,
    clientController.createOrder
);

router.get(
    '/check',
    checkOrdersValidation,
    validateClientRequest,
    clientController.checkOrders
);

module.exports = router;
