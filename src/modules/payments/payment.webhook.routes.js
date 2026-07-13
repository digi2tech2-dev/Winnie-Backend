'use strict';

const { Router } = require('express');
const webhookController = require('./payment.webhook.controller');

const router = Router();

router.post('/network', webhookController.handleNetworkWebhook);
router.post('/paymento', webhookController.handlePaymentoWebhook);
router.post('/ziina', webhookController.handleZiinaWebhook);

module.exports = router;
