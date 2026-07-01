'use strict';

/**
 * admin.settings.service.js
 *
 * CRUD over the Setting collection.
 * Only admins can write. Reads can be used internally.
 */

const { Setting } = require('./setting.model');
const { NotFoundError } = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { ADMIN_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');
const {
    PAYMENT_RISK_LIMITS_SETTING_KEY,
    normalizePaymentRiskLimits,
} = require('../payments/paymentRisk.config');

// ─── List ──────────────────────────────────────────────────────────────────────

const listSettings = async () => {
    return Setting.find().sort({ key: 1 }).select('-__v');
};

// ─── Get One ──────────────────────────────────────────────────────────────────

const getSettingByKey = async (key) => {
    const setting = await Setting.findOne({ key });
    if (!setting) throw new NotFoundError('Setting');
    return setting;
};

// ─── Get value (internal use) ─────────────────────────────────────────────────

const getSettingValue = async (key, defaultValue = null) => {
    const setting = await Setting.findOne({ key }).lean();
    return setting ? setting.value : defaultValue;
};

const normalizeSettingValueForUpdate = (key, value, currentValue) => {
    if (key === PAYMENT_RISK_LIMITS_SETTING_KEY) {
        return normalizePaymentRiskLimits(value, {
            currentValue,
            allowMissing: false,
        });
    }

    return value;
};

// ─── Update ───────────────────────────────────────────────────────────────────

const updateSetting = async (key, value, adminId) => {
    let setting = await Setting.findOne({ key });
    const before = setting ? setting.value : undefined;
    const normalizedValue = normalizeSettingValueForUpdate(key, value, before);

    if (setting) {
        // ── CRITICAL: Schema.Types.Mixed fix ─────────────────────────
        // Mongoose does not detect mutations to Mixed-type fields.
        // Without markModified(), `.save()` silently skips the write
        // even though it returns the document — a "200 OK but nothing saved" bug.
        setting.value = normalizedValue;
        setting.updatedBy = adminId;
        setting.markModified('value');
        await setting.save();
    } else {
        // Key does not exist yet — auto-create it (upsert behaviour).
        setting = await Setting.create({
            key,
            value: normalizedValue,
            description: '',
            updatedBy: adminId,
        });
    }

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.SETTING_UPDATED,
        entityType: ENTITY_TYPES.SETTING,
        entityId: setting._id,
        metadata: { key, before, after: normalizedValue },
    });

    return setting;
};

module.exports = { listSettings, getSettingByKey, getSettingValue, updateSetting };
