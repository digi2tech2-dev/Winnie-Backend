'use strict';

jest.mock('axios');

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
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { User } = require('../modules/users/user.model');
const { invalidateCurrencyCache } = require('../services/currencyConverter.service');
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
    clearNetworkEnv();
    axios.create.mockReset();
    await clearCollections();
    invalidateCurrencyCache('AED');
    invalidateCurrencyCache('EGP');
});
afterEach(() => {
    jest.restoreAllMocks();
    invalidateCurrencyCache('AED');
    invalidateCurrencyCache('EGP');
    clearNetworkEnv();
    process.env.NODE_ENV = 'test';
});

const clearNetworkEnv = () => {
    delete process.env.PAYMENT_ALLOWED_GATEWAYS;
    delete process.env.PAYMENT_DEFAULT_GATEWAY;
    delete process.env.NETWORK_INTERNATIONAL_ENABLED;
    delete process.env.NETWORK_INTERNATIONAL_ENV;
    delete process.env.NETWORK_INTERNATIONAL_BASE_URL;
    delete process.env.NETWORK_INTERNATIONAL_API_KEY;
    delete process.env.NETWORK_INTERNATIONAL_OUTLET_REF;
    delete process.env.NETWORK_INTERNATIONAL_CURRENCY;
    delete process.env.NETWORK_INTERNATIONAL_RETURN_URL;
    delete process.env.NETWORK_INTERNATIONAL_CANCEL_URL;
    delete process.env.NETWORK_INTERNATIONAL_WEBHOOK_SECRET;
    delete process.env.NETWORK_INTERNATIONAL_WEBHOOK_SECRET_HEADER;
};

const enableNetworkGateway = (overrides = {}) => {
    process.env.PAYMENT_ALLOWED_GATEWAYS = 'MOCK,NETWORK_INTERNATIONAL';
    process.env.NETWORK_INTERNATIONAL_ENABLED = 'true';
    process.env.NETWORK_INTERNATIONAL_ENV = 'sandbox';
    process.env.NETWORK_INTERNATIONAL_BASE_URL = 'https://network.example.test';
    process.env.NETWORK_INTERNATIONAL_API_KEY = 'test-service-account-key';
    process.env.NETWORK_INTERNATIONAL_OUTLET_REF = 'outlet-123';
    process.env.NETWORK_INTERNATIONAL_CURRENCY = 'AED';
    process.env.NETWORK_INTERNATIONAL_RETURN_URL = 'https://winnie.example/payment/success';
    process.env.NETWORK_INTERNATIONAL_CANCEL_URL = 'https://winnie.example/payment/cancel';

    Object.entries(overrides).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });
};

const createAedCurrency = () => Currency.updateOne(
    { code: 'AED' },
    {
        $set: {
            code: 'AED',
            name: 'UAE Dirham',
            symbol: 'AED',
            platformRate: 3.67,
            isActive: true,
        },
    },
    { upsert: true }
);

const createNetworkCustomer = async (overrides = {}) => {
    await createAedCurrency();
    const { customer } = await createCustomerWithGroup({
        walletBalance: 100,
        currency: 'AED',
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

const mockCreateOrder = (client, reference = 'network-order-1') => {
    client.post
        .mockResolvedValueOnce({ data: { access_token: 'create-access-token' } })
        .mockResolvedValueOnce({
            data: {
                _id: `urn:order:${reference}`,
                reference,
                _links: {
                    payment: { href: `https://pay.example.test/checkout/${reference}` },
                },
                _embedded: {
                    payment: [{ state: 'STARTED' }],
                },
            },
        });
};

const mockStatusFetch = (client, state = 'PURCHASED', reference = 'network-order-1') => {
    client.post.mockResolvedValueOnce({ data: { access_token: 'sync-access-token' } });
    client.get.mockResolvedValueOnce({
        data: {
            _id: `urn:order:${reference}`,
            reference,
            amount: { currencyCode: 'AED', value: 12345 },
            _embedded: {
                payment: [{ state }],
            },
        },
    });
};

const createNetworkPayment = async (customer, client, overrides = {}, reference = 'network-order-1') => {
    mockCreateOrder(client, reference);
    const result = await paymentService.createPaymentIntent({
        userId: customer._id,
        amount: 123.45,
        currency: 'AED',
        gateway: PAYMENT_GATEWAYS.NETWORK_INTERNATIONAL,
        ...overrides,
    });
    client.post.mockReset();
    client.get.mockReset();
    return result.payment;
};

const networkWebhookPayload = (overrides = {}) => ({
    eventId: 'network-event-1',
    eventType: 'ORDER_STATUS_CHANGED',
    reference: 'network-order-1',
    _id: 'urn:order:network-order-1',
    status: 'PURCHASED',
    timestamp: '2026-07-03T00:00:00.000Z',
    ...overrides,
});

const processWebhook = (payload, headers = {}) => webhookService.processNetworkWebhook({
    payload,
    headers: {
        'content-type': 'application/json',
        'user-agent': 'network-webhook-test',
        ...headers,
    },
    requestMeta: {
        ipAddress: '127.0.0.1',
        userAgent: 'network-webhook-test',
    },
});

describe('Network International webhook and reconciliation', () => {
    it('accepts and stores an unmatched webhook without wallet credit', async () => {
        enableNetworkGateway();
        const result = await processWebhook(networkWebhookPayload({
            eventId: 'unmatched-event-1',
            reference: 'missing-network-order',
        }));

        expect(result.accepted).toBe(true);
        expect(result.unmatched).toBe(true);
        expect(result.event.status).toBe(PAYMENT_WEBHOOK_EVENT_STATUSES.UNMATCHED);
        expect(await PaymentWebhookEvent.countDocuments()).toBe(1);
        expect(await WalletTransaction.countDocuments()).toBe(0);
        expect(axios.create).not.toHaveBeenCalled();
    });

    it('rejects invalid webhook secret when a shared header secret is configured', async () => {
        enableNetworkGateway({
            NETWORK_INTERNATIONAL_WEBHOOK_SECRET: 'expected-secret',
            NETWORK_INTERNATIONAL_WEBHOOK_SECRET_HEADER: 'x-network-shared-secret',
        });

        await expect(processWebhook(networkWebhookPayload(), {
            'x-network-shared-secret': 'wrong-secret',
        })).rejects.toMatchObject({ code: 'PAYMENT_WEBHOOK_INVALID_SECRET', statusCode: 401 });

        expect(await PaymentWebhookEvent.countDocuments()).toBe(0);
        expect(await WalletTransaction.countDocuments()).toBe(0);
    });

    it('accepts unverified mode but verifies Network status before crediting wallet', async () => {
        enableNetworkGateway();
        const customer = await createNetworkCustomer();
        const client = makeHttpClient();
        const payment = await createNetworkPayment(customer, client);
        mockStatusFetch(client, 'PURCHASED');

        const result = await processWebhook(networkWebhookPayload());

        expect(result.verification.mode).toBe('unverified');
        expect(result.event.status).toBe(PAYMENT_WEBHOOK_EVENT_STATUSES.PROCESSED);
        expect(result.payment.status).toBe(PAYMENT_STATUSES.SUCCEEDED);
        expect(client.post).toHaveBeenCalledWith(
            '/identity/auth/access-token',
            {},
            expect.any(Object)
        );
        expect(client.get).toHaveBeenCalledWith(
            '/transactions/outlets/outlet-123/orders/network-order-1',
            expect.any(Object)
        );

        const freshUser = await User.findById(customer._id);
        expect(freshUser.walletBalance).toBe(223.45);
        const transactions = await WalletTransaction.find({ userId: customer._id });
        expect(transactions).toHaveLength(1);
        expect(transactions[0].amount).toBe(123.45);
        expect(transactions[0].currency).toBe('AED');

        const freshPayment = await Payment.findById(payment._id);
        expect(freshPayment.amount).toBe(123.45);
        expect(freshPayment.currency).toBe('AED');
    });

    it('does not double-credit duplicate webhook events', async () => {
        enableNetworkGateway();
        const customer = await createNetworkCustomer();
        const client = makeHttpClient();
        await createNetworkPayment(customer, client);
        mockStatusFetch(client, 'PURCHASED');

        const first = await processWebhook(networkWebhookPayload({ eventId: 'duplicate-event-1' }));
        expect(first.event.status).toBe(PAYMENT_WEBHOOK_EVENT_STATUSES.PROCESSED);

        client.post.mockReset();
        client.get.mockReset();
        const second = await processWebhook(networkWebhookPayload({ eventId: 'duplicate-event-1' }));

        expect(second.duplicate).toBe(true);
        expect(client.post).not.toHaveBeenCalled();
        expect(client.get).not.toHaveBeenCalled();
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(1);

        const event = await PaymentWebhookEvent.findById(first.event._id);
        expect(event.attempts).toBe(2);
    });

    it('does not credit when authoritative Network status is failed', async () => {
        enableNetworkGateway();
        const customer = await createNetworkCustomer();
        const client = makeHttpClient();
        const payment = await createNetworkPayment(customer, client);
        mockStatusFetch(client, 'DECLINED');

        const result = await processWebhook(networkWebhookPayload({ eventId: 'failed-event-1', status: 'PURCHASED' }));

        expect(result.event.status).toBe(PAYMENT_WEBHOOK_EVENT_STATUSES.PROCESSED);
        expect(result.payment.status).toBe(PAYMENT_STATUSES.FAILED);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);

        const freshPayment = await Payment.findById(payment._id);
        expect(freshPayment.status).toBe(PAYMENT_STATUSES.FAILED);
        expect(freshPayment.creditedAt).toBeNull();
    });

    it('does not credit from webhook payload alone when Network status verification fails', async () => {
        enableNetworkGateway();
        const customer = await createNetworkCustomer();
        const client = makeHttpClient();
        await createNetworkPayment(customer, client);
        client.post.mockRejectedValueOnce(new Error('token unavailable'));

        const result = await processWebhook(networkWebhookPayload({
            eventId: 'verify-fails-event-1',
            status: 'PURCHASED',
        }));

        expect(result.event.status).toBe(PAYMENT_WEBHOOK_EVENT_STATUSES.FAILED);
        expect(result.errorCode).toBe('NETWORK_ACCESS_TOKEN_FAILED');
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);

        const freshUser = await User.findById(customer._id);
        expect(freshUser.walletBalance).toBe(100);
    });

    it('keeps webhook storage free of secrets, headers, and card data', async () => {
        enableNetworkGateway({
            NETWORK_INTERNATIONAL_WEBHOOK_SECRET: 'expected-secret',
        });

        await processWebhook(networkWebhookPayload({
            eventId: 'sanitized-event-1',
            reference: 'missing-network-order',
            card: {
                number: '4111111111111111',
                cvv: 'cvv-secret-value',
            },
            access_token: 'provider-token',
        }), {
            authorization: 'Bearer provider-token',
            'x-network-webhook-secret': 'expected-secret',
        });

        const event = await PaymentWebhookEvent.findOne({ eventId: 'sanitized-event-1' }).lean();
        const stored = JSON.stringify(event);

        expect(stored).not.toContain('4111111111111111');
        expect(stored).not.toContain('cvv-secret-value');
        expect(stored).not.toContain('provider-token');
        expect(stored).not.toContain('expected-secret');
        expect(stored).not.toContain('authorization');
        expect(event.httpHeaders).toMatchObject({
            'content-type': 'application/json',
            'user-agent': 'network-webhook-test',
        });
        expect(event.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('keeps webhook and manual sync idempotent in both orders', async () => {
        enableNetworkGateway();
        const customer = await createNetworkCustomer();
        const client = makeHttpClient();
        const payment = await createNetworkPayment(customer, client);

        mockStatusFetch(client, 'PURCHASED');
        const manualFirst = await paymentService.syncPaymentStatus(payment._id, { actor: customer });
        expect(manualFirst.payment.status).toBe(PAYMENT_STATUSES.SUCCEEDED);

        client.post.mockReset();
        client.get.mockReset();
        const webhookAfterSync = await processWebhook(networkWebhookPayload({ eventId: 'after-sync-event-1' }));
        expect(webhookAfterSync.syncResult.alreadyProcessed).toBe(true);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(1);

        const otherCustomer = await createNetworkCustomer({ email: `other-${Date.now()}@test.com` });
        mockCreateOrder(client, 'network-order-2');
        const secondPaymentResult = await paymentService.createPaymentIntent({
            userId: otherCustomer._id,
            amount: 50,
            currency: 'AED',
            gateway: PAYMENT_GATEWAYS.NETWORK_INTERNATIONAL,
        });
        client.post.mockReset();
        client.get.mockReset();
        mockStatusFetch(client, 'PURCHASED', 'network-order-2');
        const webhookFirst = await processWebhook(networkWebhookPayload({
            eventId: 'before-sync-event-1',
            reference: secondPaymentResult.payment.gatewayReference,
            _id: secondPaymentResult.payment.gatewayPaymentId,
        }));
        expect(webhookFirst.payment.status).toBe(PAYMENT_STATUSES.SUCCEEDED);

        const syncAfterWebhook = await paymentService.syncPaymentStatus(secondPaymentResult.payment._id, {
            actor: otherCustomer,
        });
        expect(syncAfterWebhook.alreadyProcessed).toBe(true);
        expect(await WalletTransaction.countDocuments({ userId: otherCustomer._id })).toBe(1);
    });

    it('enforces reconciliation ownership while allowing admin sync', async () => {
        enableNetworkGateway();
        const customer = await createNetworkCustomer();
        const otherCustomer = await createNetworkCustomer({ email: `other-sync-${Date.now()}@test.com` });
        const admin = await createAdmin();
        const client = makeHttpClient();
        const payment = await createNetworkPayment(customer, client);

        await expect(paymentService.syncPaymentStatus(payment._id, { actor: otherCustomer }))
            .rejects.toMatchObject({ statusCode: 403 });
        expect(client.post).not.toHaveBeenCalled();
        expect(client.get).not.toHaveBeenCalled();

        mockStatusFetch(client, 'PURCHASED');
        const result = await paymentService.syncPaymentStatus(payment._id, {
            actor: admin,
            source: 'admin_reconciliation',
        });

        expect(result.payment.status).toBe(PAYMENT_STATUSES.SUCCEEDED);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(1);
    });
});
