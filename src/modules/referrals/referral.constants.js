'use strict';

const REFERRAL_RELATIONSHIP_STATUS = Object.freeze({
    ACTIVE: 'ACTIVE',
    CANCELED: 'CANCELED',
    BLOCKED: 'BLOCKED',
});

const REFERRAL_COMMISSION_STATUS = Object.freeze({
    PENDING: 'pending',
    AVAILABLE: 'available',
    PAID: 'paid',
    CANCELLED: 'cancelled',

    // Historical statuses retained so old records remain readable.
    CREDITED: 'CREDITED',
    SKIPPED: 'SKIPPED',
    REVERSED: 'REVERSED',
});

const REFERRAL_SOURCE_TYPES = Object.freeze({
    MANUAL_DEPOSIT: 'manual_deposit',
    PAYMENT: 'payment',
});

const REFERRAL_PAYOUT_METHODS = Object.freeze({
    WALLET_CREDIT: 'wallet_credit',
    MANUAL_EXTERNAL: 'manual_external',
});

const REFERRAL_PAYOUT_STATUS = Object.freeze({
    PENDING: 'pending',
    APPROVED: 'approved',
    PAID: 'paid',
    REJECTED: 'rejected',
    CANCELLED: 'cancelled',
});

const REFERRAL_COMMISSION_PAYOUT_STATUS = Object.freeze({
    AVAILABLE: 'available',
    LOCKED: 'locked',
    PAID: 'paid',
    CANCELLED: 'cancelled',
});

const REFERRAL_APPLY_TO = Object.freeze({
    EVERY_ELIGIBLE_WALLET_CREDIT: 'EVERY_ELIGIBLE_WALLET_CREDIT',
});

const REFERRAL_SETTINGS_KEY = 'referrals';
const DEFAULT_REFERRAL_COMMISSION_PERCENT = Number(process.env.REFERRAL_DEFAULT_COMMISSION_PERCENT ?? 1);

const DEFAULT_REFERRAL_SETTINGS = Object.freeze({
    enabled: true,
    depositCommissionPercentage: Number.isFinite(DEFAULT_REFERRAL_COMMISSION_PERCENT)
        ? DEFAULT_REFERRAL_COMMISSION_PERCENT
        : 1,
    applyTo: REFERRAL_APPLY_TO.EVERY_ELIGIBLE_WALLET_CREDIT,
    minSourceAmount: null,
    maxCommissionAmount: null,
});

const ELIGIBLE_REFERRAL_SEMANTIC_TYPES = Object.freeze({
    DEPOSIT_APPROVED: REFERRAL_SOURCE_TYPES.MANUAL_DEPOSIT,
    CARD_PAYMENT_SUCCESS: REFERRAL_SOURCE_TYPES.PAYMENT,
});

module.exports = {
    REFERRAL_RELATIONSHIP_STATUS,
    REFERRAL_COMMISSION_STATUS,
    REFERRAL_SOURCE_TYPES,
    REFERRAL_PAYOUT_METHODS,
    REFERRAL_PAYOUT_STATUS,
    REFERRAL_COMMISSION_PAYOUT_STATUS,
    REFERRAL_APPLY_TO,
    REFERRAL_SETTINGS_KEY,
    DEFAULT_REFERRAL_SETTINGS,
    ELIGIBLE_REFERRAL_SEMANTIC_TYPES,
};
