'use strict';

const mongoose = require('mongoose');
const { ADMIN_DEFAULT_EVENT_PREFERENCES } = require('./whatsapp.constants');

const adminWhatsAppRecipientSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Recipient name is required'],
            trim: true,
            maxlength: [120, 'Recipient name cannot exceed 120 characters'],
        },
        phone: {
            type: String,
            required: [true, 'Recipient phone is required'],
            trim: true,
            maxlength: [30, 'Recipient phone cannot exceed 30 characters'],
        },
        enabled: {
            type: Boolean,
            default: true,
            index: true,
        },
        eventPreferences: {
            successfulPayment: { type: Boolean, default: ADMIN_DEFAULT_EVENT_PREFERENCES.successfulPayment },
            manualDepositPending: { type: Boolean, default: ADMIN_DEFAULT_EVENT_PREFERENCES.manualDepositPending },
            providerOrderFailed: { type: Boolean, default: ADMIN_DEFAULT_EVENT_PREFERENCES.providerOrderFailed },
            paymentWebhookError: { type: Boolean, default: ADMIN_DEFAULT_EVENT_PREFERENCES.paymentWebhookError },
            financialDayClosed: { type: Boolean, default: ADMIN_DEFAULT_EVENT_PREFERENCES.financialDayClosed },
            largeWalletAdjustment: { type: Boolean, default: ADMIN_DEFAULT_EVENT_PREFERENCES.largeWalletAdjustment },
            providerBalanceWarning: { type: Boolean, default: ADMIN_DEFAULT_EVENT_PREFERENCES.providerBalanceWarning },
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
        updatedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
    },
    { timestamps: true }
);

adminWhatsAppRecipientSchema.index(
    { phone: 1 },
    { unique: true, partialFilterExpression: { phone: { $type: 'string' } } }
);

const AdminWhatsAppRecipient = mongoose.model('AdminWhatsAppRecipient', adminWhatsAppRecipientSchema);

module.exports = { AdminWhatsAppRecipient };
