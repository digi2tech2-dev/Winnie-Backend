'use strict';

process.env.FAZERCARDS_ENABLED = 'true';
process.env.FAZERCARDS_API_KEY = 'test-fazer-key';
process.env.FAZERCARDS_API_BASE_URL = 'https://api.fzr.cards/api/v2';
process.env.FAZERCARDS_TIMEOUT_MS = '20000';

jest.mock('axios');

const axios = require('axios');
const config = require('../config/config');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct, FULFILLMENT_MODES } = require('../modules/providers/providerProduct.model');
const { Product, EXECUTION_TYPES, PRODUCT_STATUSES } = require('../modules/products/product.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const productService = require('../modules/products/product.service');
const fazerCardsCatalogSvc = require('../modules/providers/fazercards/fazercardsCatalog.service');
const { FazerCardsClient } = require('../modules/providers/fazercards/fazercards.client');
const {
    FazerCardsAdapter,
    normalizeTopupOfferProduct,
} = require('../modules/providers/fazercards/fazercards.adapter');
const { PROVIDER_CODES } = require('../modules/providers/provider.constants');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
} = require('./testHelpers');

const makeClient = () => ({
    request: jest.fn(),
});

const createFazerTopupProviderProduct = async (overrides = {}) => {
    const { provider: providerOverride, ...productOverrides } = overrides;
    const provider = providerOverride || await Provider.findOne({ providerCode: PROVIDER_CODES.FAZER_CARDS }) || await Provider.create({
        name: 'FazerCards',
        slug: 'fazer-cards',
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        baseUrl: 'https://api.fzr.cards/api/v2',
        isActive: true,
        syncInterval: 0,
    });
    const providerProduct = await ProviderProduct.create({
        provider: provider._id,
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        externalProductId: 'FAZER_TOPUP:8_ball_pool:golden_spin',
        rawName: '8 Ball Pool - Golden Spin',
        rawPrice: '0.7487',
        costPrice: '0.7487',
        category: '8_ball_pool',
        categoryName: '8 Ball Pool',
        offerId: 'golden_spin',
        offerName: 'Golden Spin',
        currency: 'USD',
        minQty: 1,
        maxQty: 1,
        isActive: true,
        available: true,
        fulfillmentMode: FULFILLMENT_MODES.TOPUP_WITH_FIELDS,
        isSupported: true,
        isBlocked: false,
        requiredFields: [{ key: 'user_id', label: 'Unique ID', type: 'text', required: true }],
        rawPayload: {
            category: { category_id: '8_ball_pool', name: '8 Ball Pool' },
            offer: { offer_id: 'golden_spin', name: 'Golden Spin', price_usd: '0.7487' },
            fields: [{ key: 'user_id', label: 'Unique ID', type: 'text' }],
        },
        ...productOverrides,
    });
    return { provider, providerProduct };
};

const originalFazerConfig = { ...config.providers.fazerCards };

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    config.providers.fazerCards = originalFazerConfig;
    await disconnectTestDB();
});

beforeEach(async () => {
    config.providers.fazerCards.enabled = true;
    config.providers.fazerCards.apiKey = 'test-fazer-key';
    config.providers.fazerCards.apiBaseUrl = 'https://api.fzr.cards/api/v2';
    config.providers.fazerCards.timeoutMs = 20000;
    config.providers.fazerCards.blockedRegions = ['RU', 'RUSSIA', 'CIS'];
    axios.create.mockReset();
    await clearCollections();
});

describe('FazerCards client foundation', () => {
    it('missing API key disables FazerCards safely without creating an HTTP client', () => {
        expect(() => new FazerCardsClient({ enabled: true, apiKey: null }))
            .toThrow(/API key is not configured/);
        expect(axios.create).not.toHaveBeenCalled();
    });

    it('get /me success is normalized', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: { 'x-request-id': 'req-me' },
            data: {
                ok: true,
                login: 'partner1',
                email: 'partner@example.com',
                summary: { totalOrders: 4 },
            },
        });

        const adapter = new FazerCardsAdapter({ baseUrl: 'https://api.fzr.cards/api/v2' });
        const result = await adapter.getAccount();

        expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'get',
            url: '/me',
        }));
        expect(result.ok).toBe(true);
        expect(result.account.login).toBe('partner1');
        expect(result.requestId).toBe('req-me');
    });

    it('get /balance success is normalized', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: { 'x-request-id': 'req-balance' },
            data: { ok: true, balance: '100.0000', currency: 'USD' },
        });

        const adapter = new FazerCardsAdapter({ baseUrl: 'https://api.fzr.cards/api/v2' });
        const result = await adapter.getBalance();

        expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'get',
            url: '/balance',
        }));
        expect(result.balance).toBe('100.0000');
        expect(result.currency).toBe('USD');
        expect(result.requestId).toBe('req-balance');
    });

    it('HTTP errors are normalized without leaking the API key', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockRejectedValueOnce({
            response: {
                status: 401,
                headers: {},
                data: { error: 'X-API-Key: test-fazer-key is invalid', apiKey: 'test-fazer-key' },
            },
            message: 'unauthorized test-fazer-key',
        });

        const fazer = new FazerCardsClient({ enabled: true, apiKey: 'test-fazer-key' });
        try {
            await fazer.getAccount();
            throw new Error('Expected FazerCards HTTP error');
        } catch (err) {
            expect(err).toMatchObject({
                code: 'FAZERCARDS_HTTP_ERROR',
                httpStatus: 401,
            });
            expect(JSON.stringify(err)).not.toContain('test-fazer-key');
            expect(err.message).not.toContain('test-fazer-key');
        }
    });

    it('timeout errors are normalized', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 20000ms exceeded' });

        const fazer = new FazerCardsClient({ enabled: true, apiKey: 'test-fazer-key' });
        await expect(fazer.getBalance()).rejects.toMatchObject({
            code: 'FAZERCARDS_TIMEOUT',
        });
    });

    it('subscription_inactive is mapped to a sync-safe FazerCards error', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockRejectedValueOnce({
            response: {
                status: 422,
                headers: {},
                data: { ok: false, code: 'subscription_inactive' },
            },
            message: 'subscription inactive',
        });

        const fazer = new FazerCardsClient({ enabled: true, apiKey: 'test-fazer-key' });
        await expect(fazer.fetchTopupCategoriesPage({ limit: 10 })).rejects.toMatchObject({
            code: 'FAZERCARDS_SUBSCRIPTION_INACTIVE',
            message: 'FazerCards subscription is inactive. Renew it to sync top-up catalog.',
        });
    });
});

describe('FazerCards catalog normalization and raw sync', () => {
    it('top-up offer normalization handles missing and unknown fields conservatively', () => {
        const normalized = normalizeTopupOfferProduct({});

        expect(normalized.providerCode).toBe(PROVIDER_CODES.FAZER_CARDS);
        expect(normalized.externalProductId).toMatch(/^FAZER_TOPUP:unknown_category:unknown_offer:/);
        expect(normalized.rawName).toBe('Unknown FazerCards category - Unknown FazerCards offer');
        expect(normalized.fulfillmentMode).toBe(FULFILLMENT_MODES.TOPUP_WITH_FIELDS);
        expect(normalized.isSupported).toBe(false);
        expect(normalized.isBlocked).toBe(true);
        expect(normalized.blockReason).toBe('MISSING_CATEGORY_ID');
    });

    it('normalizes top-up categories and offers into stable ProviderProduct DTOs', () => {
        const normalized = normalizeTopupOfferProduct({
            category: { category_id: '8_ball_pool', name: '8 Ball Pool' },
            offer: { offer_id: 'golden_spin', name: 'Golden Spin', price_usd: '0.7487' },
            fields: [{ key: 'user_id', label: 'Unique ID', type: 'text' }],
        });

        expect(normalized.externalProductId).toBe('FAZER_TOPUP:8_ball_pool:golden_spin');
        expect(normalized.rawName).toBe('8 Ball Pool - Golden Spin');
        expect(normalized.category).toBe('8_ball_pool');
        expect(normalized.categoryName).toBe('8 Ball Pool');
        expect(normalized.offerId).toBe('golden_spin');
        expect(normalized.offerName).toBe('Golden Spin');
        expect(normalized.currency).toBe('USD');
        expect(normalized.costPrice).toBe(0.7487);
        expect(normalized.fulfillmentMode).toBe(FULFILLMENT_MODES.TOPUP_WITH_FIELDS);
        expect(normalized.isSupported).toBe(true);
        expect(normalized.isBlocked).toBe(false);
        expect(normalized.requiredFields).toEqual([
            { key: 'user_id', label: 'Unique ID', required: true, type: 'text', options: [] },
        ]);
        expect(normalized.rawPayload).toMatchObject({
            category: { category_id: '8_ball_pool' },
            offer: { offer_id: 'golden_spin' },
            fields: [{ key: 'user_id' }],
        });
    });

    it('marks top-up offers without category-level fields unsupported and blocked', () => {
        const normalized = normalizeTopupOfferProduct({
            category: { category_id: '8_ball_pool', name: '8 Ball Pool' },
            offer: { offer_id: 'golden_spin', name: 'Golden Spin', price_usd: '0.7487' },
            fields: [],
        });

        expect(normalized.isSupported).toBe(false);
        expect(normalized.isBlocked).toBe(true);
        expect(normalized.blockReason).toBe('MISSING_REQUIRED_FIELDS');
    });

    it('marks top-up offers with invalid price unsupported and blocked', () => {
        const normalized = normalizeTopupOfferProduct({
            category: { category_id: '8_ball_pool', name: '8 Ball Pool' },
            offer: { offer_id: 'golden_spin', name: 'Golden Spin', price_usd: 'free' },
            fields: [{ key: 'user_id', label: 'Unique ID', type: 'text' }],
        });

        expect(normalized.isSupported).toBe(false);
        expect(normalized.isBlocked).toBe(true);
        expect(normalized.blockReason).toBe('INVALID_PRICE_USD');
    });

    it('blocked region rules mark products blocked but do not delete them', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: {
                ok: true,
                items: [
                    {
                        category_id: 'steam_cis',
                        name: 'Steam CIS',
                        region: 'CIS',
                    },
                ],
                meta: { next_cursor: null, has_more: false },
            },
        });
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: {
                ok: true,
                kind: 'topup',
                category_id: 'steam_cis',
                name: 'Steam CIS',
                offers: [{ offer_id: 'gift10', name: '$10', price_usd: '10.00' }],
                fields: [{ key: 'user_id', label: 'User ID', type: 'text' }],
            },
        });

        const result = await fazerCardsCatalogSvc.syncCatalogPage({ limit: 100 });
        const stored = await ProviderProduct.findOne({ externalProductId: 'FAZER_TOPUP:steam_cis:gift10' }).lean();

        expect(result.deleted).toBe(0);
        expect(result.deactivated).toBe(0);
        expect(result.blocked).toBe(1);
        expect(result.unsupported).toBe(1);
        expect(stored.isBlocked).toBe(true);
        expect(stored.blockReason).toBe('BLOCKED_REGION');
        expect(stored.isActive).toBe(true);
    });

    it('top-up sync stores providerproducts without creating Winnie products or orders', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: { 'x-request-id': 'req-topups' },
            data: {
                ok: true,
                kind: 'topup',
                items: [
                    {
                        category_id: '8_ball_pool',
                        name: '8 Ball Pool',
                        note: '8 Ball Pool top-up',
                    },
                ],
                meta: { total: 317, limit: 100, next_cursor: 'cursor-2', has_more: true },
            },
        });
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: { 'x-request-id': 'req-offers' },
            data: {
                ok: true,
                kind: 'topup',
                category_id: '8_ball_pool',
                name: '8 Ball Pool',
                offers: [
                    {
                        offer_id: 'golden_spin',
                        name: 'Golden Spin',
                        price_usd: '0.7487',
                    },
                ],
                fields: [
                    {
                        key: 'user_id',
                        label: 'Unique ID',
                        type: 'text',
                    },
                ],
                note: '8 Ball Pool top-up',
            },
        });

        const result = await fazerCardsCatalogSvc.syncCatalogPage({ limit: 100, cursor: 'cursor-1' });
        const stored = await ProviderProduct.findOne({ externalProductId: 'FAZER_TOPUP:8_ball_pool:golden_spin' }).lean();
        const productCount = await Product.countDocuments({});

        expect(result).toMatchObject({
            endpoints: ['GET /topups', 'GET /topups/offers'],
            categoriesFetched: 1,
            offersFetched: 1,
            providerProductsCreated: 1,
            providerProductsUpdated: 0,
            blocked: 0,
            unsupported: 0,
            nextCursor: 'cursor-2',
            hasMore: true,
            deleted: 0,
            deactivated: 0,
            requestId: 'req-topups',
        });
        expect(stored.providerCode).toBe(PROVIDER_CODES.FAZER_CARDS);
        expect(stored.rawName).toBe('8 Ball Pool - Golden Spin');
        expect(stored.category).toBe('8_ball_pool');
        expect(stored.categoryName).toBe('8 Ball Pool');
        expect(stored.offerId).toBe('golden_spin');
        expect(stored.offerName).toBe('Golden Spin');
        expect(stored.fulfillmentMode).toBe(FULFILLMENT_MODES.TOPUP_WITH_FIELDS);
        expect(stored.requiredFields[0]).toMatchObject({
            key: 'user_id',
            label: 'Unique ID',
            type: 'text',
            required: true,
        });
        expect(stored.rawPayload).toMatchObject({
            category: { category_id: '8_ball_pool' },
            offer: { offer_id: 'golden_spin' },
            fields: [{ key: 'user_id' }],
        });
        expect(productCount).toBe(0);
        expect(client.request).toHaveBeenNthCalledWith(1, expect.objectContaining({
            method: 'get',
            url: '/topups',
            params: { limit: 100, cursor: 'cursor-1' },
        }));
        expect(client.request).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: 'get',
            url: '/topups/offers',
            params: { category_id: '8_ball_pool' },
        }));
        expect(client.request.mock.calls.some(([call]) => call.url === '/catalog')).toBe(false);
        expect(client.request.mock.calls.some(([call]) => call.url === ['/topups', 'order'].join('/'))).toBe(false);
    });

    it('top-up sync updates existing ProviderProduct rows only', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        const provider = await fazerCardsCatalogSvc.ensureFazerCardsProvider();

        await ProviderProduct.create({
            provider: provider._id,
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            externalProductId: 'FAZER_TOPUP:8_ball_pool:golden_spin',
            rawName: 'Old Name',
            rawPrice: '1.00',
            category: '8_ball_pool',
            fulfillmentMode: FULFILLMENT_MODES.TOPUP_WITH_FIELDS,
            isSupported: true,
            isBlocked: false,
        });

        client.request.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: {
                ok: true,
                items: [{ category_id: '8_ball_pool', name: '8 Ball Pool' }],
                meta: { next_cursor: null, has_more: false },
            },
        });
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: {
                ok: true,
                category_id: '8_ball_pool',
                name: '8 Ball Pool',
                offers: [{ offer_id: 'golden_spin', name: 'Golden Spin', price_usd: '0.7487' }],
                fields: [{ key: 'user_id', label: 'Unique ID', type: 'text' }],
            },
        });

        const result = await fazerCardsCatalogSvc.syncCatalogPage({ limit: 10 });
        const providerProductCount = await ProviderProduct.countDocuments({});
        const productCount = await Product.countDocuments({});
        const stored = await ProviderProduct.findOne({ externalProductId: 'FAZER_TOPUP:8_ball_pool:golden_spin' }).lean();

        expect(result.providerProductsCreated).toBe(0);
        expect(result.providerProductsUpdated).toBe(1);
        expect(providerProductCount).toBe(1);
        expect(productCount).toBe(0);
        expect(stored.rawName).toBe('8 Ball Pool - Golden Spin');
    });

    it('cannot import blocked FazerCards provider products', async () => {
        const { providerProduct } = await createFazerTopupProviderProduct({
            isBlocked: true,
            blockReason: 'BLOCKED_REGION',
        });

        await expect(fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.25,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_PROVIDER_PRODUCT_BLOCKED' });
        expect(await Product.countDocuments({})).toBe(0);
    });

    it('cannot import a missing ProviderProduct', async () => {
        const missingId = '64f000000000000000000001';

        await expect(fazerCardsCatalogSvc.importProviderProduct(missingId, {
            sellPrice: 1.25,
        })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(await Product.countDocuments({})).toBe(0);
    });

    it('cannot import non-FazerCards provider products through FazerCards import', async () => {
        const provider = await Provider.create({
            name: 'Other Supplier',
            slug: 'other-supplier',
            baseUrl: 'https://api.example.com',
            isActive: true,
        });
        const providerProduct = await ProviderProduct.create({
            provider: provider._id,
            externalProductId: 'OTHER:1',
            rawName: 'Other Product',
            rawPrice: '1.00',
            costPrice: '1.00',
            fulfillmentMode: FULFILLMENT_MODES.TOPUP_WITH_FIELDS,
            isSupported: true,
            isBlocked: false,
            requiredFields: [{ key: 'user_id', label: 'User ID', type: 'text', required: true }],
        });

        await expect(fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.25,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_PROVIDER_PRODUCT_REQUIRED' });
        expect(await Product.countDocuments({})).toBe(0);
    });

    it('cannot import non top-up FazerCards provider products', async () => {
        const { providerProduct } = await createFazerTopupProviderProduct({
            fulfillmentMode: FULFILLMENT_MODES.UNKNOWN,
        });

        await expect(fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.25,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_IMPORT_UNSUPPORTED_FULFILLMENT_MODE' });
        expect(await Product.countDocuments({})).toBe(0);
    });

    it('cannot import unsupported FazerCards provider products', async () => {
        const { providerProduct } = await createFazerTopupProviderProduct({
            isSupported: false,
            blockReason: 'INVALID_PRICE_USD',
        });

        await expect(fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.25,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_PROVIDER_PRODUCT_UNSUPPORTED' });
        expect(await Product.countDocuments({})).toBe(0);
    });

    it('cannot import FazerCards products missing requiredFields', async () => {
        const { providerProduct } = await createFazerTopupProviderProduct({
            requiredFields: [],
        });

        await expect(fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.25,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_PROVIDER_PRODUCT_MISSING_FIELDS' });
        expect(await Product.countDocuments({})).toBe(0);
    });

    it('cannot import FazerCards products with invalid costPrice', async () => {
        const { providerProduct } = await createFazerTopupProviderProduct({
            costPrice: 'not-a-number',
        });

        await expect(fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.25,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_PROVIDER_PRODUCT_INVALID_COST' });

        const { providerProduct: missingCostProduct } = await createFazerTopupProviderProduct({
            costPrice: null,
            externalProductId: 'FAZER_TOPUP:8_ball_pool:missing_cost',
            offerId: 'missing_cost',
            rawPrice: '0',
        });

        await expect(fazerCardsCatalogSvc.importProviderProduct(missingCostProduct._id, {
            sellPrice: 1.25,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_PROVIDER_PRODUCT_INVALID_COST' });
        expect(await Product.countDocuments({})).toBe(0);
    });

    it('imports supported FazerCards offers as inactive draft products with copied fields and links', async () => {
        const { provider, providerProduct } = await createFazerTopupProviderProduct();

        const result = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            description: 'Admin draft import',
            sellPrice: 1.49,
            syncAvailabilityFromProvider: true,
        });
        const product = await Product.findById(result.product._id).lean();

        expect(result.action).toBe('created');
        expect(product.name).toBe('8 Ball Pool - Golden Spin');
        expect(product.description).toBe('Admin draft import');
        expect(product.provider.toString()).toBe(provider._id.toString());
        expect(product.providerProduct.toString()).toBe(providerProduct._id.toString());
        expect(product.providerCode).toBe(PROVIDER_CODES.FAZER_CARDS);
        expect(product.externalProductId).toBe('FAZER_TOPUP:8_ball_pool:golden_spin');
        expect(product.isActive).toBe(false);
        expect(product.visibleInStore).toBe(false);
        expect(product.status).toBe(PRODUCT_STATUSES.UNAVAILABLE);
        expect(product.executionType).toBe(EXECUTION_TYPES.MANUAL);
        expect(product.providerExecutionEnabled).toBe(false);
        expect(product.providerPrice).toBe('0.7487');
        expect(product.basePrice).toBe('1.49');
        expect(product.currency).toBe('USD');
        expect(product.orderFields).toHaveLength(1);
        expect(product.orderFields[0]).toMatchObject({
            id: 'user_id',
            key: 'user_id',
            label: 'Unique ID',
            type: 'text',
            required: true,
            isActive: true,
        });
        expect(product.dynamicFields[0]).toMatchObject({
            name: 'user_id',
            label: 'Unique ID',
            type: 'text',
            required: true,
            isActive: true,
        });
        const customerCatalog = await productService.listProducts({ activeOnly: true });
        expect(customerCatalog.products).toHaveLength(0);
        expect(await WalletTransaction.countDocuments({})).toBe(0);
        expect(axios.create).not.toHaveBeenCalled();
    });

    it('cannot duplicate import the same providerProduct unless updateExisting is explicit', async () => {
        const { providerProduct } = await createFazerTopupProviderProduct();

        await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            name: '8 Ball Draft',
            sellPrice: 1.49,
        });
        await expect(fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            name: '8 Ball Draft Duplicate',
            sellPrice: 1.59,
        })).rejects.toMatchObject({ code: 'CONFLICT' });

        const updated = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            name: '8 Ball Draft Updated',
            sellPrice: 1.59,
            updateExisting: true,
        });
        const products = await Product.find({ providerProduct: providerProduct._id }).lean();

        expect(updated.action).toBe('updated');
        expect(products).toHaveLength(1);
        expect(products[0].name).toBe('8 Ball Draft Updated');
        expect(products[0].isActive).toBe(false);
        expect(products[0].visibleInStore).toBe(false);
    });

    it('lists FazerCards provider products with imported filters', async () => {
        const { providerProduct } = await createFazerTopupProviderProduct();
        await createFazerTopupProviderProduct({
            externalProductId: 'FAZER_TOPUP:pubg:uc',
            rawName: 'PUBG - UC',
            category: 'pubg',
            categoryName: 'PUBG',
            offerId: 'uc',
            offerName: 'UC',
        });
        await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.49,
        });

        const imported = await fazerCardsCatalogSvc.listProviderProducts({ imported: 'true' });
        const notImported = await fazerCardsCatalogSvc.listProviderProducts({ imported: 'false' });

        expect(imported.products).toHaveLength(1);
        expect(imported.products[0].imported).toBe(true);
        expect(imported.products[0].importedProduct.name).toBe('8 Ball Pool - Golden Spin');
        expect(notImported.products).toHaveLength(1);
        expect(notImported.products[0].externalProductId).toBe('FAZER_TOPUP:pubg:uc');
        expect(notImported.products[0].imported).toBe(false);
    });

    it('unknown FazerCards provider products are not purchasable via publish/link', async () => {
        const provider = await Provider.create({
            name: 'FazerCards',
            slug: 'fazer-cards',
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            baseUrl: 'https://api.fzr.cards/api/v2',
            isActive: true,
            syncInterval: 0,
        });
        const providerProduct = await ProviderProduct.create({
            provider: provider._id,
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            externalProductId: 'unknown-product',
            rawName: 'Unknown Product',
            rawPrice: '1.00',
            isActive: true,
            fulfillmentMode: FULFILLMENT_MODES.UNKNOWN,
            isSupported: false,
            isBlocked: true,
            blockReason: 'UNSUPPORTED_FULFILLMENT_MODE',
        });

        await expect(productService.publishFromProviderProduct({
            providerProductId: providerProduct._id,
            name: 'Should Not Publish',
            basePrice: '1.50',
        })).rejects.toMatchObject({ code: 'FAZERCARDS_PURCHASE_UNSUPPORTED' });
    });

    it('lists and filters FazerCards providerproducts', async () => {
        const provider = await Provider.create({
            name: 'FazerCards',
            slug: 'fazer-cards',
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            baseUrl: 'https://api.fzr.cards/api/v2',
            isActive: true,
            syncInterval: 0,
        });
        await ProviderProduct.create({
            provider: provider._id,
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            externalProductId: 'pubg-global',
            rawName: 'PUBG Global',
            rawPrice: '2',
            category: 'game-topups',
            region: 'GLOBAL',
            available: true,
            fulfillmentMode: FULFILLMENT_MODES.TOPUP_WITH_FIELDS,
            isSupported: true,
            isBlocked: false,
        });
        await ProviderProduct.create({
            provider: provider._id,
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            externalProductId: 'steam-ru',
            rawName: 'Steam RU',
            rawPrice: '2',
            category: 'gift-cards',
            region: 'RU',
            available: true,
            fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
            isSupported: false,
            isBlocked: true,
            blockReason: 'BLOCKED_REGION',
        });

        const listed = await fazerCardsCatalogSvc.listProviderProducts({ blocked: 'true' });

        expect(listed.products).toHaveLength(1);
        expect(listed.products[0].externalProductId).toBe('steam-ru');
    });
});
