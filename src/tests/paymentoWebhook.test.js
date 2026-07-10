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
    clearPaymentoEnv();
    axios.create.mockReset();
    await clearCollections();
    invalidateCurrencyCache('USD');
});
afterEach(() => {
    jest.restoreAllMocks();
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

    Object.entries(overrides).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });
};

const createPaymentoCustomer = async (overrides = {}) => {
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

const mockCreatePaymentoPayment = (client, reference = 'paymento-ref-1') => {
    client.post.mockResolvedValueOnce({
        data: {
            token: 'paymento-token-1',
            reference,
            status: 'Initialize',
        },
    });
};

const mockPaymentoVerify = (client, status = 'Paid', reference = 'paymento-ref-1') => {
    client.post.mockResolvedValueOnce({
        data: {
            paymentId: 'paymento-payment-1',
            reference,
            status,
        },
    });
};

const createPaymentoPayment = async (customer, client, overrides = {}, reference = 'paymento-ref-1') => {
    mockCreatePaymentoPayment(client, reference);
    const result = await paymentService.createPaymentIntent({
        userId: customer._id,
        amount: 75,
        currency: 'USD',
        gateway: PAYMENT_GATEWAYS.PAYMENTO,
        antiScamConfirmed: true,
        termsAccepted: true,
        ...overrides,
    });
    client.post.mockReset();
    return result.payment;
};

const paymentoWebhookPayload = (overrides = {}) => ({
    eventId: 'paymento-event-1',
    eventType: 'PAYMENT_STATUS_CHANGED',
    paymentId: 'paymento-payment-1',
    merchantReference: overrides.merchantReference,
    reference: 'paymento-ref-1',
    status: 'Paid',
    timestamp: '2026-07-07T00:00:00.000Z',
    ...overrides,
});

const signedHeaders = (payload, secret = 'paymento-ipn-secret', headers = {}) => {
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return {
        rawBody,
        headers: {
            'content-type': 'application/json',
            'user-agent': 'paymento-webhook-test',
            'x-paymento-signature': signature,
            ...headers,
        },
    };
};

const processWebhook = (payload, headers = {}, rawBody = null) => webhookService.processPaymentoWebhook({
    payload,
    headers: {
        'content-type': 'application/json',
        'user-agent': 'paymento-webhook-test',
        ...headers,
    },
    rawBody,
    requestMeta: {
        ipAddress: '127.0.0.1',
        userAgent: 'paymento-webhook-test',
    },
});

describe('Paymento webhook and reconciliation', () => {
    it('rejects invalid Paymento webhook signatures and does not store or credit', async () => {
        enablePaymentoGateway({ PAYMENTO_IPN_SECRET: 'paymento-ipn-secret' });
        const payload = paymentoWebhookPayload();

        await expect(processWebhook(payload, {
            'x-paymento-signature': 'wrong-signature',
        }, Buffer.from(JSON.stringify(payload)))).rejects.toMatchObject({
            code: 'PAYMENTO_WEBHOOK_INVALID_SIGNATURE',
            statusCode: 401,
        });

        expect(await PaymentWebhookEvent.countDocuments()).toBe(0);
        expect(await WalletTransaction.countDocuments()).toBe(0);
    });

    it('stores unmatched Paymento webhooks as UNMATCHED without crediting', async () => {
        enablePaymentoGateway({ PAYMENTO_IPN_SECRET: 'paymento-ipn-secret' });
        const payload = paymentoWebhookPayload({
            eventId: 'paymento-unmatched-1',
            paymentId: 'missing-paymento-payment',
            reference: 'missing-paymento-ref',
            merchantReference: 'missing-local-payment',
        });
        const signed = signedHeaders(payload);

        const result = await processWebhook(payload, signed.headers, signed.rawBody);

        expect(result.accepted).toBe(true);
        expect(result.unmatched).toBe(true);
        expect(result.event.status).toBe(PAYMENT_WEBHOOK_EVENT_STATUSES.UNMATCHED);
        expect(await PaymentWebhookEvent.countDocuments()).toBe(1);
        expect(await WalletTransaction.countDocuments()).toBe(0);
        expect(axios.create).not.toHaveBeenCalled();
    });

    it('verifies Paymento status before marking succeeded and credits wallet once', async () => {
        enablePaymentoGateway({ PAYMENTO_IPN_SECRET: 'paymento-ipn-secret' });
        const customer = await createPaymentoCustomer();
        const client = makeHttpClient();
        const payment = await createPaymentoPayment(customer, client);
        mockPaymentoVerify(client, 'Paid');
        const payload = paymentoWebhookPayload({
            eventId: 'paymento-paid-1',
            merchantReference: payment._id.toString(),
        });
        const signed = signedHeaders(payload);

        const result = await processWebhook(payload, signed.headers, signed.rawBody);

        expect(result.verification.mode).toBe('hmac_sha256');
        expect(result.event.status).toBe(PAYMENT_WEBHOOK_EVENT_STATUSES.PROCESSED);
        expect(result.payment.status).toBe(PAYMENT_STATUSES.SUCCEEDED);
        expect(client.post).toHaveBeenCalledWith(
            '/v1/payment/verify',
            { token: 'paymento-token-1' },
            expect.objectContaining({
                headers: expect.objectContaining({
                    'Api-key': 'paymento-test-api-key',
                }),
            })
        );
        const verifyOptions = client.post.mock.calls[0][2];
        expect(verifyOptions.headers).not.toHaveProperty('Authorization');
        expect(verifyOptions.headers).not.toHaveProperty('X-API-Key');

        const freshUser = await User.findById(customer._id);
        expect(freshUser.walletBalance).toBe(175);
        const transactions = await WalletTransaction.find({ userId: customer._id });
        expect(transactions).toHaveLength(1);
        expect(transactions[0].amount).toBe(75);
        expect(transactions[0].currency).toBe('USD');
    });

    it('does not double-credit duplicate Paymento webhook events', async () => {
        enablePaymentoGateway({ PAYMENTO_IPN_SECRET: 'paymento-ipn-secret' });
        const customer = await createPaymentoCustomer();
        const client = makeHttpClient();
        const payment = await createPaymentoPayment(customer, client);
        mockPaymentoVerify(client, 'Paid');
        const payload = paymentoWebhookPayload({
            eventId: 'paymento-duplicate-1',
            merchantReference: payment._id.toString(),
        });
        const signed = signedHeaders(payload);

        const first = await processWebhook(payload, signed.headers, signed.rawBody);
        expect(first.event.status).toBe(PAYMENT_WEBHOOK_EVENT_STATUSES.PROCESSED);

        client.post.mockReset();
        const second = await processWebhook(payload, signed.headers, signed.rawBody);

        expect(second.duplicate).toBe(true);
        expect(client.post).not.toHaveBeenCalled();
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(1);

        const event = await PaymentWebhookEvent.findById(first.event._id);
        expect(event.attempts).toBe(2);
    });

    it('does not credit partial-paid Paymento webhook after authoritative verify', async () => {
        enablePaymentoGateway({ PAYMENTO_IPN_SECRET: 'paymento-ipn-secret' });
        const customer = await createPaymentoCustomer();
        const client = makeHttpClient();
        const payment = await createPaymentoPayment(customer, client);
        mockPaymentoVerify(client, 'PartialPaid');
        const payload = paymentoWebhookPayload({
            eventId: 'paymento-partial-1',
            merchantReference: payment._id.toString(),
            status: 'Paid',
        });
        const signed = signedHeaders(payload);

        const result = await processWebhook(payload, signed.headers, signed.rawBody);

        expect(result.event.status).toBe(PAYMENT_WEBHOOK_EVENT_STATUSES.PROCESSED);
        expect(result.payment.status).toBe(PAYMENT_STATUSES.PENDING);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('does not credit timeout, canceled, or rejected Paymento statuses', async () => {
        enablePaymentoGateway({ PAYMENTO_IPN_SECRET: 'paymento-ipn-secret' });
        const cases = [
            ['Timeout', PAYMENT_STATUSES.EXPIRED],
            ['UserCanceled', PAYMENT_STATUSES.CANCELED],
            ['Reject', PAYMENT_STATUSES.FAILED],
        ];

        for (const [providerStatus, expectedStatus] of cases) {
            await clearCollections();
            const customer = await createPaymentoCustomer();
            const client = makeHttpClient();
            const payment = await createPaymentoPayment(customer, client, {}, `paymento-ref-${providerStatus}`);
            mockPaymentoVerify(client, providerStatus, `paymento-ref-${providerStatus}`);
            const payload = paymentoWebhookPayload({
                eventId: `paymento-${providerStatus}`,
                reference: `paymento-ref-${providerStatus}`,
                merchantReference: payment._id.toString(),
            });
            const signed = signedHeaders(payload);

            const result = await processWebhook(payload, signed.headers, signed.rawBody);

            expect(result.payment.status).toBe(expectedStatus);
            expect(result.payment.creditedAt).toBeNull();
            expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
        }
    });

    it('does not credit from Paymento payload alone when provider verification fails', async () => {
        enablePaymentoGateway({ PAYMENTO_IPN_SECRET: 'paymento-ipn-secret' });
        const customer = await createPaymentoCustomer();
        const client = makeHttpClient();
        const payment = await createPaymentoPayment(customer, client);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        client.post.mockRejectedValueOnce(new Error('verify unavailable'));
        const payload = paymentoWebhookPayload({
            eventId: 'paymento-verify-fails-1',
            merchantReference: payment._id.toString(),
            status: 'Paid',
        });
        const signed = signedHeaders(payload);

        const result = await processWebhook(payload, signed.headers, signed.rawBody);

        expect(result.event.status).toBe(PAYMENT_WEBHOOK_EVENT_STATUSES.FAILED);
        expect(result.errorCode).toBe('PAYMENTO_PAYMENT_STATUS_FAILED');
        expect(warnSpy).toHaveBeenCalledWith('[payments.paymento.failed]', expect.any(String));
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
        expect((await User.findById(customer._id)).walletBalance).toBe(100);
    });

    it('keeps Paymento webhook storage free of secrets, raw payloads, signatures, and auth headers', async () => {
        enablePaymentoGateway({ PAYMENTO_IPN_SECRET: 'paymento-ipn-secret' });
        const payload = paymentoWebhookPayload({
            eventId: 'paymento-sanitized-1',
            paymentId: 'missing-paymento-payment',
            merchantReference: 'missing-payment',
            token: 'provider-token',
            authorization: 'Bearer provider-token',
            secret: 'payload-secret',
        });
        const signed = signedHeaders(payload, 'paymento-ipn-secret', {
            authorization: 'Bearer provider-token',
        });

        await processWebhook(payload, signed.headers, signed.rawBody);

        const event = await PaymentWebhookEvent.findOne({ eventId: 'paymento-sanitized-1' }).lean();
        const stored = JSON.stringify(event);

        expect(stored).not.toContain('paymento-ipn-secret');
        expect(stored).not.toContain('provider-token');
        expect(stored).not.toContain('payload-secret');
        expect(stored).not.toContain('authorization');
        expect(stored).not.toContain(signed.headers['x-paymento-signature']);
        expect(event.httpHeaders).toMatchObject({
            'content-type': 'application/json',
            'user-agent': 'paymento-webhook-test',
        });
        expect(event.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('allows admin reconciliation while enforcing customer ownership', async () => {
        enablePaymentoGateway();
        const customer = await createPaymentoCustomer();
        const otherCustomer = await createPaymentoCustomer({ email: `other-sync-${Date.now()}@test.com` });
        const admin = await createAdmin();
        const client = makeHttpClient();
        const payment = await createPaymentoPayment(customer, client);

        await expect(paymentService.syncPaymentStatus(payment._id, { actor: otherCustomer }))
            .rejects.toMatchObject({ statusCode: 403 });
        expect(client.post).not.toHaveBeenCalled();

        mockPaymentoVerify(client, 'Approve');
        const result = await paymentService.syncPaymentStatus(payment._id, {
            actor: admin,
            source: 'admin_reconciliation',
        });

        expect(result.payment.status).toBe(PAYMENT_STATUSES.SUCCEEDED);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(1);
    });
});
