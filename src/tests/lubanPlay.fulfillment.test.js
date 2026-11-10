'use strict';

const { Order, ORDER_STATUS, ORDER_EXECUTION_TYPES } = require('../modules/orders/order.model');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct, FULFILLMENT_MODES } = require('../modules/providers/providerProduct.model');
const { ProviderDeliveredCode } = require('../modules/providers/fazercards/providerDeliveredCode.model');
const { WalletTransaction, LEDGER_TRANSACTION_TYPES } = require('../modules/wallet/walletTransaction.model');
const { createOrder } = require('../modules/orders/order.service');
const orderFulfillmentService = require('../modules/orders/orderFulfillment.service');
const { executeOrder, pollProcessingOrders } = orderFulfillmentService;
const { LubanPlayAdapter, ENDPOINTS } = require('../modules/providers/adapters/lubanPlay.adapter');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
    createProduct,
} = require('./testHelpers');

beforeAll(async () => connectTestDB());
afterAll(async () => disconnectTestDB());
beforeEach(async () => clearCollections());

let sequence = 0;

const makeChain = async ({
    kind = 'giftcard',
    providerMapping = { player_id: 'player_id', server_id: 'server_id' },
    orderFields = [],
} = {}) => {
    const id = ++sequence;
    const provider = await Provider.create({
        name: `Luban ${id}`,
        slug: `luban-${id}`,
        adapterType: 'luban-play',
        providerCode: 'LUBAN_PLAY',
        baseUrl: 'https://api.lubanplay.example/index.php?s=/api/openapi',
        apiToken: 'test-token',
        isActive: true,
    });
    const providerProduct = await ProviderProduct.create({
        provider: provider._id,
        externalProductId: kind === 'giftcard' ? `LUBAN_GIFTCARD:g-${id}` : `LUBAN_TOPUP:12:${id}`,
        rawName: 'Luban test offer',
        rawPrice: '10.000000',
        minQty: 1,
        maxQty: kind === 'giftcard' ? 50 : 20,
        currency: 'USD',
        isActive: true,
        rawPayload: kind === 'giftcard'
            ? { lubanKind: 'giftcard', product_id: `g-${id}` }
            : { lubanKind: 'topup', game_id: 12, package_id: id },
    });
    const product = await createProduct({
        name: `Luban product ${id}`,
        executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
        provider: provider._id,
        providerProduct: providerProduct._id,
        providerCode: 'LUBAN_PLAY',
        familyKey: kind === 'giftcard' ? 'GIFTCARDS' : 'TOPUPS',
        fulfillmentMode: kind === 'giftcard' ? FULFILLMENT_MODES.CODE_DELIVERY : FULFILLMENT_MODES.TOPUP_WITH_FIELDS,
        providerMapping,
        orderFields,
    });
    return { provider, providerProduct, product };
};

const makeOrder = async (product, overrides = {}) => {
    const { customer, group } = await createCustomerWithGroup({ walletBalance: 1000 }, { percentage: 0 });
    return Order.create({
        userId: customer._id,
        orderNumber: 810000 + (++sequence),
        productId: product._id,
        quantity: 1,
        unitPrice: '10',
        totalPrice: '10',
        basePriceSnapshot: '10',
        markupPercentageSnapshot: 0,
        finalPriceCharged: '10',
        groupIdSnapshot: group._id,
        walletDeducted: 10,
        creditUsedAmount: '0',
        status: ORDER_STATUS.PROCESSING,
        executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
        providerCode: 'luban-play',
        familyKey: product.familyKey,
        fulfillmentMode: product.fulfillmentMode,
        customerInput: { values: { player_id: 'player-42', server_id: 'zone-2' }, fieldsSnapshot: [] },
        ...overrides,
    });
};

describe('Luban Play fulfillment safety', () => {
    it('passes checkout player_id through an empty mapping, dispatches one top-up, and completes on polling', async () => {
        const { provider, product } = await makeChain({
            kind: 'topup',
            providerMapping: {},
            orderFields: [
                { id: 'player_id', key: 'player_id', label: 'Player ID', type: 'text', required: true, isActive: true },
                { id: 'server_id', key: 'server_id', label: 'Server ID', type: 'text', required: false, isActive: true },
            ],
        });
        const { customer } = await createCustomerWithGroup({ walletBalance: 1000 }, { percentage: 0 });
        const httpClient = { post: jest.fn() };
        const adapter = new LubanPlayAdapter(provider, { httpClient, packageRequestDelayMs: 0 });
        // Checkout refreshes cached provider pricing before it commits the
        // financial transaction. Keep that read local; the actual dispatch
        // below uses the real Luban adapter with a mocked HTTP client.
        const checkoutAdapter = { getProducts: jest.fn().mockResolvedValue([]) };
        const backgroundFulfillment = jest.spyOn(orderFulfillmentService, 'executeOrder')
            .mockResolvedValue({ order: null, placed: false, refunded: false });

        let checkout;
        try {
            checkout = await createOrder({
                userId: customer._id,
                productId: product._id,
                quantity: 1,
                orderFieldsValues: { player_id: 'player-42', server_id: 'zone-2' },
                provider: checkoutAdapter,
                idempotencyKey: `luban-empty-mapping-${product._id}`,
            });
        } finally {
            backgroundFulfillment.mockRestore();
        }

        const order = checkout.order;
        expect(order.status).toBe(ORDER_STATUS.PROCESSING);
        expect(order.customerInput.values).toEqual({ player_id: 'player-42', server_id: 'zone-2' });

        httpClient.post.mockImplementation((path, body) => {
            if (path === ENDPOINTS.createTopupOrder) {
                expect(body).toEqual({
                    game_id: 12,
                    package_id: expect.any(Number),
                    player_id: 'player-42',
                    server_id: 'zone-2',
                    quantity: 1,
                    client_reference: `winnie-lp-${order._id}`,
                });
                return Promise.resolve({
                    data: {
                        success: true,
                        data: { order_id: 'TP-CHECKOUT-1', status: 'processing', client_reference: `winnie-lp-${order._id}` },
                        request_id: 'req-create',
                    },
                });
            }
            if (path === ENDPOINTS.queryOrder) {
                return Promise.reject({
                    response: { status: 404, data: { success: false, code: 'ORDER_NOT_FOUND', message: 'not found' } },
                });
            }
            if (path === ENDPOINTS.queryTopupOrder) {
                expect(body).toEqual({ order_id: 'TP-CHECKOUT-1' });
                return Promise.resolve({
                    data: {
                        success: true,
                        data: { order_id: 'TP-CHECKOUT-1', status: 'delivered', client_reference: `winnie-lp-${order._id}` },
                        request_id: 'req-poll',
                    },
                });
            }
            throw new Error(`unexpected Luban endpoint ${path}`);
        });

        const dispatched = await executeOrder(order._id, adapter);
        expect(dispatched.order.providerOrderId).toBe('TP-CHECKOUT-1');
        expect(httpClient.post.mock.calls.filter(([path]) => path === ENDPOINTS.createTopupOrder)).toHaveLength(1);

        const stats = await pollProcessingOrders(adapter);
        const completed = await Order.findById(order._id);
        expect(stats.completed).toBe(1);
        expect(completed.status).toBe(ORDER_STATUS.COMPLETED);
        expect(completed.refunded).toBe(false);
        expect(httpClient.post.mock.calls.filter(([path]) => path === ENDPOINTS.createTopupOrder)).toHaveLength(1);
    });

    it('persists the namespaced stable reference before one placement and delivers encrypted gift-card secrets', async () => {
        const { product } = await makeChain();
        const order = await makeOrder(product);
        const adapter = {
            placeOrder: jest.fn().mockResolvedValue({
                success: true,
                providerOrderId: 'GC-1',
                providerStatus: 'Delivered',
                deliveryCodes: [{ code: 'secret-code', pin: '1234', serial: 's-1', expirationDate: '2030-01-01' }],
                rawResponse: { data: { order_id: 'GC-1', status: 'delivered', codes: '[REDACTED]' } },
            }),
            checkOrderByReference: jest.fn(),
            checkOrders: jest.fn(),
        };

        const result = await executeOrder(order._id, adapter);
        expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
        expect(adapter.placeOrder.mock.calls[0][0]).toMatchObject({
            lubanClientReference: `winnie-lp-${order._id}`,
            params: { player_id: 'player-42', server_id: 'zone-2' },
        });
        expect(result.order.status).toBe(ORDER_STATUS.COMPLETED);
        expect(result.order.providerIdempotencyKey).toBe(`provider:luban-play:${order._id}`);

        const delivered = await ProviderDeliveredCode.findOne({ order: order._id }).select('+codeEncrypted +pinEncrypted +serialEncrypted');
        expect(delivered.codeEncrypted).not.toContain('secret-code');
        expect(delivered.getSecretValue('codeEncrypted')).toBe('secret-code');
        expect(delivered.getSecretValue('pinEncrypted')).toBe('1234');
    });

    it('never dispatches a concurrent duplicate placement', async () => {
        const { product } = await makeChain({ kind: 'topup' });
        const order = await makeOrder(product);
        let release;
        const placement = new Promise((resolve) => { release = resolve; });
        const adapter = {
            placeOrder: jest.fn().mockReturnValue(placement),
            checkOrderByReference: jest.fn().mockResolvedValue({ found: false }),
            checkOrders: jest.fn(),
        };

        const first = executeOrder(order._id, adapter);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const second = executeOrder(order._id, adapter);
        release({ success: true, providerOrderId: 'TP-1', providerStatus: 'Pending', rawResponse: { data: { order_id: 'TP-1' } } });
        await Promise.all([first, second]);
        expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
    });

    it('rejects a missing player_id before dispatch instead of treating server_id as a player', async () => {
        const { product } = await makeChain({ kind: 'topup' });
        const order = await makeOrder(product, {
            customerInput: { values: { server_id: 'zone-only' }, fieldsSnapshot: [] },
        });
        const adapter = {
            placeOrder: jest.fn(),
            checkOrderByReference: jest.fn(),
            checkOrders: jest.fn(),
        };

        const result = await executeOrder(order._id, adapter);

        expect(adapter.placeOrder).not.toHaveBeenCalled();
        expect(adapter.checkOrderByReference).not.toHaveBeenCalled();
        expect(result.order.status).toBe(ORDER_STATUS.FAILED);
        expect(result.order.refunded).toBe(true);
        expect(result.order.providerErrorCode).toBe('LUBAN_PLAY_PRE_DISPATCH_VALIDATION');
        expect(result.order.providerRawResponse).toMatchObject({
            placement: 'pre_dispatch_rejected',
            placementDiagnostic: { playerIdPresent: false, serverIdPresent: true },
        });
    });

    it('reconciles a timeout-like unknown outcome by client_reference without a replacement placement or refund', async () => {
        const { product } = await makeChain({ kind: 'topup' });
        const order = await makeOrder(product);
        const adapter = {
            placeOrder: jest.fn().mockResolvedValue({ success: false, manualReview: true, providerOrderId: null, providerStatus: 'Unknown', rawResponse: { transport: 'timeout' } }),
            checkOrderByReference: jest.fn().mockResolvedValue({ found: true, providerOrderId: 'TP-2', providerStatus: 'Pending', rawResponse: { data: { order_id: 'TP-2', status: 'processing' } } }),
            checkOrders: jest.fn(),
        };

        const result = await executeOrder(order._id, adapter);
        expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
        expect(adapter.checkOrderByReference).toHaveBeenCalledWith(`winnie-lp-${order._id}`, 'topup');
        expect(result.order.status).toBe(ORDER_STATUS.PROCESSING);
        expect(result.order.providerOrderId).toBe('TP-2');
        expect(result.order.refunded).toBe(false);
    });

    it('keeps the first diagnostic when a dispatched placement has no supplier reference', async () => {
        const { product } = await makeChain({ kind: 'topup' });
        const order = await makeOrder(product);
        const adapter = {
            placeOrder: jest.fn().mockResolvedValue({ success: true, providerOrderId: null, providerStatus: 'Pending', rawResponse: { data: {} } }),
            checkOrderByReference: jest.fn().mockResolvedValue({ found: false }),
            checkOrders: jest.fn(),
        };

        const result = await executeOrder(order._id, adapter);

        expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
        expect(adapter.checkOrderByReference).toHaveBeenCalledWith(`winnie-lp-${order._id}`, 'topup');
        expect(result.order.status).toBe(ORDER_STATUS.PROCESSING);
        expect(result.order.providerRawResponse).toMatchObject({
            placement: 'uncertain',
            recovery: 'not_found',
            placementDiagnostic: {
                phase: 'pre_dispatch_validated',
                gameId: '12',
                packageId: expect.any(String),
                playerIdPresent: true,
            },
        });
        expect(result.order.providerRawResponse.placementDiagnostic).not.toHaveProperty('playerId');
    });

    it('recovers a crash after the dispatch marker without a second placement', async () => {
        const { product } = await makeChain({ kind: 'topup' });
        const order = await makeOrder(product, {
            providerIdempotencyKey: 'placeholder',
            providerStatus: 'PLACEMENT_UNCERTAIN',
            providerRawResponse: { placement: 'dispatching', clientReference: 'ignored', placementDiagnostic: { phase: 'pre_dispatch_validated', playerIdPresent: true } },
        });
        await Order.findByIdAndUpdate(order._id, {
            $set: { providerIdempotencyKey: `provider:luban-play:${order._id}` },
        });
        const adapter = {
            placeOrder: jest.fn(),
            checkOrderByReference: jest.fn().mockResolvedValue({ found: false }),
            checkOrders: jest.fn(),
        };

        const result = await executeOrder(order._id, adapter);

        expect(adapter.placeOrder).not.toHaveBeenCalled();
        expect(adapter.checkOrderByReference).toHaveBeenCalledWith(`winnie-lp-${order._id}`, 'topup');
        expect(result.order.status).toBe(ORDER_STATUS.PROCESSING);
        expect(result.order.providerRawResponse).toMatchObject({
            recovery: 'not_found',
            placementDiagnostic: { phase: 'pre_dispatch_validated' },
        });
    });

    it.each([12, 13])('moves an unresolved placement at retry %i to manual review without another supplier lookup', async (retryCount) => {
        const { product } = await makeChain({ kind: 'topup' });
        const order = await makeOrder(product, {
            providerIdempotencyKey: 'placeholder',
            providerStatus: 'PLACEMENT_UNCERTAIN',
            retryCount,
            providerRawResponse: { placement: 'dispatching', placementDiagnostic: { phase: 'pre_dispatch_validated', playerIdPresent: true } },
        });
        await Order.findByIdAndUpdate(order._id, {
            $set: { providerIdempotencyKey: `provider:luban-play:${order._id}` },
        });
        const provider = {
            checkOrderByReference: jest.fn(),
            checkOrders: jest.fn(),
        };

        const stats = await pollProcessingOrders(provider);
        const persisted = await Order.findById(order._id);

        expect(provider.checkOrderByReference).not.toHaveBeenCalled();
        expect(stats.manualReview).toBe(1);
        expect(persisted.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(persisted.retryCount).toBe(retryCount);
        expect(persisted.providerRawResponse).toMatchObject({
            recovery: 'retry_limit',
            placementDiagnostic: { phase: 'pre_dispatch_validated' },
        });
    });

    it('uses the existing exactly-once refund path only for a confirmed Luban terminal failure', async () => {
        const { product } = await makeChain({ kind: 'topup' });
        const order = await makeOrder(product);
        const adapter = {
            placeOrder: jest.fn().mockResolvedValue({ success: false, providerOrderId: null, providerStatus: 'Failed', errorMessage: 'documented validation rejection', rawResponse: { code: 'INVALID_ARGUMENT' } }),
            checkOrderByReference: jest.fn(),
            checkOrders: jest.fn(),
        };
        const result = await executeOrder(order._id, adapter);
        expect(result.order.status).toBe(ORDER_STATUS.FAILED);
        expect(result.order.refunded).toBe(true);
        expect(adapter.checkOrderByReference).not.toHaveBeenCalled();
    });

    it('polls delivered codes before completing', async () => {
        const { product } = await makeChain();
        const order = await makeOrder(product, { providerOrderId: 'GC-POLL', providerStatus: 'Pending' });
        const provider = {
            checkOrders: jest.fn().mockResolvedValue([{
                providerOrderId: 'GC-POLL',
                providerStatus: 'Delivered',
                deliveryCodes: [{ code: 'poll-secret', pin: null, serial: 's-2' }],
                rawResponse: { data: { status: 'delivered', codes: '[REDACTED]' } },
            }]),
        };
        const stats = await pollProcessingOrders(provider);
        expect(stats.completed).toBe(1);
        expect((await Order.findById(order._id)).status).toBe(ORDER_STATUS.COMPLETED);
    });

    it('keeps a delivered gift card in manual review when codes are missing', async () => {
        const { product } = await makeChain();
        const order = await makeOrder(product);
        const adapter = {
            placeOrder: jest.fn().mockResolvedValue({
                success: true,
                providerOrderId: 'GC-NO-CODES',
                providerStatus: 'Delivered',
                deliveryCodes: [],
                rawResponse: { data: { order_id: 'GC-NO-CODES', status: 'delivered' } },
            }),
            checkOrderByReference: jest.fn(),
            checkOrders: jest.fn(),
        };
        const result = await executeOrder(order._id, adapter);
        expect(result.order.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(result.order.refunded).toBe(false);
        expect(await ProviderDeliveredCode.countDocuments({ order: order._id })).toBe(0);
    });

    it('refunds a reported refunded order exactly once', async () => {
        const { product } = await makeChain({ kind: 'topup' });
        const order = await makeOrder(product, { providerOrderId: 'TP-REFUND', providerStatus: 'Pending' });
        const provider = {
            checkOrders: jest.fn().mockResolvedValue([{
                providerOrderId: 'TP-REFUND',
                providerStatus: 'Refunded',
                rawResponse: { data: { order_id: 'TP-REFUND', status: 'refunded' } },
            }]),
        };

        await pollProcessingOrders(provider);
        await pollProcessingOrders(provider);

        expect((await Order.findById(order._id)).status).toBe(ORDER_STATUS.FAILED);
        expect(await WalletTransaction.countDocuments({
            reference: order._id,
            type: 'REFUND',
            semanticType: LEDGER_TRANSACTION_TYPES.ORDER_REFUND,
        })).toBe(1);
    });

    it('keeps an unknown supplier status processing without a refund', async () => {
        const { product } = await makeChain({ kind: 'topup' });
        const order = await makeOrder(product, { providerOrderId: 'TP-UNKNOWN', providerStatus: 'Pending' });
        const provider = {
            checkOrders: jest.fn().mockResolvedValue([{
                providerOrderId: 'TP-UNKNOWN',
                providerStatus: 'unexpected_status',
                rawResponse: { data: { order_id: 'TP-UNKNOWN', status: 'unexpected_status' } },
            }]),
        };
        await pollProcessingOrders(provider);
        const persisted = await Order.findById(order._id);
        expect(persisted.status).toBe(ORDER_STATUS.PROCESSING);
        expect(persisted.refunded).toBe(false);
    });
});
