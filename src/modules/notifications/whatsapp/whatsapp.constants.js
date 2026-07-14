'use strict';

const WHATSAPP_PROVIDER = Object.freeze({
    OPENWA: 'OPENWA',
});

const RECIPIENT_TYPES = Object.freeze({
    CUSTOMER: 'customer',
    ADMIN: 'admin',
});

const LOG_STATUSES = Object.freeze({
    PENDING: 'pending',
    SENT: 'sent',
    FAILED: 'failed',
    SKIPPED: 'skipped',
});

const CUSTOMER_EVENT_PREFERENCE_BY_TYPE = Object.freeze({
    wallet_topup_completed: 'walletTopupCompleted',
    payment_failed_or_pending: 'walletTopupCompleted',
    manual_deposit_approved: 'manualDepositApproved',
    manual_deposit_rejected: 'manualDepositRejected',
    order_created: 'orderCreated',
    order_completed: 'orderCompleted',
    order_failed: 'orderFailed',
    identity_verification_required: 'identityVerificationRequired',
    security_alert: 'securityAlerts',
});

const ADMIN_DEFAULT_EVENT_PREFERENCES = Object.freeze({
    successfulPayment: true,
    manualDepositPending: true,
    providerOrderFailed: true,
    paymentWebhookError: true,
    financialDayClosed: true,
    largeWalletAdjustment: true,
    providerBalanceWarning: true,
});

const ADMIN_EVENT_PREFERENCE_BY_TYPE = Object.freeze({
    successful_payment: 'successfulPayment',
    manual_deposit_pending: 'manualDepositPending',
    provider_order_failed: 'providerOrderFailed',
    payment_webhook_error: 'paymentWebhookError',
    financial_day_closed: 'financialDayClosed',
    large_wallet_adjustment: 'largeWalletAdjustment',
    provider_balance_warning: 'providerBalanceWarning',
});

const WHATSAPP_PERMISSIONS = Object.freeze({
    READ: 'whatsapp_notifications.read',
    MANAGE: 'whatsapp_notifications.manage',
    SEND_TEST: 'whatsapp_notifications.send_test',
    LOGS: 'whatsapp_notifications.logs',
});

module.exports = {
    WHATSAPP_PROVIDER,
    RECIPIENT_TYPES,
    LOG_STATUSES,
    CUSTOMER_EVENT_PREFERENCE_BY_TYPE,
    ADMIN_DEFAULT_EVENT_PREFERENCES,
    ADMIN_EVENT_PREFERENCE_BY_TYPE,
    WHATSAPP_PERMISSIONS,
};
