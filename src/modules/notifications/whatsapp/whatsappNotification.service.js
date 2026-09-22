'use strict';

// Compatibility boundary for existing business producers. The previous queue,
// recipient records, retry worker and customer delivery path are gone.
const { dispatchAdminEvent } = require('../../whatsapp/adminNotificationPolicy.service');
const {
    claimPaymentFailureNotification,
    finalizePaymentFailureNotification,
} = require('../../whatsapp/paymentFailureNotificationDedupe.service');

const LEGACY_EVENT_MAP = Object.freeze({
    order_created: 'NEW_ORDER',
    successful_payment: 'PAYMENT_SUCCESS',
    manual_deposit_pending: 'DEPOSIT_PENDING',
    provider_order_failed: 'PROVIDER_FAILURE',
    manual_order_intervention: 'MANUAL_REVIEW',
    payment_webhook_error: 'AUTOMATIC_PAYMENT_ERROR',
    financial_day_closed: 'DAY_CLOSED',
    large_wallet_adjustment: 'LARGE_WALLET_ADJUSTMENT',
    provider_balance_warning: 'PROVIDER_BALANCE_WARNING',
    sub_agent_request_submitted: 'SUB_AGENT_REQUEST',
});

const queueAdminEvent = async ({ eventType, payload = {} } = {}) => {
    const normalizedEvent = LEGACY_EVENT_MAP[eventType] || eventType;
    if (normalizedEvent === 'AUTOMATIC_PAYMENT_ERROR') {
        const claim = await claimPaymentFailureNotification({
            paymentId: payload.paymentId,
            status: payload.status,
            stage: payload.stage,
            errorCode: payload.errorCode,
            providerStatus: payload.providerStatus,
        });
        if (!claim) return { success: true, skipped: 'DUPLICATE_FAILURE_EPISODE' };
        let result;
        try {
            result = await dispatchAdminEvent({ eventType: normalizedEvent, payload });
            const delivered = result?.success === true && !result?.skipped;
            await finalizePaymentFailureNotification({ ...claim, delivered });
            return result;
        } catch (error) {
            await finalizePaymentFailureNotification({ ...claim, delivered: false });
            throw error;
        }
    }
    return dispatchAdminEvent({ eventType: normalizedEvent, payload });
};

module.exports = { queueAdminEvent };
