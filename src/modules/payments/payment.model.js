'use strict';

const mongoose = require('mongoose');
const {
    PAYMENT_PURPOSES,
    PAYMENT_GATEWAYS,
    PAYMENT_METHODS,
    PAYMENT_STATUSES,
} = require('./payment.constants');

const paymentSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'Payment userId is required'],
            index: true,
        },

        purpose: {
            type: String,
            enum: Object.values(PAYMENT_PURPOSES),
            default: PAYMENT_PURPOSES.WALLET_TOPUP,
            required: [true, 'Payment purpose is required'],
        },

        gateway: {
            type: String,
            enum: Object.values(PAYMENT_GATEWAYS),
            required: [true, 'Payment gateway is required'],
            index: true,
        },

        method: {
            type: String,
            enum: Object.values(PAYMENT_METHODS),
            default: PAYMENT_METHODS.CARD,
            required: [true, 'Payment method is required'],
        },

        amount: {
            type: Number,
            required: [true, 'Payment amount is required'],
            min: [0.01, 'Payment amount must be greater than 0'],
        },

        paymentMethodId: {
            type: String,
            trim: true,
            default: null,
            index: true,
        },

        feePercent: {
            type: Number,
            default: 0,
            min: [0, 'Payment fee percent cannot be negative'],
        },

        feeAmount: {
            type: Number,
            default: 0,
            min: [0, 'Payment fee cannot be negative'],
        },

        totalAmount: {
            type: Number,
            required: [true, 'Payment totalAmount is required'],
            min: [0.01, 'Payment totalAmount must be greater than 0'],
        },

        currency: {
            type: String,
            trim: true,
            uppercase: true,
            minlength: [3, 'Currency must be a 3-letter code'],
            maxlength: [3, 'Currency must be a 3-letter code'],
            required: [true, 'Payment currency is required'],
            index: true,
        },

        status: {
            type: String,
            enum: Object.values(PAYMENT_STATUSES),
            default: PAYMENT_STATUSES.INITIATED,
            index: true,
        },

        gatewayPaymentId: {
            type: String,
            trim: true,
            default: null,
        },

        gatewayReference: {
            type: String,
            trim: true,
            default: null,
        },

        checkoutUrl: {
            type: String,
            trim: true,
            default: null,
        },

        returnUrl: {
            type: String,
            trim: true,
            default: null,
        },

        cancelUrl: {
            type: String,
            trim: true,
            default: null,
        },

        expiresAt: {
            type: Date,
            default: null,
            index: true,
        },

        succeededAt: {
            type: Date,
            default: null,
        },

        failedAt: {
            type: Date,
            default: null,
        },

        canceledAt: {
            type: Date,
            default: null,
        },

        creditedAt: {
            type: Date,
            default: null,
        },

        walletTransactionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'WalletTransaction',
            default: null,
            index: true,
        },

        idempotencyKey: {
            type: String,
            trim: true,
            default: undefined,
        },

        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: undefined,
        },

        createdByIp: {
            type: String,
            trim: true,
            default: null,
        },

        userAgent: {
            type: String,
            trim: true,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

paymentSchema.index({ userId: 1, createdAt: -1 });
paymentSchema.index({ status: 1, createdAt: -1 });
paymentSchema.index(
    { gateway: 1, gatewayPaymentId: 1 },
    {
        unique: true,
        partialFilterExpression: { gatewayPaymentId: { $type: 'string' } },
    }
);
paymentSchema.index(
    { idempotencyKey: 1 },
    {
        unique: true,
        partialFilterExpression: { idempotencyKey: { $type: 'string' } },
    }
);

const Payment = mongoose.model('Payment', paymentSchema);

module.exports = { Payment };
