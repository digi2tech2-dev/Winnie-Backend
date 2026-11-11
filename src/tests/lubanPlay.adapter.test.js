'use strict';

const { LubanPlayAdapter, ENDPOINTS } = require('../modules/providers/adapters/lubanPlay.adapter');

const provider = {
    name: 'Luban Play',
    slug: 'luban-play',
    adapterType: 'luban-play',
    baseUrl: 'https://api.lubanplay.example/index.php?s=/api/openapi',
    apiToken: 'test-luban-token',
};

const response = (data) => ({ data: { success: true, message: 'success', data, request_id: 'req-test' } });
const makeClient = () => ({ post: jest.fn() });
const makeAdapter = (post) => {
    const client = makeClient();
    client.post.mockImplementation(post);
    return { adapter: new LubanPlayAdapter(provider, { httpClient: client, packageRequestDelayMs: 0 }), client };
};
describe('LubanPlayAdapter', () => {
    it('maps fixed USD gift cards and USD top-up packages while retaining unsupported offers inactive', async () => {
        const { adapter, client } = makeAdapter((path, body) => {
            if (path === ENDPOINTS.products) return Promise.resolve(response([
                { type: 'giftcard', product_id: 'gift-usd', sku_id: 'info-only', name: 'Fixed USD', face_value_min: '10.00', face_value_max: '10', amount_required: false, currency: 'USD', price: '9.123456', status: 'available' },
                { type: 'giftcard', product_id: 'gift-eur', name: 'EUR', face_value_min: '10', face_value_max: '10', amount_required: false, currency: 'EUR', price: '9', status: 'available' },
                { type: 'giftcard', product_id: 'open-usd', name: 'Open', face_value_min: '10', face_value_max: '50', amount_required: true, currency: 'USD', price_min: '9', price_max: '49', status: 'available' },
            ]));
            if (path === ENDPOINTS.topupProducts) return Promise.resolve(response([
                { game_id: 12, name: 'Game', delivery_type: 'direct', server_type: 1, status: 'available' },
            ]));
            if (path === ENDPOINTS.topupPackages) {
                expect(body).toEqual({ game_id: 12 });
                return Promise.resolve(response({ game_id: 12, packages: [
                    { package_id: 301, name: '60 UC', currency: 'USD', price: '0.900000', status: 'available' },
                    { package_id: 302, name: 'EUR package', currency: 'EUR', price: '1.00', status: 'available' },
                ] }));
            }
            throw new Error(`unexpected ${path}`);
        });

        const products = await adapter.getProducts();

        expect(products).toEqual(expect.arrayContaining([
            expect.objectContaining({ externalProductId: 'LUBAN_GIFTCARD:gift-usd', rawPrice: '9.123456', currency: 'USD', minQty: 1, maxQty: 50, isActive: true }),
            expect.objectContaining({ externalProductId: 'LUBAN_GIFTCARD:gift-eur', currency: 'EUR', isActive: false }),
            expect.objectContaining({ externalProductId: 'LUBAN_GIFTCARD:open-usd', currency: 'USD', isActive: false }),
            expect.objectContaining({ externalProductId: 'LUBAN_TOPUP:12:301', rawPrice: '0.900000', currency: 'USD', minQty: 1, maxQty: 20, isActive: true }),
            expect.objectContaining({ externalProductId: 'LUBAN_TOPUP:12:302', currency: 'EUR', isActive: false }),
        ]));
        expect(products.find((item) => item.externalProductId === 'LUBAN_GIFTCARD:gift-usd').rawPayload.sku_id).toBe('info-only');
        expect(client.post).toHaveBeenCalledWith(ENDPOINTS.products, {}, { timeout: 120000 });
    });

    it('maps a large complete gift-card response with the catalog-only timeout', async () => {
        const largeCatalog = Array.from({ length: 11_916 }, (_, index) => ({
            type: 'giftcard',
            product_id: `gift-${index + 1}`,
            name: `Gift ${index + 1}`,
            face_value_min: '10.00',
            face_value_max: '10',
            amount_required: false,
            currency: 'USD',
            price: '9.500000',
            status: 'available',
        }));
        const { adapter, client } = makeAdapter((path) => {
            if (path === ENDPOINTS.products) return Promise.resolve(response(largeCatalog));
            if (path === ENDPOINTS.topupProducts) return Promise.resolve(response([]));
            throw new Error(`unexpected ${path}`);
        });

        const products = await adapter.getProducts();

        expect(products).toHaveLength(11_916);
        expect(products[0]).toMatchObject({ externalProductId: 'LUBAN_GIFTCARD:gift-1', isActive: true });
        expect(products.at(-1)).toMatchObject({ externalProductId: 'LUBAN_GIFTCARD:gift-11916', isActive: true });
        expect(client.post).toHaveBeenCalledWith(ENDPOINTS.products, {}, { timeout: 120000 });
    });

    it('uses documented form fields and never sends an amount for fixed-price gift cards', async () => {
        const { adapter, client } = makeAdapter((path) => {
            expect(path).toBe(ENDPOINTS.createOrder);
            return Promise.resolve(response({
                order_id: 'GC-1', client_reference: 'winnie-lp-1', status: 'delivered', currency: 'USD', total_price: '9.12',
                codes: [{ serial_number: 'serial-1', card_code: 'gift-secret', pin: '1234', expiration_date: '2030-01-01' }],
            }));
        });

        const result = await adapter.placeOrder({
            quantity: 2,
            lubanClientReference: 'winnie-lp-1',
            providerProduct: { rawPayload: { lubanKind: 'giftcard', product_id: 'gift-usd' } },
        });

        expect(client.post.mock.calls[0][1]).toEqual({ product_id: 'gift-usd', quantity: 2, client_reference: 'winnie-lp-1' });
        expect(result).toMatchObject({ success: true, found: true, providerOrderId: 'GC-1', providerStatus: 'Delivered', referenceId: 'winnie-lp-1' });
        expect(result.deliveryCodes).toEqual([{ code: 'gift-secret', pin: '1234', serial: 'serial-1', expirationDate: '2030-01-01' }]);
        expect(JSON.stringify(result.rawResponse)).not.toContain('gift-secret');
    });

    it('enforces documented gift-card and top-up quantity limits before a request', async () => {
        const { adapter, client } = makeAdapter(() => Promise.resolve(response({})));
        await expect(adapter.placeOrder({ quantity: 51, lubanClientReference: 'r', providerProduct: { rawPayload: { lubanKind: 'giftcard', product_id: 'g' } } }))
            .resolves.toMatchObject({ success: false, providerStatus: 'Failed' });
        await expect(adapter.placeOrder({ quantity: 21, lubanClientReference: 'r', providerProduct: { rawPayload: { lubanKind: 'topup', game_id: 1, package_id: 2 } }, params: { player_id: 'p' } }))
            .resolves.toMatchObject({ success: false, providerStatus: 'Failed' });
        expect(client.post).not.toHaveBeenCalled();
    });

    it.each([
        [{ lubanKind: 'topup', game_id: 12, package_id: 301 }, {}, /player_id is required/],
        [{ lubanKind: 'topup', package_id: 301 }, { player_id: 'player-7' }, /game_id is required/],
        [{ lubanKind: 'topup', game_id: 12 }, { player_id: 'player-7' }, /package_id is required/],
    ])('rejects malformed top-up payloads before createTopupOrder', async (rawPayload, params, message) => {
        const { adapter, client } = makeAdapter(() => Promise.resolve(response({})));
        const result = await adapter.placeOrder({
            quantity: 1,
            lubanClientReference: 'winnie-lp-preflight',
            providerProduct: { rawPayload },
            params,
        });

        expect(result).toMatchObject({ success: false, providerStatus: 'Failed', errorMessage: expect.stringMatching(message) });
        expect(result.manualReview).not.toBe(true);
        expect(result.placementAttemptDiagnostic).toMatchObject({
            dispatchPhase: 'pre_post_failure',
            endpoint: 'createTopupOrder',
            httpStatus: null,
            networkErrorCode: null,
            responseClassification: 'pre_post_failure',
        });
        expect(client.post).not.toHaveBeenCalled();
    });

    it('maps player and optional server fields to a top-up request', async () => {
        const { adapter, client } = makeAdapter((path) => {
            expect(path).toBe(ENDPOINTS.createTopupOrder);
            return Promise.resolve(response({ order_id: 'TP-1', client_reference: 'winnie-lp-2', status: 'processing', currency: 'USD', amount: '0.90' }));
        });
        const result = await adapter.placeOrder({
            quantity: 20,
            lubanClientReference: 'winnie-lp-2',
            providerProduct: { rawPayload: { lubanKind: 'topup', game_id: 12, package_id: 301 } },
            params: { playerId: 'player-7', serverId: 'zone-2' },
        });
        expect(client.post.mock.calls[0][1]).toEqual({ game_id: 12, package_id: 301, player_id: 'player-7', server_id: 'zone-2', quantity: 20, client_reference: 'winnie-lp-2' });
        expect(result).toMatchObject({ success: true, providerOrderId: 'TP-1', providerStatus: 'Pending' });
        expect(result.placementAttemptDiagnostic).toEqual({
            dispatchPhase: 'supplier_response_received',
            endpoint: 'createTopupOrder',
            httpStatus: null,
            providerErrorCode: null,
            networkErrorCode: null,
            responseClassification: 'supplier_accepted',
        });
    });

    it('records a sanitized definitive supplier rejection for a top-up placement', async () => {
        const { adapter } = makeAdapter(() => Promise.reject({
            response: {
                status: 400,
                data: { success: false, code: 'MISSING_PLAYER_ID', message: 'supplier message', request_id: 'req-rejected' },
            },
        }));

        const result = await adapter.placeOrder({
            quantity: 1,
            lubanClientReference: 'winnie-lp-rejected',
            providerProduct: { rawPayload: { lubanKind: 'topup', game_id: 12, package_id: 301 } },
            params: { player_id: 'player-7' },
        });

        expect(result).toMatchObject({ success: false, providerStatus: 'Failed', providerErrorCode: 'MISSING_PLAYER_ID' });
        expect(result.placementAttemptDiagnostic).toEqual({
            dispatchPhase: 'supplier_response_received',
            endpoint: 'createTopupOrder',
            httpStatus: 400,
            providerErrorCode: 'MISSING_PLAYER_ID',
            networkErrorCode: null,
            responseClassification: 'supplier_rejection_definitive',
        });
        expect(JSON.stringify(result.placementAttemptDiagnostic)).not.toContain('player-7');
    });

    it.each([
        ['timeout', 'ECONNABORTED'],
        ['transport failure', 'ENOTFOUND'],
    ])('records a sanitized uncertain %s after top-up dispatch', async (_label, code) => {
        const { adapter } = makeAdapter(() => Promise.reject(Object.assign(new Error('transport failed'), { code })));

        const result = await adapter.placeOrder({
            quantity: 1,
            lubanClientReference: 'winnie-lp-transport',
            providerProduct: { rawPayload: { lubanKind: 'topup', game_id: 12, package_id: 301 } },
            params: { player_id: 'player-7' },
        });

        expect(result).toMatchObject({ success: false, manualReview: true, providerStatus: 'Unknown' });
        expect(result.placementAttemptDiagnostic).toEqual({
            dispatchPhase: 'post_dispatch_unknown',
            endpoint: 'createTopupOrder',
            httpStatus: null,
            providerErrorCode: null,
            networkErrorCode: code,
            responseClassification: 'transport_uncertain',
        });
        expect(JSON.stringify(result.placementAttemptDiagnostic)).not.toContain('player-7');
    });

    it('uses client_reference for status recovery and treats documented 404 as not found', async () => {
        const { adapter, client } = makeAdapter((path, body) => {
            expect(path).toBe(ENDPOINTS.queryTopupOrder);
            expect(body).toEqual({ client_reference: 'winnie-lp-missing' });
            return Promise.reject({ response: { status: 404, data: { success: false, code: 'ORDER_NOT_FOUND', message: 'not found', request_id: 'req-404' } } });
        });
        await expect(adapter.checkOrderByReference('winnie-lp-missing', 'topup')).resolves.toEqual(expect.objectContaining({ found: false, referenceId: 'winnie-lp-missing' }));
        expect(client.post).toHaveBeenCalledTimes(1);
    });

    it('uses documented gift-card and top-up query endpoints', async () => {
        const { adapter, client } = makeAdapter((path, body) => {
            if (path === ENDPOINTS.queryOrder) {
                expect(body).toEqual({ order_id: 'GC-1' });
                return Promise.resolve(response({ order_id: 'GC-1', status: 'delivered' }));
            }
            if (path === ENDPOINTS.queryTopupOrder) {
                expect(body).toEqual({ order_id: 'TP-1' });
                return Promise.resolve(response({ order_id: 'TP-1', status: 'processing' }));
            }
            throw new Error(`unexpected ${path}`);
        });

        await expect(adapter.checkOrder('GC-1')).resolves.toMatchObject({ providerOrderId: 'GC-1', providerStatus: 'Delivered' });
        await expect(adapter.checkOrder('TP-1', { kind: 'topup' })).resolves.toMatchObject({ providerOrderId: 'TP-1', providerStatus: 'Pending' });
        expect(client.post).toHaveBeenCalledTimes(2);
    });

    it('normalizes the documented wallet balance map for the admin balance contract', async () => {
        const { adapter, client } = makeAdapter((path, body) => {
            expect(path).toBe(ENDPOINTS.balance);
            expect(body).toEqual({});
            return Promise.resolve(response({ balances: { USD: '10.00' }, environment: 'production' }));
        });

        await expect(adapter.getBalance()).resolves.toEqual({
            balance: 10,
            currency: 'USD',
            balances: { USD: '10.00' },
            environment: 'production',
            requestId: 'req-test',
        });
        const configured = new LubanPlayAdapter(provider);
        expect(configured._client.defaults.headers.Authorization).toBe('Bearer test-luban-token');
        expect(configured._client.defaults.headers['Content-Type']).toBe('application/json');
    });

    it('preserves a zero wallet balance as a numeric amount', async () => {
        const { adapter } = makeAdapter(() => Promise.resolve(response({ balances: { USD: '0' } })));

        await expect(adapter.getBalance()).resolves.toMatchObject({
            balance: 0,
            currency: 'USD',
        });
    });

    it.each([
        {},
        { balances: {} },
        { balances: { USD: 'not-a-number' } },
        { balances: { US: '10' } },
        { balances: { EUR: '10', AED: '20' } },
    ])('rejects missing, malformed, or ambiguous wallet balances', async (data) => {
        const { adapter } = makeAdapter(() => Promise.resolve(response(data)));

        await expect(adapter.getBalance()).rejects.toThrow('invalid wallet balance response');
    });

    it('rejects HTML responses without retaining the provider body', async () => {
        const { adapter } = makeAdapter(() => Promise.resolve({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            data: '<html><body>proxy error</body></html>',
        }));

        await expect(adapter.getBalance()).rejects.toThrow('unexpected non-JSON response');
    });

    it.each([
        [202, 'ORDER_PROCESSING'],
        [409, 'IDEMPOTENCY_CONFLICT'],
        [429, 'RATE_LIMIT_EXCEEDED'],
        [500, 'ORDER_FAILED'],
    ])('keeps documented HTTP %i %s placement outcomes recoverable', async (status, code) => {
        const { adapter } = makeAdapter(() => Promise.reject({
            response: { status, data: { success: false, code, message: 'upstream response', request_id: 'req-recover' } },
        }));
        await expect(adapter.placeOrder({
            quantity: 1,
            lubanClientReference: 'winnie-lp-recover',
            providerProduct: { rawPayload: { lubanKind: 'giftcard', product_id: 'gift-usd' } },
        })).resolves.toMatchObject({ success: false, manualReview: true, providerStatus: 'Unknown' });
    });

    it('treats documented validation rejection as a confirmed terminal failure', async () => {
        const { adapter } = makeAdapter(() => Promise.reject({
            response: { status: 400, data: { success: false, code: 'INVALID_QUANTITY', message: 'invalid', request_id: 'req-invalid' } },
        }));
        await expect(adapter.placeOrder({
            quantity: 1,
            lubanClientReference: 'winnie-lp-invalid',
            providerProduct: { rawPayload: { lubanKind: 'giftcard', product_id: 'gift-usd' } },
        })).resolves.toMatchObject({ success: false, providerStatus: 'Failed' });
    });

    it('rejects incomplete catalog envelopes instead of returning a partial snapshot', async () => {
        const { adapter } = makeAdapter((path) => {
            if (path === ENDPOINTS.products) return Promise.resolve(response([
                { type: 'giftcard', product_id: 'gift-usd', name: 'Fixed', face_value_min: '10', face_value_max: '10', amount_required: false, currency: 'USD', price: '9', status: 'available' },
            ]));
            if (path === ENDPOINTS.topupProducts) return Promise.resolve(response([{ game_id: 12, name: 'Game', status: 'available' }]));
            if (path === ENDPOINTS.topupPackages) return Promise.resolve(response({ game_id: 12 }));
            throw new Error(`unexpected ${path}`);
        });
        await expect(adapter.getProducts()).rejects.toThrow(/invalid package envelope/);
    });

    it('rejects catalog rows missing documented ordering identifiers', async () => {
        const { adapter } = makeAdapter((path) => {
            if (path === ENDPOINTS.products) return Promise.resolve(response([
                { type: 'giftcard', name: 'Malformed', face_value_min: '10', face_value_max: '10', amount_required: false, currency: 'USD', price: '9', status: 'available' },
            ]));
            if (path === ENDPOINTS.topupProducts) return Promise.resolve(response([]));
            throw new Error(`unexpected ${path}`);
        });
        await expect(adapter.getProducts()).rejects.toThrow(/without product_id/);
    });

    it('rejects duplicate ordering identifiers before returning a catalog snapshot', async () => {
        const { adapter } = makeAdapter((path) => {
            if (path === ENDPOINTS.products) return Promise.resolve(response([
                { type: 'giftcard', product_id: 'duplicate-gift', name: 'Gift one', face_value_min: '10', face_value_max: '10', amount_required: false, currency: 'USD', price: '9', status: 'available' },
                { type: 'giftcard', product_id: 'duplicate-gift', name: 'Gift two', face_value_min: '20', face_value_max: '20', amount_required: false, currency: 'USD', price: '19', status: 'available' },
            ]));
            if (path === ENDPOINTS.topupProducts) return Promise.resolve(response([]));
            throw new Error(`unexpected ${path}`);
        });
        await expect(adapter.getProducts()).rejects.toThrow(/duplicate gift-card product_id/);
    });

    it('rejects duplicate package IDs within the same game before returning a catalog snapshot', async () => {
        const { adapter } = makeAdapter((path) => {
            if (path === ENDPOINTS.products) return Promise.resolve(response([]));
            if (path === ENDPOINTS.topupProducts) return Promise.resolve(response([{ game_id: 12, name: 'Game', status: 'available' }]));
            if (path === ENDPOINTS.topupPackages) return Promise.resolve(response({ game_id: 12, packages: [
                { package_id: 301, name: 'One', currency: 'USD', price: '1', status: 'available' },
                { package_id: 301, name: 'Two', currency: 'USD', price: '2', status: 'available' },
            ] }));
            throw new Error(`unexpected ${path}`);
        });
        await expect(adapter.getProducts()).rejects.toThrow(/duplicate package_id/);
    });
});
