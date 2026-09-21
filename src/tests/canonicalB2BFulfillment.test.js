'use strict';

const {
    Order,
    ORDER_STATUS,
    ORDER_EXECUTION_TYPES,
    MAX_RETRY_COUNT,
} = require('../modules/orders/order.model');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { CanonicalB2BAdapter } = require('../modules/providers/adapters/canonicalB2B.adapter');
const { executeOrder, pollProcessingOrders } = require('../modules/orders/orderFulfillment.service');
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

const waitFor = async (assertion, attempts = 40) => {
    let lastError;
    for (let index = 0; index < attempts; index += 1) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }
    throw lastError;
};

const canonicalResult = (overrides = {}) => ({
    success: true,
    providerOrderId: 70001,
    providerStatus: 'accept',
    rawResponse: { data: { order_id: 70001, status: 'accept' } },
    errorMessage: null,
    ...overrides,
});

const makeAdapter = (overrides = {}) => ({
    placeOrder: jest.fn().mockResolvedValue(canonicalResult()),
    checkOrderByReference: jest.fn().mockResolvedValue({ found: false, rawResponse: { data: [] } }),
    checkOrders: jest.fn().mockResolvedValue([]),
    ...overrides,
});

const makeCanonicalChain = async (overrides = {}) => {
    const id = ++sequence;
    const provider = await Provider.create({
        name: `Arbitrary upstream ${id}`,
        slug: `custom-upstream-${id}`,
        baseUrl: 'https://supplier.example/client/api',
        apiToken: 'test-token',
        adapterType: 'canonical-b2b',
        isActive: true,
        ...overrides.provider,
    });
    const providerProduct = await ProviderProduct.create({
        provider: provider._id,
        externalProductId: '1000',
        rawName: 'Canonical Product',
        rawPrice: '10',
        minQty: 1,
        maxQty: 100,
        isActive: true,
    });
    const product = await createProduct({
        name: `Canonical Product ${id}`,
        executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
        provider: provider._id,
        providerProduct: providerProduct._id,
        providerMapping: { player_id: 'playerId' },
        ...overrides.product,
    });
    return { provider, providerProduct, product };
};

const makeOrder = async (product, overrides = {}) => {
    const { customer, group } = await createCustomerWithGroup({ walletBalance: 1000 }, { percentage: 0 });
    return Order.create({
        userId: customer._id,
        orderNumber: 970000 + (++sequence),
        productId: product._id,
        quantity: 2,
        unitPrice: '10',
        totalPrice: '20',
        basePriceSnapshot: '10',
        markupPercentageSnapshot: 0,
        finalPriceCharged: '10',
        groupIdSnapshot: group._id,
        walletDeducted: 20,
        creditUsedAmount: '0',
        status: ORDER_STATUS.PROCESSING,
        executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
        customerInput: {
            values: { player_id: 'player-42' },
            fieldsSnapshot: [],
        },
        ...overrides,
    });
};

describe('Canonical B2B fulfillment safety', () => {
    it('uses orderNumber as the only stable placement reference and sends the minimal Canonical contract', async () => {
        const { product } = await makeCanonicalChain();
        const order = await makeOrder(product);
        const adapter = makeAdapter();

        const result = await executeOrder(order._id, adapter);

        expect(adapter.placeOrder).toHaveBeenCalledWith({
            externalProductId: '1000',
            quantity: 2,
            referenceId: String(order.orderNumber),
            params: { playerId: 'player-42' },
        });
        expect(result.order.status).toBe(ORDER_STATUS.COMPLETED);
        expect(result.order.providerIdempotencyKey).toBe(`provider:canonical-b2b:${order.orderNumber}`);
    });

    it.each([
        ['accept', ORDER_STATUS.COMPLETED],
        ['wait', ORDER_STATUS.PROCESSING],
    ])('handles a normal Canonical %s placement through existing status handling', async (providerStatus, expectedStatus) => {
        const { product } = await makeCanonicalChain();
        const order = await makeOrder(product);
        const adapter = makeAdapter({ placeOrder: jest.fn().mockResolvedValue(canonicalResult({ providerStatus })) });

        const result = await executeOrder(order._id, adapter);

        expect(result.order.status).toBe(expectedStatus);
        expect(result.order.providerOrderId).toBe(70001);
    });

    it('keeps a definitive reject on the existing terminal failure path', async () => {
        const { product } = await makeCanonicalChain();
        const order = await makeOrder(product);
        const adapter = makeAdapter({
            placeOrder: jest.fn().mockResolvedValue(canonicalResult({
                success: false,
                providerOrderId: null,
                providerStatus: 'reject',
                errorMessage: 'Upstream rejected the order',
            })),
        });

        const result = await executeOrder(order._id, adapter);

        expect(result.order.status).toBe(ORDER_STATUS.FAILED);
        expect(result.order.refunded).toBe(true);
    });

    it.each([
        ['accept', ORDER_STATUS.COMPLETED],
        ['wait', ORDER_STATUS.PROCESSING],
        ['reject', ORDER_STATUS.FAILED],
    ])('immediately recovers an uncertain placement by reference when upstream reports %s', async (providerStatus, expectedStatus) => {
        const { product } = await makeCanonicalChain();
        const order = await makeOrder(product);
        const adapter = makeAdapter({
            placeOrder: jest.fn().mockResolvedValue(canonicalResult({
                providerOrderId: null,
                providerStatus: 'PLACEMENT_UNCERTAIN',
                rawResponse: { placement: 'uncertain', referenceId: String(order.orderNumber) },
            })),
            checkOrderByReference: jest.fn().mockResolvedValue({
                found: true,
                providerOrderId: 70002,
                providerStatus,
                rawResponse: { order_id: 70002, status: providerStatus },
            }),
        });

        const result = await executeOrder(order._id, adapter);

        expect(adapter.checkOrderByReference).toHaveBeenCalledWith(String(order.orderNumber));
        expect(result.order.status).toBe(expectedStatus);
        expect(result.order.providerOrderId).toBe(70002);
        if (providerStatus === 'reject') expect(result.order.refunded).toBe(true);
    });

    it.each([
        ['not found', jest.fn().mockResolvedValue({ found: false, rawResponse: { data: [] } })],
        ['lookup error', jest.fn().mockRejectedValue(Object.assign(new Error('timeout token=secret'), { code: 'ECONNABORTED' }))],
    ])('preserves processing uncertainty without a refund when immediate reference recovery is %s', async (_label, checkOrderByReference) => {
        const { product } = await makeCanonicalChain();
        const order = await makeOrder(product);
        const adapter = makeAdapter({
            placeOrder: jest.fn().mockResolvedValue(canonicalResult({
                providerOrderId: null,
                providerStatus: 'PLACEMENT_UNCERTAIN',
                rawResponse: { placement: 'uncertain', token: '[REDACTED]' },
            })),
            checkOrderByReference,
        });

        const result = await executeOrder(order._id, adapter);

        expect(result.order.status).toBe(ORDER_STATUS.PROCESSING);
        expect(result.order.providerStatus).toBe('PLACEMENT_UNCERTAIN');
        expect(result.order.providerOrderId).toBeNull();
        expect(result.order.refunded).toBe(false);
        expect(JSON.stringify(result.order.providerRawResponse)).not.toContain('secret');
    });

    it('treats a thrown Canonical placement transport error as uncertainty and immediately checks the stable reference', async () => {
        const { product } = await makeCanonicalChain();
        const order = await makeOrder(product);
        const adapter = makeAdapter({
            placeOrder: jest.fn().mockRejectedValue(Object.assign(new Error('socket reset api-token=secret'), { code: 'ECONNRESET' })),
            checkOrderByReference: jest.fn().mockResolvedValue({ found: false, rawResponse: { data: [] } }),
        });

        const result = await executeOrder(order._id, adapter);

        expect(adapter.checkOrderByReference).toHaveBeenCalledWith(String(order.orderNumber));
        expect(result.order.status).toBe(ORDER_STATUS.PROCESSING);
        expect(result.order.providerStatus).toBe('PLACEMENT_UNCERTAIN');
        expect(result.order.refunded).toBe(false);
        expect(JSON.stringify(result.order.providerRawResponse)).not.toContain('secret');
    });

    it('atomically permits one placement and never re-posts an already claimed uncertain order', async () => {
        const { product } = await makeCanonicalChain();
        const order = await makeOrder(product);
        let releasePlacement;
        const placement = new Promise((resolve) => { releasePlacement = resolve; });
        const adapter = makeAdapter({
            placeOrder: jest.fn().mockImplementation(() => placement),
            checkOrderByReference: jest.fn().mockResolvedValue({ found: false, rawResponse: { data: [] } }),
        });

        const first = executeOrder(order._id, adapter);
        await waitFor(async () => {
            const claimed = await Order.findById(order._id);
            expect(claimed.providerIdempotencyKey).toBe(`provider:canonical-b2b:${order.orderNumber}`);
            expect(claimed.providerStatus).toBe('PLACEMENT_UNCERTAIN');
        });
        const second = await executeOrder(order._id, adapter);
        releasePlacement(canonicalResult({ providerOrderId: null, providerStatus: 'PLACEMENT_UNCERTAIN' }));
        await first;

        expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
        expect(second.order.providerIdempotencyKey).toBe(`provider:canonical-b2b:${order.orderNumber}`);
        await executeOrder(order._id, adapter);
        expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['inactive', async (provider) => Provider.findByIdAndUpdate(provider._id, { $set: { isActive: false } })],
        ['missing', async (provider) => Provider.findByIdAndDelete(provider._id)],
    ])('moves an already-claimed Canonical uncertainty to manual review when its provider is %s', async (_state, changeProvider) => {
        const { provider, product } = await makeCanonicalChain();
        const order = await makeOrder(product, {
            providerStatus: 'PLACEMENT_UNCERTAIN',
            providerOrderId: null,
        });
        await Order.findByIdAndUpdate(order._id, {
            $set: { providerIdempotencyKey: `provider:canonical-b2b:${order.orderNumber}` },
        });
        await changeProvider(provider);
        const placeOrder = jest.spyOn(CanonicalB2BAdapter.prototype, 'placeOrder');
        let result;
        try {
            // No adapter override: this exercises the generic provider
            // resolution path that previously failed/refunded first.
            result = await executeOrder(order._id);
        } finally {
            placeOrder.mockRestore();
        }

        expect(placeOrder).not.toHaveBeenCalled();
        expect(result.order.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(result.order.providerStatus).toBe('PLACEMENT_UNCERTAIN');
        expect(result.order.refunded).toBe(false);
        expect(result.order.providerIdempotencyKey).toBe(`provider:canonical-b2b:${order.orderNumber}`);
    });

    it('polls arbitrary-name, null-providerCode Canonical uncertainty by reference and persists a recovered upstream ID', async () => {
        const { provider, product } = await makeCanonicalChain({ provider: { providerCode: null } });
        const order = await makeOrder(product, {
            providerCode: null,
            providerStatus: 'PLACEMENT_UNCERTAIN',
            providerIdempotencyKey: `provider:canonical-b2b:970000`,
            providerOrderId: null,
        });
        await Order.findByIdAndUpdate(order._id, {
            $set: { providerIdempotencyKey: `provider:canonical-b2b:${order.orderNumber}` },
        });
        const adapter = makeAdapter({
            checkOrderByReference: jest.fn().mockResolvedValue({
                found: true,
                providerOrderId: 70003,
                providerStatus: 'wait',
                rawResponse: { order_id: 70003, status: 'wait' },
            }),
        });

        const stats = await pollProcessingOrders(adapter);
        const fresh = await Order.findById(order._id);

        expect(provider.adapterType).toBe('canonical-b2b');
        expect(adapter.checkOrderByReference).toHaveBeenCalledWith(String(order.orderNumber));
        expect(fresh.providerOrderId).toBe(70003);
        expect(fresh.status).toBe(ORDER_STATUS.PROCESSING);
        expect(stats.checked).toBe(1);
    });

    it.each([
        ['accept', ORDER_STATUS.COMPLETED, false],
        ['reject', ORDER_STATUS.FAILED, true],
    ])('applies a later reference-poll %s as a definitive result', async (providerStatus, expectedStatus, expectedRefund) => {
        const { product } = await makeCanonicalChain();
        const order = await makeOrder(product, {
            providerStatus: 'PLACEMENT_UNCERTAIN',
            providerOrderId: null,
        });
        await Order.findByIdAndUpdate(order._id, {
            $set: { providerIdempotencyKey: `provider:canonical-b2b:${order.orderNumber}` },
        });
        const adapter = makeAdapter({
            checkOrderByReference: jest.fn().mockResolvedValue({
                found: true,
                providerOrderId: 70004,
                providerStatus,
                rawResponse: { order_id: 70004, status: providerStatus },
            }),
        });

        await pollProcessingOrders(adapter);
        const fresh = await Order.findById(order._id);

        expect(fresh.status).toBe(expectedStatus);
        expect(fresh.refunded).toBe(expectedRefund);
    });

    it('increments a scheduled unresolved reference retry without refunding or placing again', async () => {
        const { product } = await makeCanonicalChain();
        const order = await makeOrder(product, {
            providerStatus: 'PLACEMENT_UNCERTAIN',
            providerOrderId: null,
            retryCount: 4,
        });
        await Order.findByIdAndUpdate(order._id, {
            $set: { providerIdempotencyKey: `provider:canonical-b2b:${order.orderNumber}` },
        });
        const adapter = makeAdapter();

        await pollProcessingOrders(adapter);
        const fresh = await Order.findById(order._id);

        expect(fresh.retryCount).toBe(5);
        expect(fresh.status).toBe(ORDER_STATUS.PROCESSING);
        expect(fresh.refunded).toBe(false);
        expect(adapter.placeOrder).not.toHaveBeenCalled();
    });

    it('increments unresolved reference retries and moves only Canonical uncertainty to manual review at the retry limit without refunding', async () => {
        const { product } = await makeCanonicalChain();
        const order = await makeOrder(product, {
            providerStatus: 'PLACEMENT_UNCERTAIN',
            providerIdempotencyKey: 'provider:canonical-b2b:pending',
            providerOrderId: null,
            retryCount: MAX_RETRY_COUNT - 1,
        });
        await Order.findByIdAndUpdate(order._id, {
            $set: { providerIdempotencyKey: `provider:canonical-b2b:${order.orderNumber}` },
        });
        const adapter = makeAdapter();

        const stats = await pollProcessingOrders(adapter);
        const fresh = await Order.findById(order._id);

        expect(adapter.placeOrder).not.toHaveBeenCalled();
        expect(adapter.checkOrderByReference).toHaveBeenCalledWith(String(order.orderNumber));
        expect(fresh.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(fresh.refunded).toBe(false);
        expect(stats.manualReview).toBe(1);
    });

    it.each([
        ['inactive', async (provider) => Provider.findByIdAndUpdate(provider._id, { $set: { isActive: false } })],
        ['missing', async (provider) => Provider.findByIdAndDelete(provider._id)],
    ])('moves Canonical reference polling to manual review when its provider is %s', async (_state, changeProvider) => {
        const { provider, product } = await makeCanonicalChain();
        const order = await makeOrder(product, {
            providerStatus: 'PLACEMENT_UNCERTAIN',
            providerOrderId: null,
        });
        await Order.findByIdAndUpdate(order._id, {
            $set: { providerIdempotencyKey: `provider:canonical-b2b:${order.orderNumber}` },
        });
        await changeProvider(provider);
        const adapter = makeAdapter();

        const stats = await pollProcessingOrders(adapter);
        const fresh = await Order.findById(order._id);

        expect(adapter.placeOrder).not.toHaveBeenCalled();
        expect(adapter.checkOrderByReference).not.toHaveBeenCalled();
        expect(fresh.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(fresh.providerStatus).toBe('PLACEMENT_UNCERTAIN');
        expect(fresh.refunded).toBe(false);
        expect(stats.manualReview).toBe(1);
    });

    it('does not opt a non-Canonical provider into the Canonical placement contract', async () => {
        const { product } = await makeCanonicalChain({ provider: { adapterType: null } });
        const order = await makeOrder(product);
        const adapter = makeAdapter({ placeOrder: jest.fn().mockResolvedValue({
            success: true,
            providerOrderId: 'legacy-1',
            providerStatus: 'Pending',
            rawResponse: {},
        }) });

        await executeOrder(order._id, adapter);

        const call = adapter.placeOrder.mock.calls[0][0];
        expect(call.productId).toBe('1000');
        expect(call.referenceId).not.toBe(String(order.orderNumber));
        expect(call.localOrderId).toBe(order._id.toString());
    });

    it.each([
        ['inactive', async (provider) => Provider.findByIdAndUpdate(provider._id, { $set: { isActive: false } })],
        ['missing', async (provider) => Provider.findByIdAndDelete(provider._id)],
    ])('keeps generic non-Canonical provider resolution failure behavior when the provider is %s', async (_state, changeProvider) => {
        const { provider, product } = await makeCanonicalChain({ provider: { adapterType: null } });
        const order = await makeOrder(product);
        await changeProvider(provider);

        const result = await executeOrder(order._id);

        expect(result.order.status).toBe(ORDER_STATUS.FAILED);
        expect(result.order.refunded).toBe(true);
    });
});
