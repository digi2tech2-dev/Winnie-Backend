'use strict';

const mongoose = require('mongoose');
const { PAYMENT_GATEWAYS } = require('./payment.constants');

const PAYMENT_WEBHOOK_EVENT_STATUSES = Object.freeze({
    RECEIVED: 'RECEIVED',
    PROCESSED: 'PROCESSED',
    DUPLICATE: 'DUPLICATE',
    UNMATCHED: 'UNMATCHED',
    FAILED: 'FAILED',
    IGNORED: 'IGNORED',
});

const paymentWebhookEventSchema = new mongoose.Schema(
    {
        provider: {
            type: String,
            enum: Object.values(PAYMENT_GATEWAYS),
            required: true,
            index: true,
        },
        eventId: {
            type: String,
            trim: true,
            default: null,
            index: true,
        },
        dedupeKey: {
            type: String,
            trim: true,
            required: true,
            unique: true,
        },
        paymentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Payment',
            default: null,
            index: true,
        },
        gatewayPaymentId: {
            type: String,
            trim: true,
            default: null,
            index: true,
        },
        gatewayReference: {
            type: String,
            trim: true,
            default: null,
            index: true,
        },
        orderReference: {
            type: String,
            trim: true,
            default: null,
            index: true,
        },
        eventType: {
            type: String,
            trim: true,
            default: null,
        },
        providerStatus: {
            type: String,
            trim: true,
            default: null,
        },
        status: {
            type: String,
            enum: Object.values(PAYMENT_WEBHOOK_EVENT_STATUSES),
            default: PAYMENT_WEBHOOK_EVENT_STATUSES.RECEIVED,
            index: true,
        },
        processingStatus: {
            type: String,
            trim: true,
            default: 'RECEIVED',
        },
        httpHeaders: {
            type: mongoose.Schema.Types.Mixed,
            default: undefined,
        },
        payloadHash: {
            type: String,
            trim: true,
            required: true,
            index: true,
        },
        payloadSummary: {
            type: mongoose.Schema.Types.Mixed,
            default: undefined,
        },
        attempts: {
            type: Number,
            default: 1,
            min: 1,
        },
        receivedAt: {
            type: Date,
            default: Date.now,
            index: true,
        },
        lastReceivedAt: {
            type: Date,
            default: null,
        },
        processedAt: {
            type: Date,
            default: null,
        },
        errorCode: {
            type: String,
            trim: true,
            default: null,
        },
        errorMessage: {
            type: String,
            trim: true,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

paymentWebhookEventSchema.index({ provider: 1, receivedAt: -1 });
paymentWebhookEventSchema.index({ provider: 1, eventId: 1 });
paymentWebhookEventSchema.index({ paymentId: 1, receivedAt: -1 });

const PaymentWebhookEvent = mongoose.model('PaymentWebhookEvent', paymentWebhookEventSchema);

module.exports = {
    PaymentWebhookEvent,
    PAYMENT_WEBHOOK_EVENT_STATUSES,
};
