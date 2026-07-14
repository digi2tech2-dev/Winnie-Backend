'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../../../config/config');
const { User, DEFAULT_WHATSAPP_EVENT_PREFERENCES } = require('../../users/user.model');
const { AdminWhatsAppRecipient } = require('./adminWhatsAppRecipient.model');
const { WhatsAppNotificationLog } = require('./whatsappNotificationLog.model');
const { normalizePhoneNumber } = require('./phoneNormalizer');
const openwaClient = require('./openwa.client');
const { renderTemplate } = require('./whatsappTemplates');
const { createAuditLog } = require('../../audit/audit.service');
const {
    ADMIN_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
} = require('../../audit/audit.constants');
const {
    ADMIN_DEFAULT_EVENT_PREFERENCES,
    ADMIN_EVENT_PREFERENCE_BY_TYPE,
    CUSTOMER_EVENT_PREFERENCE_BY_TYPE,
    LOG_STATUSES,
    RECIPIENT_TYPES,
    WHATSAPP_PROVIDER,
} = require('./whatsapp.constants');
const {
    BusinessRuleError,
    NotFoundError,
    ValidationError,
} = require('../../../shared/errors/AppError');

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RATE_LIMIT_MS = 60 * 1000;
const TEST_RATE_LIMIT_MS = 60 * 1000;

const getRuntimeOpenWaConfig = () => ({
    enabled: process.env.OPENWA_ENABLED !== undefined
        ? process.env.OPENWA_ENABLED === 'true'
        : config.openwa.enabled,
    maxRetries: parseInt(process.env.OPENWA_MAX_RETRIES || config.openwa.maxRetries || '3', 10),
    retryDelaySeconds: parseInt(process.env.OPENWA_RETRY_DELAY_SECONDS || config.openwa.retryDelaySeconds || '60', 10),
});

const toObjectIdOrNull = (value) => {
    if (!value) return null;
    if (value._id) return value._id;
    return mongoose.Types.ObjectId.isValid(value) ? value : null;
};

const mergeCustomerPreferences = (preferences = {}) => ({
    ...DEFAULT_WHATSAPP_EVENT_PREFERENCES,
    ...(preferences && typeof preferences === 'object' ? preferences : {}),
});

const mergeAdminPreferences = (preferences = {}) => ({
    ...ADMIN_DEFAULT_EVENT_PREFERENCES,
    ...(preferences && typeof preferences === 'object' ? preferences : {}),
});

const pickKnownPreferences = (source = {}, defaults) => Object.keys(defaults).reduce((acc, key) => {
    if (source[key] !== undefined) acc[key] = source[key] === true;
    return acc;
}, {});

const serializeCustomerSettings = (user) => {
    const settings = user?.whatsappNotifications || {};
    return {
        enabled: settings.enabled === true,
        phone: settings.phone || '',
        phoneVerified: settings.phoneVerified === true,
        verifiedAt: settings.verifiedAt || null,
        lastVerificationSentAt: settings.lastVerificationSentAt || null,
        inactiveReason: settings.enabled && !settings.phoneVerified ? 'PHONE_NOT_VERIFIED' : null,
        eventPreferences: mergeCustomerPreferences(settings.eventPreferences),
    };
};

const serializeRecipient = (recipient) => {
    const doc = recipient?.toObject ? recipient.toObject() : recipient;
    return {
        ...doc,
        id: doc?._id?.toString?.() || doc?.id,
        eventPreferences: mergeAdminPreferences(doc?.eventPreferences),
    };
};

const hashOtp = (code, userId) => crypto
    .createHash('sha256')
    .update(`${String(userId)}:${String(code)}:${config.jwt.secret}`)
    .digest('hex');

const generateOtp = () => crypto.randomInt(100000, 1000000).toString();

const ensureNotTooSoon = (date, windowMs, message, code) => {
    if (date && Date.now() - new Date(date).getTime() < windowMs) {
        throw new BusinessRuleError(message, code);
    }
};

const audit = (params) => {
    void createAuditLog(params);
};

const getCustomerSettings = async (userId) => {
    const user = await User.findById(userId).select('whatsappNotifications');
    if (!user) throw new NotFoundError('User');
    return serializeCustomerSettings(user);
};

const updateCustomerSettings = async (userId, payload = {}, auditContext = null) => {
    const user = await User.findById(userId).select('whatsappNotifications');
    if (!user) throw new NotFoundError('User');

    const current = serializeCustomerSettings(user);
    const updates = {};

    if (payload.phone !== undefined) {
        const normalized = String(payload.phone || '').trim()
            ? normalizePhoneNumber(payload.phone).phone
            : '';
        const changed = normalized !== String(current.phone || '');
        updates['whatsappNotifications.phone'] = normalized || null;
        if (changed) {
            updates['whatsappNotifications.phoneVerified'] = false;
            updates['whatsappNotifications.verifiedAt'] = null;
            updates['whatsappNotifications.verificationCodeHash'] = null;
            updates['whatsappNotifications.verificationCodeExpiresAt'] = null;
        }
    }

    if (payload.enabled !== undefined) {
        updates['whatsappNotifications.enabled'] = payload.enabled === true;
    }

    if (payload.eventPreferences && typeof payload.eventPreferences === 'object') {
        const nextPrefs = pickKnownPreferences(payload.eventPreferences, DEFAULT_WHATSAPP_EVENT_PREFERENCES);
        Object.entries(nextPrefs).forEach(([key, value]) => {
            updates[`whatsappNotifications.eventPreferences.${key}`] = value;
        });
    }

    const updated = await User.findByIdAndUpdate(
        userId,
        { $set: updates },
        { new: true, runValidators: true }
    ).select('whatsappNotifications');

    audit({
        actorId: auditContext?.actorId || userId,
        actorRole: auditContext?.actorRole || ACTOR_ROLES.CUSTOMER,
        action: ADMIN_ACTIONS.WHATSAPP_CUSTOMER_SETTINGS_UPDATED,
        entityType: ENTITY_TYPES.USER,
        entityId: userId,
        metadata: {
            enabled: updated.whatsappNotifications?.enabled === true,
            phoneChanged: payload.phone !== undefined,
            eventPreferencesUpdated: Boolean(payload.eventPreferences),
        },
        ipAddress: auditContext?.ipAddress || null,
        userAgent: auditContext?.userAgent || null,
    });

    return serializeCustomerSettings(updated);
};

const sendCustomerVerificationCode = async (userId, phone, auditContext = null) => {
    const normalized = normalizePhoneNumber(phone);
    const user = await User.findById(userId).select('whatsappNotifications');
    if (!user) throw new NotFoundError('User');

    ensureNotTooSoon(
        user.whatsappNotifications?.lastVerificationSentAt,
        OTP_RATE_LIMIT_MS,
        'Please wait before requesting another WhatsApp verification code.',
        'WHATSAPP_OTP_RATE_LIMITED'
    );

    const code = generateOtp();
    const now = new Date();
    user.whatsappNotifications = {
        ...serializeCustomerSettings(user),
        phone: normalized.phone,
        phoneVerified: false,
        verifiedAt: null,
        verificationCodeHash: hashOtp(code, userId),
        verificationCodeExpiresAt: new Date(now.getTime() + OTP_TTL_MS),
        lastVerificationSentAt: now,
    };
    await user.save();

    await queueWhatsAppNotification({
        recipientType: RECIPIENT_TYPES.CUSTOMER,
        recipientUserId: userId,
        phone: normalized.phone,
        eventType: 'verification_code',
        title: 'كود تفعيل واتساب',
        payload: { code },
        metadata: { purpose: 'verification' },
        idempotencyKey: null,
    });

    audit({
        actorId: auditContext?.actorId || userId,
        actorRole: auditContext?.actorRole || ACTOR_ROLES.CUSTOMER,
        action: ADMIN_ACTIONS.WHATSAPP_VERIFICATION_CODE_SENT,
        entityType: ENTITY_TYPES.USER,
        entityId: userId,
        metadata: { phone: normalized.phone },
        ipAddress: auditContext?.ipAddress || null,
        userAgent: auditContext?.userAgent || null,
    });

    if (config.env !== 'test') void processPendingMessages({ limit: 3 });

    return { message: 'Verification code queued.' };
};

const verifyCustomerPhone = async (userId, code, auditContext = null) => {
    const normalizedCode = String(code || '').trim();
    if (!/^\d{6}$/.test(normalizedCode)) {
        throw new ValidationError('Invalid verification code.', [{ field: 'code', message: 'Code must be 6 digits' }]);
    }

    const user = await User.findById(userId).select('whatsappNotifications');
    if (!user) throw new NotFoundError('User');

    const settings = user.whatsappNotifications || {};
    if (!settings.verificationCodeHash || !settings.verificationCodeExpiresAt) {
        throw new BusinessRuleError('No active WhatsApp verification code was found.', 'WHATSAPP_CODE_NOT_FOUND');
    }
    if (new Date(settings.verificationCodeExpiresAt).getTime() < Date.now()) {
        throw new BusinessRuleError('WhatsApp verification code has expired.', 'WHATSAPP_CODE_EXPIRED');
    }
    if (hashOtp(normalizedCode, userId) !== settings.verificationCodeHash) {
        throw new BusinessRuleError('WhatsApp verification code is incorrect.', 'WHATSAPP_CODE_INVALID');
    }

    user.whatsappNotifications.phoneVerified = true;
    user.whatsappNotifications.verifiedAt = new Date();
    user.whatsappNotifications.enabled = true;
    user.whatsappNotifications.verificationCodeHash = null;
    user.whatsappNotifications.verificationCodeExpiresAt = null;
    await user.save();

    audit({
        actorId: auditContext?.actorId || userId,
        actorRole: auditContext?.actorRole || ACTOR_ROLES.CUSTOMER,
        action: ADMIN_ACTIONS.WHATSAPP_PHONE_VERIFIED,
        entityType: ENTITY_TYPES.USER,
        entityId: userId,
        metadata: { phone: user.whatsappNotifications.phone },
        ipAddress: auditContext?.ipAddress || null,
        userAgent: auditContext?.userAgent || null,
    });

    return serializeCustomerSettings(user);
};

const sendCustomerTest = async (userId, auditContext = null) => {
    const user = await User.findById(userId).select('whatsappNotifications');
    if (!user) throw new NotFoundError('User');
    const settings = user.whatsappNotifications || {};
    ensureNotTooSoon(settings.lastTestSentAt, TEST_RATE_LIMIT_MS, 'Please wait before sending another test message.', 'WHATSAPP_TEST_RATE_LIMITED');
    if (!settings.enabled || !settings.phoneVerified || !settings.phone) {
        throw new BusinessRuleError('WhatsApp notifications must be enabled and verified before sending a test.', 'WHATSAPP_NOT_VERIFIED');
    }

    await queueWhatsAppNotification({
        recipientType: RECIPIENT_TYPES.CUSTOMER,
        recipientUserId: userId,
        phone: settings.phone,
        eventType: 'test_message',
        payload: { message: 'هذه رسالة تجربة من Winnie ✅' },
        metadata: { purpose: 'customer_test' },
        idempotencyKey: null,
    });

    user.whatsappNotifications.lastTestSentAt = new Date();
    await user.save();

    audit({
        actorId: auditContext?.actorId || userId,
        actorRole: auditContext?.actorRole || ACTOR_ROLES.CUSTOMER,
        action: ADMIN_ACTIONS.WHATSAPP_TEST_MESSAGE_SENT,
        entityType: ENTITY_TYPES.USER,
        entityId: userId,
        metadata: { recipientType: RECIPIENT_TYPES.CUSTOMER },
        ipAddress: auditContext?.ipAddress || null,
        userAgent: auditContext?.userAgent || null,
    });

    if (config.env !== 'test') void processPendingMessages({ limit: 3 });
    return { message: 'Test message queued.' };
};

const getOpenWaStatus = () => openwaClient.getStatus();

const listRecipients = async () => {
    const recipients = await AdminWhatsAppRecipient.find().sort({ createdAt: -1 });
    return recipients.map(serializeRecipient);
};

const createRecipient = async (payload = {}, actorId, auditContext = null) => {
    const normalized = normalizePhoneNumber(payload.phone);
    const recipient = await AdminWhatsAppRecipient.create({
        name: payload.name,
        phone: normalized.phone,
        enabled: payload.enabled !== false,
        eventPreferences: mergeAdminPreferences(payload.eventPreferences),
        createdBy: actorId,
        updatedBy: actorId,
    });

    audit({
        actorId,
        actorRole: auditContext?.actorRole || ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.WHATSAPP_ADMIN_RECIPIENT_CREATED,
        entityType: ENTITY_TYPES.USER,
        entityId: actorId,
        metadata: { adminRecipientId: recipient._id, phone: recipient.phone },
        ipAddress: auditContext?.ipAddress || null,
        userAgent: auditContext?.userAgent || null,
    });

    return serializeRecipient(recipient);
};

const updateRecipient = async (id, payload = {}, actorId, auditContext = null) => {
    const recipient = await AdminWhatsAppRecipient.findById(id);
    if (!recipient) throw new NotFoundError('AdminWhatsAppRecipient');

    if (payload.name !== undefined) recipient.name = String(payload.name || '').trim();
    if (payload.phone !== undefined) recipient.phone = normalizePhoneNumber(payload.phone).phone;
    if (payload.enabled !== undefined) recipient.enabled = payload.enabled === true;
    if (payload.eventPreferences && typeof payload.eventPreferences === 'object') {
        recipient.eventPreferences = {
            ...mergeAdminPreferences(recipient.eventPreferences),
            ...pickKnownPreferences(payload.eventPreferences, ADMIN_DEFAULT_EVENT_PREFERENCES),
        };
    }
    recipient.updatedBy = actorId;
    await recipient.save();

    audit({
        actorId,
        actorRole: auditContext?.actorRole || ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.WHATSAPP_ADMIN_RECIPIENT_UPDATED,
        entityType: ENTITY_TYPES.USER,
        entityId: actorId,
        metadata: { adminRecipientId: recipient._id, phone: recipient.phone },
        ipAddress: auditContext?.ipAddress || null,
        userAgent: auditContext?.userAgent || null,
    });

    return serializeRecipient(recipient);
};

const deleteRecipient = async (id, actorId, auditContext = null) => {
    const recipient = await AdminWhatsAppRecipient.findByIdAndDelete(id);
    if (!recipient) throw new NotFoundError('AdminWhatsAppRecipient');

    audit({
        actorId,
        actorRole: auditContext?.actorRole || ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.WHATSAPP_ADMIN_RECIPIENT_DELETED,
        entityType: ENTITY_TYPES.USER,
        entityId: actorId,
        metadata: { adminRecipientId: recipient._id, phone: recipient.phone },
        ipAddress: auditContext?.ipAddress || null,
        userAgent: auditContext?.userAgent || null,
    });

    return serializeRecipient(recipient);
};

const sendRecipientTest = async (id, actorId, auditContext = null) => {
    const recipient = await AdminWhatsAppRecipient.findById(id);
    if (!recipient) throw new NotFoundError('AdminWhatsAppRecipient');
    if (!recipient.enabled) throw new BusinessRuleError('Recipient is disabled.', 'WHATSAPP_RECIPIENT_DISABLED');

    await queueWhatsAppNotification({
        recipientType: RECIPIENT_TYPES.ADMIN,
        adminRecipientId: recipient._id,
        phone: recipient.phone,
        eventType: 'test_message',
        payload: { message: 'هذه رسالة تجربة من Winnie للأدمن ✅' },
        metadata: { purpose: 'admin_recipient_test', actorId: String(actorId) },
        idempotencyKey: null,
    });

    audit({
        actorId,
        actorRole: auditContext?.actorRole || ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.WHATSAPP_TEST_MESSAGE_SENT,
        entityType: ENTITY_TYPES.USER,
        entityId: actorId,
        metadata: { recipientType: RECIPIENT_TYPES.ADMIN, adminRecipientId: recipient._id },
        ipAddress: auditContext?.ipAddress || null,
        userAgent: auditContext?.userAgent || null,
    });

    if (config.env !== 'test') void processPendingMessages({ limit: 3 });
    return { message: 'Admin test message queued.' };
};

const sendOpenWaTest = async (phone, actorId, auditContext = null) => {
    const normalized = normalizePhoneNumber(phone);
    const log = await queueWhatsAppNotification({
        recipientType: RECIPIENT_TYPES.ADMIN,
        phone: normalized.phone,
        eventType: 'test_message',
        payload: { message: 'رسالة تجربة مباشرة من Winnie عبر OpenWA ✅' },
        metadata: { purpose: 'openwa_direct_test', actorId: String(actorId) },
        idempotencyKey: null,
    });

    audit({
        actorId,
        actorRole: auditContext?.actorRole || ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.WHATSAPP_TEST_MESSAGE_SENT,
        entityType: ENTITY_TYPES.USER,
        entityId: actorId,
        metadata: { recipientType: RECIPIENT_TYPES.ADMIN, directPhone: normalized.phone },
        ipAddress: auditContext?.ipAddress || null,
        userAgent: auditContext?.userAgent || null,
    });

    if (config.env !== 'test') void processPendingMessages({ limit: 3 });
    return log;
};

const buildIdempotencyKey = ({
    eventType,
    relatedEntityType,
    relatedEntityId,
    recipientType,
    recipientUserId,
    adminRecipientId,
}) => {
    if (!relatedEntityType || !relatedEntityId) return null;
    const recipientId = recipientType === RECIPIENT_TYPES.CUSTOMER
        ? recipientUserId
        : adminRecipientId;
    if (!recipientId) return null;
    return [
        eventType,
        relatedEntityType,
        String(relatedEntityId),
        recipientType,
        String(recipientId),
    ].join(':');
};

const queueWhatsAppNotification = async ({
    recipientType,
    recipientUserId = null,
    adminRecipientId = null,
    phone,
    eventType,
    title = null,
    message = null,
    relatedEntityType = null,
    relatedEntityId = null,
    payload = {},
    metadata = {},
    idempotencyKey,
    reason = null,
    status = LOG_STATUSES.PENDING,
}) => {
    const runtime = getRuntimeOpenWaConfig();
    let normalized;
    try {
        normalized = normalizePhoneNumber(phone);
    } catch (error) {
        const template = renderTemplate(eventType, payload);
        return WhatsAppNotificationLog.create({
            recipientType,
            recipientUserId: toObjectIdOrNull(recipientUserId),
            adminRecipientId: toObjectIdOrNull(adminRecipientId),
            phone: phone || null,
            eventType,
            title: title || template.title,
            message: message || template.message,
            provider: WHATSAPP_PROVIDER.OPENWA,
            status: LOG_STATUSES.FAILED,
            reason: 'INVALID_PHONE',
            errorMessage: error.message,
            maxRetries: runtime.maxRetries,
            relatedEntityType,
            relatedEntityId: toObjectIdOrNull(relatedEntityId),
            metadata,
        });
    }

    const template = renderTemplate(eventType, { ...payload, relatedEntityId });
    const resolvedIdempotencyKey = idempotencyKey === undefined
        ? buildIdempotencyKey({ eventType, relatedEntityType, relatedEntityId, recipientType, recipientUserId, adminRecipientId })
        : idempotencyKey;

    try {
        return await WhatsAppNotificationLog.create({
            recipientType,
            recipientUserId: toObjectIdOrNull(recipientUserId),
            adminRecipientId: toObjectIdOrNull(adminRecipientId),
            phone: normalized.phone,
            chatId: normalized.chatId,
            eventType,
            title: title || template.title,
            message: message || template.message,
            provider: WHATSAPP_PROVIDER.OPENWA,
            status,
            reason,
            maxRetries: runtime.maxRetries,
            relatedEntityType,
            relatedEntityId: toObjectIdOrNull(relatedEntityId),
            idempotencyKey: resolvedIdempotencyKey,
            metadata,
        });
    } catch (error) {
        if (error.code === 11000 && resolvedIdempotencyKey) {
            return WhatsAppNotificationLog.findOne({ idempotencyKey: resolvedIdempotencyKey });
        }
        throw error;
    }
};

const queueCustomerEvent = async ({ userId, eventType, relatedEntityType = null, relatedEntityId = null, payload = {} }) => {
    const runtime = getRuntimeOpenWaConfig();
    const user = await User.findById(userId).select('whatsappNotifications');
    if (!user) return null;

    const settings = user.whatsappNotifications || {};
    const preferenceKey = CUSTOMER_EVENT_PREFERENCE_BY_TYPE[eventType];
    const preferences = mergeCustomerPreferences(settings.eventPreferences);
    const skipReason = !runtime.enabled
        ? 'OPENWA_DISABLED'
        : !settings.enabled
            ? 'CUSTOMER_DISABLED'
            : !settings.phoneVerified
                ? 'PHONE_NOT_VERIFIED'
                : !settings.phone
                    ? 'PHONE_MISSING'
                    : preferenceKey && preferences[preferenceKey] === false
                        ? 'EVENT_DISABLED'
                        : null;

    if (skipReason) {
        if (!settings.phone && skipReason !== 'OPENWA_DISABLED') return null;
        return queueWhatsAppNotification({
            recipientType: RECIPIENT_TYPES.CUSTOMER,
            recipientUserId: userId,
            phone: settings.phone || '00000000',
            eventType,
            relatedEntityType,
            relatedEntityId,
            payload,
            status: LOG_STATUSES.SKIPPED,
            reason: skipReason,
        });
    }

    return queueWhatsAppNotification({
        recipientType: RECIPIENT_TYPES.CUSTOMER,
        recipientUserId: userId,
        phone: settings.phone,
        eventType,
        relatedEntityType,
        relatedEntityId,
        payload,
    });
};

const queueAdminEvent = async ({ eventType, relatedEntityType = null, relatedEntityId = null, payload = {} }) => {
    const runtime = getRuntimeOpenWaConfig();
    const preferenceKey = ADMIN_EVENT_PREFERENCE_BY_TYPE[eventType];
    const recipients = await AdminWhatsAppRecipient.find({ enabled: true });

    return Promise.all(recipients.map((recipient) => {
        const preferences = mergeAdminPreferences(recipient.eventPreferences);
        const skipReason = !runtime.enabled
            ? 'OPENWA_DISABLED'
            : preferenceKey && preferences[preferenceKey] === false
                ? 'EVENT_DISABLED'
                : null;

        return queueWhatsAppNotification({
            recipientType: RECIPIENT_TYPES.ADMIN,
            adminRecipientId: recipient._id,
            phone: recipient.phone,
            eventType,
            relatedEntityType,
            relatedEntityId,
            payload,
            status: skipReason ? LOG_STATUSES.SKIPPED : LOG_STATUSES.PENDING,
            reason: skipReason,
        });
    }));
};

const processOneLog = async (log) => {
    const runtime = getRuntimeOpenWaConfig();
    if (!runtime.enabled) {
        log.status = LOG_STATUSES.SKIPPED;
        log.reason = 'OPENWA_DISABLED';
        await log.save();
        return log;
    }

    try {
        const result = await openwaClient.sendText({ chatId: log.chatId, text: log.message });
        log.status = LOG_STATUSES.SENT;
        log.sentAt = new Date();
        log.providerMessageId = result.providerMessageId;
        log.errorMessage = null;
        log.nextRetryAt = null;
        await log.save();
        return log;
    } catch (error) {
        const nextRetryCount = Number(log.retryCount || 0) + 1;
        log.retryCount = nextRetryCount;
        log.status = LOG_STATUSES.FAILED;
        log.errorMessage = error.response?.data?.message || error.message || 'OpenWA request failed.';
        log.reason = 'PROVIDER_ERROR';
        if (nextRetryCount < Number(log.maxRetries || runtime.maxRetries || 0)) {
            log.nextRetryAt = new Date(Date.now() + runtime.retryDelaySeconds * 1000);
        } else {
            log.nextRetryAt = null;
        }
        await log.save();
        return log;
    }
};

const processPendingMessages = async ({ limit = 20 } = {}) => {
    const now = new Date();
    const logs = await WhatsAppNotificationLog.find({
        $or: [
            { status: LOG_STATUSES.PENDING },
            {
                status: LOG_STATUSES.FAILED,
                nextRetryAt: { $lte: now },
                $expr: { $lt: ['$retryCount', '$maxRetries'] },
            },
        ],
    })
        .sort({ createdAt: 1 })
        .limit(limit);

    const results = [];
    for (const log of logs) {
        results.push(await processOneLog(log));
    }
    return results;
};

const listLogs = async ({ status, eventType, recipientType, page = 1, limit = 20 } = {}) => {
    const filter = {};
    if (status) filter.status = String(status).trim();
    if (eventType) filter.eventType = String(eventType).trim();
    if (recipientType) filter.recipientType = String(recipientType).trim();

    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (safePage - 1) * safeLimit;

    const [logs, total] = await Promise.all([
        WhatsAppNotificationLog.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(safeLimit)
            .lean(),
        WhatsAppNotificationLog.countDocuments(filter),
    ]);

    return {
        logs,
        pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            pages: Math.ceil(total / safeLimit) || 1,
        },
    };
};

const retryLog = async (logId, actorId, auditContext = null) => {
    const log = await WhatsAppNotificationLog.findById(logId);
    if (!log) throw new NotFoundError('WhatsAppNotificationLog');
    if (log.status !== LOG_STATUSES.FAILED) {
        throw new BusinessRuleError('Only failed WhatsApp notifications can be retried.', 'WHATSAPP_RETRY_NOT_ALLOWED');
    }
    if (Number(log.retryCount || 0) >= Number(log.maxRetries || 0)) {
        log.maxRetries = Number(log.retryCount || 0) + 1;
    }
    log.status = LOG_STATUSES.PENDING;
    log.nextRetryAt = null;
    log.errorMessage = null;
    log.reason = 'MANUAL_RETRY';
    await log.save();

    audit({
        actorId,
        actorRole: auditContext?.actorRole || ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.WHATSAPP_NOTIFICATION_RETRIED,
        entityType: ENTITY_TYPES.SYSTEM,
        entityId: null,
        metadata: { logId: log._id, eventType: log.eventType },
        ipAddress: auditContext?.ipAddress || null,
        userAgent: auditContext?.userAgent || null,
    });

    if (config.env !== 'test') void processPendingMessages({ limit: 3 });
    return log;
};

module.exports = {
    getCustomerSettings,
    updateCustomerSettings,
    sendCustomerVerificationCode,
    verifyCustomerPhone,
    sendCustomerTest,
    getOpenWaStatus,
    listRecipients,
    createRecipient,
    updateRecipient,
    deleteRecipient,
    sendRecipientTest,
    sendOpenWaTest,
    queueWhatsAppNotification,
    queueCustomerEvent,
    queueAdminEvent,
    processPendingMessages,
    listLogs,
    retryLog,
};
