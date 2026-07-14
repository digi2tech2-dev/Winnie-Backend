'use strict';

const mongoose = require('mongoose');
const { LOG_STATUSES, RECIPIENT_TYPES, WHATSAPP_PROVIDER } = require('./whatsapp.constants');

const whatsappNotificationLogSchema = new mongoose.Schema(
    {
        recipientType: {
            type: String,
            enum: Object.values(RECIPIENT_TYPES),
            required: true,
            index: true,
        },
        recipientUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
            index: true,
        },
        adminRecipientId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'AdminWhatsAppRecipient',
            default: null,
            index: true,
        },
        phone: { type: String, trim: true, default: null },
        chatId: { type: String, trim: true, default: null },
        eventType: { type: String, required: true, trim: true, index: true },
        title: { type: String, trim: true, maxlength: 160, default: null },
        message: { type: String, required: true, trim: true, maxlength: 1200 },
        provider: {
            type: String,
            enum: Object.values(WHATSAPP_PROVIDER),
            default: WHATSAPP_PROVIDER.OPENWA,
        },
        status: {
            type: String,
            enum: Object.values(LOG_STATUSES),
            default: LOG_STATUSES.PENDING,
            index: true,
        },
        reason: { type: String, trim: true, default: null },
        errorMessage: { type: String, trim: true, default: null, maxlength: 1000 },
        retryCount: { type: Number, default: 0, min: 0 },
        maxRetries: { type: Number, default: 3, min: 0 },
        nextRetryAt: { type: Date, default: null, index: true },
        sentAt: { type: Date, default: null },
        providerMessageId: { type: String, trim: true, default: null },
        relatedEntityType: { type: String, trim: true, default: null, index: true },
        relatedEntityId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
        idempotencyKey: { type: String, trim: true, default: null },
        metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    { timestamps: true }
);

whatsappNotificationLogSchema.index({ status: 1, nextRetryAt: 1, createdAt: 1 });
whatsappNotificationLogSchema.index({ createdAt: -1 });
whatsappNotificationLogSchema.index(
    { idempotencyKey: 1 },
    { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

const WhatsAppNotificationLog = mongoose.model('WhatsAppNotificationLog', whatsappNotificationLogSchema);

module.exports = { WhatsAppNotificationLog };
