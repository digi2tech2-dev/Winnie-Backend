'use strict';

const jwt = require('jsonwebtoken');
const app = require('../app');
const config = require('../config/config');
const { Order, ORDER_STATUS } = require('../modules/orders/order.model');
const { WalletTransaction, TRANSACTION_TYPES, TRANSACTION_DIRECTIONS, TRANSACTION_STATUS } = require('../modules/wallet/walletTransaction.model');
const { DepositRequest, DEPOSIT_STATUS } = require('../modules/deposits/deposit.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createAdmin,
    createCustomer,
    createCustomerWithGroup,
    createProduct,
} = require('./testHelpers');

let server;
let baseUrl;
let orderNumber;

beforeAll(async () => {
    await connectTestDB();
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}/api`;
});

afterAll(async () => {
    await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
    orderNumber = 10000;
});

const tokenFor = (user) => jwt.sign({ id: user._id, role: user.role }, config.jwt.secret, { expiresIn: '1h' });

const getSummary = async (token, query = 'from=2026-07-01&to=2026-07-10') => {
    const response = await fetch(`${baseUrl}/admin/dashboard/summary?${query}`, {
        headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.json();
    return { body, response };
};

const setTimestamps = async (model, id, value) => {
    const date = new Date(value);
    await model.collection.updateOne({ _id: id }, { $set: { createdAt: date, updatedAt: date } });
};

const createOrderAt = async ({ customer, group, product, status, at, total = '120', profit = '40' }) => {
    const order = await Order.create({
        userId: customer._id,
        orderNumber: orderNumber++,
        productId: product._id,
        quantity: 1,
        unitPrice: total,
        totalPrice: total,
        basePriceSnapshot: String(Number(total) - Number(profit)),
        markupPercentageSnapshot: 0,
        finalPriceCharged: total,
        groupIdSnapshot: group._id,
        profitUsd: profit,
        usdAmount: total,
        walletDeducted: Number(total),
        status,
        idempotencyKey: `dashboard-test-${orderNumber}`,
    });
    await setTimestamps(Order, order._id, at);
    return order;
};

const createWalletTransactionAt = async ({ customer, amount = 25, at }) => {
    const transaction = await WalletTransaction.create({
        userId: customer._id,
        type: TRANSACTION_TYPES.CREDIT,
        direction: TRANSACTION_DIRECTIONS.CREDIT,
        amount,
        balanceBefore: 0,
        balanceAfter: amount,
        currency: 'USD',
        status: TRANSACTION_STATUS.COMPLETED,
        description: 'Dashboard test transaction',
    });
    await setTimestamps(WalletTransaction, transaction._id, at);
    return transaction;
};

const createPendingDepositAt = async ({ customer, at }) => {
    const deposit = await DepositRequest.create({
        userId: customer._id,
        paymentMethodId: 'manual-bank',
        requestedAmount: 100,
        currency: 'USD',
        exchangeRate: 1,
        amountUsd: 100,
        receiptImage: 'uploads/deposits/test.png',
        status: DEPOSIT_STATUS.PENDING,
    });
    await setTimestamps(DepositRequest, deposit._id, at);
    return deposit;
};

describe('GET /api/admin/dashboard/summary', () => {
    it('rejects non-admin users', async () => {
        const { customer } = await createCustomerWithGroup();

        const { response } = await getSummary(tokenFor(customer));

        expect(response.status).toBe(403);
    });

    it('allows admin users and returns empty database zeros without mock values', async () => {
        const admin = await createAdmin();

        const { body, response } = await getSummary(tokenFor(admin));

        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(body.data.range).toEqual({ from: '2026-07-01', to: '2026-07-10' });
        expect(body.data.cards.totalRevenueUsd.value).toBe(0);
        expect(body.data.cards.netProfitUsd.value).toBe(0);
        expect(body.data.cards.completedOrders.value).toBe(0);
        expect(body.data.cards.followUpOrders.value).toBe(0);
        expect(body.data.cards.activeUsers.value).toBe(0);
        expect(body.data.cards.walletMovementUsd.value).toBe(0);
        expect(body.data.cards.pendingManualOperations.value).toBe(0);
    });

    it('counts completed orders in range and excludes orders outside range', async () => {
        const admin = await createAdmin();
        const { customer, group } = await createCustomerWithGroup();
        const product = await createProduct();

        await createOrderAt({ customer, group, product, status: ORDER_STATUS.COMPLETED, at: '2026-07-02T12:00:00Z', total: '120', profit: '40' });
        await createOrderAt({ customer, group, product, status: ORDER_STATUS.COMPLETED, at: '2026-07-09T12:00:00Z', total: '80', profit: '20' });
        await createOrderAt({ customer, group, product, status: ORDER_STATUS.COMPLETED, at: '2026-06-30T12:00:00Z', total: '100', profit: '30' });

        const { body, response } = await getSummary(tokenFor(admin));

        expect(response.status).toBe(200);
        expect(body.data.cards.completedOrders.value).toBe(2);
        expect(body.data.cards.totalRevenueUsd.value).toBe(200);
        expect(body.data.cards.netProfitUsd.value).toBe(60);
    });

    it('counts follow-up orders by pending workflow statuses', async () => {
        const admin = await createAdmin();
        const { customer, group } = await createCustomerWithGroup();
        const product = await createProduct();

        await createOrderAt({ customer, group, product, status: ORDER_STATUS.PENDING, at: '2026-07-02T12:00:00Z' });
        await createOrderAt({ customer, group, product, status: ORDER_STATUS.PROCESSING, at: '2026-07-03T12:00:00Z' });
        await createOrderAt({ customer, group, product, status: ORDER_STATUS.MANUAL_REVIEW, at: '2026-07-04T12:00:00Z' });
        await createOrderAt({ customer, group, product, status: ORDER_STATUS.CANCELED, at: '2026-07-05T12:00:00Z' });

        const { body } = await getSummary(tokenFor(admin));

        expect(body.data.cards.followUpOrders.value).toBe(3);
    });

    it('counts wallet movement and pending manual deposits in range', async () => {
        const admin = await createAdmin();
        const { customer } = await createCustomerWithGroup();

        await createWalletTransactionAt({ customer, amount: 35, at: '2026-07-02T12:00:00Z' });
        await createWalletTransactionAt({ customer, amount: 15, at: '2026-07-09T12:00:00Z' });
        await createWalletTransactionAt({ customer, amount: 99, at: '2026-06-29T12:00:00Z' });
        await createPendingDepositAt({ customer, at: '2026-07-03T12:00:00Z' });

        const { body } = await getSummary(tokenFor(admin));

        expect(body.data.cards.walletMovementUsd.value).toBe(50);
        expect(body.data.cards.pendingManualOperations.value).toBe(1);
        expect(body.data.cards.activeUsers.value).toBe(1);
    });

    it('returns previous-period comparison percentages', async () => {
        const admin = await createAdmin();
        const { customer, group } = await createCustomerWithGroup();
        const product = await createProduct();

        await createOrderAt({ customer, group, product, status: ORDER_STATUS.COMPLETED, at: '2026-06-25T12:00:00Z', total: '100', profit: '20' });
        await createOrderAt({ customer, group, product, status: ORDER_STATUS.COMPLETED, at: '2026-07-02T12:00:00Z', total: '150', profit: '30' });
        await createOrderAt({ customer, group, product, status: ORDER_STATUS.COMPLETED, at: '2026-07-03T12:00:00Z', total: '50', profit: '10' });

        const { body } = await getSummary(tokenFor(admin));

        expect(body.data.cards.completedOrders.changePercent).toBe(100);
        expect(body.data.cards.totalRevenueUsd.changePercent).toBe(100);
    });

    it('validates date ranges', async () => {
        const admin = await createAdmin();

        const { body, response } = await getSummary(tokenFor(admin), 'from=2026-07-10&to=2026-07-01');

        expect(response.status).toBe(400);
        expect(body.code).toBe('VALIDATION_ERROR');
    });
});
