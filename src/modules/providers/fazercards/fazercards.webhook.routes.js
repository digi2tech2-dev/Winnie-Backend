'use strict';

const express = require('express');
const controller = require('./fazercards.webhook.controller');

const router = express.Router();

router.post('/', controller.receiveWebhook);

module.exports = router;
