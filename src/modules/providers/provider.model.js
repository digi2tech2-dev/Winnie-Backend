'use strict';

const mongoose = require('mongoose');
const {
    encryptSecret,
    getProviderCredential,
    hasSecretValue,
} = require('../../shared/utils/secretEncryption');

const CREDENTIAL_FIELDS = ['apiToken', 'apiKey'];

/**
 * Provider — an external data source that supplies raw product inventory.
 *
 * Layer 1 of the 3-layer architecture:
 *   Provider → ProviderProduct → Product
 *
 * Each provider has its own HTTP API adapter. The sync engine calls the
 * adapter and writes raw data into ProviderProducts. Admins then
 * cherry-pick which raw products to expose as platform Products.
 */
const providerSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Provider name is required'],
            trim: true,
            unique: true,
            minlength: [2, 'Provider name must be at least 2 characters'],
            maxlength: [100, 'Provider name cannot exceed 100 characters'],
        },

        /**
         * URL-safe identifier, e.g. "royal-crown".
         * Auto-generated from name if not supplied.
         * Used as adapter registry key.
         */
        slug: {
            type: String,
            trim: true,
            unique: true,
            sparse: true,
            lowercase: true,
        },

        /**
         * Base URL of the provider's API.
         * The adapter uses this as the root for all HTTP calls.
         */
        baseUrl: {
            type: String,
            required: [true, 'baseUrl is required'],
            trim: true,
        },

        /**
         * Primary API token / key for this provider.
         * Stored encrypted at rest and never returned by API serializers.
         */
        apiToken: {
            type: String,
            trim: true,
            default: null,
        },

        /**
         * @deprecated — kept for backward compatibility, maps to apiToken.
         */
        apiKey: {
            type: String,
            trim: true,
            default: null,
        },

        isActive: {
            type: Boolean,
            default: true,
        },

        /**
         * How often (in minutes) the scheduler should sync this provider.
         * 0 = never sync automatically (manual-only).
         */
        syncInterval: {
            type: Number,
            default: 60,
            min: [0, 'syncInterval cannot be negative'],
        },

        /**
         * List of feature strings this provider supports.
         * Examples: ['placeOrder', 'checkOrder', 'checkOrdersBatch', 'fetchProducts']
         * Used by the adapter factory to validate capabilities before calling.
         */
        supportedFeatures: {
            type: [String],
            default: [],
        },

        /** Soft-delete timestamp. Null = not deleted. */
        deletedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

// ─── Virtuals ──────────────────────────────────────────────────────────────────

/**
 * effectiveToken — resolves apiToken → apiKey for backward compatibility.
 * Always use this in adapters instead of reading either field directly.
 */
providerSchema.virtual('effectiveToken').get(function () {
    return getProviderCredential(this.apiToken || this.apiKey || null);
});

const addCredentialStatus = (doc, ret) => {
    const hasApiToken = hasSecretValue(doc.apiToken);
    const hasApiKey = hasSecretValue(doc.apiKey);

    ret.hasApiToken = hasApiToken;
    ret.hasApiKey = hasApiKey;
    ret.credentialConfigured = hasApiToken || hasApiKey;
    ret.credentialsConfigured = ret.credentialConfigured;

    delete ret.apiToken;
    delete ret.apiKey;
    delete ret.effectiveToken;
    return ret;
};

providerSchema.set('toJSON', {
    virtuals: false,
    versionKey: false,
    transform: addCredentialStatus,
});

providerSchema.set('toObject', {
    virtuals: false,
    versionKey: false,
    transform: addCredentialStatus,
});

// ─── Pre-save: auto-generate slug ───────────────────────────────────────────────

providerSchema.pre('save', function (next) {
    if (!this.slug && this.name) {
        this.slug = this.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    for (const field of CREDENTIAL_FIELDS) {
        if (!this.isModified(field)) continue;

        const value = this[field];
        if (!hasSecretValue(value)) {
            this[field] = null;
            continue;
        }

        this[field] = encryptSecret(String(value).trim());
    }

    next();
});

// ─── Indexes ──────────────────────────────────────────────────────────────────

providerSchema.index({ isActive: 1 });

const Provider = mongoose.model('Provider', providerSchema);

module.exports = { Provider };
