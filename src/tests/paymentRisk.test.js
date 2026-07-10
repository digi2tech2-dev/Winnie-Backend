'use strict';

const paymentService = require('../modules/payments/payment.service');
const depositService = require('../modules/deposits/deposit.service');
const adminSettingService = require('../modules/admin/admin.settings.service');
const { Payment } = require('../modules/payments/payment.model');
const {
    PAYMENT_GATEWAYS,
    PAYMENT_METHODS,
    PAYMENT_PURPOSES,
    PAYMENT_STATUSES,
} = require('../modules/payments/payment.constants');
const {
    PAYMENT_RISK_ACTIONS,
    PAYMENT_RISK_LIMITS_SETTING_KEY,
    getDefaultPaymentRiskLimits,
} = require('../modules/payments/paymentRisk.config');
const { Setting } = require('../modules/admin/setting.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { User } = require('../modules/users/user.model');
const MockPaymentGateway = require('../modules/payments/gateways/mock.gateway');

const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createAdmin,
    createCustomerWithGroup,
} = require('./testHelpers');

const flushAudit = () => new Promise((resolve) => setTimeout(resolve, 100));

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
afterEach(async () => {
    await flushAudit();
    jest.restoreAllMocks();
    process.env.NODE_ENV = 'test';
});

const relaxedRiskSettings = (overrides = {}) => ({
    ...getDefaultPaymentRiskLimits(),
    maxSingleAmount: 10000,
    hourlyAmountLimit: 10000,
    dailyAmountLimit: 10000,
    hourlyAttemptLimit: 100,
    dailyAttemptLimit: 100,
    newAccountHours: 0,
    newAccountSingleAmount: 10000,
    newAccountDailyAmount: 10000,
    ...overrides,
});

const saveRiskSettings = async (overrides = {}) => {
    const value = relaxedRiskSettings(overrides);
    await Setting.updateOne(
        { key: PAYMENT_RISK_LIMITS_SETTING_KEY },
        {
            $set: {
                key: PAYMENT_RISK_LIMITS_SETTING_KEY,
                value,
                description: 'Test payment risk limits',
            },
        },
        { upsert: true }
    );
    return value;
};

const createIntent = (customer, overrides = {}) => (
    paymentService.createPaymentIntent({
        userId: customer._id,
        amount: 25,
        currency: 'USD',
        gateway: PAYMENT_GATEWAYS.MOCK,
        returnUrl: 'http://localhost:5173/customer/wallet/transactions',
        cancelUrl: 'http://localhost:5173/customer/wallet',
        antiScamConfirmed: true,
        termsAccepted: true,
        ...overrides,
    })
);

const createHistoricalPayment = (customer, amount = 25) => (
    Payment.create({
        userId: customer._id,
        purpose: PAYMENT_PURPOSES.WALLET_TOPUP,
        gateway: PAYMENT_GATEWAYS.MOCK,
        method: PAYMENT_METHODS.CARD,
        amount,
        feeAmount: 0,
        totalAmount: amount,
        currency: 'USD',
        status: PAYMENT_STATUSES.REQUIRES_ACTION,
    })
);

describe('Payment risk limits', () => {
    it('allows a payment intent below configured limits', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD' });
        await saveRiskSettings({ maxSingleAmount: 100, hourlyAmountLimit: 200, dailyAmountLimit: 300 });

        const result = await createIntent(customer, { amount: 50 });

        expect(result.payment.status).toBe(PAYMENT_STATUSES.REQUIRES_ACTION);
        expect(result.payment.metadata.risk.amountBaseCurrency).toBe(50);
        expect(await Payment.countDocuments({ userId: customer._id })).toBe(1);
    });

    it('blocks a single payment above maxSingleAmount', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD' });
        await saveRiskSettings({ maxSingleAmount: 50 });

        await expect(createIntent(customer, { amount: 51 }))
            .rejects.toMatchObject({
                code: 'PAYMENT_RISK_LIMIT_REACHED',
                details: { reason: 'MAX_SINGLE_AMOUNT' },
            });

        expect(await Payment.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('blocks when rolling hourly amount would exceed the configured limit', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD' });
        await saveRiskSettings({ hourlyAmountLimit: 100, dailyAmountLimit: 1000 });
        await createHistoricalPayment(customer, 80);

        await expect(createIntent(customer, { amount: 25 }))
            .rejects.toMatchObject({
                code: 'PAYMENT_RISK_LIMIT_REACHED',
                details: { reason: 'HOURLY_AMOUNT_LIMIT' },
            });
    });

    it('blocks when rolling daily amount would exceed the configured limit', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD' });
        await saveRiskSettings({ hourlyAmountLimit: 1000, dailyAmountLimit: 100 });
        await createHistoricalPayment(customer, 80);

        await expect(createIntent(customer, { amount: 25 }))
            .rejects.toMatchObject({
                code: 'PAYMENT_RISK_LIMIT_REACHED',
                details: { reason: 'DAILY_AMOUNT_LIMIT' },
            });
    });

    it('blocks when rolling hourly attempt count would exceed the configured limit', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD' });
        await saveRiskSettings({ hourlyAttemptLimit: 2, dailyAttemptLimit: 100 });
        await createHistoricalPayment(customer, 1);
        await createHistoricalPayment(customer, 1);

        await expect(createIntent(customer, { amount: 1 }))
            .rejects.toMatchObject({
                code: 'PAYMENT_RISK_LIMIT_REACHED',
                details: { reason: 'HOURLY_ATTEMPT_LIMIT' },
            });
    });

    it('blocks when rolling daily attempt count would exceed the configured limit', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD' });
        await saveRiskSettings({ hourlyAttemptLimit: 100, dailyAttemptLimit: 2 });
        await createHistoricalPayment(customer, 1);
        await createHistoricalPayment(customer, 1);

        await expect(createIntent(customer, { amount: 1 }))
            .rejects.toMatchObject({
                code: 'PAYMENT_RISK_LIMIT_REACHED',
                details: { reason: 'DAILY_ATTEMPT_LIMIT' },
            });
    });

    it('blocks a new account above the newAccountSingleAmount limit', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD' });
        await saveRiskSettings({
            newAccountHours: 24,
            newAccountSingleAmount: 50,
        });

        await expect(createIntent(customer, { amount: 60 }))
            .rejects.toMatchObject({
                code: 'PAYMENT_RISK_LIMIT_REACHED',
                details: { reason: 'NEW_ACCOUNT_SINGLE_AMOUNT' },
            });
    });

    it('allows payment intent creation when risk settings are disabled', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD' });
        await saveRiskSettings({ enabled: false, maxSingleAmount: 1 });

        const result = await createIntent(customer, { amount: 500 });

        expect(result.payment.amount).toBe(500);
        expect(result.payment.gateway).toBe(PAYMENT_GATEWAYS.MOCK);
    });

    it('does not block manual deposit requests with payment risk settings', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD' });
        await saveRiskSettings({ maxSingleAmount: 1, hourlyAttemptLimit: 0, dailyAttemptLimit: 0 });

        const deposit = await depositService.createDepositRequest({
            userId: customer._id,
            paymentMethodId: 'bank-transfer-usd',
            requestedAmount: 500,
            currency: 'USD',
            exchangeRate: 1,
            amountUsd: 500,
            receiptImage: 'uploads/deposits/test-risk-receipt.jpg',
            antiScamConfirmed: true,
            termsAccepted: true,
        });

        expect(deposit._id).toBeDefined();
        expect(deposit.status).toBe('PENDING');
    });

    it('does not call the gateway adapter when risk check fails', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD' });
        const gatewaySpy = jest.spyOn(MockPaymentGateway.prototype, 'createPaymentIntent');
        await saveRiskSettings({ maxSingleAmount: 10 });

        await expect(createIntent(customer, { amount: 11 }))
            .rejects.toMatchObject({ code: 'PAYMENT_RISK_LIMIT_REACHED' });

        expect(gatewaySpy).not.toHaveBeenCalled();
    });

    it('does not credit wallet or create wallet transactions when risk check fails', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD' });
        await saveRiskSettings({ maxSingleAmount: 10 });

        await expect(createIntent(customer, { amount: 11 }))
            .rejects.toMatchObject({ code: 'PAYMENT_RISK_LIMIT_REACHED' });

        const fresh = await User.findById(customer._id);
        expect(fresh.walletBalance).toBe(100);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('returns a safe 4xx-style operational error for blocked online payments', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 100, currency: 'USD' });
        const settings = await saveRiskSettings({
            maxSingleAmount: 10,
            customerMessage: 'Online top-up is temporarily limited. Please use manual deposit or contact support.',
        });

        let caughtError;
        try {
            await createIntent(customer, { amount: 11 });
        } catch (err) {
            caughtError = err;
        }

        expect(caughtError).toMatchObject({
            statusCode: expect.any(Number),
            code: 'PAYMENT_RISK_LIMIT_REACHED',
            message: settings.customerMessage,
            details: { reason: 'MAX_SINGLE_AMOUNT' },
        });
        expect(caughtError.statusCode).toBeGreaterThanOrEqual(400);
        expect(caughtError.statusCode).toBeLessThan(500);
    });

    it('lets admins update paymentRiskLimits through the settings service', async () => {
        const admin = await createAdmin();

        const updated = await adminSettingService.updateSetting(
            PAYMENT_RISK_LIMITS_SETTING_KEY,
            {
                enabled: false,
                maxSingleAmount: 25,
                customerMessage: 'Use manual deposit or contact support.',
            },
            admin._id
        );

        expect(updated.value.enabled).toBe(false);
        expect(updated.value.maxSingleAmount).toBe(25);
        expect(updated.value.action).toBe(PAYMENT_RISK_ACTIONS.BLOCK_ONLINE_PAYMENT);
        expect(updated.updatedBy.toString()).toBe(admin._id.toString());
    });
});
