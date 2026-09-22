'use strict';

jest.mock('../modules/notifications/whatsapp/whatsappNotification.service', () => ({
    queueAdminEvent: jest.fn().mockResolvedValue({ success: true }),
}));

const { Provider } = require('../modules/providers/provider.model');
const { registerAdapter } = require('../modules/providers/adapters/adapter.factory');
const { BaseProviderAdapter } = require('../modules/providers/adapters/base.adapter');
const { Setting } = require('../modules/admin/setting.model');
const { connectTestDB, disconnectTestDB, clearCollections } = require('./testHelpers');
const notificationService = require('../modules/notifications/whatsapp/whatsappNotification.service');
const policy = require('../modules/whatsapp/adminNotificationPolicy.service');
const monitor = require('../modules/whatsapp/providerBalanceMonitor.job');

const enabled = () => ({ ...policy.DEFAULT_EVENT_PREFERENCES, providerBalanceWarning: true });
const balance = (value, currency = 'USD') => ({ balance: String(value), currency });
class ReadOnlyBalanceTestAdapter extends BaseProviderAdapter {
    async getBalance() { return { balance: '0' }; }
}
const createProvider = async (suffix = Math.random()) => {
    const provider = await Provider.create({
    name: `Canonical monitor ${Date.now()}-${suffix}`,
    slug: `balance-monitor-${Date.now()}-${suffix}`,
    providerCode: 'FAZER_CARDS',
    baseUrl: 'https://example.invalid',
    isActive: true,
    });
    registerAdapter(provider.slug, ReadOnlyBalanceTestAdapter);
    return provider;
};
const configure = async (provider, threshold = '10', preferences = enabled()) => policy.updatePolicy({
    eventPreferences: preferences,
    providerBalanceThresholds: { [String(provider._id)]: threshold },
});
const stateFor = async (provider) => (await policy.getProviderWarningState())[String(provider._id)];

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => { await clearCollections(); jest.clearAllMocks(); });

describe('durable provider-balance WhatsApp warnings', () => {
    it('uses exact provider _id threshold keys and ignores legacy code/slug keys', async () => {
        const provider = await createProvider('identity');
        const legacy = { FAZER_CARDS: '1', [provider.slug]: '2', [String(provider._id)]: '10.25' };
        const saved = await policy.updatePolicy({ eventPreferences: enabled(), providerBalanceThresholds: legacy });
        expect(saved.providerBalanceThresholds).toEqual({ [String(provider._id)]: '10.25' });
        expect(saved.balanceProviders).toEqual(expect.arrayContaining([expect.objectContaining({ key: String(provider._id), providerId: String(provider._id) })]));
    });

    it('retries a failed send, then marks LOW_NOTIFIED only after success', async () => {
        const provider = await createProvider('retry');
        await configure(provider);
        notificationService.queueAdminEvent.mockResolvedValueOnce({ success: false, error: 'DISCONNECTED' }).mockResolvedValueOnce({ success: true });
        await monitor.runOnce({ readBalance: jest.fn().mockResolvedValue(balance(5)) });
        expect((await stateFor(provider)).status).toBe('LOW_PENDING');
        expect((await stateFor(provider)).claimToken).toBeUndefined();
        await monitor.runOnce({ readBalance: jest.fn().mockResolvedValue(balance(5)) });
        expect(notificationService.queueAdminEvent).toHaveBeenCalledTimes(2);
        expect((await stateFor(provider)).status).toBe('LOW_NOTIFIED');
        await monitor.runOnce({ readBalance: jest.fn().mockResolvedValue(balance(5)) });
        expect(notificationService.queueAdminEvent).toHaveBeenCalledTimes(2);
    });

    it('recovers an expired crashed claim and permits exactly one later send', async () => {
        const provider = await createProvider('lease');
        await configure(provider);
        const observationVersion = await policy.beginProviderObservation(String(provider._id));
        const claim = await policy.claimProviderLowCrossing(String(provider._id), {
            observationVersion, configVersion: '0:1', balance: '5', threshold: '10', currency: 'USD',
        });
        expect(claim).toBeTruthy();
        await Setting.updateOne({ key: policy.PROVIDER_WARNING_STATE_KEY }, {
            $set: { [`value.providers.${provider._id}.claimExpiresAt`]: new Date(Date.now() - 1_000) },
        });
        await monitor.runOnce({ readBalance: jest.fn().mockResolvedValue(balance(5)) });
        expect(notificationService.queueAdminEvent).toHaveBeenCalledTimes(1);
        expect((await stateFor(provider)).status).toBe('LOW_NOTIFIED');
    });

    it('allows only one active low-balance send attempt across concurrent monitor workers', async () => {
        const provider = await createProvider('concurrent');
        await configure(provider);
        await Promise.all([
            monitor.runOnce({ bypassInProcessGuard: true, readBalance: jest.fn().mockResolvedValue(balance(5)) }),
            monitor.runOnce({ bypassInProcessGuard: true, readBalance: jest.fn().mockResolvedValue(balance(5)) }),
        ]);
        expect(notificationService.queueAdminEvent).toHaveBeenCalledTimes(1);
    });

    it('fences an older low observation that resolves after a newer high observation', async () => {
        const provider = await createProvider('stale-low');
        await configure(provider);
        let resolveOld;
        const oldRead = jest.fn(() => new Promise((resolve) => { resolveOld = resolve; }));
        const oldRun = monitor.runOnce({ bypassInProcessGuard: true, readBalance: oldRead });
        await new Promise((resolve) => setImmediate(resolve));
        await monitor.runOnce({ bypassInProcessGuard: true, readBalance: jest.fn().mockResolvedValue(balance(11)) });
        resolveOld(balance(5));
        await oldRun;
        expect(notificationService.queueAdminEvent).not.toHaveBeenCalled();
        expect((await stateFor(provider)).status).toBe('NORMAL');
    });

    it('fences an older high observation that resolves after newer notified low state', async () => {
        const provider = await createProvider('stale-high');
        await configure(provider);
        let resolveOld;
        const oldRun = monitor.runOnce({ bypassInProcessGuard: true, readBalance: jest.fn(() => new Promise((resolve) => { resolveOld = resolve; })) });
        await new Promise((resolve) => setImmediate(resolve));
        await monitor.runOnce({ bypassInProcessGuard: true, readBalance: jest.fn().mockResolvedValue(balance(5)) });
        resolveOld(balance(11));
        await oldRun;
        expect((await stateFor(provider)).status).toBe('LOW_NOTIFIED');
    });

    it('keeps same-code provider records independent', async () => {
        const [first, second] = await Promise.all([createProvider('first'), createProvider('second')]);
        await policy.updatePolicy({ eventPreferences: enabled(), providerBalanceThresholds: { [first._id]: '10', [second._id]: '20' } });
        await monitor.runOnce({ readBalance: jest.fn((provider) => Promise.resolve(balance(String(provider._id) === String(first._id) ? 5 : 15))) });
        expect(notificationService.queueAdminEvent).toHaveBeenCalledTimes(2);
        expect((await stateFor(first)).threshold).toBe('10');
        expect((await stateFor(second)).threshold).toBe('20');
    });

    it('uses a fresh observation after threshold or toggle configuration changes', async () => {
        const provider = await createProvider('config');
        await configure(provider, '100');
        await monitor.runOnce({ readBalance: jest.fn().mockResolvedValue(balance(80)) });
        expect((await stateFor(provider)).status).toBe('LOW_NOTIFIED');
        await configure(provider, '50');
        await monitor.runOnce({ readBalance: jest.fn().mockResolvedValue(balance(80)) });
        expect((await stateFor(provider)).status).toBe('NORMAL');
        await configure(provider, '100');
        await monitor.runOnce({ readBalance: jest.fn().mockResolvedValue(balance(80)) });
        expect(notificationService.queueAdminEvent).toHaveBeenCalledTimes(2);
        await policy.updatePolicy({ eventPreferences: { ...enabled(), providerBalanceWarning: false }, providerBalanceThresholds: { [provider._id]: '100' } });
        await monitor.runOnce({ readBalance: jest.fn().mockResolvedValue(balance(80)) });
        expect(notificationService.queueAdminEvent).toHaveBeenCalledTimes(2);
        await configure(provider, '100');
        await monitor.runOnce({ readBalance: jest.fn().mockResolvedValue(balance(80)) });
        expect(notificationService.queueAdminEvent).toHaveBeenCalledTimes(3);
    });

    it('does not alter valid state or send a false alert on a balance-read failure', async () => {
        const provider = await createProvider('read-error');
        await configure(provider);
        await monitor.runOnce({ readBalance: jest.fn().mockResolvedValue(balance(11)) });
        await monitor.runOnce({ readBalance: jest.fn().mockRejectedValue(new Error('token=super-secret unavailable')) });
        expect(notificationService.queueAdminEvent).not.toHaveBeenCalled();
        expect((await stateFor(provider)).status).toBe('NORMAL');
    });
});
