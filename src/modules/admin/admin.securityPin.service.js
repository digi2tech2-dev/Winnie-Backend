'use strict';

const bcrypt = require('bcryptjs');

const config = require('../../config/config');
const { AuthenticationError, ValidationError } = require('../../shared/errors/AppError');
const { Setting, ADMIN_SECURITY_PIN_HASH_KEY } = require('./setting.model');
const { createAuditLog } = require('../audit/audit.service');
const { ADMIN_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');

const LEGACY_DEFAULT_PIN = '1111';
const PIN_PATTERN = /^\d{4}$/;

const normalizePin = (pin) => String(pin ?? '').trim();
const isValidPinFormat = (pin) => PIN_PATTERN.test(normalizePin(pin));

const getPinHashSetting = () => Setting.findOne({ key: ADMIN_SECURITY_PIN_HASH_KEY });

const hasConfiguredPin = (setting) => (
    typeof setting?.value === 'string' && setting.value.trim().length > 0
);

const getStatus = async () => {
    const setting = await getPinHashSetting().lean();
    return { configured: hasConfiguredPin(setting) };
};

const verifyPin = async (pin) => {
    const normalizedPin = normalizePin(pin);
    if (!isValidPinFormat(normalizedPin)) {
        throw new AuthenticationError('Invalid security PIN');
    }

    const setting = await getPinHashSetting().lean();
    if (!hasConfiguredPin(setting)) {
        if (normalizedPin === LEGACY_DEFAULT_PIN) return true;
        throw new AuthenticationError('Invalid security PIN');
    }

    const valid = await bcrypt.compare(normalizedPin, setting.value);
    if (!valid) {
        throw new AuthenticationError('Invalid security PIN');
    }

    return true;
};

const validateChangePayload = ({ currentPin, newPin, confirmPin } = {}) => {
    if (!currentPin || !newPin || !confirmPin) {
        throw new ValidationError('currentPin, newPin, and confirmPin are required');
    }

    if (!isValidPinFormat(newPin)) {
        throw new ValidationError('PIN must be 4 digits');
    }

    if (normalizePin(newPin) !== normalizePin(confirmPin)) {
        throw new ValidationError('New PIN and confirmation do not match');
    }
};

const updatePin = async ({ currentPin, newPin, confirmPin } = {}, actorId, auditContext = null) => {
    validateChangePayload({ currentPin, newPin, confirmPin });
    await verifyPin(currentPin);

    const hash = await bcrypt.hash(normalizePin(newPin), config.bcrypt.rounds);
    const setting = await Setting.findOneAndUpdate(
        { key: ADMIN_SECURITY_PIN_HASH_KEY },
        {
            $set: {
                value: hash,
                description: 'Hash of the admin tools access PIN',
                updatedBy: actorId,
            },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    await createAuditLog({
        actorId: auditContext?.actorId ?? actorId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.SECURITY_PIN_UPDATED,
        entityType: ENTITY_TYPES.SETTING,
        entityId: setting._id,
        metadata: { key: ADMIN_SECURITY_PIN_HASH_KEY },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    return { success: true, configured: true };
};

module.exports = {
    ADMIN_SECURITY_PIN_HASH_KEY,
    LEGACY_DEFAULT_PIN,
    getStatus,
    verifyPin,
    updatePin,
    isValidPinFormat,
};
