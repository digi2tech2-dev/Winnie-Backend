'use strict';

jest.mock('axios');

const axios = require('axios');
const mongoose = require('mongoose');
const {
    CanonicalB2BAdapter,
    assertCanonicalBaseUrl,
} = require('../modules/providers/adapters/canonicalB2B.adapter');
const { getAdapter, getProviderAdapter } = require('../modules/providers/adapters/adapter.factory');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const adminProviderService = require('../modules/admin/admin.providers.service');
const { syncProviderProducts } = require('../modules/providers/providerProductSync.service');
const {
    clearCollections,
    connectTestDB,
    disconnectTestDB,
} = require('./testHelpers');

const provider = {
    name: 'Canonical supplier',
    slug: 'arbitrary-supplier',
    adapterType: 'canonical-b2b',
    baseUrl: ' https://supplier.example/client/api/ ',
    apiToken: 'test-provider-token',
};

const makeClient = () => ({
    get: jest.fn(),
    post: jest.fn(),
    interceptors: { response: { use: jest.fn() } },
});
const makeAdapter = () => {
    const client = makeClient();
    return { adapter: new CanonicalB2BAdapter(provider, { httpClient: client }), client };
};

describe('CanonicalB2BAdapter', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        axios.create.mockReturnValue(makeClient());
    });

    it.each([
        ['https://supplier.example/client/api', 'https://supplier.example/client/api'],
        ['https://supplier.example/client/api/', 'https://supplier.example/client/api'],
        [' https://supplier.example/client/api/// ', 'https://supplier.example/client/api'],
    ])('normalizes canonical base URL %s to %s', (baseUrl, expected) => {
        expect(assertCanonicalBaseUrl(baseUrl)).toBe(expected);
    });

    it('rejects an origin, endpoint path, and URL with query/hash instead of rewriting them', () => {
        expect(() => assertCanonicalBaseUrl('https://supplier.example')).toThrow(/complete \/client\/api/);
        expect(() => assertCanonicalBaseUrl('https://supplier.example/client/api/products')).toThrow(/complete \/client\/api/);
        expect(() => assertCanonicalBaseUrl('https://supplier.example/client/api?token=nope')).toThrow(/complete \/client\/api/);
    });

    it('uses the complete configured base URL and sends api-token', () => {
        axios.create.mockReturnValue(makeClient());
        new CanonicalB2BAdapter(provider);
        expect(axios.create).toHaveBeenCalledWith(expect.objectContaining({
            baseURL: 'https://supplier.example/client/api',
            headers: expect.objectContaining({ 'api-token': 'test-provider-token' }),
        }));
    });

    it('maps the canonical profile response into the provider balance DTO', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValue({ data: { balance: '8788.683', currency: 'USD', email: 'p@example.com' } });
        await expect(adapter.getBalance()).resolves.toEqual(expect.objectContaining({
            balance: '8788.683', currency: 'USD', email: 'p@example.com',
        }));
        expect(client.get).toHaveBeenCalledWith('/profile');
    });

    it('accepts the canonical response envelope without treating a missing balance as zero', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValue({ data: { status: 'OK', data: { currency: 'USD', email: 'p@example.com' } } });
        await expect(adapter.getBalance()).resolves.toMatchObject({ balance: undefined, currency: 'USD' });
    });

    it('maps USD and legacy currency-less products and preserves only sanitized remote metadata', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValue({ data: [
            {
                id: 1000, name: 'Range', price: 1.5, currency: 'USD', available: true,
                parent_id: 7, category_name: 'Games', qty_values: { min: 2, max: 50 },
                fields: [{ key: 'player_id' }], api_token: 'remote-secret',
                headers: { authorization: 'remote-secret' }, request: { config: { apiKey: 'remote-secret' } },
            },
            { id: 1001, name: 'Legacy package', price: 2, available: false, qty_values: [5] },
        ] });

        const products = await adapter.getProducts();
        expect(products).toEqual(expect.arrayContaining([
            expect.objectContaining({
                externalProductId: '1000', rawPrice: '1.5', minQty: 2, maxQty: 50,
                category: '7', categoryName: 'Games', currency: 'USD', available: true, isActive: true,
            }),
            expect.objectContaining({
                externalProductId: '1001', minQty: 5, maxQty: 5, currency: 'USD', available: false, isActive: false,
            }),
        ]));
        expect(products[0].rawPayload.fields).toEqual([{ key: 'player_id' }]);
        expect(products[0].rawPayload.api_token).toBe('[REDACTED]');
        expect(products[0].rawPayload.headers).toBe('[REDACTED]');
        expect(products[0].rawPayload.request).toBe('[REDACTED]');
        expect(JSON.stringify(products[0].rawPayload)).not.toContain('remote-secret');
        expect(client.get).toHaveBeenCalledWith('/products');
    });

    it.each(['EGP', 'AED', 'SAR', 'EUR'])('rejects explicit non-USD catalog currency %s', async (currency) => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValue({ data: [{ id: 1000, name: 'Other', price: 1, currency }] });
        await expect(adapter.getProducts()).rejects.toThrow(/USD only/);
    });

    it.each(['USD', 'usd', ' USD ', undefined, null, ''])('accepts canonical or legacy currency %p as USD', async (currency) => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValue({ data: [{ id: 1000, name: 'Currency test', price: 1, currency }] });
        await expect(adapter.getProducts()).resolves.toEqual([
            expect.objectContaining({ externalProductId: '1000', currency: 'USD' }),
        ]);
    });

    it('posts only canonical purchase fields and preserves the supplied stable reference', async () => {
        const { adapter, client } = makeAdapter();
        client.post.mockResolvedValue({ data: { status: 'OK', data: { order_id: 'REMOTE-1', status: 'wait' } } });

        const result = await adapter.placeOrder({
            externalProductId: '1000', quantity: 2, referenceId: 'WINNIE-100',
            params: { player_id: '123', internalFulfillmentMetadata: 'nope', apiToken: 'nope' },
            price: 99, currency: 'EGP', walletBalance: 500, providerOrderId: 'not-remote',
            providerCode: 'INTERNAL', localOrderId: 'mongo-id', retryMetadata: 'retry', attemptNumber: 2,
        });

        expect(result).toMatchObject({
            success: true,
            providerOrderId: 'REMOTE-1',
            providerStatus: 'wait',
            unifiedStatus: 'PENDING',
        });
        expect(client.post).toHaveBeenCalledWith('/orders', {
            product_id: 1000,
            qty: 2,
            order_uuid: 'WINNIE-100',
            params: { player_id: '123' },
        });
    });

    it('fails safely without a stable reference and never invents one', async () => {
        const { adapter, client } = makeAdapter();
        const result = await adapter.placeOrder({ externalProductId: '1000', quantity: 1 });
        expect(result).toMatchObject({ success: false, providerOrderId: null });
        expect(result.errorMessage).toMatch(/referenceId/);
        expect(client.post).not.toHaveBeenCalled();
    });

    it.each([
        ['accept', 'COMPLETED', true],
        ['wait', 'PENDING', true],
        ['reject', 'FAILED', false],
        ['unexpected-upstream-state', 'PENDING', true],
        [undefined, 'PENDING', true],
    ])('maps placement status %p conservatively', async (remoteStatus, unifiedStatus, success) => {
        const { adapter, client } = makeAdapter();
        client.post.mockResolvedValue({
            data: { status: 'OK', data: { order_id: 'REMOTE-STATUS', status: remoteStatus } },
        });

        const result = await adapter.placeOrder({
            externalProductId: '1000', quantity: 1, referenceId: 'WINNIE-STATUS',
        });

        expect(result).toMatchObject({
            success,
            providerOrderId: 'REMOTE-STATUS',
            providerStatus: remoteStatus === 'accept' || remoteStatus === 'reject' || remoteStatus === 'wait'
                ? remoteStatus
                : 'wait',
            unifiedStatus,
        });
    });

    it('keeps a definitive canonical reject terminal and redacts credentials', async () => {
        const { adapter, client } = makeAdapter();
        client.post.mockRejectedValue({
            message: 'api-token: upstream-secret',
            response: {
                status: 401,
                data: { code: 121, message: 'api-token: upstream-secret', authorization: 'upstream-secret' },
            },
        });
        const result = await adapter.placeOrder({ externalProductId: '1000', quantity: 1, referenceId: 'WINNIE-101' });
        expect(result).toMatchObject({ success: false, providerStatus: 'reject', unifiedStatus: 'FAILED' });
        expect(JSON.stringify(result)).not.toContain('upstream-secret');
        expect(result.rawResponse.message).toContain('[REDACTED]');
    });

    it.each([
        ['timeout', { code: 'ECONNABORTED', message: 'timeout after sending api-token: upstream-secret' }],
        ['HTTP 500', { response: { status: 500, data: { code: 500, message: 'api-token: upstream-secret' } } }],
        ['HTTP 502', { response: { status: 502, data: { code: 500, message: 'api-token: upstream-secret' } } }],
        ['HTTP 503', { response: { status: 503, data: { code: 500, message: 'api-token: upstream-secret' } } }],
        ['HTTP 504', { response: { status: 504, data: { code: 500, message: 'api-token: upstream-secret' } } }],
    ])('marks %s placement failures as recoverable uncertainty', async (_label, error) => {
        const { adapter, client } = makeAdapter();
        client.post.mockRejectedValue(error);

        const result = await adapter.placeOrder({
            externalProductId: '1000', quantity: 1, referenceId: 'WINNIE-AMBIGUOUS',
        });

        expect(result).toMatchObject({
            success: true,
            providerOrderId: null,
            providerStatus: 'PLACEMENT_UNCERTAIN',
            unifiedStatus: 'PENDING',
            referenceId: 'WINNIE-AMBIGUOUS',
            rawResponse: expect.objectContaining({
                placement: 'uncertain',
                referenceId: 'WINNIE-AMBIGUOUS',
            }),
        });
        expect(JSON.stringify(result)).not.toContain('upstream-secret');
    });

    it('marks malformed placement responses as recoverable uncertainty', async () => {
        const { adapter, client } = makeAdapter();
        client.post.mockResolvedValue({ data: { status: 'OK', data: { status: 'wait' } } });

        await expect(adapter.placeOrder({
            externalProductId: '1000', quantity: 1, referenceId: 'WINNIE-MALFORMED',
        })).resolves.toMatchObject({
            success: true,
            providerStatus: 'PLACEMENT_UNCERTAIN',
            unifiedStatus: 'PENDING',
            referenceId: 'WINNIE-MALFORMED',
        });
    });

    it('maps canonical check-by-id, batch, and reference responses', async () => {
        const { adapter, client } = makeAdapter();
        client.get
            .mockResolvedValueOnce({ data: { status: 'OK', data: [{ order_id: 'REMOTE-2', status: 'accept' }] } })
            .mockResolvedValueOnce({ data: { status: 'OK', data: [{ order_id: 'REMOTE-3', order_uuid: 'WINNIE-3', status: 'wait' }] } });

        await expect(adapter.checkOrder('REMOTE-2')).resolves.toMatchObject({
            providerOrderId: 'REMOTE-2', providerStatus: 'accept', unifiedStatus: 'COMPLETED',
        });
        await expect(adapter.checkOrderByReference('WINNIE-3')).resolves.toMatchObject({
            found: true, providerOrderId: 'REMOTE-3', providerStatus: 'wait', unifiedStatus: 'PENDING',
        });
        expect(client.get).toHaveBeenNthCalledWith(1, '/check', { params: { orders: 'REMOTE-2' } });
        expect(client.get).toHaveBeenNthCalledWith(2, '/check', { params: { uuids: 'WINNIE-3' } });
    });

    it('maps check batches by returned remote ID, never list position', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValue({ data: { status: 'OK', data: [{ order_id: 'REMOTE-2', status: 'reject' }] } });
        await expect(adapter.checkOrders(['REMOTE-1', 'REMOTE-2'])).resolves.toEqual([
            expect.objectContaining({ providerOrderId: 'REMOTE-2', providerStatus: 'reject', unifiedStatus: 'FAILED' }),
        ]);
        expect(client.get).toHaveBeenCalledWith('/check', { params: { orders: 'REMOTE-1,REMOTE-2' } });
    });

    it('maps unknown and missing check statuses to non-terminal pending', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValue({
            data: {
                status: 'OK',
                data: [
                    { order_id: 'REMOTE-UNKNOWN', status: 'delayed' },
                    { order_id: 'REMOTE-MISSING' },
                ],
            },
        });

        await expect(adapter.checkOrders(['REMOTE-UNKNOWN', 'REMOTE-MISSING'])).resolves.toEqual([
            expect.objectContaining({
                providerOrderId: 'REMOTE-UNKNOWN', providerStatus: 'wait', unifiedStatus: 'PENDING',
            }),
            expect.objectContaining({
                providerOrderId: 'REMOTE-MISSING', providerStatus: 'wait', unifiedStatus: 'PENDING',
            }),
        ]);
    });

    it('maps an unknown reference-check status to non-terminal pending', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValue({
            data: { status: 'OK', data: [{ order_id: 'REMOTE-REF', order_uuid: 'WINNIE-REF', status: 'queued' }] },
        });

        await expect(adapter.checkOrderByReference('WINNIE-REF')).resolves.toMatchObject({
            found: true,
            providerOrderId: 'REMOTE-REF',
            providerStatus: 'wait',
            unifiedStatus: 'PENDING',
        });
    });
});

describe('Canonical B2B adapter factory resolution', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        axios.create.mockReturnValue(makeClient());
    });

    const adapterProvider = (overrides = {}) => ({
        name: 'Arbitrary supplier',
        slug: 'arbitrary-supplier',
        baseUrl: 'https://supplier.example/client/api',
        apiToken: 'test-provider-token',
        ...overrides,
    });

    it('gives explicit canonical adapterType priority over a legacy slug', () => {
        const adapter = getAdapter(adapterProvider({ adapterType: 'canonical-b2b', slug: 'toros' }), { httpClient: makeClient() });
        expect(adapter).toBeInstanceOf(CanonicalB2BAdapter);
    });

    it.each([
        ['fazer-cards', 'FazerCardsAdapter'],
        ['xena-recharge', 'XenaRechargeAdapter'],
        ['alkasr', 'AlkasrVipAdapter'],
        ['royal-crown', 'RoyalCrownAdapter'],
        ['toros', 'TorosfonAdapter'],
    ])('keeps %s legacy resolution when adapterType is absent', (slug, className) => {
        const adapter = getAdapter(adapterProvider({ slug }), slug === 'fazer-cards'
            ? { enabled: true, apiKey: 'test-provider-token' }
            : {});
        expect(adapter.constructor.name).toBe(className);
    });

    it('keeps the existing Mock fallback only when adapterType is absent', () => {
        const adapter = getProviderAdapter(adapterProvider({ slug: 'unknown-provider' }));
        expect(adapter.constructor.name).toBe('MockProviderAdapter');
    });

    it('does not infer Canonical B2B from a legacy slug when adapterType is absent', () => {
        const adapter = getProviderAdapter(adapterProvider({ slug: 'canonical-b2b' }));
        expect(adapter.constructor.name).toBe('MockProviderAdapter');
    });

    it('rejects an explicit unsupported adapterType instead of falling through to a legacy adapter or Mock', () => {
        for (const factory of [getAdapter, getProviderAdapter]) {
            expect(() => factory(adapterProvider({ adapterType: 'unrecognized-adapter', slug: 'toros' })))
                .toThrow(/UNSUPPORTED_PROVIDER: Unsupported adapterType/);
        }
    });
});

describe('Canonical B2B persistence and ProviderProduct sync', () => {
    beforeAll(async () => connectTestDB());
    beforeEach(async () => clearCollections());
    afterAll(async () => disconnectTestDB());

    it('persists adapterType through admin create/update without exposing its credential', async () => {
        const adminId = new mongoose.Types.ObjectId();
        const created = await adminProviderService.createProvider({
            name: 'Canonical CRUD supplier',
            slug: 'canonical-crud-supplier',
            adapterType: 'canonical-b2b',
            baseUrl: 'https://supplier.example/client/api',
            authType: 'API_KEY',
            apiKey: 'private-provider-token',
        }, adminId);
        expect(created.adapterType).toBe('canonical-b2b');
        expect(created.toJSON().apiKey).toBeUndefined();

        const nameOnlyUpdate = await adminProviderService.updateProvider(created._id, {
            name: 'Canonical CRUD supplier renamed',
        }, adminId);
        expect(nameOnlyUpdate.adapterType).toBe('canonical-b2b');

        const updated = await adminProviderService.updateProvider(created._id, {
            adapterType: null,
        }, adminId);
        expect(updated.adapterType).toBeNull();

        const restored = await adminProviderService.updateProvider(created._id, {
            adapterType: 'CANONICAL-B2B',
        }, adminId);
        expect(restored.adapterType).toBe('canonical-b2b');

        await expect(Provider.create({
            name: 'Unsupported adapter type',
            baseUrl: 'https://supplier.example/client/api',
            adapterType: 'not-supported',
        })).rejects.toThrow(/`not-supported` is not a valid enum value/);
    });

    it('syncs canonical ProviderProducts with USD, availability, category metadata, and sanitized fields payload', async () => {
        const syncedProvider = await Provider.create({
            name: 'Canonical sync supplier',
            slug: 'canonical-sync-supplier',
            adapterType: 'canonical-b2b',
            baseUrl: 'https://supplier.example/client/api',
            apiToken: 'private-provider-token',
        });
        const httpClient = makeClient();
        httpClient.get.mockResolvedValue({ data: [{
            id: 1000,
            name: 'Remote product',
            price: 3.75,
            currency: 'USD',
            available: false,
            parent_id: 22,
            category_name: 'Remote category',
            qty_values: { min: 1, max: 10 },
            params: ['Player ID'],
            fields: [{ key: 'player_id', required: true }],
            authorization: 'upstream-secret',
        }] });

        await syncProviderProducts(syncedProvider._id, { httpClient });
        const product = await ProviderProduct.findOne({ provider: syncedProvider._id }).lean();
        expect(product).toMatchObject({
            externalProductId: '1000', rawPrice: '3.75', currency: 'USD',
            available: false, isActive: false, category: '22', categoryName: 'Remote category',
        });
        expect(product.rawPayload.fields).toEqual([{ key: 'player_id', required: true }]);
        expect(product.rawPayload.params).toEqual(['Player ID']);
        expect(product.rawPayload.authorization).toBe('[REDACTED]');
    });
});
