'use strict';

// Dependency-free status contract used by every FazerCards ingress. Keeping it
// separate from payload sanitization prevents parser-specific aliases drifting.
const NORMALIZED_STATUSES = Object.freeze({
    COMPLETED: 'COMPLETED',
    PROCESSING: 'PROCESSING',
    FAILED: 'FAILED',
    REFUNDED: 'REFUNDED',
    UNKNOWN: 'UNKNOWN',
});

const PROVIDER_STATUS_LABELS = Object.freeze({
    COMPLETED: 'Completed', PROCESSING: 'Pending', FAILED: 'Cancelled',
    REFUNDED: 'Refunded', UNKNOWN: 'Unknown',
});

const STATUS_VALUES = Object.freeze({
    COMPLETED: new Set(['completed', 'complete', 'succeeded', 'success', 'done', 'fulfilled']),
    PROCESSING: new Set(['created', 'processing', 'pending', 'in_progress', 'in progress', 'inprogress', 'accepted']),
    FAILED: new Set(['failed', 'error', 'cancelled', 'canceled', 'rejected']),
    // Official contract: refund. Legacy alias: refunded.
    REFUNDED: new Set(['refund', 'refunded']),
});

const classifyFazerCardsStatus = (rawStatus) => {
    const raw = rawStatus === undefined || rawStatus === null ? '' : String(rawStatus).trim();
    const value = raw.toLowerCase();
    for (const [key, values] of Object.entries(STATUS_VALUES)) {
        if (!values.has(value)) continue;
        const normalizedStatus = NORMALIZED_STATUSES[key];
        return {
            normalizedStatus,
            providerStatus: PROVIDER_STATUS_LABELS[key],
            known: true,
            terminalFailure: key === 'FAILED' || key === 'REFUNDED',
            outcome: key === 'COMPLETED' ? 'PROVIDER_SUCCEEDED'
                : key === 'FAILED' ? 'KNOWN_PROVIDER_FAILED'
                    : key === 'REFUNDED' ? 'KNOWN_PROVIDER_REFUNDED'
                        : 'UNKNOWN_REMOTE_OUTCOME',
        };
    }
    return {
        normalizedStatus: NORMALIZED_STATUSES.UNKNOWN,
        providerStatus: raw || PROVIDER_STATUS_LABELS.UNKNOWN,
        known: false,
        terminalFailure: false,
        outcome: 'UNKNOWN_REMOTE_OUTCOME',
    };
};

module.exports = { NORMALIZED_STATUSES, PROVIDER_STATUS_LABELS, classifyFazerCardsStatus };
