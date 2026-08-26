'use strict';

jest.mock('axios');

const mongoose = require('mongoose');
const axios = require('axios');
const adminProviderService = require('../modules/admin/admin.providers.service');
const { getProviderAdapter } = require('../modules/providers/adapters/adapter.factory');
const xenaService = require('../modules/providers/xena/xena.service');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product } = require('../modules/products/product.model');
const { Order, ORDER_STATUS, ORDER_EXECUTION_TYPES, MAX_RETRY_COUNT } = require('../modules/orders/order.model');
const { pollProcessingOrders } = require('../modules/orders/orderFulfillment.service');
const { retryOrder, syncOrderProviderStatus } = require('../modules/admin/admin.orders.service');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { User } = require('../modules/users/user.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
} = require('./testHelpers');

const TEST_KEY = Buffer.alloc(32, 37).toString('base64');
const adminId = new mongoose.Types.ObjectId();

const makeClient = () => ({ request: jest.fn() });

const createXenaProvider = (overrides = {}) => (
    adminProviderService.createProvider({
        name: 'Xena Recharge',
        code: 'xena-recharge',
        baseUrl: 'https://api.digiteech.me',
        authType: 'BEARER_TOKEN',
        apiToken: 'digiteech-client-key',
        isActive: true,
        ...overrides,
    }, adminId)
);

const createXenaProcessingOrder = async ({
    providerOrderId = 'rch_poll',
    walletDeducted = 50,
    retryCount = 0,
    status = ORDER_STATUS.PROCESSING,
    providerRawResponse = null,
} = {}) => {
    const provider = await createXenaProvider();
    const { customer, group } = await createCustomerWithGroup({ walletBalance: 1000 }, { percentage: 0 });
    const providerProduct = await ProviderProduct.create({
        provider: provider._id,
        externalProductId: 'xena-dynamic-recharge',
        rawName: 'Xena Dynamic Recharge (Any Amount)',
        rawPrice: '0.00001',
        minQty: 1,
        maxQty: 1000000,
        isActive: true,
    });
    const product = await Product.create({
        name: `Xena Poll Product ${Date.now()} ${Math.random()}`,
        basePrice: '1',
        minQty: 1,
        maxQty: 1000000,
        isActive: true,
        executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
        provider: provider._id,
        providerProduct: providerProduct._id,
    });
    const order = await Order.create({
        userId: customer._id,
        orderNumber: 970000 + Math.floor(Math.random() * 10000),
        productId: product._id,
        quantity: 1000,
        unitPrice: '1',
        totalPrice: '1000',
        basePriceSnapshot: '1',
        markupPercentageSnapshot: 0,
        finalPriceCharged: '1',
        groupIdSnapshot: group._id,
        walletDeducted,
        creditUsedAmount: '0',
        status,
        executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
        providerCode: 'xena-recharge',
        providerOrderId,
        providerRequestId: 'req_should_not_be_used',
        providerRawResponse,
        retryCount,
    });
    return { provider, customer, order };
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

describe('Xena polling providerOrderId and normalization', () => {
    it('checkOrder uses providerOrderId only and never providerRequestId/clientReference', async () => {
        const provider = await createXenaProvider();
        const adapter = getProviderAdapter(provider, { strict: true });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            data: {
                id: 'rch_trusted',
                requestId: 'req_not_order',
                clientReference: 'order:local-id',
                status: 'processing',
            },
            status: 200,
            headers: {},
        });

        const result = await adapter.checkOrder('rch_trusted');

        expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'get',
            url: '/v1/recharges/rch_trusted',
        }));
        expect(result.providerOrderId).toBe('rch_trusted');
        expect(result.providerOrderId).not.toBe('req_not_order');
        expect(result.providerOrderId).not.toBe('order:local-id');
    });

    it.each([
        [{ id: 'rch_top', status: 'succeeded' }, 'rch_top'],
        [{ rechargeId: 'rch_alt', status: 'succeeded' }, 'rch_alt'],
        [{ data: { id: 'rch_data', status: 'succeeded' } }, 'rch_data'],
        [{ data: { rechargeId: 'rch_data_alt', status: 'succeeded' } }, 'rch_data_alt'],
    ])('shared extractor accepts response shape %#', (payload, expected) => {
        expect(xenaService.extractRechargeId(payload)).toBe(expected);
    });

    it('requestId is never extracted as providerOrderId', () => {
        expect(xenaService.extractRechargeId({
            requestId: 'req_only',
            data: { requestId: 'req_nested' },
            clientReference: 'order:123',
        })).toBeNull();
    });
});

describe('Xena active polling behavior', () => {
    it('missing providerOrderId moves to MANUAL_REVIEW without Xena API call or refund', async () => {
        const { order, customer } = await createXenaProcessingOrder({ providerOrderId: null });
        const before = (await User.findById(customer._id)).walletBalance;
        const client = makeClient();
        axios.create.mockReturnValue(client);

        const stats = await pollProcessingOrders();
        const updated = await Order.findById(order._id);

        expect(stats.manualReview).toBe(1);
        expect(updated.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(updated.providerErrorCode).toBe('XENA_RECHARGE_ID_MISSING');
        expect(updated.refunded).toBe(false);
        expect(client.request).not.toHaveBeenCalled();
        expect((await User.findById(customer._id)).walletBalance).toBe(before);
    });

    it('Xena disabled moves status polling to MANUAL_REVIEW without calling Xena', async () => {
        process.env.XENA_RECHARGE_ENABLED = 'false';
        const { order, customer } = await createXenaProcessingOrder({ providerOrderId: 'rch_disabled' });
        const before = (await User.findById(customer._id)).walletBalance;
        const client = makeClient();
        axios.create.mockReturnValue(client);

        const stats = await pollProcessingOrders();
        const updated = await Order.findById(order._id);

        expect(stats.manualReview).toBe(1);
        expect(updated.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(updated.providerErrorCode).toBe('XENA_RECHARGE_DISABLED');
        expect(updated.refunded).toBe(false);
        expect(client.request).not.toHaveBeenCalled();
        expect((await User.findById(customer._id)).walletBalance).toBe(before);
    });

    it('GET recharge succeeded completes once and stores requestId separately', async () => {
        const { order, customer } = await createXenaProcessingOrder({ providerOrderId: 'rch_success' });
        const before = (await User.findById(customer._id)).walletBalance;
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            data: {
                id: 'rch_success',
                status: 'succeeded',
                requestId: 'req_status',
                connectionId: 'con_secret',
            },
            status: 200,
            headers: {},
        });

        const first = await pollProcessingOrders();
        const second = await pollProcessingOrders();
        const updated = await Order.findById(order._id);

        expect(first.completed).toBe(1);
        expect(second.checked).toBe(0);
        expect(updated.status).toBe(ORDER_STATUS.COMPLETED);
        expect(updated.providerOrderId).toBe('rch_success');
        expect(updated.providerRequestId).toBe('req_status');
        expect(updated.providerOrderId).not.toBe('req_status');
        expect(updated.providerRawResponse.connectionId).toBe('[REDACTED]');
        expect((await User.findById(customer._id)).walletBalance).toBe(before);
        expect(client.request).toHaveBeenCalledTimes(1);
    });

    it('GET recharge processing remains PROCESSING and does not refund', async () => {
        const { order, customer } = await createXenaProcessingOrder({ providerOrderId: 'rch_processing' });
        const before = (await User.findById(customer._id)).walletBalance;
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            data: { rechargeId: 'rch_processing', status: 'processing' },
            status: 200,
            headers: {},
        });

        const stats = await pollProcessingOrders();
        const updated = await Order.findById(order._id);

        expect(stats.pending).toBe(1);
        expect(updated.status).toBe(ORDER_STATUS.PROCESSING);
        expect(updated.providerStatus).toBe('Pending');
        expect(updated.retryCount).toBe(1);
        expect(updated.refunded).toBe(false);
        expect((await User.findById(customer._id)).walletBalance).toBe(before);
    });

    it('GET recharge failed marks FAILED and refunds once only', async () => {
        const { order, customer } = await createXenaProcessingOrder({ providerOrderId: 'rch_failed', walletDeducted: 50 });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            data: { id: 'rch_failed', status: 'failed', errorCode: 'DENIED', errorMessage: 'Rejected' },
            status: 200,
            headers: {},
        });

        await pollProcessingOrders();
        await pollProcessingOrders();

        const updated = await Order.findById(order._id);
        const refunds = await WalletTransaction.find({ userId: customer._id, type: 'REFUND' });
        expect(updated.status).toBe(ORDER_STATUS.FAILED);
        expect(updated.refunded).toBe(true);
        expect(updated.providerErrorCode).toBe('DENIED');
        expect(refunds).toHaveLength(1);
    });

    it('polling explicit provider insufficient balance marks FAILED and refunds exactly once', async () => {
        const { order, customer } = await createXenaProcessingOrder({ providerOrderId: 'rch_insufficient', walletDeducted: 50 });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            data: {
                id: 'rch_insufficient',
                status: 'failed',
                errorCode: 'INSUFFICIENT_BALANCE',
                errorMessage: 'Insufficient provider balance',
            },
            status: 200,
            headers: {},
        });

        await pollProcessingOrders();
        await pollProcessingOrders();

        const updated = await Order.findById(order._id);
        const refunds = await WalletTransaction.find({ userId: customer._id, type: 'REFUND' });
        expect(updated.status).toBe(ORDER_STATUS.FAILED);
        expect(updated.providerErrorCode).toBe('XENA_INSUFFICIENT_PROVIDER_BALANCE');
        expect(updated.refunded).toBe(true);
        expect(refunds).toHaveLength(1);
    });

    it('admin provider sync treats authoritative Xena Failed as terminal and refunds once', async () => {
        const { order, customer } = await createXenaProcessingOrder({ providerOrderId: 'rch_admin_failed', walletDeducted: 50 });
        const walletBeforeDebit = (await User.findById(customer._id)).walletBalance;
        await User.findByIdAndUpdate(customer._id, { $inc: { walletBalance: -50 } });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            data: { id: 'rch_admin_failed', status: 'failed', errorCode: 'DENIED', errorMessage: 'Rejected' },
            status: 200,
            headers: {},
        });

        await syncOrderProviderStatus(order._id, adminId);

        const updated = await Order.findById(order._id);
        const refunds = await WalletTransaction.find({ reference: order._id, type: 'REFUND' });
        expect(updated.status).toBe(ORDER_STATUS.FAILED);
        expect(updated.refunded).toBe(true);
        expect(refunds).toHaveLength(1);
        expect(refunds[0].semanticType).toBe('ORDER_REFUND');
        expect((await User.findById(customer._id)).walletBalance).toBe(walletBeforeDebit);
    });

    it('admin retry rejects an order that has already been refunded', async () => {
        const { order } = await createXenaProcessingOrder({ status: ORDER_STATUS.FAILED, walletDeducted: 50 });
        order.refunded = true;
        order.refundedAt = new Date();
        await order.save();

        await expect(retryOrder(order._id, adminId)).rejects.toMatchObject({
            code: 'REFUNDED_ORDER_NOT_RETRYABLE',
        });

        const unchanged = await Order.findById(order._id);
        expect(unchanged.status).toBe(ORDER_STATUS.FAILED);
        expect(unchanged.providerOrderId).toBe('rch_poll');
    });

    it.each([
        ['unknown status', { data: { id: 'rch_unknown', status: 'strange' }, status: 200, headers: {} }, 'XENA_RECHARGE_UNKNOWN'],
        ['404 not found', { reject: { response: { status: 404, data: { message: 'not found' }, headers: {} }, message: 'not found' } }, 'XENA_RECHARGE_NOT_FOUND'],
        ['malformed response', { data: 'not-json-object', status: 200, headers: {} }, 'XENA_MALFORMED_RESPONSE'],
    ])('%s moves to MANUAL_REVIEW without refund', async (_label, upstream, expectedCode) => {
        const { order, customer } = await createXenaProcessingOrder({ providerOrderId: _label === 'unknown status' ? 'rch_unknown' : 'rch_review' });
        const before = (await User.findById(customer._id)).walletBalance;
        const client = makeClient();
        axios.create.mockReturnValue(client);
        if (upstream.reject) {
            client.request.mockRejectedValueOnce(upstream.reject);
        } else {
            client.request.mockResolvedValueOnce(upstream);
        }

        await pollProcessingOrders();
        const updated = await Order.findById(order._id);

        expect(updated.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(updated.providerErrorCode).toBe(expectedCode);
        expect(updated.refunded).toBe(false);
        expect((await User.findById(customer._id)).walletBalance).toBe(before);
    });

    it.each([
        ['rate limited', { response: { status: 429, data: { code: 'RATE_LIMITED' }, headers: {} }, message: 'rate limited' }, 'XENA_RATE_LIMITED'],
        ['timeout', { code: 'ECONNABORTED', message: 'timeout of 20000ms exceeded' }, 'XENA_STATUS_UNAVAILABLE'],
        ['server error', { response: { status: 500, data: { message: 'temporary' }, headers: {} }, message: 'server error' }, 'XENA_STATUS_UNAVAILABLE'],
    ])('%s keeps PROCESSING below retry limit and does not refund or POST', async (_label, error, expectedCode) => {
        const { order, customer } = await createXenaProcessingOrder({ providerOrderId: 'rch_retryable' });
        const before = (await User.findById(customer._id)).walletBalance;
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockRejectedValueOnce(error);

        await pollProcessingOrders();
        const updated = await Order.findById(order._id);

        expect(updated.status).toBe(ORDER_STATUS.PROCESSING);
        expect(updated.providerErrorCode).toBe(expectedCode);
        expect(updated.refunded).toBe(false);
        expect((await User.findById(customer._id)).walletBalance).toBe(before);
        expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'get',
            url: '/v1/recharges/rch_retryable',
        }));
        expect(client.request).not.toHaveBeenCalledWith(expect.objectContaining({
            method: 'post',
            url: '/v1/recharges',
        }));
    });

    it('retryable Xena status errors move to MANUAL_REVIEW at retry limit without refund', async () => {
        const { order, customer } = await createXenaProcessingOrder({
            providerOrderId: 'rch_retry_limit',
            retryCount: MAX_RETRY_COUNT - 1,
        });
        const before = (await User.findById(customer._id)).walletBalance;
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 20000ms exceeded' });

        await pollProcessingOrders();
        const updated = await Order.findById(order._id);

        expect(updated.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(updated.providerErrorCode).toBe('XENA_STATUS_UNAVAILABLE');
        expect(updated.refunded).toBe(false);
        expect((await User.findById(customer._id)).walletBalance).toBe(before);
    });

    it('terminal orders are ignored by polling', async () => {
        await createXenaProcessingOrder({
            providerOrderId: 'rch_terminal',
            status: ORDER_STATUS.COMPLETED,
        });
        const client = makeClient();
        axios.create.mockReturnValue(client);

        const stats = await pollProcessingOrders();

        expect(stats.checked).toBe(0);
        expect(client.request).not.toHaveBeenCalled();
    });

    it('sanitized raw response excludes connectionId, API key, auth headers, and secrets', async () => {
        const { order } = await createXenaProcessingOrder({ providerOrderId: 'rch_sanitize' });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            data: {
                id: 'rch_sanitize',
                status: 'processing',
                connectionId: 'con_secret',
                headers: { Authorization: 'Bearer digiteech-client-key' },
                nested: { apiKey: 'digiteech-client-key', token: 'secret-token' },
            },
            status: 200,
            headers: {},
        });

        await pollProcessingOrders();
        const updated = await Order.findById(order._id);
        const text = JSON.stringify(updated.providerRawResponse);

        expect(text).not.toContain('con_secret');
        expect(text).not.toContain('digiteech-client-key');
        expect(text).not.toContain('Bearer');
        expect(text).not.toContain('secret-token');
    });
});
