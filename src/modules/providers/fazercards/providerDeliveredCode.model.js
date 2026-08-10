'use strict';

const mongoose = require('mongoose');
const { PROVIDER_CODES } = require('../provider.constants');
const { FULFILLMENT_MODES } = require('../providerProduct.model');
const { encryptSecret, decryptSecret, isEncryptedSecret } = require('../../../shared/utils/secretEncryption');

const DELIVERY_STATUSES = Object.freeze({
    RESERVED: 'RESERVED',
    DELIVERED: 'DELIVERED',
    REVEALED: 'REVEALED',
    REVOKED: 'REVOKED',
});

const providerDeliveredCodeSchema = new mongoose.Schema(
    {
        order: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Order',
            required: true,
            index: true,
        },
        provider: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Provider',
            default: null,
            index: true,
        },
        providerCode: {
            type: String,
            enum: Object.values(PROVIDER_CODES),
            uppercase: true,
            trim: true,
            default: PROVIDER_CODES.FAZER_CARDS,
            index: true,
        },
        providerProduct: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'ProviderProduct',
            default: null,
            index: true,
        },
        product: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
            default: null,
            index: true,
        },
        familyKey: {
            type: String,
            trim: true,
            uppercase: true,
            default: null,
            index: true,
        },
        fulfillmentMode: {
            type: String,
            enum: Object.values(FULFILLMENT_MODES),
            default: FULFILLMENT_MODES.CODE_DELIVERY,
            index: true,
        },
        codeEncrypted: {
            type: String,
            default: null,
            select: false,
        },
        serialEncrypted: {
            type: String,
            default: null,
            select: false,
        },
        pinEncrypted: {
            type: String,
            default: null,
            select: false,
        },
        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
        },
        providerRawResponse: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
            select: false,
        },
        deliveryStatus: {
            type: String,
            enum: Object.values(DELIVERY_STATUSES),
            default: DELIVERY_STATUSES.RESERVED,
            index: true,
        },
        revealCount: {
            type: Number,
            default: 0,
            min: 0,
        },
        deliveredAt: {
            type: Date,
            default: null,
        },
        revealedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

providerDeliveredCodeSchema.methods.setSecretValue = function setSecretValue(field, value) {
    if (!['codeEncrypted', 'serialEncrypted', 'pinEncrypted'].includes(field)) {
        throw new Error('Unsupported delivered code secret field.');
    }
    this[field] = value === null || value === undefined || value === ''
        ? null
        : encryptSecret(String(value));
};

providerDeliveredCodeSchema.methods.getSecretValue = function getSecretValue(field) {
    if (!['codeEncrypted', 'serialEncrypted', 'pinEncrypted'].includes(field)) {
        throw new Error('Unsupported delivered code secret field.');
    }
    const value = this[field];
    return isEncryptedSecret(value) ? decryptSecret(value) : value;
};

providerDeliveredCodeSchema.index({ order: 1, providerProduct: 1 });
providerDeliveredCodeSchema.index({ providerCode: 1, familyKey: 1, deliveryStatus: 1 });

const ProviderDeliveredCode = mongoose.model('ProviderDeliveredCode', providerDeliveredCodeSchema);

module.exports = {
    ProviderDeliveredCode,
    DELIVERY_STATUSES,
};
