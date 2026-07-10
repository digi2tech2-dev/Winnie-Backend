'use strict';

jest.mock('axios');

const axios = require('axios');
const paymentService = require('../modules/payments/payment.service');
const { Payment } = require('../modules/payments/payment.model');
const {
    PAYMENT_GATEWAYS,
    PAYMENT_STATUSES,
} = require('../modules/payments/payment.constants');
const { Currency } = require('../modules/currency/currency.model');
const { Setting } = require('../modules/admin/setting.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { User } = require('../modules/users/user.model');
const { invalidateCurrencyCache } = require('../services/currencyConverter.service');
const {
    PAYMENT_RISK_LIMITS_SETTING_KEY,
    getDefaultPaymentRiskLimits,
} = require('../modules/payments/paymentRisk.config');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createAdmin,
    createCustomerWithGroup,
} = require('./testHelpers');

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    clearPaymentoEnv();
    delete process.env.PAYMENTS_ENABLED;
    delete process.env.PAYMENT_MIN_AMOUNT;
    delete process.env.PAYMENT_MAX_AMOUNT;
    axios.create.mockReset();
    await clearCollections();
    invalidateCurrencyCache('EGP');
    invalidateCurrencyCache('USD');
});
afterEach(() => {
    jest.restoreAllMocks();
    invalidateCurrencyCache('EGP');
    invalidateCurrencyCache('USD');
    clearPaymentoEnv();
    process.env.NODE_ENV = 'test';
});

const clearPaymentoEnv = () => {
    delete process.env.PAYMENT_ALLOWED_GATEWAYS;
    delete process.env.PAYMENT_DEFAULT_GATEWAY;
    delete process.env.PAYMENTO_ENABLED;
    delete process.env.PAYMENTO_API_BASE_URL;
    delete process.env.PAYMENTO_API_KEY;
    delete process.env.PAYMENTO_IPN_SECRET;
    delete process.env.PAYMENTO_RETURN_URL;
    delete process.env.PAYMENTO_CANCEL_URL;
    delete process.env.PAYMENTO_PENDING_URL;
    delete process.env.PAYMENTO_IPN_URL;
    delete process.env.PAYMENTO_FIAT_CURRENCY;
    delete process.env.PAYMENTO_ALLOWED_CRYPTO;
    delete process.env.PAYMENTO_RISK_SPEED;
    delete process.env.PAYMENTO_CREATE_PATH;
    delete process.env.PAYMENTO_VERIFY_PATH;
};

const enablePaymentoGateway = (overrides = {}) => {
    process.env.PAYMENT_ALLOWED_GATEWAYS = 'MOCK,PAYMENTO';
    process.env.PAYMENTO_ENABLED = 'true';
    process.env.PAYMENTO_API_BASE_URL = 'https://paymento.example.test';
    process.env.PAYMENTO_API_KEY = 'paymento-test-api-key';
    process.env.PAYMENTO_RETURN_URL = 'https://winnie.example/payment/success';
    process.env.PAYMENTO_CANCEL_URL = 'https://winnie.example/payment/cancel';
    process.env.PAYMENTO_PENDING_URL = 'https://winnie.example/payment/pending';
    process.env.PAYMENTO_IPN_URL = 'https://api.winnie.example/api/webhooks/payments/paymento';
    process.env.PAYMENTO_FIAT_CURRENCY = 'USD';
    process.env.PAYMENTO_ALLOWED_CRYPTO = 'USDT';
    process.env.PAYMENTO_RISK_SPEED = '1';

    Object.entries(overrides).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });
};

const createCurrency = ({
    code,
    name = code,
    symbol = code,
    platformRate,
    isActive = true,
}) => Currency.create({
    code,
    name,
    symbol,
    platformRate,
    isActive,
});

const createEgpCurrency = () => createCurrency({
    code: 'EGP',
    name: 'Egyptian Pound',
    symbol: 'EGP',
    platformRate: 50,
});

const createPaymentoCustomer = async (overrides = {}) => {
    if (overrides.currency === 'EGP') await createEgpCurrency();
    const { customer } = await createCustomerWithGroup({
        walletBalance: 100,
        currency: 'USD',
        ...overrides,
    });
    return customer;
};

const makeHttpClient = () => {
    const client = {
        get: jest.fn(),
        post: jest.fn(),
    };
    axios.create.mockReturnValue(client);
    return client;
};

const mockCreatePaymentoPayment = (client, overrides = {}) => {
    client.post.mockResolvedValueOnce({
        data: {
            token: 'paymento-token-1',
            reference: 'paymento-ref-1',
            status: 'Initialize',
            ...overrides,
        },
    });
};

const mockPaymentoVerify = (client, status = 'Paid', overrides = {}) => {
    client.post.mockResolvedValueOnce({
        data: {
            paymentId: 'paymento-payment-1',
            reference: 'paymento-ref-1',
            status,
            ...overrides,
        },
    });
};

const createPaymentoIntent = (customer, overrides = {}) => (
    paymentService.createPaymentIntent({
        userId: customer._id,
        amount: 100,
        currency: customer.currency || 'USD',
        gateway: PAYMENT_GATEWAYS.PAYMENTO,
        ...overrides,
    })
);

const saveRiskSettings = async (overrides = {}) => {
    await Setting.updateOne(
        { key: PAYMENT_RISK_LIMITS_SETTING_KEY },
        {
            $set: {
                key: PAYMENT_RISK_LIMITS_SETTING_KEY,
                value: {
                    ...getDefaultPaymentRiskLimits(),
                    ...overrides,
                },
                description: 'Paymento payment risk test settings',
            },
        },
        { upsert: true }
    );
};

const savePaymentMethod = async (method = {}) => {
    await Setting.updateOne(
        { key: 'paymentGroups' },
        {
            $set: {
                key: 'paymentGroups',
                value: [{
                    id: 'wallet-topup',
                    name: 'Wallet top-up',
                    currency: method.currency || 'EGP',
                    isActive: true,
                    methods: [{
                        id: method.id || 'pm-paymento-fee',
                        name: 'Paymento fee method',
                        gateway: PAYMENT_GATEWAYS.PAYMENTO,
                        currencies: [method.currency || 'EGP'],
                        fee: method.fee ?? 2,
                        isActive: true,
                        customerVisible: true,
                    }],
                }],
                description: 'Paymento payment method test settings',
            },
        },
        { upsert: true }
    );
};

describe('Paymento USDT hosted payment gateway', () => {
    it('returns a safe error when Paymento config is missing and skips HTTP calls', async () => {
        process.env.PAYMENT_ALLOWED_GATEWAYS = 'MOCK,PAYMENTO';
        const customer = await createPaymentoCustomer();

        await expect(createPaymentoIntent(customer))
            .rejects.toMatchObject({ code: 'PAYMENTO_CONFIG_MISSING' });

        expect(axios.create).not.toHaveBeenCalled();
        expect(await Payment.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('rejects Paymento when the gateway is not allowed', async () => {
        enablePaymentoGateway({ PAYMENT_ALLOWED_GATEWAYS: 'MOCK' });
        const customer = await createPaymentoCustomer();

        await expect(createPaymentoIntent(customer))
            .rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_NOT_ALLOWED' });

        expect(axios.create).not.toHaveBeenCalled();
    });

    it('blocks risky Paymento payments before calling the provider', async () => {
        enablePaymentoGateway();
        const customer = await createPaymentoCustomer();
        await saveRiskSettings({ maxSingleAmount: 1 });

        await expect(createPaymentoIntent(customer))
            .rejects.toMatchObject({ code: 'PAYMENT_RISK_LIMIT_REACHED' });

        expect(axios.create).not.toHaveBeenCalled();
        expect(await Payment.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('creates a Paymento hosted checkout intent, stores safe metadata, and does not credit the wallet', async () => {
        enablePaymentoGateway();
        const customer = await createPaymentoCustomer({ currency: 'EGP', walletBalance: 500 });
        const client = makeHttpClient();
        mockCreatePaymentoPayment(client);

        const result = await createPaymentoIntent(customer, {
            amount: 250,
            currency: 'EGP',
        });

        const [createPath, createPayload, createOptions] = client.post.mock.calls[0];
        expect(createPath).toBe('/v1/payment/request');
        expect(createPayload).toMatchObject({
            fiatAmount: '5.00',
            fiatCurrency: 'USD',
            ReturnUrl: `https://winnie.example/payment/success?paymentId=${result.payment._id.toString()}`,
            orderId: result.payment._id.toString(),
            Speed: 1,
            additionalData: expect.arrayContaining([
                { key: 'paymentId', value: result.payment._id.toString() },
                { key: 'userId', value: customer._id.toString() },
                { key: 'requestedAmount', value: '250' },
                { key: 'requestedCurrency', value: 'EGP' },
                { key: 'allowedCrypto', value: 'USDT' },
            ]),
        });
        expect(createPayload).not.toHaveProperty('amount');
        expect(createPayload).not.toHaveProperty('currency');
        expect(createPayload).not.toHaveProperty('cryptoCurrency');
        expect(createPayload).not.toHaveProperty('allowedCrypto');
        expect(createPayload).not.toHaveProperty('merchantReference');
        expect(createPayload).not.toHaveProperty('merchant_reference');
        expect(createPayload).not.toHaveProperty('return_url');
        expect(createPayload).not.toHaveProperty('cancelUrl');
        expect(createPayload).not.toHaveProperty('cancel_url');
        expect(createPayload).not.toHaveProperty('pendingUrl');
        expect(createPayload).not.toHaveProperty('pending_url');
        expect(createPayload).not.toHaveProperty('ipnUrl');
        expect(createPayload).not.toHaveProperty('ipn_url');
        expect(createPayload).not.toHaveProperty('metadata');
        expect(createOptions.headers).toMatchObject({
            'Api-key': 'paymento-test-api-key',
            Accept: 'text/plain',
            'Content-Type': 'application/json',
        });
        expect(createOptions.headers).not.toHaveProperty('Authorization');
        expect(createOptions.headers).not.toHaveProperty('X-API-Key');

        expect(result.payment.status).toBe(PAYMENT_STATUSES.REQUIRES_ACTION);
        expect(result.payment.gateway).toBe(PAYMENT_GATEWAYS.PAYMENTO);
        expect(result.payment.method).toBe('ONLINE');
        expect(result.payment.amount).toBe(250);
        expect(result.payment.currency).toBe('EGP');
        expect(result.payment.gatewayPaymentId).toBe('paymento-token-1');
        expect(result.payment.gatewayReference).toBe('paymento-ref-1');
        expect(result.checkout.url).toBe('https://app.paymento.io/gateway?token=paymento-token-1');
        expect(result.checkout).toMatchObject({
            requestedAmount: 250,
            requestedCurrency: 'EGP',
            gatewayAmount: 5,
            gatewayCurrency: 'USD',
            exchangeRate: 0.02,
        });
        expect(result.payment.metadata).toMatchObject({
            mode: 'paymento_usdt',
            gatewayMetadata: {
                provider: 'PAYMENTO',
                mode: 'hosted_usdt_checkout',
                allowedCrypto: 'USDT',
                checkoutUrlPresent: true,
            },
            gatewayCurrencyConversion: {
                requestedAmount: 250,
                requestedCurrency: 'EGP',
                gatewayAmount: 5,
                gatewayCurrency: 'USD',
                exchangeRate: 0.02,
                exchangeRateSource: 'PLATFORM_CURRENCY_RATES_VIA_USD',
            },
        });

        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
        expect((await User.findById(customer._id)).walletBalance).toBe(500);
    });

    it('sends Paymento fiatAmount from fee-inclusive payable amount', async () => {
        enablePaymentoGateway();
        const customer = await createPaymentoCustomer({ currency: 'EGP', walletBalance: 500 });
        await savePaymentMethod({ fee: 2, currency: 'EGP' });
        const client = makeHttpClient();
        mockCreatePaymentoPayment(client);

        const result = await createPaymentoIntent(customer, {
            amount: 250,
            currency: 'EGP',
            paymentMethodId: 'pm-paymento-fee',
        });

        const [, createPayload] = client.post.mock.calls[0];
        expect(createPayload).toMatchObject({
            fiatAmount: '5.10',
            fiatCurrency: 'USD',
            additionalData: expect.arrayContaining([
                { key: 'requestedAmount', value: '250' },
                { key: 'requestedCurrency', value: 'EGP' },
                { key: 'feePercent', value: '2' },
                { key: 'feeAmount', value: '5' },
                { key: 'payableAmount', value: '255' },
                { key: 'payableCurrency', value: 'EGP' },
            ]),
        });
        expect(result.payment.amount).toBe(250);
        expect(result.payment.feePercent).toBe(2);
        expect(result.payment.feeAmount).toBe(5);
        expect(result.payment.totalAmount).toBe(255);
        expect(result.checkout).toMatchObject({
            requestedAmount: 250,
            requestedCurrency: 'EGP',
            feePercent: 2,
            feeAmount: 5,
            payableAmount: 255,
            payableCurrency: 'EGP',
            gatewayAmount: 5.1,
            gatewayCurrency: 'USD',
        });
    });

    it('does not expose Paymento API keys, IPN secrets, or raw auth headers in serialized responses', async () => {
        enablePaymentoGateway({ PAYMENTO_IPN_SECRET: 'paymento-ipn-secret' });
        const customer = await createPaymentoCustomer();
        const client = makeHttpClient();
        mockCreatePaymentoPayment(client, { token: 'provider-safe-payment-token' });

        const result = await createPaymentoIntent(customer);
        const serialized = paymentService.serializePayment(result.payment, { admin: true });
        const body = JSON.stringify({ payment: serialized, checkout: result.checkout });

        expect(body).not.toContain('paymento-test-api-key');
        expect(body).not.toContain('paymento-ipn-secret');
        expect(body).not.toContain('Authorization');
        expect(body).not.toContain('X-API-Key');
    });

    it('returns the idempotent Paymento intent without creating a duplicate provider payment', async () => {
        enablePaymentoGateway();
        const customer = await createPaymentoCustomer();
        const client = makeHttpClient();
        mockCreatePaymentoPayment(client);

        const first = await createPaymentoIntent(customer, { idempotencyKey: 'paymento-idem-1' });
        const second = await createPaymentoIntent(customer, { idempotencyKey: 'paymento-idem-1' });

        expect(second.idempotent).toBe(true);
        expect(second.payment._id.toString()).toBe(first.payment._id.toString());
        expect(client.post).toHaveBeenCalledTimes(1);
        expect(await Payment.countDocuments({ userId: customer._id })).toBe(1);
    });

    it('browser return sync does not credit unless Paymento verify returns success', async () => {
        enablePaymentoGateway();
        const customer = await createPaymentoCustomer();
        const client = makeHttpClient();
        mockCreatePaymentoPayment(client);
        const result = await createPaymentoIntent(customer);

        client.post.mockReset();
        mockPaymentoVerify(client, 'Pending');
        const pending = await paymentService.syncPaymentStatus(result.payment._id, { actor: customer });

        expect(client.post).toHaveBeenCalledWith(
            '/v1/payment/verify',
            { token: 'paymento-token-1' },
            expect.objectContaining({
                headers: expect.objectContaining({
                    'Api-key': 'paymento-test-api-key',
                }),
            })
        );
        expect(pending.payment.status).toBe(PAYMENT_STATUSES.PENDING);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);

        client.post.mockReset();
        mockPaymentoVerify(client, 'Paid');
        const paid = await paymentService.syncPaymentStatus(result.payment._id, { actor: customer });

        expect(paid.payment.status).toBe(PAYMENT_STATUSES.SUCCEEDED);
        expect(paid.payment.creditedAt).not.toBeNull();
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(1);
        expect((await User.findById(customer._id)).walletBalance).toBe(200);
    });

    it('does not credit partial, timeout, canceled, or rejected Paymento statuses', async () => {
        enablePaymentoGateway();
        const statusCases = [
            ['PartialPaid', PAYMENT_STATUSES.PENDING],
            ['Timeout', PAYMENT_STATUSES.EXPIRED],
            ['UserCanceled', PAYMENT_STATUSES.CANCELED],
            ['Reject', PAYMENT_STATUSES.FAILED],
        ];

        for (const [providerStatus, expectedStatus] of statusCases) {
            await clearCollections();
            const customer = await createPaymentoCustomer();
            const client = makeHttpClient();
            mockCreatePaymentoPayment(client, {
                paymentId: `paymento-${providerStatus}`,
                reference: `paymento-ref-${providerStatus}`,
            });
            const result = await createPaymentoIntent(customer);

            client.post.mockReset();
            mockPaymentoVerify(client, providerStatus, {
                paymentId: `paymento-${providerStatus}`,
                reference: `paymento-ref-${providerStatus}`,
            });
            const synced = await paymentService.syncPaymentStatus(result.payment._id, { actor: customer });

            expect(synced.payment.status).toBe(expectedStatus);
            expect(synced.payment.creditedAt).toBeNull();
            expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
        }
    });

    it('admin sync calls Paymento verify and remains idempotent after success', async () => {
        enablePaymentoGateway();
        const customer = await createPaymentoCustomer();
        const admin = await createAdmin();
        const client = makeHttpClient();
        mockCreatePaymentoPayment(client);
        const result = await createPaymentoIntent(customer);

        client.post.mockReset();
        mockPaymentoVerify(client, 'Approve');
        const first = await paymentService.syncPaymentStatus(result.payment._id, {
            actor: admin,
            source: 'admin_reconciliation',
        });
        const second = await paymentService.syncPaymentStatus(result.payment._id, {
            actor: admin,
            source: 'admin_reconciliation',
        });

        expect(first.payment.status).toBe(PAYMENT_STATUSES.SUCCEEDED);
        expect(second.alreadyProcessed).toBe(true);
        expect(client.post).toHaveBeenCalledTimes(1);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(1);
    });

    it('prevents a customer from syncing another user Paymento payment', async () => {
        enablePaymentoGateway();
        const customer = await createPaymentoCustomer();
        const otherCustomer = await createPaymentoCustomer({ email: `other-${Date.now()}@test.com` });
        const client = makeHttpClient();
        mockCreatePaymentoPayment(client);
        const result = await createPaymentoIntent(customer);

        client.post.mockReset();
        await expect(paymentService.syncPaymentStatus(result.payment._id, { actor: otherCustomer }))
            .rejects.toMatchObject({ statusCode: 403 });

        expect(client.post).not.toHaveBeenCalled();
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
    });
});
