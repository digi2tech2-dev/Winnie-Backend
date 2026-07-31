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
const { Product } = require('../modules/products/product.model');
const productService = require('../modules/products/product.service');
const fazerCardsCatalogSvc = require('../modules/providers/fazercards/fazercardsCatalog.service');
const { FazerCardsClient } = require('../modules/providers/fazercards/fazercards.client');
const {
    FazerCardsAdapter,
    normalizeCatalogProduct,
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
});

describe('FazerCards catalog normalization and raw sync', () => {
    it('catalog product normalization handles missing and unknown fields conservatively', () => {
        const normalized = normalizeCatalogProduct({});

        expect(normalized.providerCode).toBe(PROVIDER_CODES.FAZER_CARDS);
        expect(normalized.externalProductId).toMatch(/^unknown:/);
        expect(normalized.rawName).toBe('Unknown FazerCards product');
        expect(normalized.fulfillmentMode).toBe(FULFILLMENT_MODES.UNKNOWN);
        expect(normalized.isSupported).toBe(false);
        expect(normalized.isBlocked).toBe(true);
        expect(normalized.blockReason).toBe('UNSUPPORTED_FULFILLMENT_MODE');
    });

    it('detects obvious top-up products with target fields as supported metadata only', () => {
        const normalized = normalizeCatalogProduct({
            sku_id: 'pubg-uc-global',
            name: 'PUBG UC Top Up',
            category: 'game-topups',
            price_usd: '9.50',
            currency: 'USD',
            required_fields: [{ key: 'player_id', label: 'Player ID', required: true }],
        });

        expect(normalized.fulfillmentMode).toBe(FULFILLMENT_MODES.TOPUP_WITH_FIELDS);
        expect(normalized.isSupported).toBe(true);
        expect(normalized.isBlocked).toBe(false);
        expect(normalized.requiredFields[0].key).toBe('player_id');
    });

    it('detects code delivery but marks it blocked for this phase', () => {
        const normalized = normalizeCatalogProduct({
            sku_id: 'steam-us-10',
            name: 'Steam $10 Gift Card',
            category: 'gift-cards',
            price_usd: '10.00',
            stock: 20,
        });

        expect(normalized.fulfillmentMode).toBe(FULFILLMENT_MODES.CODE_DELIVERY);
        expect(normalized.isSupported).toBe(false);
        expect(normalized.isBlocked).toBe(true);
        expect(normalized.blockReason).toBe('CODE_DELIVERY_NOT_SUPPORTED_IN_PHASE_1');
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
                        sku_id: 'steam-cis-10',
                        name: 'Steam Gift CIS',
                        category: 'gift-cards',
                        region: 'CIS',
                        price_usd: '10.00',
                    },
                ],
                meta: { next_cursor: null, has_more: false },
            },
        });

        const result = await fazerCardsCatalogSvc.syncCatalogPage({ limit: 100 });
        const stored = await ProviderProduct.findOne({ externalProductId: 'steam-cis-10' }).lean();

        expect(result.deleted).toBe(0);
        expect(result.deactivated).toBe(0);
        expect(stored.isBlocked).toBe(true);
        expect(stored.blockReason).toBe('BLOCKED_REGION');
        expect(stored.isActive).toBe(true);
    });

    it('raw catalog sync stores providerproducts without creating Winnie products', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: { 'x-request-id': 'req-catalog' },
            data: {
                ok: true,
                items: [
                    {
                        sku_id: 'pubg-uc-global',
                        name: 'PUBG UC Top Up',
                        category: 'game-topups',
                        region: 'GLOBAL',
                        price_usd: '9.50',
                        required_fields: ['player_id'],
                    },
                ],
                meta: { total: 1, limit: 100, next_cursor: null, has_more: false },
            },
        });

        const result = await fazerCardsCatalogSvc.syncCatalogPage({ limit: 100, category: 'game-topups' });
        const stored = await ProviderProduct.findOne({ externalProductId: 'pubg-uc-global' }).lean();
        const productCount = await Product.countDocuments({});

        expect(result).toMatchObject({
            endpoint: 'GET /catalog',
            totalFetched: 1,
            upserted: 1,
            deleted: 0,
            deactivated: 0,
            requestId: 'req-catalog',
        });
        expect(stored.providerCode).toBe(PROVIDER_CODES.FAZER_CARDS);
        expect(stored.rawPayload).not.toHaveProperty('apiKey');
        expect(productCount).toBe(0);
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
