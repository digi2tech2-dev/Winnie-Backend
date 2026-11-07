'use strict';

process.env.FAZERCARDS_ENABLED = 'true';
process.env.FAZERCARDS_API_KEY = 'test-fazer-key';
process.env.FAZERCARDS_API_BASE_URL = 'https://api.example.test';

const { BusinessRuleError } = require('../shared/errors/AppError');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { FazerCardsCatalogSyncJob } = require('../modules/providers/fazercards/fazerCardsCatalogSyncJob.model');
const { FazerCardsCatalogSnapshot } = require('../modules/providers/fazercards/fazerCardsCatalogSnapshot.model');
const {
    processCatalogSyncJobPage,
    startCatalogSyncJobs,
} = require('../modules/providers/fazercards/fazercardsCatalogSyncJob.service');
const { connectTestDB, disconnectTestDB, clearCollections } = require('./testHelpers');

beforeAll(connectTestDB);
afterEach(clearCollections);
afterAll(disconnectTestDB);

const giftClientForLeaseTest = () => ({
    fetchCatalogPath: jest.fn(async (path) => {
        if (path === '/giftcards') return { data: { items: [{ category_id: 'lease-cat', name: 'Lease category' }], meta: { has_more: true, next_cursor: 'next' } } };
        if (path === '/giftcards/cards') return { data: { offers: [{ card_id: 'lease-card', name: 'Lease card', price_usd: '1', stock: 1 }] } };
        throw new Error(`Unexpected provider call ${path}`);
    }),
});

describe('FazerCards catalog sync jobs', () => {
    it('keeps Steam Gifts bulk sync disabled', async () => {
        await expect(startCatalogSyncJobs({ family: 'STEAM_GIFTS' }))
            .rejects.toMatchObject({ code: 'FAZERCARDS_STEAM_GIFTS_ON_DEMAND_ONLY' });
    });

    it('invalidates a partial snapshot on 429, restarts from page one with a new snapshot, then reconciles only after completion', async () => {
        const client = {
            fetchCatalogPath: jest.fn(async (path, params = {}) => {
                if (path === '/giftcards' && !params.cursor) {
                    return {
                        data: {
                            items: [{ category_id: 'apple-us', name: 'App Store & iTunes' }],
                            meta: { has_more: true, next_cursor: 'giftcards-page-2' },
                        },
                    };
                }
                if (path === '/giftcards/cards' && params.category_id === 'apple-us') {
                    return {
                        data: { offers: [{ card_id: 'apple-10', name: 'US $10', price_usd: '10.00', stock: 10 }] },
                    };
                }
                if (path === '/giftcards' && params.cursor === 'giftcards-page-2') {
                    if (client.failPageTwoOnce) {
                        client.failPageTwoOnce = false;
                        const error = new BusinessRuleError('FazerCards rate limited.', 'FAZERCARDS_RATE_LIMITED');
                        error.statusCode = 429;
                        error.retryAfterSeconds = 11;
                        throw error;
                    }
                    return {
                        data: {
                            items: [{ category_id: 'itunes-ca', name: 'iTunes Canada' }],
                            meta: { has_more: false, next_cursor: null },
                        },
                    };
                }
                if (path === '/giftcards/cards' && params.category_id === 'itunes-ca') {
                    return {
                        data: { offers: [{ card_id: 'itunes-25', name: 'CA $25', price_usd: '25.00', stock: 10 }] },
                    };
                }
                throw new Error(`Unexpected provider call ${path}`);
            }),
            failPageTwoOnce: true,
        };

        await startCatalogSyncJobs({ family: 'GIFTCARDS', limit: 1 });
        let job = await FazerCardsCatalogSyncJob.findOne({ family: 'GIFTCARDS' });

        job = await processCatalogSyncJobPage(job, { client, enabled: true });
        expect(job).toMatchObject({ status: 'running', currentCursor: 'giftcards-page-2', processedCatalogCount: 1, processedOfferCount: 1 });
        expect(await ProviderProduct.countDocuments({ familyKey: 'GIFTCARDS' })).toBe(1);
        const incompleteSnapshotId = job.snapshotId;

        job = await processCatalogSyncJobPage(job, { client, enabled: true });
        expect(job.status).toBe('rate_limited');
        expect(job.completedAt).toBeNull();
        expect(job.currentCursor).toBeNull();
        const replacementSnapshotId = job.snapshotId;
        expect(replacementSnapshotId).not.toBeNull();
        expect(replacementSnapshotId).not.toBe(incompleteSnapshotId);
        const invalidSnapshots = await FazerCardsCatalogSnapshot.find({ status: 'invalid' }).lean();
        expect(invalidSnapshots).toHaveLength(1);

        job.nextRunAt = new Date(Date.now() - 1);
        await job.save();
        job = await processCatalogSyncJobPage(job, { client, enabled: true });

        expect(job).toMatchObject({ status: 'running', currentCursor: 'giftcards-page-2' });
        job = await processCatalogSyncJobPage(job, { client, enabled: true });

        expect(job).not.toBeNull();
        expect(job.status).toBe('completed');
        expect(job.currentPage).toBe(2);
        expect(job.processedCatalogCount).toBe(2);
        expect(job.processedOfferCount).toBe(2);
        expect(await ProviderProduct.findOne({ familyKey: 'GIFTCARDS', rawName: /App Store & iTunes/i })).not.toBeNull();
        expect(client.fetchCatalogPath).not.toHaveBeenCalledWith('/steam-gifts/games', expect.anything(), expect.anything());
    });

    it('rejects malformed empty category responses without changing source availability', async () => {
        const client = { fetchCatalogPath: jest.fn(async () => ({ data: { unexpected: true } })) };
        const providerProduct = await ProviderProduct.create({
            provider: (await require('../modules/providers/provider.model').Provider.create({ name: 'Malformed review provider', slug: 'malformed-review-provider', providerCode: 'FAZER_CARDS', baseUrl: 'https://api.example.test', isActive: true }))._id,
            providerCode: 'FAZER_CARDS', externalProductId: 'FAZER_GIFTCARD:cat:existing', rawName: 'Existing', rawPrice: '1',
            familyKey: 'GIFTCARDS', fulfillmentMode: 'CODE_DELIVERY', sourceAvailability: 'AVAILABLE', sourceLastSeenSnapshotId: 'prior',
        });
        await startCatalogSyncJobs({ family: 'GIFTCARDS', limit: 10 });
        const job = await FazerCardsCatalogSyncJob.findOne({ family: 'GIFTCARDS' });
        const failed = await processCatalogSyncJobPage(job, { client, enabled: true });
        expect(failed.status).toBe('failed');
        expect((await ProviderProduct.findById(providerProduct._id)).sourceAvailability).toBe('AVAILABLE');
        expect(await FazerCardsCatalogSnapshot.countDocuments({ status: 'completed' })).toBe(0);
    });

    it('rejects malformed empty child-offer responses without reconciliation', async () => {
        const client = {
            fetchCatalogPath: jest.fn(async (path) => (
                path === '/giftcards'
                    ? { data: { items: [{ category_id: 'cat', name: 'Category' }], meta: { has_more: false } } }
                    : { data: {} }
            )),
        };
        await startCatalogSyncJobs({ family: 'GIFTCARDS', limit: 10 });
        const failed = await processCatalogSyncJobPage(await FazerCardsCatalogSyncJob.findOne({ family: 'GIFTCARDS' }), { client, enabled: true });
        expect(failed.status).toBe('failed');
        expect(await FazerCardsCatalogSnapshot.countDocuments({ status: 'completed' })).toBe(0);
    });

    it.each([
        ['authorization failure', Object.assign(new BusinessRuleError('Forbidden.', 'FAZERCARDS_AUTHORIZATION_FAILED'), { statusCode: 403 })],
        ['timeout', Object.assign(new BusinessRuleError('Timed out.', 'FAZERCARDS_TIMEOUT'), { statusCode: 504 })],
    ])('invalidates a %s snapshot without incrementing absence counters', async (_label, failure) => {
        const provider = await require('../modules/providers/provider.model').Provider.create({ name: `Error provider ${Date.now()}-${Math.random()}`, slug: `error-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`, providerCode: 'FAZER_CARDS', baseUrl: 'https://api.example.test', isActive: true });
        const existing = await ProviderProduct.create({
            provider: provider._id, providerCode: 'FAZER_CARDS', externalProductId: `FAZER_GIFTCARD:error:${Date.now()}`,
            rawName: 'Previously seen', rawPrice: '1', familyKey: 'GIFTCARDS', fulfillmentMode: 'CODE_DELIVERY',
            sourceAvailability: 'AVAILABLE', sourceConsecutiveMissingSnapshots: 0,
        });
        await startCatalogSyncJobs({ family: 'GIFTCARDS', limit: 10 });
        const failed = await processCatalogSyncJobPage(await FazerCardsCatalogSyncJob.findOne({ family: 'GIFTCARDS' }), {
            client: { fetchCatalogPath: jest.fn(async () => { throw failure; }) }, enabled: true,
        });
        expect(failed.status).toBe('failed');
        const persisted = await ProviderProduct.findById(existing._id);
        expect(persisted.sourceAvailability).toBe('AVAILABLE');
        expect(persisted.sourceConsecutiveMissingSnapshots).toBe(0);
        expect(await FazerCardsCatalogSnapshot.countDocuments({ status: 'completed' })).toBe(0);
    });

    it('resumes safely when snapshot completion committed before job completion', async () => {
        const provider = await require('../modules/providers/provider.model').Provider.create({ name: 'Completion recovery provider', slug: 'completion-recovery-provider', providerCode: 'FAZER_CARDS', baseUrl: 'https://api.example.test', isActive: true });
        await startCatalogSyncJobs({ family: 'GIFTCARDS', limit: 10 });
        const job = await FazerCardsCatalogSyncJob.findOne({ family: 'GIFTCARDS' });
        await FazerCardsCatalogSnapshot.create({
            snapshotId: job.snapshotId, provider: provider._id, family: 'GIFTCARDS', ownerJobId: job._id,
            status: 'completed', startedAt: new Date(), completedAt: new Date(),
        });
        const resumed = await processCatalogSyncJobPage(job, { client: { fetchCatalogPath: jest.fn() }, enabled: true });
        expect(resumed.status).toBe('completed');
        expect(resumed.safeLastError).toBeNull();
    });

    it('does not let a stale worker invalidate the replacement worker snapshot', async () => {
        const client = giftClientForLeaseTest();
        await startCatalogSyncJobs({ family: 'GIFTCARDS', limit: 10 });
        let job = await FazerCardsCatalogSyncJob.findOne({ family: 'GIFTCARDS' });
        job = await processCatalogSyncJobPage(job, { client, enabled: true });
        const stale = job.toObject();
        const replacementToken = 'replacement-worker-token';
        await FazerCardsCatalogSyncJob.updateOne({ _id: job._id }, { $set: { leaseToken: replacementToken } });
        await FazerCardsCatalogSnapshot.updateOne({ snapshotId: job.snapshotId }, { $set: { leaseToken: replacementToken, leaseUntil: new Date(Date.now() + 60000) } });
        await processCatalogSyncJobPage(stale, { client, enabled: true });
        expect((await FazerCardsCatalogSnapshot.findOne({ snapshotId: job.snapshotId })).status).toBe('collecting');
    });
});
