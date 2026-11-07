'use strict';

process.env.FAZERCARDS_ENABLED = 'true';
process.env.FAZERCARDS_API_KEY = 'test-fazer-key';
process.env.FAZERCARDS_API_BASE_URL = 'https://api.example.test';

const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct, SOURCE_AVAILABILITY } = require('../modules/providers/providerProduct.model');
const { Product, PRODUCT_STATUSES } = require('../modules/products/product.model');
const { PROVIDER_CODES } = require('../modules/providers/provider.constants');
const { FazerCardsCatalogSyncJob } = require('../modules/providers/fazercards/fazerCardsCatalogSyncJob.model');
const { startCatalogSyncJobs, processCatalogSyncJobPage } = require('../modules/providers/fazercards/fazercardsCatalogSyncJob.service');
const { syncCatalogFamily } = require('../modules/providers/fazercards/fazercardsCatalog.service');
const { repairSourceAvailabilityBlocks } = require('../modules/providers/fazercards/fazercardsCatalog.service');
const { connectTestDB, disconnectTestDB, clearCollections } = require('./testHelpers');

beforeAll(connectTestDB);
afterEach(clearCollections);
afterAll(disconnectTestDB);

const giftClient = (items, cardsByCategory = {}) => ({
    fetchCatalogPath: jest.fn(async (path, params = {}) => {
        if (path === '/giftcards') return { data: { items, meta: { has_more: false, next_cursor: null } } };
        if (path === '/giftcards/cards') return { data: { offers: cardsByCategory[params.category_id] || [] } };
        throw new Error(`Unexpected ${path}`);
    }),
});

const gameClient = (items, keysByGame = {}) => ({
    fetchCatalogPath: jest.fn(async (path, params = {}) => {
        if (path === '/gamekeys') return { data: { games: items, meta: { has_more: false, next_cursor: null } } };
        if (path === '/gamekeys/keys') return { data: { keys: keysByGame[params.game_id] || [] } };
        throw new Error(`Unexpected ${path}`);
    }),
});

const completeJob = async (family, client) => {
    await startCatalogSyncJobs({ family, limit: 20 });
    const job = await FazerCardsCatalogSyncJob.findOne({ family });
    return processCatalogSyncJobPage(job, { client, enabled: true });
};

describe('FazerCards authoritative catalog lifecycle', () => {
    it('records valid complete GIFTCARDS and GAME_KEYS snapshots as AVAILABLE', async () => {
        const gift = await completeJob('GIFTCARDS', giftClient(
            [{ category_id: 'steam', name: 'Steam' }],
            { steam: [{ card_id: '10', name: '10', price_usd: '10', stock: 3 }] }
        ));
        expect(gift.status).toBe('completed');
        expect((await ProviderProduct.findOne({ familyKey: 'GIFTCARDS' })).sourceAvailability).toBe(SOURCE_AVAILABILITY.AVAILABLE);

        const game = await completeJob('GAME_KEYS', gameClient(
            [{ game_id: 'game-1', name: 'Game One' }],
            { 'game-1': [{ key_id: 'key-1', name: 'Key One', price_usd: '5', stock: 2 }] }
        ));
        expect(game.status).toBe('completed');
        expect((await ProviderProduct.findOne({ familyKey: 'GAME_KEYS' })).sourceAvailability).toBe(SOURCE_AVAILABILITY.AVAILABLE);
    });

    it('marks first valid absence pending and second valid absence confirmed, blocking linked product without deleting it', async () => {
        await completeJob('GIFTCARDS', giftClient(
            [{ category_id: 'steam', name: 'Steam' }],
            { steam: [{ card_id: '10', name: '10', price_usd: '10', stock: 3 }] }
        ));
        const providerProduct = await ProviderProduct.findOne({ familyKey: 'GIFTCARDS' });
        const product = await Product.create({
            name: 'Linked catalog test', basePrice: '12', finalPrice: '12', provider: providerProduct.provider,
            providerProduct: providerProduct._id, providerCode: PROVIDER_CODES.FAZER_CARDS, familyKey: 'GIFTCARDS', fulfillmentMode: 'CODE_DELIVERY',
            minQty: 1, maxQty: 5, isActive: true, visibleInStore: true, status: PRODUCT_STATUSES.AVAILABLE, customerPurchaseEnabled: true,
            providerExecutionMode: 'AUTO_PROVIDER', providerExecutionEnabled: true, providerExecutionBlocked: false,
        });

        await completeJob('GIFTCARDS', giftClient([], {}));
        expect((await ProviderProduct.findById(providerProduct._id)).sourceAvailability).toBe(SOURCE_AVAILABILITY.MISSING_PENDING);
        expect((await Product.findById(product._id)).customerPurchaseEnabled).toBe(true);

        await completeJob('GIFTCARDS', giftClient([], {}));
        const missing = await ProviderProduct.findById(providerProduct._id);
        const blocked = await Product.findById(product._id);
        expect(missing.sourceAvailability).toBe(SOURCE_AVAILABILITY.MISSING_CONFIRMED);
        expect(missing.sourceConsecutiveMissingSnapshots).toBe(2);
        expect(blocked.providerProduct.toString()).toBe(providerProduct._id.toString());
        expect(blocked.status).toBe(PRODUCT_STATUSES.UNAVAILABLE);
        expect(blocked.customerPurchaseEnabled).toBe(false);
    });

    it('never mass-deactivates legacy UNKNOWN or a non-authoritative family merely because current sync is empty', async () => {
        const provider = await Provider.create({ name: 'Lifecycle provider', slug: 'lifecycle-provider', providerCode: PROVIDER_CODES.FAZER_CARDS, baseUrl: 'https://api.example.test', isActive: true });
        const legacy = await ProviderProduct.create({ provider: provider._id, providerCode: PROVIDER_CODES.FAZER_CARDS, externalProductId: 'FAZER_GIFTCARD:legacy:1', rawName: 'Legacy', rawPrice: '1', familyKey: 'GIFTCARDS', fulfillmentMode: 'CODE_DELIVERY', sourceAvailability: SOURCE_AVAILABILITY.UNKNOWN });
        const manual = await ProviderProduct.create({ provider: provider._id, providerCode: PROVIDER_CODES.FAZER_CARDS, externalProductId: 'FAZER_MANUAL_SERVICE:x:1', rawName: 'Manual', rawPrice: '1', familyKey: 'MANUAL_SERVICES', fulfillmentMode: 'MANUAL_SERVICE', sourceAvailability: SOURCE_AVAILABILITY.AVAILABLE });
        await completeJob('GIFTCARDS', giftClient([], {}));
        expect((await ProviderProduct.findById(legacy._id)).sourceAvailability).toBe(SOURCE_AVAILABILITY.UNKNOWN);
        await syncCatalogFamily({ family: 'MANUAL_SERVICES' }, { client: { fetchCatalogPath: jest.fn(async () => ({ data: { services: [] } })) }, enabled: true });
        expect((await ProviderProduct.findById(manual._id)).sourceAvailability).toBe(SOURCE_AVAILABILITY.AVAILABLE);
    });

    it('recovers same-identity source state without automatically republishing or clearing an independent admin block', async () => {
        await completeJob('GIFTCARDS', giftClient([{ category_id: 'steam', name: 'Steam' }], { steam: [{ card_id: '10', name: '10', price_usd: '10', stock: 3 }] }));
        const providerProduct = await ProviderProduct.findOne({ familyKey: 'GIFTCARDS' });
        const product = await Product.create({
            name: 'Manual block recovery', basePrice: '12', finalPrice: '12', minQty: 1, maxQty: 5,
            provider: providerProduct.provider, providerProduct: providerProduct._id, providerCode: PROVIDER_CODES.FAZER_CARDS,
            familyKey: 'GIFTCARDS', fulfillmentMode: 'CODE_DELIVERY', isActive: true, visibleInStore: true,
            status: PRODUCT_STATUSES.UNAVAILABLE, customerPurchaseEnabled: false, providerExecutionMode: 'AUTO_PROVIDER',
            providerExecutionEnabled: true, providerExecutionBlocked: true, providerBlockReason: 'ADMIN_MANUAL_SAFETY_BLOCK', sourceAvailabilityBlocked: false,
        });
        await completeJob('GIFTCARDS', giftClient([], {}));
        await completeJob('GIFTCARDS', giftClient([], {}));
        await completeJob('GIFTCARDS', giftClient([{ category_id: 'steam', name: 'Steam' }], { steam: [{ card_id: '10', name: '10', price_usd: '10', stock: 3 }] }));
        const recovered = await ProviderProduct.findById(providerProduct._id);
        const persisted = await Product.findById(product._id);
        expect(recovered.sourceAvailability).toBe(SOURCE_AVAILABILITY.AVAILABLE);
        expect(persisted.customerPurchaseEnabled).toBe(false);
        expect(persisted.status).toBe(PRODUCT_STATUSES.UNAVAILABLE);
        expect(persisted.providerBlockReason).toBe('ADMIN_MANUAL_SAFETY_BLOCK');
    });

    it('repairs an interrupted linked-product propagation without re-enabling unrelated state', async () => {
        const provider = await Provider.create({ name: 'Repair provider', slug: 'repair-provider', providerCode: PROVIDER_CODES.FAZER_CARDS, baseUrl: 'https://api.example.test', isActive: true });
        const providerProduct = await ProviderProduct.create({ provider: provider._id, providerCode: PROVIDER_CODES.FAZER_CARDS, externalProductId: 'FAZER_GIFTCARD:repair:1', rawName: 'Repair', rawPrice: '1', familyKey: 'GIFTCARDS', fulfillmentMode: 'CODE_DELIVERY', sourceAvailability: SOURCE_AVAILABILITY.MISSING_CONFIRMED });
        const product = await Product.create({ name: 'Repair linked Product', basePrice: '2', finalPrice: '2', minQty: 1, maxQty: 5, provider: provider._id, providerProduct: providerProduct._id, providerCode: PROVIDER_CODES.FAZER_CARDS, familyKey: 'GIFTCARDS', fulfillmentMode: 'CODE_DELIVERY', isActive: true, visibleInStore: true, status: PRODUCT_STATUSES.AVAILABLE, customerPurchaseEnabled: true, providerExecutionMode: 'AUTO_PROVIDER', providerExecutionEnabled: true, providerExecutionBlocked: false });
        expect(await repairSourceAvailabilityBlocks({ limit: 10 })).toMatchObject({ repaired: 1 });
        const repaired = await Product.findById(product._id);
        expect(repaired.customerPurchaseEnabled).toBe(false);
        expect(repaired.status).toBe(PRODUCT_STATUSES.UNAVAILABLE);
        expect(repaired.providerExecutionBlocked).toBe(true);
    });
});
