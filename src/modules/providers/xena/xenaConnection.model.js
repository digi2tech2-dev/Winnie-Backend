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

xenaConnectionSchema.pre('save', function encryptConnectionId(next) {
    if (!this.isModified('encryptedConnectionId')) return next();

    if (!hasSecretValue(this.encryptedConnectionId)) {
        this.encryptedConnectionId = null;
        return next();
    }

    this.encryptedConnectionId = encryptSecret(String(this.encryptedConnectionId).trim());
    return next();
});

const hideSecrets = (_doc, ret) => {
    delete ret.encryptedConnectionId;
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
};
