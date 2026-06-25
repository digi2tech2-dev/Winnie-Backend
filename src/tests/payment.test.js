'use strict';

const paymentService = require('../modules/payments/payment.service');
const { Payment } = require('../modules/payments/payment.model');
const {
    PAYMENT_GATEWAYS,
    PAYMENT_STATUSES,
} = require('../modules/payments/payment.constants');
const { getPaymentGateway } = require('../modules/payments/gateways/gateway.factory');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { User } = require('../modules/users/user.model');

const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
    createAdmin,
} = require('./testHelpers');

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.PAYMENT_ALLOWED_GATEWAYS;
    delete process.env.PAYMENTS_ENABLED;
    delete process.env.PAYMENT_MIN_AMOUNT;
    delete process.env.PAYMENT_MAX_AMOUNT;
    await clearCollections();
});
afterEach(() => {
    process.env.NODE_ENV = 'test';
});

const createMockPayment = async (customer, overrides = {}) => {
    const result = await paymentService.createPaymentIntent({
        userId: customer._id,
        amount: 50,
        currency: 'USD',
        gateway: PAYMENT_GATEWAYS.MOCK,
        returnUrl: 'http://localhost:5173/customer/wallet/transactions',
        cancelUrl: 'http://localhost:5173/customer/wallet',
        ...overrides,
    });

    return result.payment;
};

describe('Payments base module', () => {
    it('creates a mock wallet top-up payment intent without crediting the wallet', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD' });

        const result = await paymentService.createPaymentIntent({
            userId: customer._id,
            amount: 100,
            currency: 'USD',
            gateway: PAYMENT_GATEWAYS.MOCK,
            returnUrl: 'http://localhost:5173/customer/wallet/transactions',
            cancelUrl: 'http://localhost:5173/customer/wallet',
        });

        expect(result.payment.status).toBe(PAYMENT_STATUSES.REQUIRES_ACTION);
        expect(result.payment.amount).toBe(100);
        expect(result.payment.totalAmount).toBe(100);
        expect(result.payment.feeAmount).toBe(0);
        expect(result.payment.gateway).toBe(PAYMENT_GATEWAYS.MOCK);
        expect(result.payment.purpose).toBe('WALLET_TOPUP');
        expect(result.checkout.mode).toBe('mock');
        expect(result.checkout.url).toContain(result.payment._id.toString());

        const freshUser = await User.findById(customer._id);
        expect(freshUser.walletBalance).toBe(100);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('rejects invalid payment amounts', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD' });

        await expect(paymentService.createPaymentIntent({
            userId: customer._id,
            amount: 0,
            currency: 'USD',
            gateway: PAYMENT_GATEWAYS.MOCK,
        })).rejects.toMatchObject({ code: 'INVALID_PAYMENT_AMOUNT' });
    });

    it('lets a customer view their own payment', async () => {
        const { customer } = await createCustomerWithGroup({ currency: 'USD' });
        const payment = await createMockPayment(customer);

        const found = await paymentService.getPaymentById(payment._id, { actor: customer });
        expect(found._id.toString()).toBe(payment._id.toString());
    });

    it('blocks a customer from viewing another customer payment', async () => {
        const { customer } = await createCustomerWithGroup({ currency: 'USD' });
        const { customer: otherCustomer } = await createCustomerWithGroup({ currency: 'USD' });
        const payment = await createMockPayment(customer);

        await expect(paymentService.getPaymentById(payment._id, { actor: otherCustomer }))
            .rejects.toMatchObject({ statusCode: 403 });
    });

    it('lets admins list and read payments', async () => {
        const { customer } = await createCustomerWithGroup({ currency: 'USD' });
        const admin = await createAdmin();
        const payment = await createMockPayment(customer);

        const list = await paymentService.listPayments({ page: 1, limit: 10 });
        expect(list.payments.map((item) => item._id.toString())).toContain(payment._id.toString());

        const found = await paymentService.getPaymentById(payment._id, {
            actor: admin,
            admin: true,
        });
        expect(found._id.toString()).toBe(payment._id.toString());
    });

    it('keeps real gateway adapters as non-operational placeholders', async () => {
        const adapter = getPaymentGateway(PAYMENT_GATEWAYS.NETWORK_INTERNATIONAL);

        await expect(adapter.createPaymentIntent({}))
            .rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_NOT_IMPLEMENTED' });
    });

    it('mock confirm marks payment succeeded, credits wallet once, and writes CARD_PAYMENT_SUCCESS', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD' });
        const payment = await createMockPayment(customer);

        const result = await paymentService.confirmMockPayment(payment._id, { actor: customer });

        expect(result.payment.status).toBe(PAYMENT_STATUSES.SUCCEEDED);
        expect(result.payment.creditedAt).not.toBeNull();
        expect(result.payment.walletTransactionId).toBeDefined();

        const freshUser = await User.findById(customer._id);
        expect(freshUser.walletBalance).toBe(150);

        const tx = await WalletTransaction.findOne({
            userId: customer._id,
            semanticType: 'CARD_PAYMENT_SUCCESS',
        });
        expect(tx).not.toBeNull();
        expect(tx.type).toBe('CREDIT');
        expect(tx.sourceType).toBe('PAYMENT');
        expect(tx.sourceId.toString()).toBe(payment._id.toString());
        expect(tx.direction).toBe('CREDIT');
        expect(tx.idempotencyKey).toBe(`payment:${payment._id.toString()}:wallet-credit`);
    });

    it('mock confirm is idempotent and does not double-credit', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD' });
        const payment = await createMockPayment(customer);

        await paymentService.confirmMockPayment(payment._id, { actor: customer });
        const second = await paymentService.confirmMockPayment(payment._id, { actor: customer });

        expect(second.alreadyProcessed).toBe(true);

        const freshUser = await User.findById(customer._id);
        expect(freshUser.walletBalance).toBe(150);

        const txCount = await WalletTransaction.countDocuments({
            userId: customer._id,
            semanticType: 'CARD_PAYMENT_SUCCESS',
        });
        expect(txCount).toBe(1);
    });

    it('mock fail marks payment failed and does not credit wallet', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD' });
        const payment = await createMockPayment(customer);

        const result = await paymentService.failMockPayment(payment._id, { actor: customer });

        expect(result.payment.status).toBe(PAYMENT_STATUSES.FAILED);
        expect(result.payment.failedAt).not.toBeNull();

        const freshUser = await User.findById(customer._id);
        expect(freshUser.walletBalance).toBe(100);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('blocks mock confirm and mock fail in production', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD' });
        const payment = await createMockPayment(customer);

        process.env.NODE_ENV = 'production';

        await expect(paymentService.confirmMockPayment(payment._id, { actor: customer }))
            .rejects.toMatchObject({ code: 'MOCK_PAYMENTS_DISABLED_IN_PRODUCTION' });
        await expect(paymentService.failMockPayment(payment._id, { actor: customer }))
            .rejects.toMatchObject({ code: 'MOCK_PAYMENTS_DISABLED_IN_PRODUCTION' });

        const unchanged = await Payment.findById(payment._id);
        expect(unchanged.status).toBe(PAYMENT_STATUSES.REQUIRES_ACTION);
        expect((await User.findById(customer._id)).walletBalance).toBe(100);
    });
});
