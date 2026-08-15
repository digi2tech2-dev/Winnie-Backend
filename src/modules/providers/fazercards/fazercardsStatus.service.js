'use strict';

const { sanitizePayload } = require('./fazercards.client');
const { redactSecrets } = require('./fazercardsContracts');

const NORMALIZED_STATUSES = Object.freeze({
    COMPLETED: 'COMPLETED',
    PROCESSING: 'PROCESSING',
    FAILED: 'FAILED',
    REFUNDED: 'REFUNDED',
    UNKNOWN: 'UNKNOWN',
});

const PROVIDER_STATUS_LABELS = Object.freeze({
    COMPLETED: 'Completed',
    PROCESSING: 'Pending',
    FAILED: 'Cancelled',
    REFUNDED: 'Refunded',
    UNKNOWN: 'Unknown',
});

const COMPLETED_VALUES = new Set(['completed', 'complete', 'succeeded', 'success', 'fulfilled']);
const PROCESSING_VALUES = new Set(['processing', 'pending', 'in_progress', 'in progress', 'inprogress', 'created', 'accepted']);
const FAILED_VALUES = new Set(['failed', 'error', 'cancelled', 'canceled', 'rejected']);
const REFUNDED_VALUES = new Set(['refunded']);

const asString = (value, fallback = '') => {
    if (value === undefined || value === null) return fallback;
    return String(value).trim();
};

const firstValue = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

const getPath = (value, path) => {
    if (!value || !path) return undefined;
    return path.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), value);
};

const normalizeFazerCardsProviderStatus = (rawStatus) => {
    const raw = asString(rawStatus);
    const normalized = raw.toLowerCase();
    if (COMPLETED_VALUES.has(normalized)) {
        return {
            normalizedStatus: NORMALIZED_STATUSES.COMPLETED,
            providerStatus: PROVIDER_STATUS_LABELS.COMPLETED,
            known: true,
            terminalFailure: false,
        };
    }
    if (PROCESSING_VALUES.has(normalized)) {
        return {
            normalizedStatus: NORMALIZED_STATUSES.PROCESSING,
            providerStatus: PROVIDER_STATUS_LABELS.PROCESSING,
            known: true,
            terminalFailure: false,
        };
    }
    if (FAILED_VALUES.has(normalized)) {
        return {
            normalizedStatus: NORMALIZED_STATUSES.FAILED,
            providerStatus: PROVIDER_STATUS_LABELS.FAILED,
            known: true,
            terminalFailure: true,
        };
    }
    if (REFUNDED_VALUES.has(normalized)) {
        return {
            normalizedStatus: NORMALIZED_STATUSES.REFUNDED,
            providerStatus: PROVIDER_STATUS_LABELS.REFUNDED,
            known: true,
            terminalFailure: true,
        };
    }
    return {
        normalizedStatus: NORMALIZED_STATUSES.UNKNOWN,
        providerStatus: raw || PROVIDER_STATUS_LABELS.UNKNOWN,
        known: false,
        terminalFailure: false,
    };
};

const extractFazerCardsOrderId = (payload = {}) => firstValue(
    getPath(payload, 'id'),
    getPath(payload, 'order_id'),
    getPath(payload, 'orderId'),
    getPath(payload, 'order.id'),
    getPath(payload, 'order.order_id'),
    getPath(payload, 'order.orderId'),
    getPath(payload, 'data.order.id'),
    getPath(payload, 'data.order.order_id'),
    getPath(payload, 'data.order.orderId'),
    getPath(payload, 'data.id'),
    getPath(payload, 'data.order_id'),
    getPath(payload, 'data.orderId')
);

const extractFazerCardsStatus = (payload = {}) => firstValue(
    getPath(payload, 'status'),
    getPath(payload, 'state'),
    getPath(payload, 'order.status'),
    getPath(payload, 'order.state'),
    getPath(payload, 'data.order.status'),
    getPath(payload, 'data.order.state'),
    getPath(payload, 'data.status'),
    getPath(payload, 'data.state')
);

const extractFazerCardsRequestId = (payload = {}, requestId = null) => firstValue(
    requestId,
    getPath(payload, 'requestId'),
    getPath(payload, 'request_id'),
    getPath(payload, 'traceId'),
    getPath(payload, 'trace_id'),
    getPath(payload, 'data.requestId'),
    getPath(payload, 'data.request_id')
);

const parseFazerCardsOrderPayload = (payload = {}, {
    fallbackProviderOrderId = null,
    requestId = null,
    providerIdempotencyKey = null,
    fallbackStatus = null,
} = {}) => {
    const providerOrderId = asString(extractFazerCardsOrderId(payload), asString(fallbackProviderOrderId, null));
    const rawStatus = firstValue(extractFazerCardsStatus(payload), fallbackStatus);
    const mapped = normalizeFazerCardsProviderStatus(rawStatus);
    const providerRequestId = extractFazerCardsRequestId(payload, requestId);

    return {
        success: mapped.normalizedStatus === NORMALIZED_STATUSES.COMPLETED
            || mapped.normalizedStatus === NORMALIZED_STATUSES.PROCESSING,
        manualReview: mapped.normalizedStatus === NORMALIZED_STATUSES.UNKNOWN || !providerOrderId,
        normalizedStatus: mapped.normalizedStatus,
        providerOrderId,
        providerStatus: mapped.providerStatus,
        providerRequestId,
        providerIdempotencyKey,
        knownStatus: mapped.known,
        terminalFailure: mapped.terminalFailure,
        providerMessage: firstValue(
            getPath(payload, 'message'),
            getPath(payload, 'order.message'),
            getPath(payload, 'data.message'),
            null
        ),
        providerErrorCode: firstValue(
            getPath(payload, 'errorCode'),
            getPath(payload, 'error_code'),
            getPath(payload, 'order.errorCode'),
            getPath(payload, 'order.error_code'),
            getPath(payload, 'data.errorCode'),
            getPath(payload, 'data.error_code'),
            mapped.normalizedStatus === NORMALIZED_STATUSES.UNKNOWN ? 'FAZERCARDS_STATUS_UNKNOWN' : null
        ),
        providerErrorMessage: firstValue(
            getPath(payload, 'errorMessage'),
            getPath(payload, 'error_message'),
            getPath(payload, 'message'),
            getPath(payload, 'order.errorMessage'),
            getPath(payload, 'order.error_message'),
            getPath(payload, 'data.errorMessage'),
            getPath(payload, 'data.error_message'),
            null
        ),
        rawResponse: redactSecrets(sanitizePayload(payload)),
        rawProviderPayload: payload,
        errorMessage: mapped.normalizedStatus === NORMALIZED_STATUSES.UNKNOWN
            ? 'FazerCards provider status is unknown and requires manual review.'
            : null,
    };
};

module.exports = {
    NORMALIZED_STATUSES,
    PROVIDER_STATUS_LABELS,
    normalizeFazerCardsProviderStatus,
    extractFazerCardsOrderId,
    extractFazerCardsStatus,
    parseFazerCardsOrderPayload,
};
