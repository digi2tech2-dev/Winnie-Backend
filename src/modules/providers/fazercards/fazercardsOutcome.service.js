'use strict';

const { NORMALIZED_STATUSES, classifyFazerCardsStatus } = require('./fazercardsStatus.classifier');

const FAZER_CARDS_OUTCOMES = Object.freeze({
    KNOWN_NO_ORDER_CREATED: 'KNOWN_NO_ORDER_CREATED',
    KNOWN_PROVIDER_FAILED: 'KNOWN_PROVIDER_FAILED',
    KNOWN_PROVIDER_REFUNDED: 'KNOWN_PROVIDER_REFUNDED',
    UNKNOWN_REMOTE_OUTCOME: 'UNKNOWN_REMOTE_OUTCOME',
    PROVIDER_SUCCEEDED: 'PROVIDER_SUCCEEDED',
});

// A transport error is deliberately *not* proof that FazerCards created no
// order. Callers may opt in only after parsing a documented provider response
// that establishes this fact; no undocumented HTTP status is inferred here.
const classifyFazerCardsOutcome = ({ rawStatus, explicitNoOrderCreated = false } = {}) => {
    if (explicitNoOrderCreated === true) return FAZER_CARDS_OUTCOMES.KNOWN_NO_ORDER_CREATED;
    const status = classifyFazerCardsStatus(rawStatus);
    if (status.normalizedStatus === NORMALIZED_STATUSES.COMPLETED) return FAZER_CARDS_OUTCOMES.PROVIDER_SUCCEEDED;
    if (status.normalizedStatus === NORMALIZED_STATUSES.FAILED) return FAZER_CARDS_OUTCOMES.KNOWN_PROVIDER_FAILED;
    if (status.normalizedStatus === NORMALIZED_STATUSES.REFUNDED) return FAZER_CARDS_OUTCOMES.KNOWN_PROVIDER_REFUNDED;
    return FAZER_CARDS_OUTCOMES.UNKNOWN_REMOTE_OUTCOME;
};

module.exports = { FAZER_CARDS_OUTCOMES, classifyFazerCardsOutcome };
