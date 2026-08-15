'use strict';

const crypto = require('crypto');
const config = require('../../../config/config');
const { AppError } = require('../../../shared/errors/AppError');
const { Order } = require('../../orders/order.model');
const { PROVIDER_CODES } = require('../provider.constants');
const { sanitizePayload } = require('./fazercards.client');
const { sanitizeProviderCodePayload } = require('./fazercardsDelivery.service');
const fazerCardsCatalogSvc = require('./fazercardsCatalog.service');
const {
    FazerCardsWebhookEvent,
    WEBHOOK_PROCESSING_STATUSES,
} = require('./fazercardsWebhookEvent.model');

const ACCEPTED_EVENTS = new Set([
    'order.created',
    'order.status_changed',
    'order.completed',
    'order.failed',
    'order.refunded',
    'manual_service.chat.message',
    'manual_service.chat.waiting_reply',
]);

const asString = (value, fallback = '') => {
    if (value === undefined || value === null) return fallback;
    return String(value).trim();
};

const firstValue = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

const getPath = (value, path) => {
    if (!value || !path) return undefined;
    return path.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), value);
};

const toBuffer = (rawBody) => {
    if (Buffer.isBuffer(rawBody)) return rawBody;
    if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
    return Buffer.from(JSON.stringify(rawBody || {}), 'utf8');
};

const hashRawBody = (rawBody) => crypto.createHash('sha256').update(toBuffer(rawBody)).digest('hex');

const hmacRawBody = (rawBody, secret) => (
    `sha256=${crypto.createHmac('sha256', secret).update(toBuffer(rawBody)).digest('hex')}`
);

const normalizeHeaderValue = (value) => {
    if (Array.isArray(value)) return value[0];
    return value;
};

const getSignatureHeader = (headers = {}) => firstValue(
    normalizeHeaderValue(headers['x-webhook-signature']),
    normalizeHeaderValue(headers['X-Webhook-Signature']),
    normalizeHeaderValue(headers['x-fazercards-signature']),
    normalizeHeaderValue(headers['X-FazerCards-Signature'])
);

const verifyWebhookSignature = ({ headers = {}, rawBody } = {}) => {
    if (config.providers.fazerCards.webhookEnabled !== true) {
        return { ok: true, ignored: true, reason: 'FAZERCARDS_WEBHOOK_DISABLED' };
    }

    const secret = config.providers.fazerCards.webhookSecret;
    if (!secret) {
        throw new AppError('FazerCards webhook secret is not configured.', 503, 'FAZERCARDS_WEBHOOK_SECRET_MISSING');
    }

    const provided = asString(getSignatureHeader(headers));
    if (!provided) {
        throw new AppError('FazerCards webhook signature is required.', 401, 'FAZERCARDS_WEBHOOK_SIGNATURE_MISSING');
    }

    const expected = hmacRawBody(rawBody, secret);
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);
    const valid = providedBuffer.length === expectedBuffer.length
        && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
    if (!valid) {
        throw new AppError('FazerCards webhook signature is invalid.', 401, 'FAZERCARDS_WEBHOOK_SIGNATURE_INVALID');
    }

    return { ok: true, ignored: false };
};

const parseJsonBody = (rawBody) => {
    if (rawBody && typeof rawBody === 'object' && !Buffer.isBuffer(rawBody)) return rawBody;
    const rawText = toBuffer(rawBody).toString('utf8');
    return rawText ? JSON.parse(rawText) : {};
};

const eventStatusFromName = (event) => {
    if (event === 'order.completed') return 'completed';
    if (event === 'order.failed') return 'failed';
    if (event === 'order.refunded') return 'refunded';
    if (event === 'order.created') return 'processing';
    return null;
};

const extractWebhookEventInfo = (payload = {}, rawBody) => {
    const event = asString(payload.event || payload.type || payload.eventType || 'unknown').toLowerCase();
    const eventId = asString(firstValue(payload.event_id, payload.eventId, payload.id), `sha256:${hashRawBody(rawBody)}`);
    const providerOrderId = asString(firstValue(
        getPath(payload, 'data.order_id'),
        getPath(payload, 'data.orderId'),
        getPath(payload, 'data.id'),
        getPath(payload, 'order.id'),
        getPath(payload, 'order.order_id'),
        getPath(payload, 'order.orderId'),
        payload.order_id,
        payload.orderId,
        event.startsWith('order.') ? payload.id : null
    ), null);
    const status = firstValue(
        getPath(payload, 'data.status'),
        getPath(payload, 'data.state'),
        payload.status,
        payload.state,
        getPath(payload, 'order.status'),
        getPath(payload, 'order.state'),
        eventStatusFromName(event)
    );

    return {
        event,
        eventId,
        providerOrderId,
        status,
        timestamp: firstValue(payload.timestamp, payload.created_at, payload.createdAt, null),
        acceptedEvent: ACCEPTED_EVENTS.has(event),
    };
};

const sanitizeWebhookPayload = (payload = {}) => sanitizeProviderCodePayload(sanitizePayload(payload));

const findLocalOrderByProviderReference = async (providerOrderId) => {
    const id = asString(providerOrderId);
    if (!id) return null;
    return Order.findOne({
        $or: [
            { providerOrderId: id },
            { providerRequestId: id },
            { 'providerRawResponse.order.id': id },
            { 'providerRawResponse.order.order_id': id },
            { 'providerRawResponse.order.orderId': id },
            { 'providerRawResponse.data.id': id },
            { 'providerRawResponse.data.order_id': id },
            { 'providerRawResponse.data.orderId': id },
        ],
    }).select('_id status providerOrderId providerRequestId').lean();
};

const appendManualServiceChatNote = async (orderId, payload = {}, event = '') => {
    const preview = asString(firstValue(
        getPath(payload, 'data.message'),
        getPath(payload, 'data.text'),
        getPath(payload, 'message'),
        getPath(payload, 'text'),
        ''
    )).slice(0, 500);
    await Order.findByIdAndUpdate(orderId, {
        $push: {
            internalNotes: {
                note: preview ? `FazerCards provider chat event: ${preview}` : `FazerCards provider chat event: ${event}`,
                type: 'provider_webhook',
                createdAt: new Date(),
            },
        },
        $set: {
            lastCheckedAt: new Date(),
        },
    });
};

const markEvent = (eventDoc, update) => FazerCardsWebhookEvent.findByIdAndUpdate(
    eventDoc._id,
    {
        $set: {
            processedAt: new Date(),
            ...update,
        },
    },
    { new: true }
).lean();

const buildDeliverySummary = (eventDoc) => ({
    eventId: eventDoc?.eventId,
    event: eventDoc?.event,
    providerOrderId: eventDoc?.providerOrderId ?? null,
    localOrderId: eventDoc?.localOrder?.toString?.() || eventDoc?.localOrder || null,
    matched: eventDoc?.matched === true,
    processingStatus: eventDoc?.processingStatus,
    statusBefore: eventDoc?.statusBefore ?? null,
    statusAfter: eventDoc?.statusAfter ?? null,
    receivedAt: eventDoc?.receivedAt ?? null,
    processedAt: eventDoc?.processedAt ?? null,
    errorMessage: eventDoc?.errorMessage ?? null,
});

const processWebhook = async ({ headers = {}, rawBody, payload: parsedPayload = null } = {}) => {
    const verification = verifyWebhookSignature({ headers, rawBody });
    if (verification.ignored) {
        return {
            success: true,
            ignored: true,
            reason: verification.reason,
            processed: false,
        };
    }

    const payload = parsedPayload || parseJsonBody(rawBody);
    const rawBuffer = toBuffer(rawBody);
    const payloadHash = hashRawBody(rawBuffer);
    const info = extractWebhookEventInfo(payload, rawBuffer);
    const dedupeKey = `${PROVIDER_CODES.FAZER_CARDS}:${info.eventId}`;
    const sanitizedPayload = sanitizeWebhookPayload(payload);
    const now = new Date();

    const existing = await FazerCardsWebhookEvent.findOneAndUpdate(
        { dedupeKey },
        { $inc: { attempts: 1 }, $set: { lastReceivedAt: now } },
        { new: true }
    ).lean();
    if (existing) {
        return {
            success: true,
            duplicate: true,
            processed: false,
            delivery: buildDeliverySummary({ ...existing, processingStatus: WEBHOOK_PROCESSING_STATUSES.DUPLICATE }),
        };
    }

    const eventDoc = await FazerCardsWebhookEvent.create({
        provider: PROVIDER_CODES.FAZER_CARDS,
        dedupeKey,
        eventId: info.eventId,
        event: info.event,
        providerOrderId: info.providerOrderId,
        payloadHash,
        rawPayloadSanitized: sanitizedPayload,
        receivedAt: now,
        processingStatus: info.acceptedEvent
            ? WEBHOOK_PROCESSING_STATUSES.PROCESSED
            : WEBHOOK_PROCESSING_STATUSES.IGNORED,
    });

    if (!info.acceptedEvent) {
        const ignored = await markEvent(eventDoc, {
            processingStatus: WEBHOOK_PROCESSING_STATUSES.IGNORED,
            errorMessage: 'Unsupported FazerCards webhook event.',
        });
        return { success: true, ignored: true, processed: false, delivery: buildDeliverySummary(ignored) };
    }

    const localOrder = await findLocalOrderByProviderReference(info.providerOrderId);
    if (!localOrder) {
        const unmatched = await markEvent(eventDoc, {
            matched: false,
            processingStatus: WEBHOOK_PROCESSING_STATUSES.UNMATCHED,
            statusBefore: null,
            statusAfter: null,
        });
        return { success: true, unmatched: true, processed: false, delivery: buildDeliverySummary(unmatched) };
    }

    try {
        if (info.event.startsWith('manual_service.chat.')) {
            await appendManualServiceChatNote(localOrder._id, sanitizedPayload, info.event);
            const chatEvent = await markEvent(eventDoc, {
                matched: true,
                localOrder: localOrder._id,
                processingStatus: WEBHOOK_PROCESSING_STATUSES.PROCESSED,
                statusBefore: localOrder.status,
                statusAfter: localOrder.status,
            });
            return { success: true, processed: true, action: 'chatNote', delivery: buildDeliverySummary(chatEvent) };
        }

        const result = await fazerCardsCatalogSvc.applyProviderStatusPayloadToOrder(localOrder._id, payload, {
            source: 'fazercards_webhook',
            providerOrderId: info.providerOrderId,
            fallbackStatus: info.status,
        });
        const updated = await markEvent(eventDoc, {
            matched: true,
            localOrder: localOrder._id,
            processingStatus: WEBHOOK_PROCESSING_STATUSES.PROCESSED,
            statusBefore: localOrder.status,
            statusAfter: result.order?.status || null,
        });
        return {
            success: true,
            processed: true,
            action: result.action,
            refunded: result.refunded === true,
            delivery: buildDeliverySummary(updated),
        };
    } catch (err) {
        const failed = await markEvent(eventDoc, {
            matched: true,
            localOrder: localOrder._id,
            processingStatus: WEBHOOK_PROCESSING_STATUSES.FAILED,
            statusBefore: localOrder.status,
            statusAfter: localOrder.status,
            errorMessage: err.code || err.message || 'FazerCards webhook processing failed.',
        });
        return {
            success: false,
            processed: false,
            delivery: buildDeliverySummary(failed),
        };
    }
};

const listDeliveries = async ({
    page = 1,
    limit = 25,
    event,
    processingStatus,
    matched,
} = {}) => {
    const normalizedPage = Math.max(1, Number(page) || 1);
    const normalizedLimit = Math.min(100, Math.max(1, Number(limit) || 25));
    const filter = { provider: PROVIDER_CODES.FAZER_CARDS };
    if (event) filter.event = String(event).trim().toLowerCase();
    if (processingStatus) filter.processingStatus = String(processingStatus).trim().toLowerCase();
    if (matched !== undefined && matched !== null && matched !== '') {
        filter.matched = matched === true || String(matched).toLowerCase() === 'true';
    }

    const [items, total] = await Promise.all([
        FazerCardsWebhookEvent.find(filter)
            .select('eventId event providerOrderId localOrder matched processingStatus statusBefore statusAfter errorMessage receivedAt processedAt')
            .sort({ receivedAt: -1 })
            .skip((normalizedPage - 1) * normalizedLimit)
            .limit(normalizedLimit)
            .lean(),
        FazerCardsWebhookEvent.countDocuments(filter),
    ]);

    return {
        deliveries: items.map(buildDeliverySummary),
        pagination: {
            page: normalizedPage,
            limit: normalizedLimit,
            total,
            pages: Math.max(1, Math.ceil(total / normalizedLimit)),
        },
    };
};

module.exports = {
    verifyWebhookSignature,
    processWebhook,
    listDeliveries,
    extractWebhookEventInfo,
    hmacRawBody,
};
