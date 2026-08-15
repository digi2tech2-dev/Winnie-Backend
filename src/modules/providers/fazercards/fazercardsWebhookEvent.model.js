'use strict';

const mongoose = require('mongoose');
const { PROVIDER_CODES } = require('../provider.constants');

const WEBHOOK_PROCESSING_STATUSES = Object.freeze({
    PROCESSED: 'processed',
    IGNORED: 'ignored',
    FAILED: 'failed',
    DUPLICATE: 'duplicate',
    UNMATCHED: 'unmatched',
});

const fazerCardsWebhookEventSchema = new mongoose.Schema(
    {
        provider: {
            type: String,
            enum: [PROVIDER_CODES.FAZER_CARDS],
            default: PROVIDER_CODES.FAZER_CARDS,
            index: true,
        },
        dedupeKey: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },
        eventId: {
            type: String,
            required: true,
            trim: true,
            index: true,
        },
        event: {
            type: String,
            trim: true,
            default: null,
            index: true,
        },
        providerOrderId: {
            type: String,
            trim: true,
            default: null,
            index: true,
        },
        localOrder: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Order',
            default: null,
            index: true,
        },
        matched: {
            type: Boolean,
            default: false,
            index: true,
        },
        processingStatus: {
            type: String,
            enum: Object.values(WEBHOOK_PROCESSING_STATUSES),
            default: WEBHOOK_PROCESSING_STATUSES.PROCESSED,
            index: true,
        },
        statusBefore: {
            type: String,
            trim: true,
            default: null,
        },
        statusAfter: {
            type: String,
            trim: true,
            default: null,
        },
        errorMessage: {
            type: String,
            trim: true,
            default: null,
        },
        payloadHash: {
            type: String,
            trim: true,
            default: null,
        },
        rawPayloadSanitized: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
        },
        receivedAt: {
            type: Date,
            default: Date.now,
            index: true,
        },
        processedAt: {
            type: Date,
            default: null,
        },
        attempts: {
            type: Number,
            default: 1,
            min: 1,
        },
        lastReceivedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

fazerCardsWebhookEventSchema.index({ provider: 1, receivedAt: -1 });
fazerCardsWebhookEventSchema.index({ providerOrderId: 1, receivedAt: -1 });
fazerCardsWebhookEventSchema.index({ event: 1, processingStatus: 1 });

const FazerCardsWebhookEvent = mongoose.model('FazerCardsWebhookEvent', fazerCardsWebhookEventSchema);

module.exports = {
    FazerCardsWebhookEvent,
    WEBHOOK_PROCESSING_STATUSES,
};
