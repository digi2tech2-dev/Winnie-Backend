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
    createCustomerWithGroup,
} = require('./testHelpers');

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    clearNetworkEnv();
    delete process.env.PAYMENTS_ENABLED;
    delete process.env.PAYMENT_MIN_AMOUNT;
    delete process.env.PAYMENT_MAX_AMOUNT;
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
    platformRate: 50,
});

const createNetworkCustomer = async (overrides = {}) => {
    await createAedCurrency();
    if (overrides.currency === 'EGP') {
        await createEgpCurrency();
    }
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

const mockCreateOrder = (client, overrides = {}) => {
    client.post
        .mockResolvedValueOnce({ data: { access_token: 'test-access-token' } })
        .mockResolvedValueOnce({
            data: {
                _id: 'urn:order:network-order-1',
                reference: 'network-order-1',
                _links: {
                    payment: { href: 'https://pay.example.test/checkout/network-order-1' },
                },
                _embedded: {
                    payment: [{ state: 'STARTED' }],
                },
                ...overrides,
            },
        });
};

const createNetworkIntent = (customer, overrides = {}) => (
    paymentService.createPaymentIntent({
        userId: customer._id,
        amount: 123.45,
        currency: 'AED',
        gateway: PAYMENT_GATEWAYS.NETWORK_INTERNATIONAL,
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
                description: 'Network payment risk test settings',
            },
        },
        { upsert: true }
    );
};

describe('Network International hosted payment gateway', () => {
    it('requires Network configuration only when the gateway is selected', async () => {
        process.env.PAYMENT_ALLOWED_GATEWAYS = 'MOCK,NETWORK_INTERNATIONAL';
        const customer = await createNetworkCustomer();

        await expect(createNetworkIntent(customer))
            .rejects.toMatchObject({ code: 'NETWORK_PAYMENT_CONFIG_MISSING' });

        expect(axios.create).not.toHaveBeenCalled();
        expect(await Payment.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('creates a hosted Network order, stores checkout details, and does not credit the wallet', async () => {
        enableNetworkGateway();
        const customer = await createNetworkCustomer();
        const client = makeHttpClient();
        mockCreateOrder(client);

        const result = await createNetworkIntent(customer);

        expect(client.post).toHaveBeenNthCalledWith(
            1,
            '/identity/auth/access-token',
            {},
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Basic test-service-account-key',
                    'Content-Type': 'application/vnd.ni-identity.v1+json',
                }),
            })
        );
        expect(client.post).toHaveBeenNthCalledWith(
            2,
            '/transactions/outlets/outlet-123/orders',
            expect.objectContaining({
                action: 'SALE',
                amount: { currencyCode: 'AED', value: 12345 },
                merchantOrderReference: result.payment._id.toString(),
                merchantAttributes: {
                    redirectUrl: `https://winnie.example/payment/success?paymentId=${result.payment._id.toString()}`,
                    cancelUrl: `https://winnie.example/payment/cancel?paymentId=${result.payment._id.toString()}`,
                },
            }),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-access-token',
                    'Content-Type': 'application/vnd.ni-payment.v2+json',
                }),
            })
        );

        expect(result.payment.status).toBe(PAYMENT_STATUSES.REQUIRES_ACTION);
        expect(result.payment.gatewayPaymentId).toBe('urn:order:network-order-1');
        expect(result.payment.gatewayReference).toBe('network-order-1');
        expect(result.payment.checkoutUrl).toBe('https://pay.example.test/checkout/network-order-1');
        expect(result.checkout.url).toBe('https://pay.example.test/checkout/network-order-1');
        expect(result.payment.metadata.mode).toBe('network_international');
        expect(result.payment.metadata.gatewayMetadata.amountMinor).toBe(12345);
        expect(result.payment.metadata.gatewayCurrencyConversion).toMatchObject({
            requestedAmount: 123.45,
            requestedCurrency: 'AED',
            gatewayAmount: 123.45,
            gatewayCurrency: 'AED',
            exchangeRate: 1,
            exchangeRateSource: 'SAME_CURRENCY',
        });
        expect(result.checkout).toMatchObject({
            requestedAmount: 123.45,
            requestedCurrency: 'AED',
            gatewayAmount: 123.45,
            gatewayCurrency: 'AED',
            exchangeRate: 1,
        });
        expect(paymentService.serializePayment(result.payment)).toMatchObject({
            requestedAmount: 123.45,
            requestedCurrency: 'AED',
            gatewayAmount: 123.45,
            gatewayCurrency: 'AED',
            exchangeRate: 1,
        });

        const freshUser = await User.findById(customer._id);
        expect(freshUser.walletBalance).toBe(100);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('does not expose API keys or access tokens in serialized payment responses', async () => {
        enableNetworkGateway();
        const customer = await createNetworkCustomer();
        const client = makeHttpClient();
        mockCreateOrder(client);

        const result = await createNetworkIntent(customer);
        const serialized = paymentService.serializePayment(result.payment, { admin: true });
        const body = JSON.stringify({ payment: serialized, checkout: result.checkout });

        expect(body).not.toContain('test-service-account-key');
        expect(body).not.toContain('test-access-token');
        expect(body).not.toContain('outlet-123');
    });

    it('creates an AED Network order for an EGP requested wallet top-up', async () => {
        enableNetworkGateway();
        const customer = await createNetworkCustomer({ walletBalance: 500, currency: 'EGP' });
        const client = makeHttpClient();
        mockCreateOrder(client);

        const result = await createNetworkIntent(customer, {
            amount: 100,
            currency: 'EGP',
        });

        expect(client.post).toHaveBeenNthCalledWith(
            2,
            '/transactions/outlets/outlet-123/orders',
            expect.objectContaining({
                amount: { currencyCode: 'AED', value: 734 },
                merchantOrderReference: result.payment._id.toString(),
            }),
            expect.any(Object)
        );
        expect(result.payment.amount).toBe(100);
        expect(result.payment.currency).toBe('EGP');
        expect(result.payment.metadata.gatewayCurrencyConversion).toMatchObject({
            requestedAmount: 100,
            requestedCurrency: 'EGP',
            gatewayAmount: 7.34,
            gatewayCurrency: 'AED',
            exchangeRate: 0.0734,
            exchangeRateSource: 'PLATFORM_CURRENCY_RATES_VIA_USD',
            requestedAmountUsd: 2,
            requestedCurrencyRate: 50,
            gatewayCurrencyRate: 3.67,
        });
        expect(result.checkout).toMatchObject({
            requestedAmount: 100,
            requestedCurrency: 'EGP',
            gatewayAmount: 7.34,
            gatewayCurrency: 'AED',
            exchangeRate: 0.0734,
        });

        const freshUser = await User.findById(customer._id);
        expect(freshUser.walletBalance).toBe(500);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('returns a safe conversion error and skips Network HTTP calls when gateway currency rate is unavailable', async () => {
        enableNetworkGateway();
        await createEgpCurrency();
        const { customer } = await createCustomerWithGroup({
            walletBalance: 500,
            currency: 'EGP',
        });

        await expect(createNetworkIntent(customer, {
            amount: 100,
            currency: 'EGP',
        })).rejects.toMatchObject({ code: 'PAYMENT_CURRENCY_CONVERSION_UNAVAILABLE' });

        expect(axios.create).not.toHaveBeenCalled();
        expect(await Payment.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('logs safe backend diagnostics when Network create order fails', async () => {
        enableNetworkGateway();
        const customer = await createNetworkCustomer();
        const client = makeHttpClient();
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        client.post
            .mockResolvedValueOnce({ data: { access_token: 'test-access-token' } })
            .mockRejectedValueOnce({
                message: 'Request failed with status code 422',
                config: {
                    url: '/transactions/outlets/outlet-123/orders',
                    headers: {
                        Authorization: 'Bearer test-access-token',
                    },
                },
                response: {
                    status: 422,
                    data: {
                        code: 'INVALID_REQUEST',
                        message: 'Invalid order for outlet-123',
                        access_token: 'test-access-token',
                        debug: {
                            outletRef: 'outlet-123',
                            apiKey: 'test-service-account-key',
                        },
                    },
                },
            });

        await expect(createNetworkIntent(customer))
            .rejects.toMatchObject({
                code: 'NETWORK_CREATE_ORDER_FAILED',
                message: 'Online payment is temporarily unavailable. Please try again later or use manual deposit.',
            });

        expect(warnSpy).toHaveBeenCalledWith(
            '[payments.networkInternational.createOrder.failed]',
            expect.any(String)
        );
        const loggedPayload = warnSpy.mock.calls[0][1];
        const parsedPayload = JSON.parse(loggedPayload);
        expect(parsedPayload).toMatchObject({
            endpointPath: '/transactions/outlets/[REDACTED]/orders',
            httpStatus: 422,
            networkErrorCode: 'INVALID_REQUEST',
            networkErrorMessage: 'Invalid order for [REDACTED]',
            responseBody: {
                code: 'INVALID_REQUEST',
                message: 'Invalid order for [REDACTED]',
                access_token: '[REDACTED]',
                debug: {
                    outletRef: '[REDACTED]',
                    apiKey: '[REDACTED]',
                },
            },
        });
        expect(loggedPayload).not.toContain('test-service-account-key');
        expect(loggedPayload).not.toContain('test-access-token');
        expect(loggedPayload).not.toContain('outlet-123');
        expect(loggedPayload).not.toContain('Authorization');
    });

    it('does not call Network when payment risk blocks the intent', async () => {
        enableNetworkGateway();
        const customer = await createNetworkCustomer();
        await saveRiskSettings({ maxSingleAmount: 1 });

        await expect(createNetworkIntent(customer, { amount: 100 }))
            .rejects.toMatchObject({ code: 'PAYMENT_RISK_LIMIT_REACHED' });

        expect(axios.create).not.toHaveBeenCalled();
        expect(await Payment.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('keeps idempotency safe and does not create a second Network order', async () => {
        enableNetworkGateway();
        const customer = await createNetworkCustomer({ currency: 'EGP', walletBalance: 500 });
        const client = makeHttpClient();
        mockCreateOrder(client);

        const first = await createNetworkIntent(customer, {
            amount: 100,
            currency: 'EGP',
            idempotencyKey: 'network-idem-1',
        });
        const second = await createNetworkIntent(customer, {
            amount: 100,
            currency: 'EGP',
            idempotencyKey: 'network-idem-1',
        });

        expect(second.idempotent).toBe(true);
        expect(second.payment._id.toString()).toBe(first.payment._id.toString());
        expect(second.checkout).toMatchObject({
            requestedAmount: 100,
            requestedCurrency: 'EGP',
            gatewayAmount: 7.34,
            gatewayCurrency: 'AED',
        });
        expect(client.post).toHaveBeenCalledTimes(2);
        expect(await Payment.countDocuments({ userId: customer._id })).toBe(1);
    });

    it('syncs authoritative purchased status and credits the wallet once', async () => {
        enableNetworkGateway();
        const customer = await createNetworkCustomer({ currency: 'EGP', walletBalance: 500 });
        const client = makeHttpClient();
        mockCreateOrder(client);
        const result = await createNetworkIntent(customer, { amount: 100, currency: 'EGP' });

        client.post.mockReset();
        client.get.mockReset();
        client.post.mockResolvedValueOnce({ data: { access_token: 'sync-access-token' } });
        client.get.mockResolvedValueOnce({
            data: {
                _id: 'urn:order:network-order-1',
                reference: 'network-order-1',
                amount: { currencyCode: 'AED', value: 734 },
                _embedded: {
                    payment: [{ state: 'PURCHASED' }],
                },
            },
        });

        const synced = await paymentService.syncPaymentStatus(result.payment._id, { actor: customer });

        expect(client.get).toHaveBeenCalledWith(
            '/transactions/outlets/outlet-123/orders/network-order-1',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer sync-access-token',
                    Accept: 'application/vnd.ni-payment.v2+json',
                }),
            })
        );
        expect(synced.payment.status).toBe(PAYMENT_STATUSES.SUCCEEDED);
        expect(synced.payment.creditedAt).not.toBeNull();
        expect(synced.providerStatus).toBe('PURCHASED');

        const second = await paymentService.syncPaymentStatus(result.payment._id, { actor: customer });
        expect(second.alreadyProcessed).toBe(true);

        const freshUser = await User.findById(customer._id);
        expect(freshUser.walletBalance).toBe(600);
        const walletCredit = await WalletTransaction.findOne({
            userId: customer._id,
            semanticType: 'CARD_PAYMENT_SUCCESS',
        });
        expect(walletCredit.amount).toBe(100);
        expect(walletCredit.currency).toBe('EGP');
        expect(await WalletTransaction.countDocuments({
            userId: customer._id,
            semanticType: 'CARD_PAYMENT_SUCCESS',
        })).toBe(1);
    });
});
