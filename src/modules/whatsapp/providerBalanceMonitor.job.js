'use strict';

const Decimal = require('decimal.js');
const { Provider } = require('../providers/provider.model');
const { getProviderAdapter } = require('../providers/adapters/adapter.factory');
const notificationService = require('../notifications/whatsapp/whatsappNotification.service');
const {
    providerKey,
    getPolicy,
    listBalanceCapableProviders,
    beginProviderObservation,
    claimProviderLowCrossing,
    finalizeProviderLowClaim,
    rearmProviderWarning,
} = require('./adminNotificationPolicy.service');

let timer = null;
let running = false;

const getPollIntervalMs = () => {
    const minutes = Number(process.env.WHATSAPP_PROVIDER_BALANCE_POLL_INTERVAL_MINUTES || 15);
    return (Number.isFinite(minutes) && minutes >= 1 ? minutes : 15) * 60 * 1000;
};
const diagnostic = (error) => String(error?.message || error || 'Unknown provider balance error')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|authorization|token|password|secret)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 300);
const extractLiveBalance = (raw) => {
    const readCandidate = (value) => {
        if (value === null || value === undefined) return undefined;
        if (typeof value !== 'object') return value;
        for (const key of ['balance', 'Balance', 'amount', 'Amount', 'credit', 'Credit', 'funds', 'Funds']) {
            if (value[key] !== undefined && value[key] !== null) return readCandidate(value[key]);
        }
        return undefined;
    };
    const body = raw?.data && typeof raw.data === 'object' ? { ...raw, ...raw.data } : (raw || {});
    const candidate = readCandidate(body);
    const balance = new Decimal(String(candidate));
    if (!balance.isFinite() || balance.isNegative()) throw new Error('Provider returned no usable non-negative balance.');
    return {
        balance,
        currency: body.currency || body.Currency || body.balanceCurrency || null,
    };
};

const providerConfigVersion = (policy, key) => `${Number(policy.providerBalanceWarningToggleVersion || 0)}:${Number(policy.providerBalanceThresholdVersions?.[key] || 0)}`;

const runOnce = async ({ readBalance = null, bypassInProcessGuard = false } = {}) => {
    if (running && !bypassInProcessGuard) return { skipped: 'RUNNING' };
    running = true;
    const summary = { checked: 0, sent: 0, rearmed: 0, errors: 0 };
    try {
        const policy = await getPolicy();
        if (!policy.eventPreferences.providerBalanceWarning) return { ...summary, skipped: 'EVENT_DISABLED' };
        const capable = await listBalanceCapableProviders();
        const configured = capable.filter((provider) => policy.providerBalanceThresholds?.[provider.key] !== undefined);
        if (!configured.length) return { ...summary, skipped: 'NO_CONFIGURED_THRESHOLDS' };
        const providers = await Provider.find({ isActive: true, deletedAt: null }).lean();
        const providerByKey = new Map(providers.map((provider) => [providerKey(provider), provider]));
        for (const descriptor of configured) {
            const provider = providerByKey.get(descriptor.key);
            if (!provider) continue;
            // Reserve an observation generation before the read. A later
            // observation fences this worker's stale response.
            const observationVersion = await beginProviderObservation(descriptor.key);
            const configVersion = providerConfigVersion(policy, descriptor.key);
            let live;
            try {
                const raw = readBalance
                    ? await readBalance(provider)
                    : await getProviderAdapter(provider, { strict: true }).getBalance();
                live = extractLiveBalance(raw);
                summary.checked += 1;
            } catch (error) {
                summary.errors += 1;
                console.warn(`[WhatsApp] Provider balance check failed for ${descriptor.key}: ${diagnostic(error)}`);
                continue;
            }

            const threshold = new Decimal(policy.providerBalanceThresholds[descriptor.key]);
            const below = live.balance.lessThanOrEqualTo(threshold);
            if (!below) {
                if (await rearmProviderWarning(descriptor.key, {
                    observationVersion,
                    configVersion,
                    balance: live.balance.toFixed(),
                    threshold: threshold.toFixed(),
                    currency: live.currency || null,
                })) {
                    summary.rearmed += 1;
                }
                continue;
            }

            const claim = await claimProviderLowCrossing(descriptor.key, {
                observationVersion,
                configVersion,
                balance: live.balance.toFixed(),
                threshold: threshold.toFixed(),
                currency: live.currency || null,
            });
            if (!claim) continue;
            let delivered = false;
            try {
                const result = await notificationService.queueAdminEvent({
                    eventType: 'provider_balance_warning',
                    payload: {
                        provider: provider.name,
                        balance: live.balance.toFixed(),
                        threshold: threshold.toFixed(),
                        currency: live.currency || null,
                        timestamp: new Date().toISOString(),
                    },
                });
                delivered = result?.success === true && !result?.skipped;
                if (delivered) summary.sent += 1;
            } catch (error) {
                summary.errors += 1;
                console.warn(`[WhatsApp] Provider low-balance notification failed for ${descriptor.key}: ${diagnostic(error)}`);
            } finally {
                // Failed sends become immediately retry-eligible. If this
                // worker dies before finalizing, the durable lease expires.
                await finalizeProviderLowClaim(descriptor.key, {
                    observationVersion,
                    claimToken: claim.claimToken,
                    delivered,
                });
            }
        }
        return summary;
    } catch (error) {
        console.warn('[WhatsApp] Provider balance monitor failed:', diagnostic(error));
        return { ...summary, errors: summary.errors + 1 };
    } finally {
        running = false;
    }
};
const start = () => {
    if (process.env.NODE_ENV === 'test' || timer) return;
    timer = setInterval(() => { void runOnce(); }, getPollIntervalMs());
    timer.unref?.();
};
const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
};

module.exports = { start, stop, runOnce, extractLiveBalance, getPollIntervalMs };
