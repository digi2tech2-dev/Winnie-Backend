'use strict';

jest.mock('axios');

const mongoose = require('mongoose');
const axios = require('axios');
const adminProviderService = require('../modules/admin/admin.providers.service');
const productService = require('../modules/products/product.service');
const { getProviderAdapter } = require('../modules/providers/adapters/adapter.factory');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product } = require('../modules/products/product.model');
const { XenaConnection } = require('../modules/providers/xena/xenaConnection.model');
const xenaService = require('../modules/providers/xena/xena.service');
const { Order, ORDER_STATUS, ORDER_EXECUTION_TYPES } = require('../modules/orders/order.model');
const { createOrder } = require('../modules/orders/order.service');
const { executeOrder } = require('../modules/orders/orderFulfillment.service');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { User } = require('../modules/users/user.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
} = require('./testHelpers');

const TEST_KEY = Buffer.alloc(32, 31).toString('base64');
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

const connectXenaProvider = async (provider, connectionId = 'con_recharge') => {
    const state = await XenaConnection.create({
        provider: provider._id,
        status: 'connected',
    });
    state.setConnectionId(connectionId);
    await state.save();
    return state;
};

const createXenaOrder = async ({
    targetUid = '001234',
    quantity = 1000,
    walletDeducted = 50,
    fieldKey = 'target_uid',
} = {}) => {
    const provider = await createXenaProvider();
    await connectXenaProvider(provider, 'con_recharge');
    const { customer, group } = await createCustomerWithGroup({ walletBalance: 1000 }, { percentage: 0 });
    const providerProduct = await ProviderProduct.create({
        provider: provider._id,
        externalProductId: 'xena-dynamic-recharge',
        rawName: 'Xena Dynamic Recharge (Any Amount)',
        rawPrice: '0.00001',
        minQty: 1,
        maxQty: 1000000,
        isActive: true,
        rawPayload: {
            synthetic: true,
            providerCode: 'xena-recharge',
            orderFields: [{ key: 'target_uid', type: 'text', required: true }],
        },
    });
    const product = await Product.create({
        name: `Xena Product ${Date.now()} ${Math.random()}`,
        basePrice: '1',
        minQty: 1,
        maxQty: 1000000,
        isActive: true,
        executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
        provider: provider._id,
        providerProduct: providerProduct._id,
        orderFields: [{
            id: fieldKey,
            key: fieldKey,
            label: fieldKey === 'target_uid' ? 'Xena ID' : 'Account ID',
            type: 'text',
            required: true,
            isActive: true,
        }],
    });
    const order = await Order.create({
        userId: customer._id,
        orderNumber: 990000 + Math.floor(Math.random() * 10000),
        productId: product._id,
        quantity,
        unitPrice: '1',
        totalPrice: String(quantity),
        basePriceSnapshot: '1',
        markupPercentageSnapshot: 0,
        finalPriceCharged: '1',
        groupIdSnapshot: group._id,
        walletDeducted,
        creditUsedAmount: '0',
        status: ORDER_STATUS.PROCESSING,
        executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
        providerCode: 'xena-recharge',
        customerInput: {
            values: { [fieldKey]: targetUid },
            fieldsSnapshot: [{ key: fieldKey, label: fieldKey === 'target_uid' ? 'Xena ID' : 'Account ID', type: 'text' }],
        },
    });
    return { provider, customer, order, product, providerProduct };
};

const queueSuccessfulVerification = (client, uid = '001234') => {
    client.request.mockResolvedValueOnce({
        data: { uid, nickname: 'Safe nickname', country: 'EG' },
        status: 200,
        headers: { 'x-request-id': 'req-verify' },
    });
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
    axios.create.mockReset();
    await clearCollections();
});

describe('Xena recharge normalization helpers', () => {
    it.each([
        [{ id: 'rch_top', status: 'processing' }, 'rch_top'],
        [{ rechargeId: 'rch_alt', status: 'processing' }, 'rch_alt'],
        [{ data: { id: 'rch_data', status: 'processing' } }, 'rch_data'],
        [{ data: { rechargeId: 'rch_data_alt', status: 'processing' } }, 'rch_data_alt'],
    ])('extracts trusted providerOrderId from response shape %#', (payload, expectedId) => {
        expect(xenaService.extractRechargeId(payload)).toBe(expectedId);
    });

    it('does not use requestId, clientReference, or local ids as providerOrderId', () => {
        expect(xenaService.extractRechargeId({
            requestId: 'req_not_order',
            clientReference: 'order:local',
            orderId: 'local-order',
        })).toBeNull();
    });

    it('sanitizes connectionId and auth material from raw responses', () => {
        const sanitized = xenaService.sanitizeXenaPayload({
            id: 'rch_safe',
            connectionId: 'con_secret',
            headers: { Authorization: 'Bearer digiteech-client-key' },
            nested: { apiKey: 'digiteech-client-key', token: 'secret-token' },
        });

        const text = JSON.stringify(sanitized);
        expect(text).not.toContain('con_secret');
        expect(text).not.toContain('digiteech-client-key');
        expect(text).not.toContain('Bearer');
        expect(sanitized.id).toBe('rch_safe');
    });
});

describe('Xena adapter recharge execution', () => {
    it('preserves target_uid as a string and posts the stable Xena recharge body', async () => {
        const { provider, order } = await createXenaOrder({ targetUid: '001234', quantity: 1000 });
        const adapter = getProviderAdapter(provider, { strict: true });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        queueSuccessfulVerification(client, '001234');
        client.request.mockResolvedValueOnce({
            data: { id: 'rch_example', status: 'processing', requestId: 'req-body' },
            status: 200,
            headers: { 'x-request-id': 'req-body-header' },
        });

        const result = await adapter.placeOrder({
            localOrderId: order._id.toString(),
            amount: order.quantity,
            params: { target_uid: '001234' },
        });

        expect(result.success).toBe(true);
        expect(result.providerOrderId).toBe('rch_example');
        expect(result.providerRequestId).toBe('req-body-header');
        expect(result.providerIdempotencyKey).toBe(`provider:xena:${order._id.toString()}`);
        expect(client.request).toHaveBeenLastCalledWith(expect.objectContaining({
            method: 'post',
            url: '/v1/recharges',
            headers: { 'Idempotency-Key': `provider:xena:${order._id.toString()}` },
            data: {
                connectionId: 'con_recharge',
                targetUid: '001234',
                amount: 1000,
                clientReference: `order:${order._id.toString()}`,
            },
        }));
        expect(typeof client.request.mock.calls[1][0].data.targetUid).toBe('string');
    });

    it('invalid or missing target_uid prevents provider POST', async () => {
        const { provider, order } = await createXenaOrder({ targetUid: 'bad-value' });
        const adapter = getProviderAdapter(provider, { strict: true });
        const client = makeClient();
        axios.create.mockReturnValue(client);

        const result = await adapter.placeOrder({
            localOrderId: order._id.toString(),
            amount: order.quantity,
            params: { target_uid: 'bad-value' },
        });

        expect(result.success).toBe(false);
        expect(result.providerErrorCode).toBe('XENA_TARGET_INVALID');
        expect(client.request).not.toHaveBeenCalled();
    });

    it('uses legacy account_id as a Xena-only target_uid alias and preserves leading zeroes', async () => {
        const { provider, order } = await createXenaOrder({ targetUid: '0004454725', fieldKey: 'account_id' });
        const adapter = getProviderAdapter(provider, { strict: true });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        queueSuccessfulVerification(client, '0004454725');
        client.request.mockResolvedValueOnce({
            data: { id: 'rch_legacy', status: 'processing' },
            status: 200,
            headers: {},
        });

        const result = await adapter.placeOrder({
            localOrderId: order._id.toString(),
            amount: order.quantity,
            params: { account_id: '0004454725' },
        });

        expect(result.success).toBe(true);
        expect(result.providerOrderId).toBe('rch_legacy');
        expect(result.rawResponse.legacyTargetField).toBe('account_id');
        expect(client.request).toHaveBeenLastCalledWith(expect.objectContaining({
            method: 'post',
            url: '/v1/recharges',
            data: expect.objectContaining({
                targetUid: '0004454725',
            }),
        }));
        expect(typeof client.request.mock.calls[1][0].data.targetUid).toBe('string');
    });

    it('re-verifies target_uid before recharge and does not treat unavailable verification as invalid', async () => {
        const { provider, order } = await createXenaOrder();
        const adapter = getProviderAdapter(provider, { strict: true });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 20000ms exceeded' });

        const result = await adapter.placeOrder({
            localOrderId: order._id.toString(),
            amount: order.quantity,
            params: { target_uid: '001234' },
        });

        expect(result.manualReview).toBe(true);
        expect(result.providerErrorCode).toBe('XENA_VERIFICATION_UNAVAILABLE');
        expect(client.request).toHaveBeenCalledTimes(1);
    });

    it('uses the same provider idempotency key for the same local order retry', async () => {
        const { provider, order } = await createXenaOrder();
        const adapter = getProviderAdapter(provider, { strict: true });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        queueSuccessfulVerification(client);
        client.request.mockResolvedValueOnce({ data: { id: 'rch_1', status: 'processing' }, status: 200, headers: {} });
        queueSuccessfulVerification(client);
        client.request.mockResolvedValueOnce({ data: { id: 'rch_1', status: 'processing' }, status: 200, headers: {} });

        await adapter.placeOrder({ localOrderId: order._id.toString(), amount: order.quantity, params: { target_uid: '001234' } });
        await adapter.placeOrder({ localOrderId: order._id.toString(), amount: order.quantity, params: { target_uid: '001234' } });

        const rechargeCalls = client.request.mock.calls
            .map(([call]) => call)
            .filter((call) => call.url === '/v1/recharges');
        expect(rechargeCalls).toHaveLength(2);
        expect(rechargeCalls[0].headers['Idempotency-Key']).toBe(`provider:xena:${order._id.toString()}`);
        expect(rechargeCalls[1].headers['Idempotency-Key']).toBe(`provider:xena:${order._id.toString()}`);
    });
});

describe('Xena fulfillment status mapping and refund behavior', () => {
    it('order creation accepts canonical target_uid for a legacy account_id Xena product definition', async () => {
        const { product, customer } = await createXenaOrder({ fieldKey: 'account_id' });
        await Product.findByIdAndUpdate(product._id, { executionType: ORDER_EXECUTION_TYPES.MANUAL });

        const { order } = await createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
            orderFieldsValues: { target_uid: '0001234' },
            idempotencyKey: `xena-canonical-${product._id.toString()}`,
        });

        expect(order.customerInput.values).toEqual({ target_uid: '0001234' });
        expect(order.customerInput.fieldsSnapshot).toHaveLength(1);
        expect(order.customerInput.fieldsSnapshot[0].key).toBe('target_uid');
        expect(order.customerInput.values.account_id).toBeUndefined();
    });

    it('fulfills an already-created legacy account_id Xena order as target_uid', async () => {
        const { order } = await createXenaOrder({ targetUid: '004454725', fieldKey: 'account_id' });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        queueSuccessfulVerification(client, '004454725');
        client.request.mockResolvedValueOnce({
            data: { id: 'rch_existing_legacy', status: 'processing' },
            status: 200,
            headers: {},
        });

        const { order: updated, refunded } = await executeOrder(order._id);

        expect(updated.status).toBe(ORDER_STATUS.PROCESSING);
        expect(updated.providerOrderId).toBe('rch_existing_legacy');
        expect(updated.providerRawResponse.legacyTargetField).toBe('account_id');
        expect(refunded).toBe(false);
        expect(client.request).toHaveBeenLastCalledWith(expect.objectContaining({
            method: 'post',
            url: '/v1/recharges',
            data: expect.objectContaining({
                targetUid: '004454725',
            }),
        }));
    });

    it('succeeded completes the local order and keeps requestId separate from providerOrderId', async () => {
        const { order } = await createXenaOrder();
        const client = makeClient();
        axios.create.mockReturnValue(client);
        queueSuccessfulVerification(client);
        client.request.mockResolvedValueOnce({
            data: { id: 'rch_success', requestId: 'req_success', status: 'succeeded', connectionId: 'con_recharge' },
            status: 200,
            headers: {},
        });

        const { order: updated, refunded } = await executeOrder(order._id);

        expect(updated.status).toBe(ORDER_STATUS.COMPLETED);
        expect(updated.providerOrderId).toBe('rch_success');
        expect(updated.providerRequestId).toBe('req_success');
        expect(updated.providerOrderId).not.toBe('req_success');
        expect(updated.providerIdempotencyKey).toBe(`provider:xena:${order._id.toString()}`);
        expect(updated.providerRawResponse.connectionId).toBe('[REDACTED]');
        expect(refunded).toBe(false);
    });

    it('processing with providerOrderId keeps order PROCESSING and does not refund', async () => {
        const { order, customer } = await createXenaOrder();
        const before = (await User.findById(customer._id)).walletBalance;
        const client = makeClient();
        axios.create.mockReturnValue(client);
        queueSuccessfulVerification(client);
        client.request.mockResolvedValueOnce({ data: { rechargeId: 'rch_pending', status: 'processing' }, status: 200, headers: {} });

        const { order: updated, refunded } = await executeOrder(order._id);

        expect(updated.status).toBe(ORDER_STATUS.PROCESSING);
        expect(updated.providerOrderId).toBe('rch_pending');
        expect(updated.refunded).toBe(false);
        expect(refunded).toBe(false);
        expect((await User.findById(customer._id)).walletBalance).toBe(before);
    });

    it('failed marks FAILED and refunds once only', async () => {
        const { order, customer } = await createXenaOrder({ walletDeducted: 50 });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        queueSuccessfulVerification(client);
        client.request.mockResolvedValueOnce({
            data: { id: 'rch_failed', status: 'failed', errorCode: 'DENIED', errorMessage: 'Rejected' },
            status: 200,
            headers: {},
        });

        await executeOrder(order._id);
        await executeOrder(order._id);

        const updated = await Order.findById(order._id);
        const refunds = await WalletTransaction.find({ userId: customer._id, type: 'REFUND' });
        expect(updated.status).toBe(ORDER_STATUS.FAILED);
        expect(updated.refunded).toBe(true);
        expect(refunds).toHaveLength(1);
    });

    it('unknown, timeout after POST, and missing id move to manual review without refund', async () => {
        for (const scenario of [
            { response: { id: 'rch_unknown', status: 'mystery' }, code: 'XENA_RECHARGE_UNKNOWN' },
            { response: { status: 'processing' }, code: 'XENA_RECHARGE_ID_MISSING' },
            { error: { code: 'ECONNABORTED', message: 'timeout of 20000ms exceeded' }, code: 'XENA_RECHARGE_UNKNOWN' },
        ]) {
            await clearCollections();
            const { order, customer } = await createXenaOrder();
            const before = (await User.findById(customer._id)).walletBalance;
            const client = makeClient();
            axios.create.mockReturnValue(client);
            queueSuccessfulVerification(client);
            if (scenario.error) {
                client.request.mockRejectedValueOnce(scenario.error);
            } else {
                client.request.mockResolvedValueOnce({ data: scenario.response, status: 200, headers: {} });
            }

            const { order: updated, refunded } = await executeOrder(order._id);

            expect(updated.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
            expect(updated.refunded).toBe(false);
            expect(updated.providerErrorCode).toBe(scenario.code);
            expect(refunded).toBe(false);
            expect((await User.findById(customer._id)).walletBalance).toBe(before);
        }
    });

    it('does not place a duplicate recharge when the order already has providerOrderId', async () => {
        const { order } = await createXenaOrder();
        await Order.findByIdAndUpdate(order._id, { providerOrderId: 'rch_existing' });
        const client = makeClient();
        axios.create.mockReturnValue(client);

        const { order: returned, placed } = await executeOrder(order._id);

        expect(returned.providerOrderId).toBe('rch_existing');
        expect(placed).toBe(false);
        expect(client.request).not.toHaveBeenCalled();
    });

    it('refunds once when Xena target validation fails before provider POST', async () => {
        const { order, customer } = await createXenaOrder({ targetUid: 'bad-value', walletDeducted: 50 });
        const client = makeClient();
        axios.create.mockReturnValue(client);

        await executeOrder(order._id);
        await executeOrder(order._id);

        const updated = await Order.findById(order._id);
        const refunds = await WalletTransaction.find({ userId: customer._id, type: 'REFUND' });
        expect(updated.status).toBe(ORDER_STATUS.FAILED);
        expect(updated.refunded).toBe(true);
        expect(updated.providerOrderId).toBeNull();
        expect(updated.providerRequestId).toBeNull();
        expect(updated.providerErrorCode).toBe('XENA_TARGET_INVALID');
        expect(refunds).toHaveLength(1);
        expect(client.request).not.toHaveBeenCalled();
    });

    it('product update persists target_uid order and dynamic fields for Xena products', async () => {
        const { product } = await createXenaOrder({ fieldKey: 'account_id' });
        await Product.findByIdAndUpdate(product._id, {
            dynamicFields: [{
                name: 'account_id',
                label: 'Account ID',
                type: 'text',
                required: true,
                isActive: true,
            }],
        });

        const updated = await productService.updateProduct(product._id, {
            orderFields: [{
                id: 'target_uid',
                key: 'target_uid',
                label: 'Xena ID',
                type: 'text',
                required: true,
                isActive: true,
            }],
            dynamicFields: [{
                name: 'target_uid',
                label: 'Xena ID',
                type: 'text',
                required: true,
                isActive: true,
            }],
        });

        expect(updated.orderFields).toHaveLength(1);
        expect(updated.orderFields[0].key).toBe('target_uid');
        expect(updated.dynamicFields).toHaveLength(1);
        expect(updated.dynamicFields[0].name).toBe('target_uid');

        const detail = await productService.getProductById(product._id);
        expect(detail.orderFields).toHaveLength(1);
        expect(detail.orderFields[0].key).toBe('target_uid');
        expect(detail.dynamicFields).toHaveLength(1);
        expect(detail.dynamicFields[0].name).toBe('target_uid');
    });

    it('does not canonicalize non-Xena account_id product fields', async () => {
        const product = await Product.create({
            name: `Manual Account Product ${Date.now()} ${Math.random()}`,
            basePrice: '1',
            minQty: 1,
            maxQty: 1000,
            isActive: true,
            executionType: ORDER_EXECUTION_TYPES.MANUAL,
            orderFields: [{
                id: 'account_id',
                key: 'account_id',
                label: 'Account ID',
                type: 'text',
                required: true,
                isActive: true,
            }],
            dynamicFields: [{
                name: 'account_id',
                label: 'Account ID',
                type: 'text',
                required: true,
                isActive: true,
            }],
        });

        const updated = await productService.updateProduct(product._id, {
            orderFields: [{
                id: 'account_id',
                key: 'account_id',
                label: 'Account ID',
                type: 'text',
                required: true,
                isActive: true,
            }],
            dynamicFields: [{
                name: 'account_id',
                label: 'Account ID',
                type: 'text',
                required: true,
                isActive: true,
            }],
        });

        expect(updated.orderFields[0].key).toBe('account_id');
        expect(updated.dynamicFields[0].name).toBe('account_id');
    });
});
