'use strict';

const { sanitizePayload } = require('./fazercards.client');
const { redactSecrets } = require('./fazercardsContracts');

const { NORMALIZED_STATUSES, PROVIDER_STATUS_LABELS, classifyFazerCardsStatus } = require('./fazercardsStatus.classifier');

const asString = (value, fallback = '') => {
    if (value === undefined || value === null) return fallback;
    return String(value).trim();
};

const firstValue = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

const getPath = (value, path) => {
    if (!value || !path) return undefined;
    return path.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), value);
};

const normalizeFazerCardsProviderStatus = classifyFazerCardsStatus;

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
    requireProviderOrderId = true,
} = {}) => {
    const providerOrderId = asString(extractFazerCardsOrderId(payload), asString(fallbackProviderOrderId, null));
    const rawStatus = firstValue(extractFazerCardsStatus(payload), fallbackStatus);
    const mapped = normalizeFazerCardsProviderStatus(rawStatus);
    const providerRequestId = extractFazerCardsRequestId(payload, requestId);

    return {
        success: mapped.normalizedStatus === NORMALIZED_STATUSES.COMPLETED
            || mapped.normalizedStatus === NORMALIZED_STATUSES.PROCESSING,
        manualReview: mapped.normalizedStatus === NORMALIZED_STATUSES.UNKNOWN
            || (requireProviderOrderId && !providerOrderId),
        normalizedStatus: mapped.normalizedStatus,
        providerOrderId,
        providerStatus: mapped.providerStatus,
        providerRequestId,
        providerIdempotencyKey,
        knownStatus: mapped.known,
        terminalFailure: mapped.terminalFailure,
        outcome: mapped.outcome,
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
