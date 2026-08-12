'use strict';

const mongoose = require('mongoose');
const { ORDER_STATUS } = require('../../orders/order.model');
const { PROVIDER_CODES } = require('../provider.constants');
const { FULFILLMENT_MODES } = require('../providerProduct.model');

const providerPilotOrderSchema = new mongoose.Schema(
    {
        product: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
            required: true,
            index: true,
        },
        provider: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Provider',
            required: true,
            index: true,
        },
        providerProduct: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'ProviderProduct',
            required: true,
            index: true,
        },
        providerCode: {
            type: String,
            enum: Object.values(PROVIDER_CODES),
            default: PROVIDER_CODES.FAZER_CARDS,
            uppercase: true,
            trim: true,
            index: true,
        },
        familyKey: {
            type: String,
            trim: true,
            uppercase: true,
            required: true,
            index: true,
        },
        fulfillmentMode: {
            type: String,
            enum: Object.values(FULFILLMENT_MODES),
            default: FULFILLMENT_MODES.CODE_DELIVERY,
            index: true,
        },
        quantity: {
            type: Number,
            required: true,
            min: 1,
        },
        providerCost: {
            type: String,
            required: true,
            get: (v) => String(v ?? '0'),
            set: (v) => String(v ?? '0'),
        },
        providerCostCurrency: {
            type: String,
            trim: true,
            uppercase: true,
            default: 'USD',
        },
        status: {
            type: String,
            enum: Object.values(ORDER_STATUS),
            default: ORDER_STATUS.PROCESSING,
            index: true,
        },
        providerOrderId: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
            index: true,
        },
        providerStatus: {
            type: String,
            default: null,
        },
        providerRequestId: {
            type: String,
            trim: true,
            default: null,
        },
        providerIdempotencyKey: {
            type: String,
            trim: true,
            default: null,
        },
        providerRawResponse: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
        },
        providerErrorCode: {
            type: String,
            trim: true,
            default: null,
        },
        providerErrorMessage: {
            type: String,
            trim: true,
            default: null,
        },
        operator: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
            index: true,
        },
        operatorNote: {
            type: String,
            trim: true,
            default: null,
        },
        deliveredCodeCount: {
            type: Number,
            default: 0,
            min: 0,
        },
        hasPin: {
            type: Boolean,
            default: false,
        },
        hasSerial: {
            type: Boolean,
            default: false,
        },
        storedEncrypted: {
            type: Boolean,
            default: false,
        },
        warnings: {
            type: [String],
            default: [],
        },
        completedAt: {
            type: Date,
            default: null,
        },
        failedAt: {
            type: Date,
            default: null,
        },
        lastCheckedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

providerPilotOrderSchema.index({ providerCode: 1, familyKey: 1, status: 1, createdAt: -1 });
providerPilotOrderSchema.index({ providerIdempotencyKey: 1 }, { unique: true, sparse: true });

const ProviderPilotOrder = mongoose.model('ProviderPilotOrder', providerPilotOrderSchema);

module.exports = { ProviderPilotOrder };
