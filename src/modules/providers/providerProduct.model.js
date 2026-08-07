'use strict';

const mongoose = require('mongoose');
const { PROVIDER_CODES } = require('./provider.constants');

const FULFILLMENT_MODES = Object.freeze({
    TOPUP_WITH_FIELDS: 'TOPUP_WITH_FIELDS',
    CODE_DELIVERY: 'CODE_DELIVERY',
    UNKNOWN: 'UNKNOWN',
});

/**
 * ProviderProduct — INTERNAL ONLY.
 *
 * Raw product data as fetched (and refreshed) from a provider's API.
 * This collection is NEVER exposed to end-users.
 * Admins read it when deciding which products to publish.
 *
 * Lifecycle:
 *   Sync engine → upsert → ProviderProduct
 *   Admin → select ProviderProduct → create/link Product
 *
 * Immutability contract:
 *   rawPayload is replaced wholesale on each sync.
 *   All other raw* fields are also overwritten.
 *   The only field preserved across syncs is _id (the stable internal key).
 */
const providerProductSchema = new mongoose.Schema(
    {
        provider: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Provider',
            required: [true, 'provider is required'],
            index: true,
        },

        /**
         * The product's identifier as returned by the provider's API.
         * Combined with `provider`, forms the natural key of this record.
         */
        externalProductId: {
            type: String,
            required: [true, 'externalProductId is required'],
            trim: true,
        },

        providerCode: {
            type: String,
            enum: Object.values(PROVIDER_CODES),
            uppercase: true,
            trim: true,
            default: null,
        },

        rawName: {
            type: String,
            required: [true, 'rawName is required'],
            trim: true,
        },

        name: {
            type: String,
            trim: true,
            default: null,
        },

        /**
         * Optional human-friendly name set by an admin.
         * Displayed in the admin product-selection UI.
         * Never overwritten by syncs.
         */
        translatedName: {
            type: String,
            trim: true,
            default: null,
        },

        rawPrice: {
            type: String,
            required: [true, 'rawPrice is required'],
            get: (v) => String(v ?? '0'),
            set: (v) => String(v ?? '0'),
        },

        category: {
            type: String,
            trim: true,
            default: null,
            index: true,
        },

        categoryName: {
            type: String,
            trim: true,
            default: null,
        },

        offerId: {
            type: String,
            trim: true,
            default: null,
            index: true,
        },

        offerName: {
            type: String,
            trim: true,
            default: null,
        },

        subCategory: {
            type: String,
            trim: true,
            default: null,
        },

        region: {
            type: String,
            trim: true,
            default: null,
            index: true,
        },

        platform: {
            type: String,
            trim: true,
            default: null,
        },

        currency: {
            type: String,
            trim: true,
            uppercase: true,
            default: null,
        },

        costPrice: {
            type: String,
            default: null,
            get: (v) => (v == null ? null : String(v)),
            set: (v) => (v == null ? null : String(v)),
        },

        available: {
            type: Boolean,
            default: null,
            index: true,
        },

        stock: {
            type: Number,
            default: null,
        },

        minQty: {
            type: Number,
            default: 1,
            min: [1, 'minQty must be at least 1'],
        },

        maxQty: {
            type: Number,
            default: 9999,
        },

        /**
         * Whether the provider reports this product as available.
         * A ProviderProduct with isActive=false should not be surfaced
         * for new Product publishing, but existing linked Products are
         * not automatically deactivated (admin decides).
         */
        isActive: {
            type: Boolean,
            default: true,
        },

        /** Timestamp of the most recent successful sync for this product. */
        lastSyncedAt: {
            type: Date,
            default: null,
        },

        fulfillmentMode: {
            type: String,
            enum: Object.values(FULFILLMENT_MODES),
            default: FULFILLMENT_MODES.UNKNOWN,
            index: true,
        },

        isSupported: {
            type: Boolean,
            default: false,
            index: true,
        },

        isBlocked: {
            type: Boolean,
            default: false,
            index: true,
        },

        blockReason: {
            type: String,
            trim: true,
            default: null,
        },

        requiredFields: {
            type: [mongoose.Schema.Types.Mixed],
            default: [],
        },

        /**
         * Full raw JSON payload returned by the provider for this product.
         * Stored verbatim so nothing is ever lost even if the schema evolves.
         */
        rawPayload: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
        },
    },
    {
        timestamps: true,   // createdAt + updatedAt
        versionKey: false,
    }
);

// =============================================================================
// Indexes
// =============================================================================

/**
 * Primary uniqueness constraint: each (provider, externalProductId) pair is
 * globally unique. Prevents duplicate records from idempotent upserts.
 */
providerProductSchema.index(
    { provider: 1, externalProductId: 1 },
    { unique: true, name: 'unique_provider_external_product' }
);

/**
 * Admin product-selection screen: fetch all raw products for a given provider.
 */
providerProductSchema.index(
    { provider: 1, isActive: 1 },
    { name: 'provider_active_products' }
);

/**
 * Stale-sync detection: find all products that haven't been synced recently.
 */
providerProductSchema.index(
    { lastSyncedAt: 1 },
    { name: 'last_synced_at' }
);

providerProductSchema.index(
    { providerCode: 1, category: 1, region: 1, fulfillmentMode: 1 },
    { name: 'provider_code_catalog_filters' }
);

providerProductSchema.pre('validate', async function enforceUniqueProviderProductIdentity() {
    if (!this.isNew && !this.isModified('provider') && !this.isModified('externalProductId')) return;
    if (!this.provider || !this.externalProductId) return;

    const existing = await this.constructor.exists({
        _id: { $ne: this._id },
        provider: this.provider,
        externalProductId: this.externalProductId,
    });

    if (existing) {
        throw new Error('ProviderProduct externalProductId must be unique per provider');
    }
});

const ProviderProduct = mongoose.model('ProviderProduct', providerProductSchema);

module.exports = { ProviderProduct, FULFILLMENT_MODES };
