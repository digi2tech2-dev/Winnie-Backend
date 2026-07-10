'use strict';

const { createOrder } = require('../modules/orders/order.service');
const { Order, ORDER_STATUS, ORDER_EXECUTION_TYPES } = require('../modules/orders/order.model');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
    createProduct,
} = require('./testHelpers');

const waitFor = async (assertion, timeoutMs = 1500) => {
    const startedAt = Date.now();
    let lastError;

    while (Date.now() - startedAt < timeoutMs) {
        try {
            await assertion();
            return;
        } catch (err) {
            lastError = err;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }

    throw lastError;
};

const makeProviderAdapter = (result) => ({
    getProducts: jest.fn().mockResolvedValue([]),
    placeOrder: jest.fn().mockResolvedValue(result),
});

const setupAlkasrProduct = async (overrides = {}) => {
    const provider = await Provider.create({
        name: `Alkasr VIP ${Date.now()} ${Math.random().toString(36).slice(2)}`,
        slug: `alkasr-vip-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        baseUrl: 'https://api.alkasr-vip.com',
        apiToken: 'test-token',
        isActive: true,
    });

    const providerProduct = await ProviderProduct.create({
        provider: provider._id,
        externalProductId: '7097',
        rawName: 'SoulStar',
        rawPrice: '0.00010780225539945481',
        minQty: 10000,
        maxQty: 5000000,
        isActive: true,
    });

    const product = await createProduct({
        name: `SoulStar-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
        provider: provider._id,
        providerProduct: providerProduct._id,
        basePrice: '0.01',
        minQty: 10000,
        maxQty: 5000000,
        orderFields: [{
            id: 'account_id',
            key: 'account_id',
            label: 'Account ID',
            type: 'text',
            required: true,
            isActive: true,
        }],
        ...overrides,
    });

    return { provider, providerProduct, product };
};

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    jest.clearAllMocks();
    await clearCollections();
});

describe('Alkasr automatic order dispatch', () => {
    it('dispatches automatic linked products with external id, playerId, quantity, and stable order UUID', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 10000 }, { percentage: 0 });
        const { product, providerProduct } = await setupAlkasrProduct();
        const adapter = makeProviderAdapter({
            success: true,
            providerOrderId: 'ID_TEST',
            providerStatus: 'Pending',
            rawResponse: { status: 'OK', data: { order_id: 'ID_TEST', status: 'wait' } },
            errorMessage: null,
        });

        const idempotencyKey = 'stable-order-key-001';
        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 10000,
            idempotencyKey,
            customerInput: {
                values: { account_id: '64632491' },
                fieldsSnapshot: [],
            },
            provider: adapter,
        });

        await waitFor(() => expect(adapter.placeOrder).toHaveBeenCalledTimes(1));
        const call = adapter.placeOrder.mock.calls[0][0];

        expect(call.productId).toBe('7097');
        expect(call.externalProductId).toBe('7097');
        expect(call.productId).not.toBe(providerProduct._id.toString());
        expect(call.amount).toBe(10000);
        expect(call.quantity).toBe(10000);
        expect(call.playerId).toBe('64632491');
        expect(call.params.playerId).toBe('64632491');
        expect(call.orderUuid).toBe(idempotencyKey);
        expect(call.order_uuid).toBe(idempotencyKey);
        expect(call.referenceId).toBe(idempotencyKey);

        const fresh = await Order.findById(order._id);
        expect(fresh.providerOrderId).toBe('ID_TEST');
        expect(fresh.providerStatus).toBe('Pending');
        expect(fresh.providerRawResponse).toMatchObject({ status: 'OK' });
        expect(fresh.status).toBe(ORDER_STATUS.PROCESSING);
    });

    it('persists provider failures visibly instead of leaving provider fields null', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 10000 }, { percentage: 0 });
        const { product } = await setupAlkasrProduct();
        const adapter = makeProviderAdapter({
            success: false,
            providerOrderId: null,
            providerStatus: 'Cancelled',
            rawResponse: { code: 109, message: 'Product not available now' },
            errorMessage: 'Product not available now',
        });

        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 10000,
            customerInput: {
                values: { account_id: '64632491' },
                fieldsSnapshot: [],
            },
            provider: adapter,
        });

        await waitFor(async () => {
            const fresh = await Order.findById(order._id);
            expect(fresh.status).toBe(ORDER_STATUS.FAILED);
        });

        const fresh = await Order.findById(order._id);
        expect(fresh.providerRawResponse).toMatchObject({ code: 109 });
        expect(fresh.providerStatus).toBe('Cancelled');
        expect(fresh.rejectionReason).toBe('Product not available now');
        expect(fresh.failedAt).toBeTruthy();
    });

    it('does not dispatch manual products', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 1000 }, { percentage: 0 });
        const manualProduct = await createProduct({
            executionType: ORDER_EXECUTION_TYPES.MANUAL,
            basePrice: '10',
        });
        const adapter = makeProviderAdapter({
            success: true,
            providerOrderId: 'SHOULD_NOT_CALL',
            providerStatus: 'Pending',
            rawResponse: {},
            errorMessage: null,
        });

        const { order } = await createOrder({
            userId: customer._id,
            productId: manualProduct._id,
            quantity: 1,
            provider: adapter,
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(order.status).toBe(ORDER_STATUS.PENDING);
        expect(adapter.placeOrder).not.toHaveBeenCalled();
    });
});
