'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { AppError } = require('../../shared/errors/AppError');
const { Payment } = require('./payment.model');
const {
    PaymentWebhookEvent,
    PAYMENT_WEBHOOK_EVENT_STATUSES,
} = require('./paymentWebhookEvent.model');
const {
    PAYMENT_GATEWAYS,
} = require('./payment.constants');
const paymentService = require('./payment.service');
const { createAuditLog } = require('../audit/audit.service');
const {
    PAYMENT_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
} = require('../audit/audit.constants');
const config = require('../../config/config');

const DEFAULT_WEBHOOK_SECRET_HEADER = 'x-network-webhook-secret';
const SYSTEM_ACTOR_ID = new mongoose.Types.ObjectId('000000000000000000000001');
const MAX_SUMMARY_STRING_LENGTH = 500;
const SAFE_HEADER_NAMES = new Set([
    'content-type',
    'user-agent',
    'x-correlation-id',
    'x-request-id',
    'x-network-event-id',
    'x-ngenius-event-id',
    'x-ngenius-request-id',
]);
const SENSITIVE_KEYS = new Set([
    'access_token',
    'accesstoken',
    'accountnumber',
    'api_key',
    'apikey',
    'auth',
    'authorization',
    'card',
    'cardholdername',
    'cardnumber',
    'cookie',
    'cvc',
    'cvv',
    'expiry',
    'expirydate',
    'pan',
    'securitycode',
    'secret',
    'signature',
    'token',
]);

const trim = (value) => String(value || '').trim();

const getWebhookConfig = () => ({
    secret: trim(
        process.env.NETWORK_INTERNATIONAL_WEBHOOK_SECRET ||
        config.payments.networkInternational.webhookSecret ||
        ''
    ),
    secretHeader: trim(
        process.env.NETWORK_INTERNATIONAL_WEBHOOK_SECRET_HEADER ||
        config.payments.networkInternational.webhookSecretHeader ||
        DEFAULT_WEBHOOK_SECRET_HEADER
    ).toLowerCase(),
});

const timingSafeEqualString = (actual, expected) => {
    const actualBuffer = Buffer.from(String(actual || ''), 'utf8');
    const expectedBuffer = Buffer.from(String(expected || ''), 'utf8');
    if (actualBuffer.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
};

const verifyWebhookSecret = (headers = {}) => {
    const webhookConfig = getWebhookConfig();
    if (!webhookConfig.secret) {
        return { verified: false, mode: 'unverified' };
    }

    const headerValue = headers[webhookConfig.secretHeader];
    const actualSecret = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!actualSecret || !timingSafeEqualString(actualSecret, webhookConfig.secret)) {
        throw new AppError('Invalid payment webhook secret.', 401, 'PAYMENT_WEBHOOK_INVALID_SECRET');
    }

    return { verified: true, mode: 'shared_header_secret', headerName: webhookConfig.secretHeader };
};

const safeString = (value) => {
    const text = trim(value);
    if (!text) return null;
    return text.length > MAX_SUMMARY_STRING_LENGTH
        ? `${text.slice(0, MAX_SUMMARY_STRING_LENGTH)}...`
        : text;
};

const normalizedKey = (key) => String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();

const sanitizeValue = (value, seen = new Set()) => {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return safeString(value);
    if (typeof value !== 'object') return value;

    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.slice(0, 20).map((item) => sanitizeValue(item, seen));
    }

    return Object.entries(value).reduce((safe, [key, childValue]) => {
        if (SENSITIVE_KEYS.has(normalizedKey(key))) {
            safe[key] = '[REDACTED]';
        } else {
            safe[key] = sanitizeValue(childValue, seen);
        }
        return safe;
    }, {});
};

const stableJson = (value) => {
    try {
        return JSON.stringify(value || {});
    } catch (_) {
        return JSON.stringify({ unserializable: true });
    }
};

const hashPayload = (payload) =>
    crypto.createHash('sha256').update(stableJson(payload)).digest('hex');

const firstPresent = (...values) => {
    for (const value of values) {
        const text = trim(value);
        if (text) return text;
    }
    return null;
};

const safeHeaders = (headers = {}) => {
    const webhookConfig = getWebhookConfig();
    return Object.entries(headers).reduce((safe, [key, value]) => {
        const lowerKey = String(key).toLowerCase();
        if (!SAFE_HEADER_NAMES.has(lowerKey) || lowerKey === webhookConfig.secretHeader) return safe;
        safe[lowerKey] = Array.isArray(value)
            ? value.map((item) => safeString(item)).filter(Boolean)
            : safeString(value);
        return safe;
    }, {});
};

const payloadAt = (payload, ...paths) => {
    for (const path of paths) {
        const value = path.split('.').reduce((cursor, key) => cursor?.[key], payload);
        if (value !== undefined && value !== null && trim(value)) return value;
    }
    return null;
};

const extractWebhookRefs = (payload = {}, headers = {}) => {
    const eventId = firstPresent(
        headers['x-network-event-id'],
        headers['x-ngenius-event-id'],
        payloadAt(payload, 'eventId', 'event_id', 'event.id', 'event.eventId')
    );
    const eventType = firstPresent(
        payloadAt(payload, 'eventType', 'event_type', 'type', 'eventName', 'event.name', 'event.type')
    );
    const providerStatus = firstPresent(
        payloadAt(
            payload,
            'state',
            'status',
            'order.status',
            'order.state',
            'data.status',
            'data.state',
            'data.order.status',
            'data.order.state',
            '_embedded.payment.0.state',
            '_embedded.payments.0.state'
        )
    );
    const orderReference = firstPresent(
        payloadAt(
            payload,
            'reference',
            'orderReference',
            'order.reference',
            'data.reference',
            'data.orderReference',
            'data.order.reference',
            'resource.reference'
        )
    );
    const gatewayPaymentId = firstPresent(
        payloadAt(payload, 'orderId', 'order._id', '_id', 'data._id', 'data.order._id', 'resource._id')
    );
    const merchantOrderReference = firstPresent(
        payloadAt(
            payload,
            'merchantOrderReference',
            'order.merchantOrderReference',
            'data.merchantOrderReference',
            'data.order.merchantOrderReference',
            'merchantAttributes.merchantOrderReference',
            'metadata.paymentId',
            'paymentId'
        )
    );
    const eventTimestamp = firstPresent(
        payloadAt(payload, 'timestamp', 'createdAt', 'eventTime', 'eventDate', 'event.timestamp', 'data.timestamp')
    );

    return {
        eventId,
        eventType,
        providerStatus,
        orderReference,
        gatewayPaymentId,
        gatewayReference: orderReference,
        merchantOrderReference,
        eventTimestamp,
    };
};

const buildDedupeKey = ({ refs, payloadHash }) => {
    if (refs.eventId) return `${PAYMENT_GATEWAYS.NETWORK_INTERNATIONAL}:event:${refs.eventId}`;
    if (refs.orderReference || refs.gatewayPaymentId || refs.merchantOrderReference) {
        return [
            PAYMENT_GATEWAYS.NETWORK_INTERNATIONAL,
            'order',
            refs.orderReference || refs.gatewayPaymentId || refs.merchantOrderReference,
            refs.eventType || 'event',
            refs.providerStatus || 'unknown',
            refs.eventTimestamp || 'no_timestamp',
        ].join(':');
    }
    return `${PAYMENT_GATEWAYS.NETWORK_INTERNATIONAL}:hash:${payloadHash}`;
};

const buildPayloadSummary = (payload, refs) => ({
    eventId: refs.eventId,
    eventType: refs.eventType,
    providerStatus: refs.providerStatus,
    gatewayPaymentId: refs.gatewayPaymentId,
    gatewayReference: refs.gatewayReference,
    orderReference: refs.orderReference,
    merchantOrderReference: refs.merchantOrderReference,
    amount: payloadAt(payload, 'amount.value', 'order.amount.value', 'data.amount.value', 'data.order.amount.value'),
    currency: payloadAt(payload, 'amount.currencyCode', 'order.amount.currencyCode', 'data.amount.currencyCode'),
    payloadKeys: Object.keys(payload || {}).slice(0, 30),
});

const paymentLookupRefs = (refs) => [
    refs.merchantOrderReference,
    refs.orderReference,
    refs.gatewayReference,
    refs.gatewayPaymentId,
].map((ref) => trim(ref)).filter(Boolean);

const resolvePaymentFromWebhook = async (refs) => {
    const lookupRefs = paymentLookupRefs(refs);
    if (lookupRefs.length === 0) return null;

    const or = [];
    lookupRefs.forEach((ref) => {
        if (mongoose.Types.ObjectId.isValid(ref)) {
            or.push({ _id: ref });
        }
        or.push(
            { gatewayPaymentId: ref },
            { gatewayReference: ref },
            { 'metadata.gatewayMetadata.orderId': ref },
            { 'metadata.gatewayMetadata.orderReference': ref },
            { 'metadata.gatewayMetadata.paymentId': ref }
        );
    });

    return Payment.findOne({
        gateway: PAYMENT_GATEWAYS.NETWORK_INTERNATIONAL,
        $or: or,
    });
};

const systemActor = () => ({
    actorId: SYSTEM_ACTOR_ID,
    actorRole: ACTOR_ROLES.SYSTEM,
    role: ACTOR_ROLES.SYSTEM,
});

const auditWebhook = ({
    event,
    action,
    payment = null,
    requestMeta = {},
    metadata = {},
}) => {
    void createAuditLog({
        actorId: SYSTEM_ACTOR_ID,
        actorRole: ACTOR_ROLES.SYSTEM,
        action,
        entityType: ENTITY_TYPES.PAYMENT,
        entityId: payment?._id || event?.paymentId || null,
        metadata: {
            webhookEventId: event?._id,
            dedupeKey: event?.dedupeKey,
            provider: PAYMENT_GATEWAYS.NETWORK_INTERNATIONAL,
            status: event?.status,
            gatewayReference: event?.gatewayReference,
            gatewayPaymentId: event?.gatewayPaymentId,
            ...metadata,
        },
        ipAddress: requestMeta.ipAddress || null,
        userAgent: requestMeta.userAgent || null,
    });
};

const markEvent = async (event, update) => PaymentWebhookEvent.findByIdAndUpdate(
    event._id,
    { $set: update },
    { new: true }
);

const processNetworkWebhook = async ({ payload = {}, headers = {}, requestMeta = {} } = {}) => {
    const verification = verifyWebhookSecret(headers);
    const refs = extractWebhookRefs(payload, headers);
    const payloadHash = hashPayload(payload);
    const dedupeKey = buildDedupeKey({ refs, payloadHash });
    const now = new Date();

    const duplicateEvent = await PaymentWebhookEvent.findOneAndUpdate(
        { dedupeKey },
        {
            $inc: { attempts: 1 },
            $set: {
                lastReceivedAt: now,
                processingStatus: 'DUPLICATE',
            },
        },
        { new: true }
    );

    if (duplicateEvent) {
        auditWebhook({
            event: duplicateEvent,
            action: PAYMENT_ACTIONS.WEBHOOK_DUPLICATE,
            requestMeta,
            metadata: { duplicate: true },
        });
        return {
            accepted: true,
            duplicate: true,
            event: duplicateEvent,
            payment: duplicateEvent.paymentId ? await Payment.findById(duplicateEvent.paymentId) : null,
            verification,
        };
    }

    let event;
    try {
        event = await PaymentWebhookEvent.create({
            provider: PAYMENT_GATEWAYS.NETWORK_INTERNATIONAL,
            eventId: refs.eventId,
            dedupeKey,
            gatewayPaymentId: refs.gatewayPaymentId,
            gatewayReference: refs.gatewayReference,
            orderReference: refs.orderReference,
            eventType: refs.eventType,
            providerStatus: refs.providerStatus,
            status: PAYMENT_WEBHOOK_EVENT_STATUSES.RECEIVED,
            processingStatus: 'RECEIVED',
            httpHeaders: safeHeaders(headers),
            payloadHash,
            payloadSummary: sanitizeValue(buildPayloadSummary(payload, refs)),
            attempts: 1,
            receivedAt: now,
        });
    } catch (err) {
        if (err.code !== 11000) throw err;

        const racedDuplicate = await PaymentWebhookEvent.findOneAndUpdate(
            { dedupeKey },
            {
                $inc: { attempts: 1 },
                $set: {
                    lastReceivedAt: now,
                    processingStatus: 'DUPLICATE',
                },
            },
            { new: true }
        );

        auditWebhook({
            event: racedDuplicate,
            action: PAYMENT_ACTIONS.WEBHOOK_DUPLICATE,
            requestMeta,
            metadata: { duplicate: true, source: 'unique_index_race' },
        });

        return {
            accepted: true,
            duplicate: true,
            event: racedDuplicate,
            payment: racedDuplicate?.paymentId ? await Payment.findById(racedDuplicate.paymentId) : null,
            verification,
        };
    }

    auditWebhook({
        event,
        action: PAYMENT_ACTIONS.WEBHOOK_RECEIVED,
        requestMeta,
        metadata: { verificationMode: verification.mode },
    });

    const payment = await resolvePaymentFromWebhook(refs);
    if (!payment) {
        event = await markEvent(event, {
            status: PAYMENT_WEBHOOK_EVENT_STATUSES.UNMATCHED,
            processingStatus: 'UNMATCHED',
            processedAt: new Date(),
            errorCode: 'PAYMENT_WEBHOOK_UNMATCHED_PAYMENT',
            errorMessage: 'Webhook accepted but no matching payment was found.',
        });
        auditWebhook({
            event,
            action: PAYMENT_ACTIONS.WEBHOOK_UNMATCHED,
            requestMeta,
        });
        return {
            accepted: true,
            duplicate: false,
            event,
            payment: null,
            verification,
            unmatched: true,
        };
    }

    event = await markEvent(event, {
        paymentId: payment._id,
        processingStatus: 'VERIFYING_PROVIDER_STATUS',
    });

    try {
        const syncResult = await paymentService.syncPaymentStatus(payment._id, {
            actor: systemActor(),
            requestMeta,
            source: 'network_webhook',
        });
        event = await markEvent(event, {
            status: PAYMENT_WEBHOOK_EVENT_STATUSES.PROCESSED,
            processingStatus: 'PROCESSED',
            processedAt: new Date(),
            providerStatus: syncResult.providerStatus || refs.providerStatus || null,
            errorCode: null,
            errorMessage: null,
        });
        auditWebhook({
            event,
            action: PAYMENT_ACTIONS.WEBHOOK_PROCESSED,
            payment,
            requestMeta,
            metadata: {
                providerStatus: syncResult.providerStatus || null,
                paymentStatus: syncResult.payment?.status || null,
                alreadyProcessed: Boolean(syncResult.alreadyProcessed),
            },
        });
        return {
            accepted: true,
            duplicate: false,
            event,
            payment: syncResult.payment,
            syncResult,
            verification,
        };
    } catch (err) {
        event = await markEvent(event, {
            status: PAYMENT_WEBHOOK_EVENT_STATUSES.FAILED,
            processingStatus: 'FAILED',
            processedAt: new Date(),
            errorCode: err.code || 'PAYMENT_WEBHOOK_PROCESSING_FAILED',
            errorMessage: err.message || 'Webhook could not be processed.',
        });
        auditWebhook({
            event,
            action: PAYMENT_ACTIONS.WEBHOOK_FAILED,
            payment,
            requestMeta,
            metadata: {
                errorCode: err.code || 'PAYMENT_WEBHOOK_PROCESSING_FAILED',
                errorMessage: err.message || 'Webhook could not be processed.',
            },
        });
        return {
            accepted: true,
            duplicate: false,
            event,
            payment,
            verification,
            errorCode: err.code || 'PAYMENT_WEBHOOK_PROCESSING_FAILED',
        };
    }
};

module.exports = {
    processNetworkWebhook,
    verifyWebhookSecret,
    resolvePaymentFromWebhook,
    sanitizeValue,
    SYSTEM_ACTOR_ID,
};
