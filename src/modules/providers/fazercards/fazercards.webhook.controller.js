'use strict';

const catchAsync = require('../../../shared/utils/catchAsync');
const { sendSuccess } = require('../../../shared/utils/apiResponse');
const fazerCardsWebhookSvc = require('./fazercards.webhook.service');

const receiveWebhook = catchAsync(async (req, res) => {
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}), 'utf8');
    const data = await fazerCardsWebhookSvc.processWebhook({
        headers: req.headers,
        rawBody,
        payload: req.body,
    });
    sendSuccess(res, data, 'FazerCards webhook accepted');
});

module.exports = {
    receiveWebhook,
};
