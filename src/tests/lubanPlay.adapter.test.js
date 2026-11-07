'use strict';

const { LubanPlayAdapter } = require('../modules/providers/adapters/lubanPlay.adapter');

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
const form = (body) => Object.fromEntries(new URLSearchParams(body));

describe('LubanPlayAdapter', () => {
    it('maps fixed USD gift cards and USD top-up packages while retaining unsupported offers inactive', async () => {
        const { adapter, client } = makeAdapter((path, body) => {
            if (path === '/products') return Promise.resolve(response([
                { type: 'giftcard', product_id: 'gift-usd', sku_id: 'info-only', name: 'Fixed USD', face_value_min: '10.00', face_value_max: '10', amount_required: false, currency: 'USD', price: '9.123456', status: 'available' },
                { type: 'giftcard', product_id: 'gift-eur', name: 'EUR', face_value_min: '10', face_value_max: '10', amount_required: false, currency: 'EUR', price: '9', status: 'available' },
                { type: 'giftcard', product_id: 'open-usd', name: 'Open', face_value_min: '10', face_value_max: '50', amount_required: true, currency: 'USD', price_min: '9', price_max: '49', status: 'available' },
            ]));
            if (path === '/topupProducts') return Promise.resolve(response([
                { game_id: 12, name: 'Game', delivery_type: 'direct', server_type: 1, status: 'available' },
            ]));
            if (path === '/topupPackages') {
                expect(form(body)).toEqual({ game_id: '12' });
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
        expect(client.post).toHaveBeenCalledWith('/products', '');
    });

    it('uses documented form fields and never sends an amount for fixed-price gift cards', async () => {
        const { adapter, client } = makeAdapter((path) => {
            expect(path).toBe('/createOrder');
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

        expect(form(client.post.mock.calls[0][1])).toEqual({ product_id: 'gift-usd', quantity: '2', client_reference: 'winnie-lp-1' });
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

    it('maps player and optional server fields to a top-up request', async () => {
        const { adapter, client } = makeAdapter((path) => {
            expect(path).toBe('/createTopupOrder');
            return Promise.resolve(response({ order_id: 'TP-1', client_reference: 'winnie-lp-2', status: 'processing', currency: 'USD', amount: '0.90' }));
        });
        const result = await adapter.placeOrder({
            quantity: 20,
            lubanClientReference: 'winnie-lp-2',
            providerProduct: { rawPayload: { lubanKind: 'topup', game_id: 12, package_id: 301 } },
            params: { playerId: 'player-7', serverId: 'zone-2' },
        });
        expect(form(client.post.mock.calls[0][1])).toEqual({ game_id: '12', package_id: '301', player_id: 'player-7', server_id: 'zone-2', quantity: '20', client_reference: 'winnie-lp-2' });
        expect(result).toMatchObject({ success: true, providerOrderId: 'TP-1', providerStatus: 'Pending' });
    });

    it('uses client_reference for status recovery and treats documented 404 as not found', async () => {
        const { adapter } = makeAdapter(() => Promise.reject({ response: { status: 404, data: { success: false, code: 'ORDER_NOT_FOUND', message: 'not found', request_id: 'req-404' } } }));
        await expect(adapter.checkOrderByReference('winnie-lp-missing', 'topup')).resolves.toEqual(expect.objectContaining({ found: false, referenceId: 'winnie-lp-missing' }));
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
            if (path === '/products') return Promise.resolve(response([
                { type: 'giftcard', product_id: 'gift-usd', name: 'Fixed', face_value_min: '10', face_value_max: '10', amount_required: false, currency: 'USD', price: '9', status: 'available' },
            ]));
            if (path === '/topupProducts') return Promise.resolve(response([{ game_id: 12, name: 'Game', status: 'available' }]));
            if (path === '/topupPackages') return Promise.resolve(response({ game_id: 12 }));
            throw new Error(`unexpected ${path}`);
        });
        await expect(adapter.getProducts()).rejects.toThrow(/invalid package envelope/);
    });

    it('rejects catalog rows missing documented ordering identifiers', async () => {
        const { adapter } = makeAdapter((path) => {
            if (path === '/products') return Promise.resolve(response([
                { type: 'giftcard', name: 'Malformed', face_value_min: '10', face_value_max: '10', amount_required: false, currency: 'USD', price: '9', status: 'available' },
            ]));
            if (path === '/topupProducts') return Promise.resolve(response([]));
            throw new Error(`unexpected ${path}`);
        });
        await expect(adapter.getProducts()).rejects.toThrow(/without product_id/);
    });
});
