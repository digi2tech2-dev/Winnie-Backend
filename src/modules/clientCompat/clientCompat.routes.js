'use strict';

const express = require('express');

const { clientCompatAuth } = require('./clientCompat.auth');
const controller = require('./clientCompat.controller');
const { catchCompat } = require('./clientCompat.errors');
const { requireCompatOrderingAvailable } = require('./clientCompat.maintenance');

const router = express.Router();

router.use(clientCompatAuth);
router.get('/profile', catchCompat(controller.getProfile));
router.get('/products', catchCompat(controller.getProducts));
router.get('/content/:parentId', catchCompat(controller.getContent));
router.post('/orders', requireCompatOrderingAvailable, catchCompat(controller.placeCanonicalOrder));
router.get('/newOrder/:productId/params', requireCompatOrderingAvailable, catchCompat(controller.placeLegacyOrder));
router.get('/check', catchCompat(controller.checkOrders));

module.exports = router;
