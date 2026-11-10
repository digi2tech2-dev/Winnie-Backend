'use strict';

const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const {
    resolveLubanProviderId,
    runBackfill,
} = require('../../scripts/backfill-provider-product-search');
const { connectTestDB, disconnectTestDB, clearCollections } = require('./testHelpers');

beforeAll(async () => connectTestDB());
afterAll(async () => disconnectTestDB());
beforeEach(async () => clearCollections());

let sequence = 0;
const createProvider = async (overrides = {}) => Provider.create({
    name: `Backfill provider ${++sequence}`,
    slug: `backfill-provider-${sequence}`,
    adapterType: 'luban-play',
    providerCode: 'LUBAN_PLAY',
    baseUrl: 'https://api.lubanplay.example',
    isActive: true,
    ...overrides,
});

const createProduct = async (provider, overrides = {}) => {
    const product = {
        provider: provider._id,
        externalProductId: `LUBAN-${Date.now()}-${Math.random()}`,
        rawName: 'Luban Gift Card',
        translatedName: 'بطاقة لوبان',
        offerId: 'offer-1',
        offerName: 'Gift Card',
        rawPrice: '10.00',
        rawPayload: { product_id: 'gift-1', sku_id: 'sku-1' },
        ...overrides,
    };
    return ProviderProduct.create(product);
};

describe('Luban provider-product search backfill', () => {
    it('fails closed for missing or ambiguous Luban provider identity and isolates the resolved provider', async () => {
        await expect(resolveLubanProviderId()).rejects.toThrow(/found 0/);

        const first = await createProvider();
        const second = await createProvider();
        await expect(resolveLubanProviderId()).rejects.toThrow(/found 2/);

        await Provider.deleteOne({ _id: second._id });
        const otherProvider = await Provider.create({
            name: `Other provider ${Date.now()}`,
            slug: `other-provider-${Date.now()}`,
            adapterType: 'canonical-b2b',
            providerCode: 'FAZER_CARDS',
            baseUrl: 'https://example.test',
        });
        const lubanProduct = await createProduct(first, { rawName: 'Luban only' });
        const otherProduct = await createProduct(otherProvider, { rawName: 'Other only' });

        const result = await runBackfill({ batchSize: 10 });
        expect(result.processed).toBe(1);
        expect((await ProviderProduct.findById(lubanProduct._id)).searchLookup).toContain('luban');
        expect((await ProviderProduct.findById(otherProduct._id)).searchLookup).toEqual([]);
    });

    it('supports dry-run counts without writing and is idempotent', async () => {
        const provider = await createProvider();
        const product = await createProduct(provider);
        const before = await ProviderProduct.findById(product._id).lean();
        const output = [];
        const dryRun = await runBackfill({ dryRun: true, log: (line) => output.push(JSON.parse(line)) });

        expect(dryRun.targetCount).toBe(1);
        expect(output[0]).toMatchObject({ dryRun: true, targetCount: 1 });
        expect(await ProviderProduct.findById(product._id).lean()).toMatchObject({ searchLookup: [] });

        const firstRun = await runBackfill({ batchSize: 1 });
        const afterFirst = await ProviderProduct.findById(product._id).lean();
        const secondRun = await runBackfill({ batchSize: 1 });
        const afterSecond = await ProviderProduct.findById(product._id).lean();

        expect(firstRun.applied).toBe(1);
        expect(secondRun.applied).toBe(0);
        expect(afterSecond.updatedAt).toEqual(afterFirst.updatedAt);
        expect(afterSecond.searchLookup).toEqual(afterFirst.searchLookup);
    });

    it('reindexes the mapped Luban parent game name for package-only records', async () => {
        const provider = await createProvider();
        const product = await createProduct(provider, {
            rawName: '60 Pink Diamonds',
            translatedName: null,
            offerName: null,
            rawPayload: {
                game_id: 'gangstar-mirage-city',
                game_name: 'Gangstar Mirage City',
                package_id: 'pkg-60',
                package_name: '60 Pink Diamonds',
            },
        });

        await runBackfill();
        const indexed = await ProviderProduct.findById(product._id).lean();
        expect(indexed.searchLookup).toEqual(expect.arrayContaining(['gangstar', 'mirage']));
    });

    it('retries a compare-and-set conflict using the fresh source version', async () => {
        const provider = await createProvider();
        const product = await createProduct(provider, { rawName: 'Before sync' });
        const originalUpdateOne = ProviderProduct.updateOne.bind(ProviderProduct);
        let firstAttempt = true;
        ProviderProduct.updateOne = jest.fn(async (filter, update, options) => {
            if (firstAttempt && filter._id.equals(product._id) && update.$set.searchLookup) {
                firstAttempt = false;
                await originalUpdateOne({ _id: product._id }, { $set: { rawName: 'After sync' } });
                return { matchedCount: 0 };
            }
            return originalUpdateOne(filter, update, options);
        });

        try {
            const result = await runBackfill({ maxRetries: 2 });
            expect(result.applied).toBe(1);
        } finally {
            ProviderProduct.updateOne = originalUpdateOne;
        }

        const updated = await ProviderProduct.findById(product._id).lean();
        expect(updated.rawName).toBe('After sync');
        expect(updated.searchLookup).toContain('after');
        expect(updated.searchLookup).not.toContain('before');
    });

    it('does not advance past a failed record and resumes from the last checkpoint', async () => {
        const provider = await createProvider();
        const first = await createProduct(provider, { rawName: 'First product' });
        const second = await createProduct(provider, { rawName: 'Second product' });
        const originalUpdateOne = ProviderProduct.updateOne.bind(ProviderProduct);
        let failSecond = true;
        ProviderProduct.updateOne = jest.fn(async (filter, update, options) => {
            if (failSecond && filter._id.equals(second._id)) return { matchedCount: 0 };
            return originalUpdateOne(filter, update, options);
        });

        let failure;
        try {
            await runBackfill({ batchSize: 10, maxRetries: 0 });
        } catch (error) {
            failure = error;
        } finally {
            ProviderProduct.updateOne = originalUpdateOne;
        }

        expect(failure).toMatchObject({ code: 'BACKFILL_CONFLICT', checkpoint: String(first._id) });
        expect((await ProviderProduct.findById(first._id)).searchLookup).toContain('first');
        expect((await ProviderProduct.findById(second._id)).searchLookup).toEqual([]);

        failSecond = false;
        const resumed = await runBackfill({ batchSize: 10, afterId: String(first._id) });
        expect(resumed.processed).toBe(1);
        expect((await ProviderProduct.findById(second._id)).searchLookup).toContain('second');
    });
});
