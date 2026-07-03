'use strict';

const webhookService = require('./payment.webhook.service');
const paymentService = require('./payment.service');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess } = require('../../shared/utils/apiResponse');

const requestMetaFrom = (req) => ({
    ipAddress: req.ip || null,
    userAgent: req.get('User-Agent') || null,
});

const handleNetworkWebhook = catchAsync(async (req, res) => {
    const result = await webhookService.processNetworkWebhook({
        payload: req.body || {},
        headers: req.headers || {},
        requestMeta: requestMetaFrom(req),
    });

    sendSuccess(res, {
        accepted: true,
        duplicate: Boolean(result.duplicate),
        event: {
            id: result.event?._id?.toString?.() || null,
            status: result.event?.status || null,
            processingStatus: result.event?.processingStatus || null,
        },
        matched: Boolean(result.payment),
        unmatched: Boolean(result.unmatched),
        payment: result.payment ? paymentService.serializePayment(result.payment) : null,
        alreadyProcessed: Boolean(result.syncResult?.alreadyProcessed),
        providerStatus: result.syncResult?.providerStatus || null,
        verificationMode: result.verification?.mode || 'unverified',
    }, 'Payment webhook accepted.');
});

module.exports = {
    handleNetworkWebhook,
};
