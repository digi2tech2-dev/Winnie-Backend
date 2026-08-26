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
});

afterEach(() => {
    delete process.env.XENA_RECHARGE_ENABLED;
});

describe('Xena provider balance preflight', () => {
    it('allows quantity below live balance and creates a PROCESSING order', async () => {
        const { customer, product, provider } = await createXenaFixture();
        const client = mockLiveBalance(100);
        const adapter = {
            provider,
            placeOrder: jest.fn().mockResolvedValue({
                success: true,
                providerOrderId: 'rch_preflight_pending',
                providerStatus: 'Pending',
            }),
        };

        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 10,
            orderFieldsValues: { target_uid: '001234' },
            provider: adapter,
            idempotencyKey: `xena-preflight-ok-${product._id}`,
        });

        expect(order.status).toBe(ORDER_STATUS.PROCESSING);
        expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'get',
            url: '/v1/connections/test-xena-connection/balance',
        }));
        expect(await Order.countDocuments()).toBe(1);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBeGreaterThan(0);
    });

    it('rejects quantity above live balance before wallet debit or order creation', async () => {
        const { customer, product } = await createXenaFixture();
        mockLiveBalance(9);
        const balanceBefore = (await User.findById(customer._id)).walletBalance;

        await expect(createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 10,
            orderFieldsValues: { target_uid: '001234' },
            idempotencyKey: `xena-preflight-insufficient-${product._id}`,
        })).rejects.toMatchObject({ code: 'XENA_INSUFFICIENT_PROVIDER_BALANCE' });

        expect((await User.findById(customer._id)).walletBalance).toBe(balanceBefore);
        expect(await Order.countDocuments()).toBe(0);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('fails closed when the live balance check is unavailable', async () => {
        const { customer, product } = await createXenaFixture();
        const client = { request: jest.fn().mockRejectedValue({
            code: 'ECONNABORTED',
            message: 'timeout',
        }) };
        axios.create.mockReturnValue(client);
        const balanceBefore = (await User.findById(customer._id)).walletBalance;

        await expect(createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 10,
            orderFieldsValues: { target_uid: '001234' },
            idempotencyKey: `xena-preflight-unavailable-${product._id}`,
        })).rejects.toMatchObject({ code: 'XENA_BALANCE_UNAVAILABLE' });

        expect((await User.findById(customer._id)).walletBalance).toBe(balanceBefore);
        expect(await Order.countDocuments()).toBe(0);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
    });
});
