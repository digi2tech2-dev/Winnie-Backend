'use strict';

const mongoose = require('mongoose');
const {
    encryptSecret,
    getProviderCredential,
    hasSecretValue,
} = require('../../../shared/utils/secretEncryption');

const XENA_CONNECTION_STATUSES = Object.freeze({
    CONNECTION_REQUIRED: 'connection_required',
    VERIFICATION_REQUIRED: 'verification_required',
    PENDING: 'pending',
    CONNECTED: 'connected',
    REAUTHENTICATION_REQUIRED: 'reauthentication_required',
    DISABLED: 'disabled',
    UNKNOWN: 'unknown',
});

const DEFAULT_XENA_SYNTHETIC_PRODUCT = Object.freeze({
    externalProductId: 'xena-dynamic-recharge',
    name: 'Xena Dynamic Recharge (Any Amount)',
    minAmount: 1,
    maxAmount: 1000000,
    providerUnitPrice: null,
    isActive: true,
});

const xenaConnectionSchema = new mongoose.Schema(
    {
        provider: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Provider',
            required: true,
            unique: true,
            index: true,
        },
        encryptedConnectionId: {
            type: String,
            default: null,
            select: false,
        },
        encryptedChallengeReference: {
            type: String,
            default: null,
            select: false,
        },
        displayName: {
            type: String,
            trim: true,
            maxlength: 120,
            default: null,
        },
        maskedUsername: {
            type: String,
            trim: true,
            maxlength: 180,
            default: null,
        },
        status: {
            type: String,
            enum: Object.values(XENA_CONNECTION_STATUSES),
            default: XENA_CONNECTION_STATUSES.CONNECTION_REQUIRED,
            index: true,
        },
        tokenExpiresAt: {
            type: Date,
            default: null,
        },
        lastErrorCode: {
            type: String,
            trim: true,
            maxlength: 100,
            default: null,
        },
        lastErrorMessage: {
            type: String,
            trim: true,
            maxlength: 500,
            default: null,
        },
        lastCheckedAt: {
            type: Date,
            default: null,
        },
        lastBalance: {
            type: String,
            default: null,
        },
        lastBalanceCurrency: {
            type: String,
            trim: true,
            maxlength: 20,
            default: null,
        },
        lastBalanceCheckedAt: {
            type: Date,
            default: null,
        },
        lastBalanceRequestId: {
            type: String,
            trim: true,
            maxlength: 200,
            default: null,
        },
        productConfig: {
            externalProductId: {
                type: String,
                trim: true,
                default: DEFAULT_XENA_SYNTHETIC_PRODUCT.externalProductId,
                immutable: true,
            },
            name: {
                type: String,
                trim: true,
                maxlength: 180,
                default: DEFAULT_XENA_SYNTHETIC_PRODUCT.name,
            },
            minAmount: {
                type: Number,
                default: DEFAULT_XENA_SYNTHETIC_PRODUCT.minAmount,
                min: 1,
            },
            maxAmount: {
                type: Number,
                default: DEFAULT_XENA_SYNTHETIC_PRODUCT.maxAmount,
                min: 1,
            },
            providerUnitPrice: {
                type: String,
                default: DEFAULT_XENA_SYNTHETIC_PRODUCT.providerUnitPrice,
            },
            isActive: {
                type: Boolean,
                default: DEFAULT_XENA_SYNTHETIC_PRODUCT.isActive,
            },
            updatedBy: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'User',
                default: null,
            },
            updatedAt: {
                type: Date,
                default: null,
            },
        },
    },
    {
        timestamps: true,
    }
);

xenaConnectionSchema.methods.setConnectionId = function setConnectionId(connectionId) {
    this.encryptedConnectionId = hasSecretValue(connectionId)
        ? encryptSecret(String(connectionId).trim())
        : null;
};

xenaConnectionSchema.methods.getConnectionId = function getConnectionId() {
    return getProviderCredential(this.encryptedConnectionId || null);
};

xenaConnectionSchema.methods.setChallengeReference = function setChallengeReference(challengeReference) {
    this.encryptedChallengeReference = hasSecretValue(challengeReference)
        ? encryptSecret(String(challengeReference).trim())
        : null;
};

xenaConnectionSchema.methods.getChallengeReference = function getChallengeReference() {
    return getProviderCredential(this.encryptedChallengeReference || null);
};

xenaConnectionSchema.methods.clearChallengeReference = function clearChallengeReference() {
    this.encryptedChallengeReference = null;
};

xenaConnectionSchema.pre('save', function encryptConnectionId(next) {
    const secretFields = ['encryptedConnectionId', 'encryptedChallengeReference'];

    for (const field of secretFields) {
        if (!this.isModified(field)) continue;

        if (!hasSecretValue(this[field])) {
            this[field] = null;
            continue;
        }

        this[field] = encryptSecret(String(this[field]).trim());
    }

    return next();
});

const hideSecrets = (_doc, ret) => {
    delete ret.encryptedConnectionId;
    delete ret.encryptedChallengeReference;
    return ret;
};

xenaConnectionSchema.set('toJSON', {
    versionKey: false,
    transform: hideSecrets,
});

xenaConnectionSchema.set('toObject', {
    versionKey: false,
    transform: hideSecrets,
});

const XenaConnection = mongoose.model('XenaConnection', xenaConnectionSchema);

module.exports = {
    XenaConnection,
    XENA_CONNECTION_STATUSES,
    DEFAULT_XENA_SYNTHETIC_PRODUCT,
};
