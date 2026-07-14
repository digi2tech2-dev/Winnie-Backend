'use strict';

jest.mock('axios');

const crypto = require('crypto');
const axios = require('axios');
const paymentService = require('../modules/payments/payment.service');
const webhookService = require('../modules/payments/payment.webhook.service');
const { Payment } = require('../modules/payments/payment.model');
const {
    PaymentWebhookEvent,
    PAYMENT_WEBHOOK_EVENT_STATUSES,
} = require('../modules/payments/paymentWebhookEvent.model');
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
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
} = require('./testHelpers');

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    clearZiinaEnv();
    delete process.env.PAYMENTS_ENABLED;
    delete process.env.PAYMENT_MIN_AMOUNT;
    delete process.env.PAYMENT_MAX_AMOUNT;
    axios.create.mockReset();
    await clearCollections();
    invalidateCurrencyCache('AED');
    invalidateCurrencyCache('EGP');
    invalidateCurrencyCache('USD');
});
afterEach(() => {
    jest.restoreAllMocks();
    invalidateCurrencyCache('AED');
    invalidateCurrencyCache('EGP');
    invalidateCurrencyCache('USD');
    clearZiinaEnv();
    process.env.NODE_ENV = 'test';
});

const clearZiinaEnv = () => {
    delete process.env.PAYMENT_ALLOWED_GATEWAYS;
    delete process.env.PAYMENT_DEFAULT_GATEWAY;
    delete process.env.ZIINA_ENABLED;
    delete process.env.ZIINA_API_BASE_URL;
    delete process.env.ZIINA_ACCESS_TOKEN;
    delete process.env.ZIINA_CURRENCY;
    delete process.env.ZIINA_TEST_MODE;
    delete process.env.ZIINA_SUCCESS_URL;
    delete process.env.ZIINA_CANCEL_URL;
    delete process.env.ZIINA_FAILURE_URL;
    delete process.env.ZIINA_WEBHOOK_URL;
    delete process.env.ZIINA_WEBHOOK_SECRET;
};

const enableZiinaGateway = (overrides = {}) => {
    process.env.PAYMENT_ALLOWED_GATEWAYS = 'MOCK,ZIINA';
    process.env.ZIINA_ENABLED = 'true';
    process.env.ZIINA_API_BASE_URL = 'https://ziina.example.test/api';
    process.env.ZIINA_ACCESS_TOKEN = 'ziina-test-token';
    process.env.ZIINA_CURRENCY = 'AED';
    process.env.ZIINA_TEST_MODE = 'true';
    process.env.ZIINA_SUCCESS_URL = 'https://winnie.example/payment/success?provider=ziina&payment_intent_id={PAYMENT_INTENT_ID}';
    process.env.ZIINA_CANCEL_URL = 'https://winnie.example/payment/cancel?provider=ziina&payment_intent_id={PAYMENT_INTENT_ID}';
    process.env.ZIINA_FAILURE_URL = 'https://winnie.example/payment/cancel?provider=ziina&payment_intent_id={PAYMENT_INTENT_ID}';
    process.env.ZIINA_WEBHOOK_URL = 'https://api.winnie.example/api/webhooks/payments/ziina';

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

const createAedCurrency = () => createCurrency({
    code: 'AED',
    name: 'UAE Dirham',
    symbol: 'AED',
    platformRate: 3.67,
});

const createEgpCurrency = () => createCurrency({
    code: 'EGP',
    name: 'Egyptian Pound',
    symbol: 'EGP',
    platformRate: 52,
});

const createZiinaCustomer = async (overrides = {}) => {
    const { createAed = true, ...customerOverrides } = overrides;
    if (createAed !== false) await createAedCurrency();
    if (customerOverrides.currency === 'EGP') await createEgpCurrency();
    const { customer } = await createCustomerWithGroup({
        walletBalance: 100,
        currency: 'AED',
        ...customerOverrides,
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

const mockCreateZiinaPayment = (client, overrides = {}) => {
    client.post.mockResolvedValueOnce({
        status: 200,
        data: {
            id: 'pi_123',
            amount: 10200,
            currency_code: 'AED',
            redirect_url: 'https://pay.ziina.com/checkout/pi_123',
            embedded_url: 'https://pay.ziina.com/embed/pi_123',
            ...overrides,
        },
    });
};

const mockZiinaVerify = (client, status = 'completed', overrides = {}) => {
    client.get.mockResolvedValueOnce({
        status: 200,
        data: {
            id: 'pi_123',
            status,
            amount: 10200,
            currency_code: 'AED',
            ...overrides,
        },
    });
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
                    currency: method.currency || 'AED',
                    isActive: true,
                    methods: [{
                        id: method.id || 'pm-ziina-fee',
                        name: 'Ziina',
                        gateway: PAYMENT_GATEWAYS.ZIINA,
                        currencies: [method.currency || 'AED'],
                        fee: method.fee ?? 2,
                        isActive: true,
                        customerVisible: true,
                    }],
                }],
                description: 'Ziina payment method test settings',
            },
        },
        { upsert: true }
    );
};

const createZiinaIntent = (customer, overrides = {}) => (
    paymentService.createPaymentIntent({
        userId: customer._id,
        amount: 100,
        currency: customer.currency || 'AED',
        gateway: PAYMENT_GATEWAYS.ZIINA,
        antiScamConfirmed: true,
        termsAccepted: true,
        ...overrides,
    })
);

const ziinaWebhookPayload = (overrides = {}) => ({
    event: 'payment_intent.status.updated',
    data: {
        id: 'pi_123',
        status: 'completed',
        amount: 10200,
        currency_code: 'AED',
        ...overrides.data,
    },
    ...overrides,
});

const signedHeaders = (payload, secret = 'ziina-webhook-secret') => {
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return {
        rawBody,
        headers: {
            'content-type': 'application/json',
            'user-agent': 'ziina-webhook-test',
            'x-hmac-signature': signature,
        },
    };
};

const processWebhook = (payload, headers = {}, rawBody = null) => webhookService.processZiinaWebhook({
    payload,
    headers: {
        'content-type': 'application/json',
        'user-agent': 'ziina-webhook-test',
        ...headers,
    },
    rawBody,
    requestMeta: {
        ipAddress: '127.0.0.1',
        userAgent: 'ziina-webhook-test',
    },
});

describe('Ziina wallet top-up gateway', () => {
    it('creates a Ziina payment intent with fee-inclusive minor-unit amount and bearer auth', async () => {
        enableZiinaGateway();
        const customer = await createZiinaCustomer({ walletBalance: 500 });
        await savePaymentMethod({ fee: 2, currency: 'AED' });
        const client = makeHttpClient();
        mockCreateZiinaPayment(client);

        const result = await createZiinaIntent(customer, {
            paymentMethodId: 'pm-ziina-fee',
        });

        expect(client.post).toHaveBeenCalledWith(
            '/payment_intent',
            expect.objectContaining({
                amount: 10200,
                currency_code: 'AED',
                message: `Winnie wallet top-up ${result.payment._id.toString()}`,
                success_url: process.env.ZIINA_SUCCESS_URL,
                cancel_url: process.env.ZIINA_CANCEL_URL,
                failure_url: process.env.ZIINA_FAILURE_URL,
                test: true,
                allow_tips: false,
            }),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer ziina-test-token',
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                }),
            })
        );

        expect(result.payment.status).toBe(PAYMENT_STATUSES.REQUIRES_ACTION);
        expect(result.payment.gateway).toBe(PAYMENT_GATEWAYS.ZIINA);
        expect(result.payment.method).toBe('ONLINE');
        expect(result.payment.gatewayPaymentId).toBe('pi_123');
        expect(result.payment.checkoutUrl).toBe('https://pay.ziina.com/checkout/pi_123');
        expect(result.payment.amount).toBe(100);
        expect(result.payment.feePercent).toBe(2);
        expect(result.payment.feeAmount).toBe(2);
        expect(result.payment.totalAmount).toBe(102);
        expect(result.payment.metadata.gatewayMetadata).toMatchObject({
            provider: 'ZIINA',
            mode: 'ziina_hosted_checkout',
            amountMinor: 10200,
            gatewayAmount: 102,
            gatewayCurrency: 'AED',
            requestedAmount: 100,
            requestedCurrency: 'AED',
            feeAmount: 2,
            payableAmount: 102,
            checkoutUrlPresent: true,
        });
        expect(result.checkout).toMatchObject({
            requestedAmount: 100,
            requestedCurrency: 'AED',
            feePercent: 2,
            feeAmount: 2,
            payableAmount: 102,
            payableCurrency: 'AED',
            gatewayAmount: 102,
            gatewayCurrency: 'AED',
        });
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
        expect((await User.findById(customer._id)).walletBalance).toBe(500);
    });

    it('rejects missing redirect_url with a clear provider response error', async () => {
        enableZiinaGateway();
        const customer = await createZiinaCustomer();
        const client = makeHttpClient();
        mockCreateZiinaPayment(client, { redirect_url: '' });

        await expect(createZiinaIntent(customer))
            .rejects.toMatchObject({
                code: 'ZIINA_CREATE_PAYMENT_INVALID_RESPONSE',
                message: 'Ziina create-payment response did not include redirect_url.',
            });

        expect(await Payment.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('rejects Ziina gateway amounts below 2 AED before calling the provider', async () => {
        enableZiinaGateway();
        const customer = await createZiinaCustomer();
        const client = makeHttpClient();

        await expect(createZiinaIntent(customer, { amount: 1 }))
            .rejects.toMatchObject({
                code: 'ZIINA_MINIMUM_AMOUNT_NOT_MET',
                messages: {
                    en: 'Minimum Ziina payment amount is 2 AED',
                    ar: 'الحد الأدنى للدفع عبر Ziina هو 2 AED',
                },
            });

        expect(client.post).not.toHaveBeenCalled();
        expect(await Payment.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('converts EGP wallet top-up payable amount to AED while preserving wallet credit currency', async () => {
        enableZiinaGateway();
        const customer = await createZiinaCustomer({ currency: 'EGP', walletBalance: 500 });
        const client = makeHttpClient();
        mockCreateZiinaPayment(client, { amount: 706 });

        const result = await createZiinaIntent(customer, {
            amount: 100,
            currency: 'EGP',
        });

        expect(client.post).toHaveBeenCalledWith(
            '/payment_intent',
            expect.objectContaining({
                amount: 706,
                currency_code: 'AED',
            }),
            expect.any(Object)
        );
        expect(result.payment.amount).toBe(100);
        expect(result.payment.currency).toBe('EGP');
        expect(result.payment.metadata.gatewayCurrencyConversion).toMatchObject({
            requestedAmount: 100,
            requestedCurrency: 'EGP',
            gatewayAmount: 7.06,
            gatewayCurrency: 'AED',
            exchangeRate: 0.0706,
            exchangeRateSource: 'PLATFORM_CURRENCY_RATES_VIA_USD',
        });
        expect(result.checkout).toMatchObject({
            requestedAmount: 100,
            requestedCurrency: 'EGP',
            gatewayAmount: 7.06,
            gatewayCurrency: 'AED',
        });
    });

    it('allows an AED Ziina payment method for an EGP wallet and converts fee-inclusive total to AED', async () => {
        enableZiinaGateway();
        const customer = await createZiinaCustomer({ currency: 'EGP', walletBalance: 500 });
        await savePaymentMethod({ fee: 2, currency: 'AED' });
        const client = makeHttpClient();
        mockCreateZiinaPayment(client, { amount: 720 });

        const result = await createZiinaIntent(customer, {
            amount: 100,
            currency: 'EGP',
            paymentMethodId: 'pm-ziina-fee',
        });

        expect(client.post).toHaveBeenCalledWith(
            '/payment_intent',
            expect.objectContaining({
                amount: 720,
                currency_code: 'AED',
            }),
            expect.any(Object)
        );
        expect(result.payment.amount).toBe(100);
        expect(result.payment.currency).toBe('EGP');
        expect(result.payment.feePercent).toBe(2);
        expect(result.payment.feeAmount).toBe(2);
        expect(result.payment.totalAmount).toBe(102);
        expect(result.payment.metadata.gatewayCurrencyConversion).toMatchObject({
            requestedAmount: 100,
            requestedCurrency: 'EGP',
            feePercent: 2,
            feeAmount: 2,
            payableAmount: 102,
            payableCurrency: 'EGP',
            gatewayAmount: 7.2,
            gatewayCurrency: 'AED',
        });
        expect(result.checkout).toMatchObject({
            requestedAmount: 100,
            requestedCurrency: 'EGP',
            feeAmount: 2,
            payableAmount: 102,
            gatewayAmount: 7.2,
            gatewayCurrency: 'AED',
        });
    });

    it('returns a clear conversion error when the AED gateway rate is missing', async () => {
        enableZiinaGateway();
        const customer = await createZiinaCustomer({ currency: 'EGP', walletBalance: 500, createAed: false });
        const client = makeHttpClient();

        await expect(createZiinaIntent(customer, {
            amount: 100,
            currency: 'EGP',
        })).rejects.toMatchObject({ code: 'PAYMENT_CURRENCY_CONVERSION_UNAVAILABLE' });

        expect(client.post).not.toHaveBeenCalled();
        expect(await Payment.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('returns a clear currency error when the wallet currency rate is missing', async () => {
        enableZiinaGateway();
        await createAedCurrency();
        const { customer } = await createCustomerWithGroup({
            walletBalance: 500,
            currency: 'EGP',
        });
        const client = makeHttpClient();

        await expect(createZiinaIntent(customer, {
            amount: 100,
            currency: 'EGP',
        })).rejects.toMatchObject({ code: 'PAYMENT_CURRENCY_NOT_SUPPORTED' });

        expect(client.post).not.toHaveBeenCalled();
        expect(await Payment.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('verify completed credits wallet amount once and does not credit gateway amount', async () => {
        enableZiinaGateway();
        const customer = await createZiinaCustomer({ currency: 'EGP', walletBalance: 500 });
        const client = makeHttpClient();
        mockCreateZiinaPayment(client, { amount: 706 });
        const result = await createZiinaIntent(customer, { amount: 100, currency: 'EGP' });

        client.post.mockReset();
        client.get.mockReset();
        mockZiinaVerify(client, 'completed', { amount: 706 });

        const first = await paymentService.syncPaymentStatus(result.payment._id, { actor: customer });
        const second = await paymentService.syncPaymentStatus(result.payment._id, { actor: customer });

        expect(client.get).toHaveBeenCalledWith(
            '/payment_intent/pi_123',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer ziina-test-token',
                }),
            })
        );
        expect(first.payment.status).toBe(PAYMENT_STATUSES.SUCCEEDED);
        expect(second.alreadyProcessed).toBe(true);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(1);
        const credit = await WalletTransaction.findOne({ userId: customer._id, semanticType: 'CARD_PAYMENT_SUCCESS' });
        expect(credit.amount).toBe(100);
        expect(credit.currency).toBe('EGP');
        expect((await User.findById(customer._id)).walletBalance).toBe(600);
    });

    it('verify pending does not credit wallet', async () => {
        enableZiinaGateway();
        const customer = await createZiinaCustomer();
        const client = makeHttpClient();
        mockCreateZiinaPayment(client);
        const result = await createZiinaIntent(customer);

        client.post.mockReset();
        client.get.mockReset();
        mockZiinaVerify(client, 'pending');

        const synced = await paymentService.syncPaymentStatus(result.payment._id, { actor: customer });

        expect(synced.payment.status).toBe(PAYMENT_STATUSES.PENDING);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
        expect((await User.findById(customer._id)).walletBalance).toBe(100);
    });

    it('verify failed marks payment failed and does not credit wallet', async () => {
        enableZiinaGateway();
        const customer = await createZiinaCustomer();
        const client = makeHttpClient();
        mockCreateZiinaPayment(client);
        const result = await createZiinaIntent(customer);

        client.post.mockReset();
        client.get.mockReset();
        mockZiinaVerify(client, 'failed', { latest_error: { message: 'declined' } });

        const synced = await paymentService.syncPaymentStatus(result.payment._id, { actor: customer });

        expect(synced.payment.status).toBe(PAYMENT_STATUSES.FAILED);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
        expect((await User.findById(customer._id)).walletBalance).toBe(100);
    });

    it('valid Ziina webhook verifies with provider before crediting', async () => {
        enableZiinaGateway({ ZIINA_WEBHOOK_SECRET: 'ziina-webhook-secret' });
        const customer = await createZiinaCustomer();
        const client = makeHttpClient();
        mockCreateZiinaPayment(client);
        const payment = (await createZiinaIntent(customer)).payment;

        client.post.mockReset();
        client.get.mockReset();
        mockZiinaVerify(client, 'completed');
        const payload = ziinaWebhookPayload();
        const signed = signedHeaders(payload);

        const result = await processWebhook(payload, signed.headers, signed.rawBody);

        expect(result.verification.mode).toBe('hmac_sha256');
        expect(result.event.status).toBe(PAYMENT_WEBHOOK_EVENT_STATUSES.PROCESSED);
        expect(result.payment.status).toBe(PAYMENT_STATUSES.SUCCEEDED);
        expect(client.get).toHaveBeenCalledWith('/payment_intent/pi_123', expect.any(Object));
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(1);
        expect((await User.findById(customer._id)).walletBalance).toBe(200);
        expect(result.event.paymentId.toString()).toBe(payment._id.toString());
    });

    it('invalid Ziina webhook signature rejects and does not credit or store an event', async () => {
        enableZiinaGateway({ ZIINA_WEBHOOK_SECRET: 'ziina-webhook-secret' });
        const payload = ziinaWebhookPayload();

        await expect(processWebhook(payload, {
            'x-hmac-signature': 'wrong-signature',
        }, Buffer.from(JSON.stringify(payload)))).rejects.toMatchObject({
            code: 'ZIINA_WEBHOOK_INVALID_SIGNATURE',
            statusCode: 401,
        });

        expect(await PaymentWebhookEvent.countDocuments()).toBe(0);
        expect(await WalletTransaction.countDocuments()).toBe(0);
    });
});
