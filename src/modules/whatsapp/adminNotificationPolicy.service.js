'use strict';

const { Setting } = require('../admin/setting.model');
const { Provider } = require('../providers/provider.model');
const { getProviderAdapter } = require('../providers/adapters/adapter.factory');
const { BaseProviderAdapter } = require('../providers/adapters/base.adapter');
const Decimal = require('decimal.js');
const { randomUUID } = require('crypto');
const { ValidationError } = require('../../shared/errors/AppError');
const { sendAdminNotification } = require('./whatsapp.service');
const { renderAdminMessage } = require('./adminNotificationTemplates');

const SETTING_KEY = 'whatsappAdminNotificationPolicy';
const PROVIDER_WARNING_STATE_KEY = 'whatsappProviderBalanceWarningState';
const LOW_BALANCE_CLAIM_LEASE_MS = 60_000;
const DEFAULT_EVENT_PREFERENCES = Object.freeze({
    newOrder: true,
    paymentSuccess: true,
    depositPending: true,
    providerFailure: true,
    manualReview: true,
    automaticPaymentError: true,
    dayClosed: true,
    largeWalletAdjustment: true,
    // Enabled only after at least one valid live-provider threshold is saved.
    providerBalanceWarning: false,
    subAgentRequest: true,
});
const EVENT_TO_PREFERENCE = Object.freeze({
    NEW_ORDER: 'newOrder',
    PAYMENT_SUCCESS: 'paymentSuccess',
    DEPOSIT_PENDING: 'depositPending',
    PROVIDER_FAILURE: 'providerFailure',
    MANUAL_REVIEW: 'manualReview',
    AUTOMATIC_PAYMENT_ERROR: 'automaticPaymentError',
    DAY_CLOSED: 'dayClosed',
    LARGE_WALLET_ADJUSTMENT: 'largeWalletAdjustment',
    PROVIDER_BALANCE_WARNING: 'providerBalanceWarning',
    SUB_AGENT_REQUEST: 'subAgentRequest',
});
const normalizePreferences = (value = {}) => Object.keys(DEFAULT_EVENT_PREFERENCES).reduce((result, key) => {
    result[key] = value?.[key] === undefined ? DEFAULT_EVENT_PREFERENCES[key] : value[key] === true;
    return result;
}, {});
// Provider code and adapter type are not unique: balances, thresholds, and
// warning state must belong to the exact provider record.
const providerKey = (provider) => String(provider?._id || '').trim();
const isTrustedBalanceAdapter = (adapter) => adapter
    && adapter.constructor?.name !== 'MockProviderAdapter'
    && typeof adapter.getBalance === 'function'
    && adapter.getBalance !== BaseProviderAdapter.prototype.getBalance;
const listBalanceCapableProviders = async () => {
    const providers = await Provider.find({ isActive: true, deletedAt: null }).select('name slug providerCode adapterType').lean();
    return providers.reduce((result, provider) => {
        try {
            const adapter = getProviderAdapter(provider, { strict: true });
            if (!isTrustedBalanceAdapter(adapter) || !providerKey(provider)) return result;
            result.push({
                key: providerKey(provider),
                providerId: String(provider._id),
                name: provider.name,
                // FazerCards explicitly defaults its documented balance unit to USD.
                // Other adapters report a unit only in their live response.
                unit: adapter.constructor?.name === 'FazerCardsAdapter' ? 'USD' : null,
            });
        } catch (_) {
            // Unknown/fallback adapters cannot participate in low-balance alerts.
        }
        return result;
    }, []);
};
const normalizeThresholds = (thresholds = {}, capableProviders = []) => {
    if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)) {
        throw new ValidationError('providerBalanceThresholds must be an object.');
    }
    const capableKeys = new Set(capableProviders.map((provider) => provider.key));
    return Object.entries(thresholds).reduce((result, [key, raw]) => {
        if (!capableKeys.has(key) || raw === '' || raw === null || raw === undefined) return result;
        let amount;
        try { amount = new Decimal(String(raw).trim()); } catch (_) { throw new ValidationError(`Invalid provider balance threshold for ${key}.`); }
        if (!amount.isFinite() || amount.isNegative()) throw new ValidationError(`Provider balance threshold for ${key} must be a non-negative number.`);
        result[key] = amount.toFixed();
        return result;
    }, {});
};
const getPolicy = async () => {
    const setting = await Setting.findOneAndUpdate(
        { key: SETTING_KEY },
        { $setOnInsert: { key: SETTING_KEY, value: { eventPreferences: DEFAULT_EVENT_PREFERENCES }, description: 'Single-admin WhatsApp event policy' } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    return {
        eventPreferences: normalizePreferences(setting?.value?.eventPreferences),
        providerBalanceThresholds: setting?.value?.providerBalanceThresholds || {},
        providerBalanceThresholdVersions: setting?.value?.providerBalanceThresholdVersions || {},
        providerBalanceWarningToggleVersion: Number(setting?.value?.providerBalanceWarningToggleVersion || 0),
        updatedAt: setting?.updatedAt || null,
    };
};
const updatePolicy = async ({ eventPreferences, providerBalanceThresholds }, actorId) => {
    const current = await getPolicy();
    const capableProviders = await listBalanceCapableProviders();
    const next = normalizePreferences({ ...current.eventPreferences, ...(eventPreferences || {}) });
    const thresholds = normalizeThresholds(
        providerBalanceThresholds === undefined ? current.providerBalanceThresholds : providerBalanceThresholds,
        capableProviders
    );
    if (next.providerBalanceWarning && Object.keys(thresholds).length === 0) {
        throw new ValidationError('Enable provider balance warnings only after configuring a valid threshold for at least one live-balance provider.');
    }
    const thresholdVersions = { ...(current.providerBalanceThresholdVersions || {}) };
    const thresholdKeys = new Set([
        ...Object.keys(current.providerBalanceThresholds || {}),
        ...Object.keys(thresholds),
    ]);
    for (const key of thresholdKeys) {
        if ((current.providerBalanceThresholds || {})[key] !== thresholds[key]) {
            thresholdVersions[key] = Number(thresholdVersions[key] || 0) + 1;
        }
    }
    const toggleVersion = current.providerBalanceWarningToggleVersion
        + (current.eventPreferences.providerBalanceWarning !== next.providerBalanceWarning ? 1 : 0);
    const setting = await Setting.findOneAndUpdate(
        { key: SETTING_KEY },
        {
            $set: {
                value: {
                    eventPreferences: next,
                    providerBalanceThresholds: thresholds,
                    providerBalanceThresholdVersions: thresholdVersions,
                    providerBalanceWarningToggleVersion: toggleVersion,
                },
                updatedBy: actorId || null,
            },
        },
        { new: true }
    ).lean();
    return {
        eventPreferences: normalizePreferences(setting?.value?.eventPreferences),
        providerBalanceThresholds: setting?.value?.providerBalanceThresholds || {},
        providerBalanceThresholdVersions: setting?.value?.providerBalanceThresholdVersions || {},
        providerBalanceWarningToggleVersion: Number(setting?.value?.providerBalanceWarningToggleVersion || 0),
        balanceProviders: capableProviders,
        updatedAt: setting?.updatedAt || null,
    };
};
const dispatchAdminEvent = async ({ eventType, payload = {} }) => {
    try {
        const preference = EVENT_TO_PREFERENCE[eventType];
        if (!preference) return { success: false, skipped: 'UNKNOWN_EVENT' };
        const policy = await getPolicy();
        if (!policy.eventPreferences[preference]) return { success: true, skipped: 'EVENT_DISABLED' };
        return await sendAdminNotification(renderAdminMessage(eventType, payload), { eventType });
    } catch (error) {
        console.warn('[WhatsApp] Event dispatch failed:', String(error?.message || error).slice(0, 300));
        return { success: false, error: 'EVENT_DISPATCH_FAILED' };
    }
};

const getProviderWarningState = async () => {
    const setting = await Setting.findOneAndUpdate(
        { key: PROVIDER_WARNING_STATE_KEY },
        { $setOnInsert: { key: PROVIDER_WARNING_STATE_KEY, value: { providers: {} }, description: 'Durable provider low-balance crossing state' } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    return setting?.value?.providers || {};
};
const beginProviderObservation = async (key) => {
    await getProviderWarningState();
    const statePath = `value.providers.${key}`;
    const state = await Setting.findOneAndUpdate(
        { key: PROVIDER_WARNING_STATE_KEY },
        {
            $inc: { [`${statePath}.observationVersion`]: 1 },
            $set: { [`${statePath}.observationStartedAt`]: new Date().toISOString() },
        },
        { new: true }
    ).lean();
    return Number(state?.value?.providers?.[key]?.observationVersion || 0);
};
const claimProviderLowCrossing = async (key, {
    observationVersion,
    configVersion,
    balance,
    threshold,
    currency = null,
} = {}) => {
    const statePath = `value.providers.${key}`;
    const claimToken = randomUUID();
    const now = new Date();
    const claimExpiresAt = new Date(now.getTime() + LOW_BALANCE_CLAIM_LEASE_MS);
    const claimed = await Setting.findOneAndUpdate(
        {
            key: PROVIDER_WARNING_STATE_KEY,
            [`${statePath}.observationVersion`]: observationVersion,
            $or: [
                { [`${statePath}.status`]: { $in: [null, 'NORMAL', 'LOW_PENDING'] }, [`${statePath}.claimExpiresAt`]: { $exists: false } },
                { [`${statePath}.status`]: 'LOW_PENDING', [`${statePath}.claimExpiresAt`]: { $lte: now } },
                { [`${statePath}.status`]: 'LOW_NOTIFIED', [`${statePath}.configVersion`]: { $ne: configVersion } },
            ],
        },
        {
            $set: {
                [statePath]: {
                    status: 'LOW_PENDING',
                    observationVersion,
                    configVersion,
                    balance,
                    threshold,
                    currency,
                    observedAt: now.toISOString(),
                    claimToken,
                    claimExpiresAt,
                },
            },
        },
        { new: true }
    ).lean();
    return claimed ? { claimToken, claimExpiresAt } : null;
};
const finalizeProviderLowClaim = async (key, {
    observationVersion,
    claimToken,
    delivered,
} = {}) => {
    const statePath = `value.providers.${key}`;
    const updated = await Setting.findOneAndUpdate(
        {
            key: PROVIDER_WARNING_STATE_KEY,
            [`${statePath}.status`]: 'LOW_PENDING',
            [`${statePath}.observationVersion`]: observationVersion,
            [`${statePath}.claimToken`]: claimToken,
        },
        delivered
            ? {
                $set: {
                    [`${statePath}.status`]: 'LOW_NOTIFIED',
                    [`${statePath}.notifiedAt`]: new Date().toISOString(),
                },
                $unset: { [`${statePath}.claimToken`]: '', [`${statePath}.claimExpiresAt`]: '' },
            }
            : {
                $unset: { [`${statePath}.claimToken`]: '', [`${statePath}.claimExpiresAt`]: '' },
            },
        { new: true }
    ).lean();
    return Boolean(updated);
};
const rearmProviderWarning = async (key, { observationVersion, configVersion, balance, threshold, currency = null } = {}) => {
    const statePath = `value.providers.${key}`;
    const updated = await Setting.findOneAndUpdate(
        { key: PROVIDER_WARNING_STATE_KEY, [`${statePath}.observationVersion`]: observationVersion },
        {
            $set: {
                [statePath]: {
                    status: 'NORMAL', observationVersion, configVersion, balance, threshold, currency, observedAt: new Date().toISOString(), rearmedAt: new Date().toISOString(),
                },
            },
        },
        { new: true }
    ).lean();
    return Boolean(updated);
};

module.exports = {
    SETTING_KEY,
    PROVIDER_WARNING_STATE_KEY,
    DEFAULT_EVENT_PREFERENCES,
    EVENT_TO_PREFERENCE,
    providerKey,
    listBalanceCapableProviders,
    getPolicy,
    updatePolicy,
    dispatchAdminEvent,
    getProviderWarningState,
    LOW_BALANCE_CLAIM_LEASE_MS,
    beginProviderObservation,
    claimProviderLowCrossing,
    finalizeProviderLowClaim,
    rearmProviderWarning,
};
