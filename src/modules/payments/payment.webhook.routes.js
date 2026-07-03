'use strict';

const { Router } = require('express');
const webhookController = require('./payment.webhook.controller');

const router = Router();

router.post('/network', webhookController.handleNetworkWebhook);

module.exports = router;
