'use strict';

/**
 * setting.model.js
 *
 * Generic key-value system settings store.
 *
 * Fields:
 *   key         - unique identifier (e.g. "orderTimeoutMinutes")
 *   value       - any JSON-serialisable value
 *   description - human-readable note for admin UI
 *   updatedBy   - last admin who changed this setting
 */

const mongoose = require('mongoose');
const {
    getDefaultPaymentRiskLimits,
    PAYMENT_RISK_LIMITS_SETTING_KEY,
} = require('../payments/paymentRisk.config');

const settingSchema = new mongoose.Schema(
    {
        key: {
            type: String,
            required: [true, 'Setting key is required'],
            unique: true,
            trim: true,
            match: [/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Key must be alphanumeric (camelCase or underscores)'],
            maxlength: [64, 'Key cannot exceed 64 characters'],
        },

        value: {
            type: mongoose.Schema.Types.Mixed,
            required: [true, 'Setting value is required'],
        },

        description: {
            type: String,
            trim: true,
            maxlength: [255, 'Description cannot exceed 255 characters'],
            default: '',
        },

        updatedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
    },
    { timestamps: true }
);

const Setting = mongoose.model('Setting', settingSchema);
const ADMIN_SECURITY_PIN_HASH_KEY = 'ADMIN_SECURITY_PIN_HASH';

// ─── Default settings (seeded on first boot) ─────────────────────────────────
const DEFAULT_SETTINGS = [
    { key: 'orderTimeoutMinutes', value: 30, description: 'Minutes before a PROCESSING order is auto-failed' },
    { key: 'providerRetryLimit', value: 5, description: 'Max polling attempts before an order is forced FAILED' },
    { key: 'maintenanceMode', value: false, description: 'When true, new orders are blocked platform-wide' },
    { key: 'maxWalletAdjustment', value: 10000, description: 'Maximum single manual wallet adjustment (admin)' },
    { key: 'defaultPaginationLimit', value: 20, description: 'Default page size for list endpoints' },
    { key: 'paymentGroups', value: [], description: 'Dynamic payment methods grouped by category' },
    { key: 'paymentCountryAccounts', value: [], description: 'Country-specific payment accounts' },
    { key: 'paymentInstructions', value: '', description: 'General payment instructions shown to customers' },
    { key: 'whatsappNumber', value: '', description: 'WhatsApp number for customer support' },
    {
        key: PAYMENT_RISK_LIMITS_SETTING_KEY,
        value: getDefaultPaymentRiskLimits(),
        description: 'Online payment risk limits evaluated before gateway intent creation',
    },
    {
        key: 'referrals',
        value: {
            enabled: true,
            depositCommissionPercentage: 1,
            applyTo: 'EVERY_ELIGIBLE_WALLET_CREDIT',
            minSourceAmount: null,
            maxCommissionAmount: null,
        },
        description: 'Referral and invitation commission settings',
    },
];

/**
 * Upsert default settings on startup.
 * Only inserts rows that don't already exist — never overwrites admin values.
 */
const seedDefaultSettings = async () => {
    for (const s of DEFAULT_SETTINGS) {
        await Setting.updateOne(
            { key: s.key },
            { $setOnInsert: { key: s.key, value: s.value, description: s.description } },
            { upsert: true }
        );
    }
};

module.exports = { Setting, DEFAULT_SETTINGS, seedDefaultSettings, ADMIN_SECURITY_PIN_HASH_KEY };
