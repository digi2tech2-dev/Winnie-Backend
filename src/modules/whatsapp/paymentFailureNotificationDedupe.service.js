'use strict';

const { randomUUID } = require('crypto');
const { Setting } = require('../admin/setting.model');

const SETTING_KEY = 'whatsappPaymentFailureNotificationState';
const CLAIM_LEASE_MS = 60_000;

const episodeOf = ({ paymentId, status, stage, errorCode, providerStatus } = {}) => [
    String(paymentId || ''), String(status || ''), String(stage || 'payment_reconciliation'),
    String(errorCode || ''), String(providerStatus || ''),
].join('|');

const ensureState = async () => {
    await Setting.findOneAndUpdate(
        { key: SETTING_KEY },
        { $setOnInsert: { key: SETTING_KEY, value: { payments: {} }, description: 'Durable WhatsApp reconciliation-error notification claims' } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
};

const claimPaymentFailureNotification = async (payload = {}) => {
    const paymentId = String(payload.paymentId || '').trim();
    if (!paymentId) return null;
    await ensureState();
    const statePath = `value.payments.${paymentId}`;
    const episode = episodeOf(payload);
    const claimToken = randomUUID();
    const now = new Date();
    const claimExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS);
    const claimed = await Setting.findOneAndUpdate(
        {
            key: SETTING_KEY,
            $or: [
                { [`${statePath}.episode`]: { $ne: episode } },
                { [`${statePath}.status`]: { $in: [null, 'PENDING'] }, [`${statePath}.claimExpiresAt`]: { $exists: false } },
                { [`${statePath}.status`]: 'PENDING', [`${statePath}.claimExpiresAt`]: { $lte: now } },
            ],
        },
        {
            $set: {
                [statePath]: {
                    episode,
                    status: 'PENDING',
                    claimToken,
                    claimExpiresAt,
                    updatedAt: now.toISOString(),
                },
            },
        },
        { new: true }
    ).lean();
    return claimed ? { paymentId, episode, claimToken } : null;
};

const finalizePaymentFailureNotification = async ({ paymentId, episode, claimToken, delivered } = {}) => {
    const statePath = `value.payments.${String(paymentId || '').trim()}`;
    if (!paymentId || !episode || !claimToken) return false;
    const updated = await Setting.findOneAndUpdate(
        {
            key: SETTING_KEY,
            [`${statePath}.episode`]: episode,
            [`${statePath}.status`]: 'PENDING',
            [`${statePath}.claimToken`]: claimToken,
        },
        delivered
            ? {
                $set: { [`${statePath}.status`]: 'NOTIFIED', [`${statePath}.notifiedAt`]: new Date().toISOString() },
                $unset: { [`${statePath}.claimToken`]: '', [`${statePath}.claimExpiresAt`]: '' },
            }
            : { $unset: { [`${statePath}.claimToken`]: '', [`${statePath}.claimExpiresAt`]: '' } },
        { new: true }
    ).lean();
    return Boolean(updated);
};

// A successful/non-failed reconciliation closes the prior technical failure
// episode. A later recurrence with the same fingerprint is then a new episode.
const resolvePaymentFailureNotification = async (paymentId) => {
    const normalizedPaymentId = String(paymentId || '').trim();
    if (!normalizedPaymentId) return false;
    await ensureState();
    const statePath = `value.payments.${normalizedPaymentId}`;
    const updated = await Setting.findOneAndUpdate(
        { key: SETTING_KEY, [statePath]: { $exists: true } },
        { $unset: { [statePath]: '' } },
        { new: true }
    ).lean();
    return Boolean(updated);
};

module.exports = {
    SETTING_KEY,
    CLAIM_LEASE_MS,
    episodeOf,
    claimPaymentFailureNotification,
    finalizePaymentFailureNotification,
    resolvePaymentFailureNotification,
};
