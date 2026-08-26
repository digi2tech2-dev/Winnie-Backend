'use strict';

jest.mock('axios');

const mongoose = require('mongoose');
const axios = require('axios');
const adminProviderService = require('../modules/admin/admin.providers.service');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product } = require('../modules/products/product.model');
const { XenaConnection } = require('../modules/providers/xena/xenaConnection.model');
const { Order, ORDER_STATUS, ORDER_EXECUTION_TYPES } = require('../modules/orders/order.model');
const { createOrder } = require('../modules/orders/order.service');
const { processOrderStatusResult } = require('../modules/orders/orderFulfillment.service');
const orderFulfillmentService = require('../modules/orders/orderFulfillment.service');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { User } = require('../modules/users/user.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
} = require('./testHelpers');

const TEST_KEY = Buffer.alloc(32, 43).toString('base64');
const adminId = new mongoose.Types.ObjectId();
let executeOrderSpy;

const createXenaFixture = async () => {
    const provider = await adminProviderService.createProvider({
        name: 'Xena Recharge',
        code: 'xena-recharge',
        baseUrl: 'https://api.digiteech.test',
        authType: 'BEARER_TOKEN',
        apiToken: 'test-xena-token',
        isActive: true,
    }, adminId);
    const connection = await XenaConnection.create({
        provider: provider._id,
        status: 'connected',
    });
    connection.setConnectionId('test-xena-connection');
    await connection.save();

    const providerProduct = await ProviderProduct.create({
        provider: provider._id,
        externalProductId: 'xena-dynamic-recharge',
        rawName: 'Xena Dynamic Recharge',
        rawPrice: '1',
        minQty: 1,
        maxQty: 1000000,
        isActive: true,
    });
    const product = await Product.create({
        name: `Xena preflight ${Date.now()}-${Math.random()}`,
        basePrice: '1',
        minQty: 1,
        maxQty: 1000000,
        isActive: true,
        executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
        provider: provider._id,
        providerProduct: providerProduct._id,
        orderFields: [{
            id: 'target_uid',
            key: 'target_uid',
            label: 'Xena ID',
            type: 'text',
            required: true,
            isActive: true,
        }],
    });
    const { customer } = await createCustomerWithGroup({ walletBalance: 1000 }, { percentage: 0 });

    return { customer, product, provider };
};

const mockLiveBalance = (balance) => {
    const client = { request: jest.fn() };
    axios.create.mockReturnValue(client);
    client.request.mockResolvedValueOnce({
        data: { balance },
        status: 200,
        headers: {},
    });
    return client;
};

beforeAll(async () => {
    process.env.PROVIDER_CREDENTIALS_KEY = TEST_KEY;
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    process.env.PROVIDER_CREDENTIALS_KEY = TEST_KEY;
    process.env.XENA_RECHARGE_ENABLED = 'true';
    axios.create.mockReset();
    await clearCollections();
    // createOrder deliberately starts fulfillment after committing. This suite
    // verifies the creation/debit boundary only, so keep that background work
    // mocked and prevent it racing the disposable DB teardown.
    executeOrderSpy = jest.spyOn(orderFulfillmentService, 'executeOrder')
        .mockResolvedValue({ order: null, placed: false, refunded: false });
});

afterEach(() => {
    executeOrderSpy?.mockRestore();
    delete process.env.XENA_RECHARGE_ENABLED;
});

describe('Xena provider balance diagnostics do not block customer order creation', () => {
    const pendingAdapter = (provider) => ({
        provider,
        // createOrder refreshes provider pricing through the adapter before
        // creating its financial transaction. Keep that read local to this
        // test double; balance diagnostics must never reach the real client.
        getProducts: jest.fn().mockResolvedValue([]),
        placeOrder: jest.fn().mockResolvedValue({
            success: true,
            providerOrderId: 'rch_preflight_pending',
            providerStatus: 'Pending',
        }),
    });

    it('creates a PROCESSING order without consulting live Xena balance', async () => {
        const { customer, product, provider } = await createXenaFixture();
        const client = mockLiveBalance(100);
        const adapter = pendingAdapter(provider);

        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 10,
            orderFieldsValues: { target_uid: '001234' },
            provider: adapter,
            idempotencyKey: `xena-preflight-ok-${product._id}`,
        });

        expect(order.status).toBe(ORDER_STATUS.PROCESSING);
        expect(client.request).not.toHaveBeenCalled();
        expect(await Order.countDocuments()).toBe(1);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBeGreaterThan(0);
    });

    it('keeps a successful 200-unit Xena order debited at 800 after confirmed completion', async () => {
        const { customer, product, provider } = await createXenaFixture();

        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 200,
            orderFieldsValues: { target_uid: '001234' },
            provider: pendingAdapter(provider),
            idempotencyKey: `xena-success-debit-${product._id}`,
        });

        expect(order.status).toBe(ORDER_STATUS.PROCESSING);
        expect((await User.findById(customer._id)).walletBalance).toBe(800);
        expect(await WalletTransaction.countDocuments({
            reference: order._id,
            type: 'DEBIT',
            semanticType: 'ORDER_DEBIT',
        })).toBe(1);

        await processOrderStatusResult(order, {
            providerOrderId: 'rch_confirmed_success',
            providerStatus: 'Completed',
        });

        expect((await Order.findById(order._id)).status).toBe(ORDER_STATUS.COMPLETED);
        expect((await User.findById(customer._id)).walletBalance).toBe(800);
        expect(await WalletTransaction.countDocuments({ reference: order._id, type: 'REFUND' })).toBe(0);
    });

    it('creates and debits when the last diagnostic balance would be insufficient', async () => {
        const { customer, product, provider } = await createXenaFixture();
        const client = mockLiveBalance(9);
        const balanceBefore = (await User.findById(customer._id)).walletBalance;

        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 10,
            orderFieldsValues: { target_uid: '001234' },
            provider: pendingAdapter(provider),
            idempotencyKey: `xena-preflight-insufficient-${product._id}`,
        });

        expect(order.status).toBe(ORDER_STATUS.PROCESSING);
        expect((await User.findById(customer._id)).walletBalance).toBeLessThan(balanceBefore);
        expect(await Order.countDocuments()).toBe(1);
        expect(await WalletTransaction.countDocuments({ userId: customer._id, type: 'DEBIT' })).toBe(1);
        expect(client.request).not.toHaveBeenCalled();
    });

    it('creates and debits when live balance diagnostics are unavailable', async () => {
        const { customer, product, provider } = await createXenaFixture();
        const client = { request: jest.fn().mockRejectedValue({
            code: 'ECONNABORTED',
            message: 'timeout',
        }) };
        axios.create.mockReturnValue(client);
        const balanceBefore = (await User.findById(customer._id)).walletBalance;

        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 10,
            orderFieldsValues: { target_uid: '001234' },
            provider: pendingAdapter(provider),
            idempotencyKey: `xena-preflight-unavailable-${product._id}`,
        });

        expect(order.status).toBe(ORDER_STATUS.PROCESSING);
        expect((await User.findById(customer._id)).walletBalance).toBeLessThan(balanceBefore);
        expect(await Order.countDocuments()).toBe(1);
        expect(await WalletTransaction.countDocuments({ userId: customer._id, type: 'DEBIT' })).toBe(1);
        expect(client.request).not.toHaveBeenCalled();
    });
});
