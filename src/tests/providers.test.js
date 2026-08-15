'use strict';

process.env.FAZERCARDS_ENABLED = 'true';
process.env.FAZERCARDS_API_KEY = 'test-fazer-key';
process.env.FAZERCARDS_API_BASE_URL = 'https://api.fzr.cards/api/v2';
process.env.FAZERCARDS_TIMEOUT_MS = '20000';
process.env.FAZERCARDS_REAL_ORDERS_ENABLED = 'false';
process.env.FAZERCARDS_WEBHOOK_ENABLED = 'false';
process.env.FAZERCARDS_WEBHOOK_SECRET = '';

jest.mock('axios');

const axios = require('axios');
const config = require('../config/config');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct, FULFILLMENT_MODES } = require('../modules/providers/providerProduct.model');
const { Product, EXECUTION_TYPES, PRODUCT_STATUSES } = require('../modules/products/product.model');
const { Order, ORDER_STATUS, ORDER_EXECUTION_TYPES } = require('../modules/orders/order.model');
const orderService = require('../modules/orders/order.service');
const { executeOrder } = require('../modules/orders/orderFulfillment.service');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { User } = require('../modules/users/user.model');
const productService = require('../modules/products/product.service');
const fazerCardsCatalogSvc = require('../modules/providers/fazercards/fazercardsCatalog.service');
const fazerCardsWebhookSvc = require('../modules/providers/fazercards/fazercards.webhook.service');
const fazerCardsContracts = require('../modules/providers/fazercards/fazercardsContracts');
const { FazerCardsClient } = require('../modules/providers/fazercards/fazercards.client');
const { ProviderDeliveredCode } = require('../modules/providers/fazercards/providerDeliveredCode.model');
const { ProviderPilotOrder } = require('../modules/providers/fazercards/providerPilotOrder.model');
const { FazerCardsWebhookEvent } = require('../modules/providers/fazercards/fazercardsWebhookEvent.model');
const { decryptSecret, isEncryptedSecret } = require('../shared/utils/secretEncryption');
const {
    FazerCardsAdapter,
    normalizeTopupOfferProduct,
} = require('../modules/providers/fazercards/fazercards.adapter');
const { PROVIDER_CODES } = require('../modules/providers/provider.constants');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
} = require('./testHelpers');

const makeClient = () => ({
    request: jest.fn(),
});

const createFazerTopupProviderProduct = async (overrides = {}) => {
    const { provider: providerOverride, ...productOverrides } = overrides;
    const provider = providerOverride || await Provider.findOne({ providerCode: PROVIDER_CODES.FAZER_CARDS }) || await Provider.create({
        name: 'FazerCards',
        slug: 'fazer-cards',
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        baseUrl: 'https://api.fzr.cards/api/v2',
        isActive: true,
        syncInterval: 0,
    });
    const providerProduct = await ProviderProduct.create({
        provider: provider._id,
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        externalProductId: 'FAZER_TOPUP:8_ball_pool:golden_spin',
        rawName: '8 Ball Pool - Golden Spin',
        rawPrice: '0.7487',
        costPrice: '0.7487',
        category: '8_ball_pool',
        categoryName: '8 Ball Pool',
        offerId: 'golden_spin',
        offerName: 'Golden Spin',
        currency: 'USD',
        minQty: 1,
        maxQty: 1,
        isActive: true,
        available: true,
        fulfillmentMode: FULFILLMENT_MODES.TOPUP_WITH_FIELDS,
        isSupported: true,
        isBlocked: false,
        requiredFields: [{ key: 'user_id', label: 'Unique ID', type: 'text', required: true }],
        rawPayload: {
            category: { category_id: '8_ball_pool', name: '8 Ball Pool' },
            offer: { offer_id: 'golden_spin', name: 'Golden Spin', price_usd: '0.7487' },
            fields: [{ key: 'user_id', label: 'Unique ID', type: 'text' }],
        },
        ...productOverrides,
    });
    return { provider, providerProduct };
};

const createFazerCodeDeliveryProviderProduct = async ({ familyKey = 'GIFTCARDS', overrides = {} } = {}) => {
    const provider = await Provider.findOne({ providerCode: PROVIDER_CODES.FAZER_CARDS }) || await Provider.create({
        name: 'FazerCards',
        slug: 'fazer-cards',
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        baseUrl: 'https://api.fzr.cards/api/v2',
        isActive: true,
        syncInterval: 0,
    });
    const isGameKey = familyKey === 'GAME_KEYS';
    const base = isGameKey
        ? {
            externalProductId: 'FAZER_GAMEKEY:against_the_storm_cis:keepers_of_the_stone',
            rawName: 'Against the Storm CIS - Keepers of the Stone',
            rawPrice: '4.7877',
            costPrice: '4.7877',
            category: 'against_the_storm_cis',
            categoryName: 'Against the Storm CIS',
            offerId: 'keepers_of_the_stone',
            offerName: 'Keepers of the Stone',
            familyKey: 'GAME_KEYS',
            stock: 1,
            minQty: 1,
            maxQty: 1,
            region: 'CIS',
            platform: 'Steam',
            rawPayload: {
                family: 'GAME_KEYS',
                game: { game_id: 'against_the_storm_cis', name: 'Against the Storm', region: 'CIS', platform: 'Steam' },
                key: { key_id: 'keepers_of_the_stone', name: 'Keepers of the Stone', price_usd: '4.7877', stock: 1 },
            },
        }
        : {
            externalProductId: 'FAZER_GIFTCARD:acash_my:10_myr',
            rawName: 'A-Cash (MY) - 10 MYR',
            rawPrice: '2.6029',
            costPrice: '2.6029',
            category: 'acash_my',
            categoryName: 'A-Cash (MY)',
            offerId: '10_myr',
            offerName: '10 MYR',
            familyKey: 'GIFTCARDS',
            stock: 100,
            minQty: 1,
            maxQty: 10,
            rawPayload: {
                family: 'GIFTCARDS',
                category: { category_id: 'acash_my', name: 'A-Cash (MY)' },
                offer: { card_id: '10_myr', name: '10 MYR', price_usd: '2.6029', stock: 100 },
            },
        };

    const providerProduct = await ProviderProduct.create({
        provider: provider._id,
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        currency: 'USD',
        isActive: true,
        available: true,
        fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
        supportLevel: 'CATALOG_ONLY',
        executionBlocked: false,
        isSupported: true,
        isBlocked: false,
        blockReason: null,
        requiredFields: [],
        ...base,
        ...overrides,
    });

    return { provider, providerProduct };
};

const createFazerCatalogOnlyProviderProduct = async ({ familyKey = 'TELEGRAM', overrides = {} } = {}) => {
    const provider = await Provider.findOne({ providerCode: PROVIDER_CODES.FAZER_CARDS }) || await Provider.create({
        name: 'FazerCards',
        slug: 'fazer-cards',
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        baseUrl: 'https://api.fzr.cards/api/v2',
        isActive: true,
        syncInterval: 0,
    });
    const defaultsByFamily = {
        TELEGRAM: {
            externalProductId: 'FAZER_TELEGRAM:STARS',
            rawName: 'Telegram Stars',
            rawPrice: '0.02',
            costPrice: '0.02',
            category: 'telegram',
            categoryName: 'Telegram',
            offerId: 'stars',
            offerName: 'Stars',
            familyKey: 'TELEGRAM',
            fulfillmentMode: FULFILLMENT_MODES.TELEGRAM_STARS_TOPUP,
            supportLevel: 'NEEDS_SPECIAL_FIELDS',
            blockReason: 'TELEGRAM_EXECUTION_NOT_IMPLEMENTED',
            requiredFields: [{ key: 'telegram_username', label: 'Telegram Username', type: 'text', required: true }],
            rawPayload: { family: 'TELEGRAM', kind: 'telegram_stars', response: { price_per_star: '0.02' } },
        },
        STEAM_TOPUP: {
            externalProductId: 'FAZER_STEAM_TOPUP:USD',
            rawName: 'Steam Wallet Top-up - USD',
            rawPrice: '1',
            costPrice: '1',
            category: 'steam_topup',
            categoryName: 'Steam Wallet Top-up',
            offerId: 'USD',
            offerName: 'USD',
            familyKey: 'STEAM_TOPUP',
            fulfillmentMode: FULFILLMENT_MODES.STEAM_TOPUP_WITH_LOGIN,
            supportLevel: 'NEEDS_SPECIAL_FIELDS',
            blockReason: 'STEAM_TOPUP_EXECUTION_NOT_IMPLEMENTED',
            requiredFields: [{ key: 'steamLogin', label: 'Steam Login', type: 'text', required: true }],
            rawPayload: { family: 'STEAM_TOPUP', rateCurrency: 'USD', rate: 1 },
        },
        MANUAL_SERVICES: {
            externalProductId: 'FAZER_MANUAL_SERVICE:social_boost:starter',
            rawName: 'Social Boost - Starter',
            rawPrice: '0.75',
            costPrice: '0.75',
            category: 'social_boost',
            categoryName: 'Social Boost',
            offerId: 'starter',
            offerName: 'Starter',
            familyKey: 'MANUAL_SERVICES',
            fulfillmentMode: FULFILLMENT_MODES.MANUAL_SERVICE,
            supportLevel: 'NEEDS_SPECIAL_FIELDS',
            blockReason: 'MANUAL_SERVICE_EXECUTION_NOT_IMPLEMENTED',
            requiredFields: [],
            rawPayload: {
                family: 'MANUAL_SERVICES',
                category: { id: 'social_boost', name: 'Social Boost' },
                offer: { id: 'starter', name: 'Starter', price_usd: '0.75' },
            },
        },
    };
    const base = defaultsByFamily[familyKey] || defaultsByFamily.TELEGRAM;
    const providerProduct = await ProviderProduct.create({
        provider: provider._id,
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        currency: 'USD',
        isActive: true,
        available: true,
        executionBlocked: true,
        isSupported: false,
        isBlocked: true,
        minQty: 1,
        maxQty: 9999,
        ...base,
        ...overrides,
    });

    return { provider, providerProduct };
};

const createReadyCodeDeliveryProduct = async ({ familyKey = 'GIFTCARDS', sellPrice = 3.25 } = {}) => {
    const { provider, providerProduct } = await createFazerCodeDeliveryProviderProduct({ familyKey });
    const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
        sellPrice,
        name: familyKey === 'GAME_KEYS' ? 'Against the Storm Key' : 'A-Cash MY 10',
    });
    await ProviderProduct.findByIdAndUpdate(providerProduct._id, {
        $set: {
            executionBlocked: false,
        },
    });
    const updatedProduct = await Product.findByIdAndUpdate(product._id, {
        $set: {
            providerExecutionEnabled: true,
            providerExecutionBlocked: false,
            providerBlockReason: null,
        },
    }, { new: true });
    const updatedProviderProduct = await ProviderProduct.findById(providerProduct._id);
    return { provider, providerProduct: updatedProviderProduct, product: updatedProduct };
};

const createFazerTopupOrder = async ({
    providerExecutionEnabled = true,
    customerFields = { user_id: '00123456789' },
    walletDeducted = 50,
    providerProductOverrides = {},
    productOverrides = {},
} = {}) => {
    const { provider, providerProduct } = await createFazerTopupProviderProduct(providerProductOverrides);
    const { customer, group } = await createCustomerWithGroup({ walletBalance: 1000 }, { percentage: 0 });
    const product = await Product.create({
        name: `Fazer Topup ${Date.now()} ${Math.random()}`,
        basePrice: '1.49',
        providerPrice: '0.7487',
        finalPrice: '1.49',
        minQty: 1,
        maxQty: 1,
        isActive: true,
        visibleInStore: true,
        status: PRODUCT_STATUSES.AVAILABLE,
        executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
        provider,
        providerProduct,
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        externalProductId: providerProduct.externalProductId,
        providerExecutionEnabled,
        orderFields: [{
            id: 'user_id',
            key: 'user_id',
            label: 'Unique ID',
            type: 'text',
            required: true,
            isActive: true,
        }],
        providerMapping: {},
        ...productOverrides,
    });
    const order = await Order.create({
        userId: customer._id,
        orderNumber: 880000 + Math.floor(Math.random() * 10000),
        productId: product._id,
        quantity: 1,
        unitPrice: '1.49',
        totalPrice: '1.49',
        basePriceSnapshot: '1.49',
        markupPercentageSnapshot: 0,
        finalPriceCharged: '1.49',
        groupIdSnapshot: group._id,
        walletDeducted,
        creditUsedAmount: '0',
        status: ORDER_STATUS.PROCESSING,
        executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
        providerCode: 'fazer-cards',
        customerInput: {
            values: customerFields,
            fieldsSnapshot: [{ key: 'user_id', label: 'Unique ID', type: 'text', required: true }],
        },
    });

    return { provider, providerProduct, product, order, customer };
};

const createFazerCodeDeliveryOrder = async ({
    familyKey = 'GIFTCARDS',
    walletDeducted = 50,
    providerOrderId = 'fc_code_order',
    status = ORDER_STATUS.PROCESSING,
} = {}) => {
    const { provider, providerProduct, product } = await createReadyCodeDeliveryProduct({ familyKey });
    const { customer, group } = await createCustomerWithGroup({ walletBalance: 1000 }, { percentage: 0 });
    const order = await Order.create({
        userId: customer._id,
        orderNumber: 885000 + Math.floor(Math.random() * 10000),
        productId: product._id,
        quantity: 1,
        unitPrice: '3.25',
        totalPrice: '3.25',
        basePriceSnapshot: '3.25',
        markupPercentageSnapshot: 0,
        finalPriceCharged: '3.25',
        groupIdSnapshot: group._id,
        walletDeducted,
        creditUsedAmount: '0',
        status,
        executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
        providerCode: 'fazer-cards',
        providerOrderId,
        providerStatus: 'Pending',
        providerIdempotencyKey: `fazercards:code-delivery:${providerOrderId}`,
        familyKey,
        fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
        customerInput: {
            values: {},
            fieldsSnapshot: [],
        },
    });
    return { provider, providerProduct, product, order, customer };
};

const originalFazerConfig = { ...config.providers.fazerCards };

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    config.providers.fazerCards = originalFazerConfig;
    await disconnectTestDB();
});

beforeEach(async () => {
    config.providers.fazerCards.enabled = true;
    config.providers.fazerCards.apiKey = 'test-fazer-key';
    config.providers.fazerCards.apiBaseUrl = 'https://api.fzr.cards/api/v2';
    config.providers.fazerCards.timeoutMs = 20000;
    config.providers.fazerCards.topupOrderStatusPath = null;
    config.providers.fazerCards.realOrdersEnabled = false;
    config.providers.fazerCards.maxOrderUsd = 1.00;
    config.providers.fazerCards.codeDeliveryEnabled = false;
    config.providers.fazerCards.codeDeliveryMaxOrderUsd = 3.00;
    config.providers.fazerCards.webhookEnabled = false;
    config.providers.fazerCards.webhookSecret = '';
    config.providers.fazerCards.blockedRegions = ['RU', 'RUSSIA', 'CIS'];
    axios.create.mockReset();
    await clearCollections();
});

describe('FazerCards client foundation', () => {
    it('missing API key disables FazerCards safely without creating an HTTP client', () => {
        expect(() => new FazerCardsClient({ enabled: true, apiKey: null }))
            .toThrow(/API key is not configured/);
        expect(axios.create).not.toHaveBeenCalled();
    });

    it('get /me success is normalized', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: { 'x-request-id': 'req-me' },
            data: {
                ok: true,
                login: 'partner1',
                email: 'partner@example.com',
                summary: { totalOrders: 4 },
            },
        });

        const adapter = new FazerCardsAdapter({ baseUrl: 'https://api.fzr.cards/api/v2' });
        const result = await adapter.getAccount();

        expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'get',
            url: '/me',
        }));
        expect(result.ok).toBe(true);
        expect(result.account.login).toBe('partner1');
        expect(result.requestId).toBe('req-me');
    });

    it('get /balance success is normalized', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: { 'x-request-id': 'req-balance' },
            data: { ok: true, balance: '100.0000', currency: 'USD' },
        });

        const adapter = new FazerCardsAdapter({ baseUrl: 'https://api.fzr.cards/api/v2' });
        const result = await adapter.getBalance();

        expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'get',
            url: '/balance',
        }));
        expect(result.balance).toBe('100.0000');
        expect(result.currency).toBe('USD');
        expect(result.requestId).toBe('req-balance');
    });

    it('HTTP errors are normalized without leaking the API key', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockRejectedValueOnce({
            response: {
                status: 401,
                headers: {},
                data: { error: 'X-API-Key: test-fazer-key is invalid', apiKey: 'test-fazer-key' },
            },
            message: 'unauthorized test-fazer-key',
        });

        const fazer = new FazerCardsClient({ enabled: true, apiKey: 'test-fazer-key' });
        try {
            await fazer.getAccount();
            throw new Error('Expected FazerCards HTTP error');
        } catch (err) {
            expect(err).toMatchObject({
                code: 'FAZERCARDS_HTTP_ERROR',
                httpStatus: 401,
            });
            expect(JSON.stringify(err)).not.toContain('test-fazer-key');
            expect(err.message).not.toContain('test-fazer-key');
        }
    });

    it('timeout errors are normalized', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 20000ms exceeded' });

        const fazer = new FazerCardsClient({ enabled: true, apiKey: 'test-fazer-key' });
        await expect(fazer.getBalance()).rejects.toMatchObject({
            code: 'FAZERCARDS_TIMEOUT',
        });
    });

    it('subscription_inactive is mapped to a sync-safe FazerCards error', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockRejectedValueOnce({
            response: {
                status: 422,
                headers: {},
                data: { ok: false, code: 'subscription_inactive' },
            },
            message: 'subscription inactive',
        });

        const fazer = new FazerCardsClient({ enabled: true, apiKey: 'test-fazer-key' });
        await expect(fazer.fetchTopupCategoriesPage({ limit: 10 })).rejects.toMatchObject({
            code: 'FAZERCARDS_SUBSCRIPTION_INACTIVE',
            message: 'FazerCards subscription is inactive. Renew it to sync top-up catalog.',
        });
    });

    it('uses the documented generic order status endpoint by default', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: { ok: true, order: { id: 'fc_order_1', status: 'processing' } },
        });

        const fazer = new FazerCardsClient({ enabled: true, apiKey: 'test-fazer-key' });

        await expect(fazer.getTopupOrderStatus({ providerOrderId: 'fc_order_1' }))
            .resolves.toMatchObject({ data: { order: { id: 'fc_order_1' } } });
        expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'get',
            url: '/orders/fc_order_1',
        }));
    });
});

describe('FazerCards family contracts', () => {
    it('lists all known family contracts and summarizes support stages', () => {
        const contracts = fazerCardsContracts.listContracts();
        const familyKeys = contracts.map((contract) => contract.familyKey);
        expect(familyKeys).toEqual(expect.arrayContaining([
            'TOPUPS',
            'GIFTCARDS',
            'GAME_KEYS',
            'TELEGRAM',
            'STEAM_TOPUP',
            'MANUAL_SERVICES',
            'STEAM_GIFTS',
        ]));

        const summary = fazerCardsContracts.getContractSummary();
        expect(summary.families.TOPUPS.supportStage).toBe('PILOT_READY');
        expect(summary.families.GIFTCARDS.executionStage).toBe('CUSTOMER_FLOW_READY_BUT_GATED');
        expect(summary.families.STEAM_GIFTS.supportStage).toBe('DISABLED_UNAVAILABLE');
        expect(summary.nextBestExecutionOrder).toEqual(expect.arrayContaining(['GIFTCARDS', 'GAME_KEYS', 'TOPUPS']));
    });

    it('service exposes contract list, one contract, and summary without provider calls', () => {
        const list = fazerCardsCatalogSvc.listContracts();
        const single = fazerCardsCatalogSvc.getContract('giftcards');
        const summary = fazerCardsCatalogSvc.getContractsSummary();

        expect(list.contracts).toHaveLength(7);
        expect(single.contract).toMatchObject({
            familyKey: 'GIFTCARDS',
            fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
            supportStage: 'PILOT_READY',
        });
        expect(summary.families.TELEGRAM.supportStage).toBe('IMPORT_READY');
        expect(axios.create).not.toHaveBeenCalled();
    });

    it('builds confirmed TOPUPS payloads and preserves numeric-looking IDs as strings', async () => {
        const { providerProduct } = await createFazerTopupProviderProduct();
        const built = fazerCardsContracts.buildPayloadFromContract({
            familyKey: 'TOPUPS',
            providerProduct: providerProduct.toObject(),
            fields: { user_id: '00123456789' },
        });

        expect(built).toMatchObject({
            success: true,
            wouldCall: 'POST /topups/order',
            payload: {
                category_id: '8_ball_pool',
                offer_id: 'golden_spin',
                fields: { user_id: '00123456789' },
            },
        });
        expect(typeof built.payload.fields.user_id).toBe('string');
    });

    it('builds confirmed GIFTCARDS and GAME_KEYS payloads', async () => {
        const { providerProduct: giftCard } = await createFazerCodeDeliveryProviderProduct({ familyKey: 'GIFTCARDS' });
        const { providerProduct: gameKey } = await createFazerCodeDeliveryProviderProduct({ familyKey: 'GAME_KEYS' });

        const giftCardPayload = fazerCardsContracts.buildPayloadFromContract({
            familyKey: 'GIFTCARDS',
            providerProduct: giftCard.toObject(),
            quantity: 2,
        });
        const gameKeyPayload = fazerCardsContracts.buildPayloadFromContract({
            familyKey: 'GAME_KEYS',
            providerProduct: gameKey.toObject(),
            quantity: 1,
        });

        expect(giftCardPayload).toMatchObject({
            success: true,
            wouldCall: 'POST /giftcards/order',
            payload: { category_id: 'acash_my', card_id: '10_myr', quantity: 2 },
        });
        expect(gameKeyPayload).toMatchObject({
            success: true,
            wouldCall: 'POST /gamekeys/order',
            payload: { game_id: 'against_the_storm_cis', key_id: 'keepers_of_the_stone', quantity: 1 },
        });
    });

    it.each(['TELEGRAM', 'STEAM_TOPUP', 'MANUAL_SERVICES'])('%s payload contract is unconfirmed', async (familyKey) => {
        const { providerProduct } = await createFazerCatalogOnlyProviderProduct({ familyKey });
        const built = fazerCardsContracts.buildPayloadFromContract({
            familyKey,
            providerProduct: providerProduct.toObject(),
            fields: { telegram_username: 'pilot_user' },
            quantity: 1,
        });

        expect(built).toMatchObject({
            success: false,
            dryRun: false,
            code: 'CONTRACT_UNCONFIRMED',
            wouldCall: null,
            payload: null,
        });
    });

    it('response parsers keep delivered code plaintext out of parsed safe results', () => {
        const parsed = fazerCardsContracts.parseGiftCardResponse({
            ok: true,
            order: { id: 'fgc_1', status: 'completed' },
            cards: [{ code: 'SECRET-CODE-123', pin: 'PIN-999', serial: 'SERIAL-1' }],
        });
        const serialized = JSON.stringify(parsed);

        expect(parsed.status).toBe('COMPLETED');
        expect(parsed.deliveredCodeCount).toBe(1);
        expect(parsed.hasPin).toBe(true);
        expect(parsed.hasSerial).toBe(true);
        expect(serialized).not.toContain('SECRET-CODE-123');
        expect(serialized).not.toContain('PIN-999');
        expect(serialized).not.toContain('SERIAL-1');
        expect(serialized).toContain('[REDACTED_CODE]');

        const unconfirmed = fazerCardsContracts.parseTelegramResponse({ order: { id: 'tg_1', status: 'success' } });
        expect(unconfirmed).toMatchObject({
            status: 'MANUAL_REVIEW',
            code: 'CONTRACT_UNCONFIRMED',
            manualReview: true,
        });
    });

    it('detects realistic gift-card code payload variants without storing provider ids as codes', () => {
        const payload = {
            ok: true,
            data: {
                order: { id: 'fgc_nested_order', status: 'accepted' },
                codes: ['ACASH-CODE-001'],
                cards: [
                    { id: 'card-row-1', card_id: '10_myr', giftCode: 'ACASH-GIFT-002', pin: 'PIN-002', serial: 'SER-002' },
                    { order_id: 'fgc_nested_order', serial_number: 'SER-ONLY-003' },
                ],
                items: [
                    { activation_code: 'ACASH-ACT-004' },
                    { id: 'item-row-1', value: 'NOT_CONFIDENT_CODE_VALUE' },
                ],
            },
        };

        const parsed = fazerCardsContracts.parseGiftCardResponse(payload);
        const extracted = fazerCardsContracts.extractDeliveredCodes(payload);
        const codes = extracted.map((item) => item.code).filter(Boolean);
        const serials = extracted.map((item) => item.serial).filter(Boolean);
        const serialized = JSON.stringify(parsed);

        expect(parsed.status).toBe('COMPLETED');
        expect(parsed.providerOrderId).toBe('fgc_nested_order');
        expect(parsed.deliveredCodeCount).toBe(4);
        expect(codes).toEqual(expect.arrayContaining(['ACASH-CODE-001', 'ACASH-GIFT-002', 'ACASH-ACT-004']));
        expect(codes).not.toContain('fgc_nested_order');
        expect(codes).not.toContain('10_myr');
        expect(codes).not.toContain('NOT_CONFIDENT_CODE_VALUE');
        expect(serials).toEqual(expect.arrayContaining(['SER-002', 'SER-ONLY-003']));
        expect(serialized).not.toContain('ACASH-CODE-001');
        expect(serialized).not.toContain('ACASH-GIFT-002');
        expect(serialized).not.toContain('ACASH-ACT-004');
    });

    it('detects realistic game-key payload variants and keeps plaintext out of safe parser output', () => {
        const payload = {
            ok: true,
            order: { order_id: 'fgk_order_1', status: 'created' },
            keys: [
                { key: 'GAME-KEY-001', serial: 'GK-SER-001' },
                { licenseKey: 'GAME-LICENSE-002' },
            ],
            data: {
                activationCodes: ['GAME-ACT-003'],
                cards: [{ code: 'GAME-CODE-004' }],
            },
        };

        const parsed = fazerCardsContracts.parseGameKeyResponse(payload);
        const extracted = fazerCardsContracts.extractDeliveredCodes(payload);
        const codes = extracted.map((item) => item.code).filter(Boolean);
        const serialized = JSON.stringify(parsed);

        expect(parsed.status).toBe('COMPLETED');
        expect(parsed.providerOrderId).toBe('fgk_order_1');
        expect(codes).toEqual(expect.arrayContaining([
            'GAME-KEY-001',
            'GAME-LICENSE-002',
            'GAME-ACT-003',
            'GAME-CODE-004',
        ]));
        expect(serialized).not.toContain('GAME-KEY-001');
        expect(serialized).not.toContain('GAME-LICENSE-002');
        expect(serialized).not.toContain('GAME-ACT-003');
        expect(serialized).not.toContain('GAME-CODE-004');
    });
});

describe('FazerCards catalog normalization and raw sync', () => {
    it('top-up offer normalization handles missing and unknown fields conservatively', () => {
        const normalized = normalizeTopupOfferProduct({});

        expect(normalized.providerCode).toBe(PROVIDER_CODES.FAZER_CARDS);
        expect(normalized.externalProductId).toMatch(/^FAZER_TOPUP:unknown_category:unknown_offer:/);
        expect(normalized.rawName).toBe('Unknown FazerCards category - Unknown FazerCards offer');
        expect(normalized.fulfillmentMode).toBe(FULFILLMENT_MODES.TOPUP_WITH_FIELDS);
        expect(normalized.isSupported).toBe(false);
        expect(normalized.isBlocked).toBe(true);
        expect(normalized.blockReason).toBe('MISSING_CATEGORY_ID');
    });

    it('normalizes top-up categories and offers into stable ProviderProduct DTOs', () => {
        const normalized = normalizeTopupOfferProduct({
            category: { category_id: '8_ball_pool', name: '8 Ball Pool' },
            offer: { offer_id: 'golden_spin', name: 'Golden Spin', price_usd: '0.7487' },
            fields: [{ key: 'user_id', label: 'Unique ID', type: 'text' }],
        });

        expect(normalized.externalProductId).toBe('FAZER_TOPUP:8_ball_pool:golden_spin');
        expect(normalized.rawName).toBe('8 Ball Pool - Golden Spin');
        expect(normalized.category).toBe('8_ball_pool');
        expect(normalized.categoryName).toBe('8 Ball Pool');
        expect(normalized.offerId).toBe('golden_spin');
        expect(normalized.offerName).toBe('Golden Spin');
        expect(normalized.currency).toBe('USD');
        expect(normalized.costPrice).toBe(0.7487);
        expect(normalized.fulfillmentMode).toBe(FULFILLMENT_MODES.TOPUP_WITH_FIELDS);
        expect(normalized.isSupported).toBe(true);
        expect(normalized.isBlocked).toBe(false);
        expect(normalized.requiredFields).toEqual([
            { key: 'user_id', label: 'Unique ID', required: true, type: 'text', options: [] },
        ]);
        expect(normalized.rawPayload).toMatchObject({
            category: { category_id: '8_ball_pool' },
            offer: { offer_id: 'golden_spin' },
            fields: [{ key: 'user_id' }],
        });
    });

    it('marks top-up offers without category-level fields unsupported and blocked', () => {
        const normalized = normalizeTopupOfferProduct({
            category: { category_id: '8_ball_pool', name: '8 Ball Pool' },
            offer: { offer_id: 'golden_spin', name: 'Golden Spin', price_usd: '0.7487' },
            fields: [],
        });

        expect(normalized.isSupported).toBe(false);
        expect(normalized.isBlocked).toBe(true);
        expect(normalized.blockReason).toBe('MISSING_REQUIRED_FIELDS');
    });

    it('marks top-up offers with invalid price unsupported and blocked', () => {
        const normalized = normalizeTopupOfferProduct({
            category: { category_id: '8_ball_pool', name: '8 Ball Pool' },
            offer: { offer_id: 'golden_spin', name: 'Golden Spin', price_usd: 'free' },
            fields: [{ key: 'user_id', label: 'Unique ID', type: 'text' }],
        });

        expect(normalized.isSupported).toBe(false);
        expect(normalized.isBlocked).toBe(true);
        expect(normalized.blockReason).toBe('INVALID_PRICE_USD');
    });

    it('blocked region rules mark products blocked but do not delete them', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: {
                ok: true,
                items: [
                    {
                        category_id: 'steam_cis',
                        name: 'Steam CIS',
                        region: 'CIS',
                    },
                ],
                meta: { next_cursor: null, has_more: false },
            },
        });
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: {
                ok: true,
                kind: 'topup',
                category_id: 'steam_cis',
                name: 'Steam CIS',
                offers: [{ offer_id: 'gift10', name: '$10', price_usd: '10.00' }],
                fields: [{ key: 'user_id', label: 'User ID', type: 'text' }],
            },
        });

        const result = await fazerCardsCatalogSvc.syncCatalogPage({ limit: 100 });
        const stored = await ProviderProduct.findOne({ externalProductId: 'FAZER_TOPUP:steam_cis:gift10' }).lean();

        expect(result.deleted).toBe(0);
        expect(result.deactivated).toBe(0);
        expect(result.blocked).toBe(1);
        expect(result.unsupported).toBe(1);
        expect(stored.isBlocked).toBe(true);
        expect(stored.blockReason).toBe('BLOCKED_REGION');
        expect(stored.isActive).toBe(true);
    });

    it('top-up sync stores providerproducts without creating Winnie products or orders', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: { 'x-request-id': 'req-topups' },
            data: {
                ok: true,
                kind: 'topup',
                items: [
                    {
                        category_id: '8_ball_pool',
                        name: '8 Ball Pool',
                        note: '8 Ball Pool top-up',
                    },
                ],
                meta: { total: 317, limit: 100, next_cursor: 'cursor-2', has_more: true },
            },
        });
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: { 'x-request-id': 'req-offers' },
            data: {
                ok: true,
                kind: 'topup',
                category_id: '8_ball_pool',
                name: '8 Ball Pool',
                offers: [
                    {
                        offer_id: 'golden_spin',
                        name: 'Golden Spin',
                        price_usd: '0.7487',
                    },
                ],
                fields: [
                    {
                        key: 'user_id',
                        label: 'Unique ID',
                        type: 'text',
                    },
                ],
                note: '8 Ball Pool top-up',
            },
        });

        const result = await fazerCardsCatalogSvc.syncCatalogPage({ limit: 100, cursor: 'cursor-1' });
        const stored = await ProviderProduct.findOne({ externalProductId: 'FAZER_TOPUP:8_ball_pool:golden_spin' }).lean();
        const productCount = await Product.countDocuments({});

        expect(result).toMatchObject({
            endpoints: ['GET /topups', 'GET /topups/offers'],
            categoriesFetched: 1,
            offersFetched: 1,
            providerProductsCreated: 1,
            providerProductsUpdated: 0,
            blocked: 0,
            unsupported: 0,
            nextCursor: 'cursor-2',
            hasMore: true,
            deleted: 0,
            deactivated: 0,
            requestId: 'req-topups',
        });
        expect(stored.providerCode).toBe(PROVIDER_CODES.FAZER_CARDS);
        expect(stored.rawName).toBe('8 Ball Pool - Golden Spin');
        expect(stored.category).toBe('8_ball_pool');
        expect(stored.categoryName).toBe('8 Ball Pool');
        expect(stored.offerId).toBe('golden_spin');
        expect(stored.offerName).toBe('Golden Spin');
        expect(stored.fulfillmentMode).toBe(FULFILLMENT_MODES.TOPUP_WITH_FIELDS);
        expect(stored.requiredFields[0]).toMatchObject({
            key: 'user_id',
            label: 'Unique ID',
            type: 'text',
            required: true,
        });
        expect(stored.rawPayload).toMatchObject({
            category: { category_id: '8_ball_pool' },
            offer: { offer_id: 'golden_spin' },
            fields: [{ key: 'user_id' }],
        });
        expect(productCount).toBe(0);
        expect(client.request).toHaveBeenNthCalledWith(1, expect.objectContaining({
            method: 'get',
            url: '/topups',
            params: { limit: 100, cursor: 'cursor-1' },
        }));
        expect(client.request).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: 'get',
            url: '/topups/offers',
            params: { category_id: '8_ball_pool' },
        }));
        expect(client.request.mock.calls.some(([call]) => call.url === '/catalog')).toBe(false);
        expect(client.request.mock.calls.some(([call]) => call.url === ['/topups', 'order'].join('/'))).toBe(false);
    });

    it('top-up sync updates existing ProviderProduct rows only', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        const provider = await fazerCardsCatalogSvc.ensureFazerCardsProvider();

        await ProviderProduct.create({
            provider: provider._id,
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            externalProductId: 'FAZER_TOPUP:8_ball_pool:golden_spin',
            rawName: 'Old Name',
            rawPrice: '1.00',
            category: '8_ball_pool',
            fulfillmentMode: FULFILLMENT_MODES.TOPUP_WITH_FIELDS,
            isSupported: true,
            isBlocked: false,
        });

        client.request.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: {
                ok: true,
                items: [{ category_id: '8_ball_pool', name: '8 Ball Pool' }],
                meta: { next_cursor: null, has_more: false },
            },
        });
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: {
                ok: true,
                category_id: '8_ball_pool',
                name: '8 Ball Pool',
                offers: [{ offer_id: 'golden_spin', name: 'Golden Spin', price_usd: '0.7487' }],
                fields: [{ key: 'user_id', label: 'Unique ID', type: 'text' }],
            },
        });

        const result = await fazerCardsCatalogSvc.syncCatalogPage({ limit: 10 });
        const providerProductCount = await ProviderProduct.countDocuments({});
        const productCount = await Product.countDocuments({});
        const stored = await ProviderProduct.findOne({ externalProductId: 'FAZER_TOPUP:8_ball_pool:golden_spin' }).lean();

        expect(result.providerProductsCreated).toBe(0);
        expect(result.providerProductsUpdated).toBe(1);
        expect(providerProductCount).toBe(1);
        expect(productCount).toBe(0);
        expect(stored.rawName).toBe('8 Ball Pool - Golden Spin');
    });

    it('cannot import blocked FazerCards provider products', async () => {
        const { providerProduct } = await createFazerTopupProviderProduct({
            isBlocked: true,
            blockReason: 'BLOCKED_REGION',
        });

        await expect(fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.25,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_PROVIDER_PRODUCT_BLOCKED' });
        expect(await Product.countDocuments({})).toBe(0);
    });

    it('cannot import a missing ProviderProduct', async () => {
        const missingId = '64f000000000000000000001';

        await expect(fazerCardsCatalogSvc.importProviderProduct(missingId, {
            sellPrice: 1.25,
        })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(await Product.countDocuments({})).toBe(0);
    });

    it('cannot import non-FazerCards provider products through FazerCards import', async () => {
        const provider = await Provider.create({
            name: 'Other Supplier',
            slug: 'other-supplier',
            baseUrl: 'https://api.example.com',
            isActive: true,
        });
        const providerProduct = await ProviderProduct.create({
            provider: provider._id,
            externalProductId: 'OTHER:1',
            rawName: 'Other Product',
            rawPrice: '1.00',
            costPrice: '1.00',
            fulfillmentMode: FULFILLMENT_MODES.TOPUP_WITH_FIELDS,
            isSupported: true,
            isBlocked: false,
            requiredFields: [{ key: 'user_id', label: 'User ID', type: 'text', required: true }],
        });

        await expect(fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.25,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_PROVIDER_PRODUCT_REQUIRED' });
        expect(await Product.countDocuments({})).toBe(0);
    });

    it('cannot import non top-up FazerCards provider products', async () => {
        const { providerProduct } = await createFazerTopupProviderProduct({
            fulfillmentMode: FULFILLMENT_MODES.UNKNOWN,
        });

        await expect(fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.25,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_IMPORT_UNSUPPORTED_FULFILLMENT_MODE' });
        expect(await Product.countDocuments({})).toBe(0);
    });

    it('cannot import unsupported FazerCards provider products', async () => {
        const { providerProduct } = await createFazerTopupProviderProduct({
            isSupported: false,
            blockReason: 'INVALID_PRICE_USD',
        });

        await expect(fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.25,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_PROVIDER_PRODUCT_UNSUPPORTED' });
        expect(await Product.countDocuments({})).toBe(0);
    });

    it('cannot import FazerCards products missing requiredFields', async () => {
        const { providerProduct } = await createFazerTopupProviderProduct({
            requiredFields: [],
        });

        await expect(fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.25,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_PROVIDER_PRODUCT_MISSING_FIELDS' });
        expect(await Product.countDocuments({})).toBe(0);
    });

    it('cannot import FazerCards products with invalid costPrice', async () => {
        const { providerProduct } = await createFazerTopupProviderProduct({
            costPrice: 'not-a-number',
        });

        await expect(fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.25,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_PROVIDER_PRODUCT_INVALID_COST' });

        const { providerProduct: missingCostProduct } = await createFazerTopupProviderProduct({
            costPrice: null,
            externalProductId: 'FAZER_TOPUP:8_ball_pool:missing_cost',
            offerId: 'missing_cost',
            rawPrice: '0',
        });

        await expect(fazerCardsCatalogSvc.importProviderProduct(missingCostProduct._id, {
            sellPrice: 1.25,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_PROVIDER_PRODUCT_INVALID_COST' });
        expect(await Product.countDocuments({})).toBe(0);
    });

    it('imports supported FazerCards offers as inactive draft products with copied fields and links', async () => {
        const { provider, providerProduct } = await createFazerTopupProviderProduct();

        const result = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            description: 'Admin draft import',
            sellPrice: 1.49,
            syncAvailabilityFromProvider: true,
        });
        const product = await Product.findById(result.product._id).lean();

        expect(result.action).toBe('created');
        expect(product.name).toBe('8 Ball Pool - Golden Spin');
        expect(product.description).toBe('Admin draft import');
        expect(product.provider.toString()).toBe(provider._id.toString());
        expect(product.providerProduct.toString()).toBe(providerProduct._id.toString());
        expect(product.providerCode).toBe(PROVIDER_CODES.FAZER_CARDS);
        expect(product.externalProductId).toBe('FAZER_TOPUP:8_ball_pool:golden_spin');
        expect(product.isActive).toBe(false);
        expect(product.visibleInStore).toBe(false);
        expect(product.status).toBe(PRODUCT_STATUSES.UNAVAILABLE);
        expect(product.executionType).toBe(EXECUTION_TYPES.MANUAL);
        expect(product.providerExecutionEnabled).toBe(false);
        expect(product.providerPrice).toBe('0.7487');
        expect(product.basePrice).toBe('1.49');
        expect(product.currency).toBe('USD');
        expect(product.orderFields).toHaveLength(1);
        expect(product.orderFields[0]).toMatchObject({
            id: 'user_id',
            key: 'user_id',
            label: 'Unique ID',
            type: 'text',
            required: true,
            isActive: true,
        });
        expect(product.dynamicFields[0]).toMatchObject({
            name: 'user_id',
            label: 'Unique ID',
            type: 'text',
            required: true,
            isActive: true,
        });
        const customerCatalog = await productService.listProducts({ activeOnly: true });
        expect(customerCatalog.products).toHaveLength(0);
        expect(await WalletTransaction.countDocuments({})).toBe(0);
        expect(axios.create).not.toHaveBeenCalled();
    });

    it('cannot duplicate import the same providerProduct unless updateExisting is explicit', async () => {
        const { providerProduct } = await createFazerTopupProviderProduct();

        await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            name: '8 Ball Draft',
            sellPrice: 1.49,
        });
        await expect(fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            name: '8 Ball Draft Duplicate',
            sellPrice: 1.59,
        })).rejects.toMatchObject({ code: 'CONFLICT' });

        const updated = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            name: '8 Ball Draft Updated',
            sellPrice: 1.59,
            updateExisting: true,
        });
        const products = await Product.find({ providerProduct: providerProduct._id }).lean();

        expect(updated.action).toBe('updated');
        expect(products).toHaveLength(1);
        expect(products[0].name).toBe('8 Ball Draft Updated');
        expect(products[0].isActive).toBe(false);
        expect(products[0].visibleInStore).toBe(false);
    });

    it('lists FazerCards provider products with imported filters', async () => {
        const { providerProduct } = await createFazerTopupProviderProduct();
        await createFazerTopupProviderProduct({
            externalProductId: 'FAZER_TOPUP:pubg:uc',
            rawName: 'PUBG - UC',
            category: 'pubg',
            categoryName: 'PUBG',
            offerId: 'uc',
            offerName: 'UC',
        });
        await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.49,
        });

        const imported = await fazerCardsCatalogSvc.listProviderProducts({ imported: 'true' });
        const notImported = await fazerCardsCatalogSvc.listProviderProducts({ imported: 'false' });

        expect(imported.products).toHaveLength(1);
        expect(imported.products[0].imported).toBe(true);
        expect(imported.products[0].importedProduct.name).toBe('8 Ball Pool - Golden Spin');
        expect(notImported.products).toHaveLength(1);
        expect(notImported.products[0].externalProductId).toBe('FAZER_TOPUP:pubg:uc');
        expect(notImported.products[0].imported).toBe(false);
    });

    it('unknown FazerCards provider products are not purchasable via publish/link', async () => {
        const provider = await Provider.create({
            name: 'FazerCards',
            slug: 'fazer-cards',
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            baseUrl: 'https://api.fzr.cards/api/v2',
            isActive: true,
            syncInterval: 0,
        });
        const providerProduct = await ProviderProduct.create({
            provider: provider._id,
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            externalProductId: 'unknown-product',
            rawName: 'Unknown Product',
            rawPrice: '1.00',
            isActive: true,
            fulfillmentMode: FULFILLMENT_MODES.UNKNOWN,
            isSupported: false,
            isBlocked: true,
            blockReason: 'UNSUPPORTED_FULFILLMENT_MODE',
        });

        await expect(productService.publishFromProviderProduct({
            providerProductId: providerProduct._id,
            name: 'Should Not Publish',
            basePrice: '1.50',
        })).rejects.toMatchObject({ code: 'FAZERCARDS_PURCHASE_UNSUPPORTED' });
    });

    it('lists and filters FazerCards providerproducts', async () => {
        const provider = await Provider.create({
            name: 'FazerCards',
            slug: 'fazer-cards',
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            baseUrl: 'https://api.fzr.cards/api/v2',
            isActive: true,
            syncInterval: 0,
        });
        await ProviderProduct.create({
            provider: provider._id,
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            externalProductId: 'pubg-global',
            rawName: 'PUBG Global',
            rawPrice: '2',
            category: 'game-topups',
            region: 'GLOBAL',
            available: true,
            fulfillmentMode: FULFILLMENT_MODES.TOPUP_WITH_FIELDS,
            isSupported: true,
            isBlocked: false,
        });
        await ProviderProduct.create({
            provider: provider._id,
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            externalProductId: 'steam-ru',
            rawName: 'Steam RU',
            rawPrice: '2',
            category: 'gift-cards',
            region: 'RU',
            available: true,
            fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
            isSupported: false,
            isBlocked: true,
            blockReason: 'BLOCKED_REGION',
        });

        const listed = await fazerCardsCatalogSvc.listProviderProducts({ blocked: 'true' });

        expect(listed.products).toHaveLength(1);
        expect(listed.products[0].externalProductId).toBe('steam-ru');
    });
});

describe('FazerCards multi-family catalog discovery', () => {
    it('family discovery returns known catalog families with gated code-delivery execution', () => {
        const result = fazerCardsCatalogSvc.listFamilies();

        expect(result.families.map((family) => family.familyKey)).toEqual(expect.arrayContaining([
            'TOPUPS',
            'GIFTCARDS',
            'GAME_KEYS',
            'STEAM_TOPUP',
            'STEAM_GIFTS',
            'TELEGRAM',
            'MANUAL_SERVICES',
            'UNKNOWN',
        ]));
        const topups = result.families.find((family) => family.familyKey === 'TOPUPS');
        const giftcards = result.families.find((family) => family.familyKey === 'GIFTCARDS');
        expect(topups).toMatchObject({
            status: 'implemented',
            catalogAvailable: true,
            executionAvailable: true,
            executionGloballyGated: true,
            fulfillmentMode: FULFILLMENT_MODES.TOPUP_WITH_FIELDS,
        });
        expect(giftcards).toMatchObject({
            status: 'implemented_gated',
            catalogAvailable: true,
            executionAvailable: true,
            executionGloballyGated: true,
            fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
            supportLevel: 'CATALOG_ONLY',
        });
    });

    it('sync-family rejects unknown families', async () => {
        await expect(fazerCardsCatalogSvc.syncCatalogFamily({ family: 'NOPE' }))
            .rejects.toMatchObject({ code: 'FAZERCARDS_UNKNOWN_FAMILY' });
        expect(axios.create).not.toHaveBeenCalled();
    });

    it('syncs gift cards as supported gated ProviderProducts without creating Products, Orders, or wallet transactions', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request
            .mockResolvedValueOnce({
                status: 200,
                headers: { 'x-request-id': 'req-giftcats' },
                data: {
                    ok: true,
                    kind: 'gift_card',
                    items: [{ category_id: 'gc_steam_1', name: 'Steam USD' }],
                    meta: { total: 1, limit: 20, next_cursor: null, has_more: false },
                },
            })
            .mockResolvedValueOnce({
                status: 200,
                headers: {},
                data: {
                    ok: true,
                    kind: 'gift_card',
                    category_id: 'gc_steam_1',
                    name: 'Steam USD',
                    offers: [{
                        card_id: 'card_10usd',
                        name: 'Steam - $10',
                        price_usd: '10.5000',
                        stock: 100,
                        min_order_quantity: 1,
                        max_order_quantity: 10,
                    }],
                },
            });

        const result = await fazerCardsCatalogSvc.syncCatalogFamily({ family: 'GIFTCARDS', limit: 20 });
        const stored = await ProviderProduct.findOne({ externalProductId: 'FAZER_GIFTCARD:gc_steam_1:card_10usd' }).lean();

        expect(result).toMatchObject({
            familyKey: 'GIFTCARDS',
            endpoints: ['GET /giftcards', 'GET /giftcards/cards'],
            providerProductsCreated: 1,
            providerProductsUpdated: 0,
            blocked: 0,
            unsupported: 0,
            catalogOnly: false,
            requestId: 'req-giftcats',
        });
        expect(stored).toMatchObject({
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            familyKey: 'GIFTCARDS',
            supportLevel: 'CATALOG_ONLY',
            fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
            isSupported: true,
            isBlocked: false,
            executionBlocked: false,
            blockReason: null,
            rawName: 'Steam USD - Steam - $10',
            category: 'gc_steam_1',
            offerId: 'card_10usd',
            costPrice: '10.5',
        });
        expect(await Product.countDocuments({})).toBe(0);
        expect(await Order.countDocuments({})).toBe(0);
        expect(await WalletTransaction.countDocuments({})).toBe(0);
        expect(client.request.mock.calls.some(([call]) => String(call.url).includes('/order'))).toBe(false);
    });

    it('syncs game keys as catalog-only code-delivery ProviderProducts and supports family filters', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request
            .mockResolvedValueOnce({
                status: 200,
                headers: {},
                data: {
                    ok: true,
                    kind: 'game_key',
                    items: [{ game_id: 'gk_example_1', name: 'Example Game', region: 'GLOBAL', platform: 'steam' }],
                    meta: { total: 1, limit: 20, next_cursor: null, has_more: false },
                },
            })
            .mockResolvedValueOnce({
                status: 200,
                headers: {},
                data: {
                    ok: true,
                    kind: 'game_key',
                    game_id: 'gk_example_1',
                    GameName: 'Example Game',
                    region: 'GLOBAL',
                    platform: 'steam',
                    keys: [{
                        key_id: 'key_sku_1',
                        name: 'Standard edition',
                        price_usd: '19.9900',
                        stock: 5,
                    }],
                },
            });

        await fazerCardsCatalogSvc.syncCatalogFamily({ family: 'GAME_KEYS', limit: 20 });
        const listed = await fazerCardsCatalogSvc.listProviderProducts({ familyKey: 'GAME_KEYS' });
        const summary = await fazerCardsCatalogSvc.getCatalogSummary();

        expect(listed.products).toHaveLength(1);
        expect(listed.products[0]).toMatchObject({
            familyKey: 'GAME_KEYS',
            supportLevel: 'CATALOG_ONLY',
            fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
            blockReason: null,
            imported: false,
        });
        expect(summary.byFamily.GAME_KEYS).toMatchObject({
            total: 1,
            supported: 1,
            blocked: 0,
            imported: 0,
        });
        expect(summary.nextRecommendedFamilies.map((family) => family.familyKey)).toContain('GAME_KEYS');
        expect(await Product.countDocuments({})).toBe(0);
        expect(await Order.countDocuments({})).toBe(0);
        expect(client.request.mock.calls.some(([call]) => String(call.url).includes('/order'))).toBe(false);
    });

    it('sync-all runs only read-only catalog endpoints and records Steam Gifts as unavailable', async () => {
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request
            .mockResolvedValueOnce({
                status: 200,
                headers: {},
                data: {
                    ok: true,
                    kind: 'topup',
                    items: [{ category_id: '8_ball_pool', name: '8 Ball Pool' }],
                    meta: { total: 1, limit: 2, next_cursor: null, has_more: false },
                },
            })
            .mockResolvedValueOnce({
                status: 200,
                headers: {},
                data: {
                    ok: true,
                    kind: 'topup',
                    category_id: '8_ball_pool',
                    name: '8 Ball Pool',
                    offers: [{ offer_id: '110_cash', name: '110 Cash', price_usd: '0.99' }],
                    fields: [{ key: 'user_id', label: 'Unique ID', type: 'text' }],
                },
            })
            .mockResolvedValueOnce({
                status: 200,
                headers: {},
                data: {
                    ok: true,
                    kind: 'gift_card',
                    items: [{ category_id: 'acash_my', name: 'A-Cash (MY)' }],
                    meta: { total: 1, limit: 2, next_cursor: null, has_more: false },
                },
            })
            .mockResolvedValueOnce({
                status: 200,
                headers: {},
                data: {
                    ok: true,
                    kind: 'gift_card',
                    offers: [{ card_id: '10_myr', name: '10 MYR', price_usd: '2.60', stock: 100 }],
                },
            });

        const result = await fazerCardsCatalogSvc.syncAllCatalogFamilies({
            families: ['TOPUPS', 'GIFTCARDS', 'STEAM_GIFTS'],
            limit: 2,
        });

        expect(result.familiesSynced).toEqual(expect.arrayContaining(['TOPUPS', 'GIFTCARDS']));
        expect(result.familiesSkipped).toContain('STEAM_GIFTS');
        expect(result.results.STEAM_GIFTS).toMatchObject({
            skipped: true,
            unavailable: true,
            providerProductsCreated: 0,
        });
        expect(result.warnings[0]).toMatchObject({
            familyKey: 'STEAM_GIFTS',
            code: 'STEAM_GIFTS_CATALOG_UNAVAILABLE',
        });
        expect(await ProviderProduct.countDocuments({ providerCode: PROVIDER_CODES.FAZER_CARDS })).toBe(2);
        expect(await Product.countDocuments({})).toBe(0);
        expect(await Order.countDocuments({})).toBe(0);
        expect(await WalletTransaction.countDocuments({})).toBe(0);
        const urls = client.request.mock.calls.map(([call]) => call.url);
        expect(urls).toEqual(['/topups', '/topups/offers', '/giftcards', '/giftcards/cards']);
        expect(urls.some((url) => String(url).includes('/order'))).toBe(false);
        expect(urls.some((url) => String(url).includes('/steam-gifts'))).toBe(false);
    });

    it('counts legacy top-up ProviderProducts under TOPUPS summary before backfill', async () => {
        const { providerProduct } = await createFazerTopupProviderProduct();
        await ProviderProduct.findByIdAndUpdate(providerProduct._id, {
            $unset: { familyKey: '', supportLevel: '' },
            $set: { executionBlocked: false },
        });

        const summary = await fazerCardsCatalogSvc.getCatalogSummary();

        expect(summary.totalProviderProducts).toBe(1);
        expect(summary.byFamily.TOPUPS).toMatchObject({
            total: 1,
            supported: 1,
            blocked: 0,
            imported: 0,
        });
        expect(summary.byFamily.UNKNOWN.total).toBe(0);
    });

    it('familyKey=TOPUPS listing includes legacy rows and UNKNOWN excludes them', async () => {
        const { providerProduct } = await createFazerTopupProviderProduct();
        await ProviderProduct.findByIdAndUpdate(providerProduct._id, {
            $unset: { familyKey: '', supportLevel: '' },
        });
        await ProviderProduct.create({
            provider: providerProduct.provider,
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            externalProductId: 'FAZER_UNKNOWN:one',
            rawName: 'Unknown Fazer Product',
            rawPrice: '1.00',
            isActive: true,
            fulfillmentMode: FULFILLMENT_MODES.UNKNOWN,
            isSupported: false,
            isBlocked: true,
            blockReason: 'DISCOVERY_UNCONFIRMED',
        });

        const topups = await fazerCardsCatalogSvc.listProviderProducts({ familyKey: 'TOPUPS' });
        const unknown = await fazerCardsCatalogSvc.listProviderProducts({ familyKey: 'UNKNOWN' });

        expect(topups.products).toHaveLength(1);
        expect(topups.products[0].externalProductId).toBe('FAZER_TOPUP:8_ball_pool:golden_spin');
        expect(unknown.products).toHaveLength(1);
        expect(unknown.products[0].externalProductId).toBe('FAZER_UNKNOWN:one');
    });

    it('backfills legacy top-up classification without creating Products, Orders, or Wallet transactions', async () => {
        const { provider, providerProduct } = await createFazerTopupProviderProduct();
        const original = await ProviderProduct.findByIdAndUpdate(providerProduct._id, {
            $unset: { familyKey: '', supportLevel: '' },
            $set: { executionBlocked: true },
        }, { new: true }).lean();
        const originalRawPayload = JSON.stringify(original.rawPayload);

        const result = await fazerCardsCatalogSvc.backfillLegacyFamilies();
        const updated = await ProviderProduct.findById(providerProduct._id).lean();

        expect(result).toMatchObject({
            success: true,
            matched: 1,
            updated: 1,
            skipped: 0,
            byFamily: { TOPUPS: 1 },
        });
        expect(updated.familyKey).toBe('TOPUPS');
        expect(updated.supportLevel).toBe('FULL_TOPUP_SUPPORTED');
        expect(updated.executionBlocked).toBe(false);
        expect(updated.provider.toString()).toBe(provider._id.toString());
        expect(updated.rawPrice).toBe(original.rawPrice);
        expect(updated.costPrice).toBe(original.costPrice);
        expect(JSON.stringify(updated.rawPayload)).toBe(originalRawPayload);
        expect(updated.requiredFields).toEqual(original.requiredFields);
        expect(updated.isSupported).toBe(original.isSupported);
        expect(updated.isBlocked).toBe(original.isBlocked);
        expect(updated.blockReason).toBe(original.blockReason);
        expect(await Product.countDocuments({})).toBe(0);
        expect(await Order.countDocuments({})).toBe(0);
        expect(await WalletTransaction.countDocuments({})).toBe(0);
        expect(axios.create).not.toHaveBeenCalled();
    });

    it('backfill leaves gift card rows blocked and catalog-only', async () => {
        const { provider } = await createFazerTopupProviderProduct();
        await ProviderProduct.deleteMany({});
        await ProviderProduct.create({
            provider: provider._id,
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            externalProductId: 'FAZER_GIFTCARD:gc_steam_1:card_10usd',
            rawName: 'Steam USD - Steam - $10',
            rawPrice: '10.5000',
            costPrice: '10.5',
            familyKey: 'GIFTCARDS',
            supportLevel: 'NEEDS_CODE_DELIVERY',
            executionBlocked: true,
            fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
            isSupported: false,
            isBlocked: true,
            blockReason: 'CODE_DELIVERY_NOT_IMPLEMENTED',
            rawPayload: {
                family: 'GIFTCARDS',
                category: { category_id: 'gc_steam_1' },
                offer: { card_id: 'card_10usd' },
            },
        });

        const result = await fazerCardsCatalogSvc.backfillLegacyFamilies();
        const giftcard = await ProviderProduct.findOne({ familyKey: 'GIFTCARDS' }).lean();

        expect(result).toMatchObject({ matched: 0, updated: 0, skipped: 0 });
        expect(giftcard).toMatchObject({
            familyKey: 'GIFTCARDS',
            supportLevel: 'NEEDS_CODE_DELIVERY',
            executionBlocked: true,
            isSupported: false,
            isBlocked: true,
            blockReason: 'CODE_DELIVERY_NOT_IMPLEMENTED',
        });
    });
});

describe('FazerCards CODE_DELIVERY foundation', () => {
    it('builds a gift card import preview for inactive code-delivery import', async () => {
        const { providerProduct } = await createFazerCodeDeliveryProviderProduct({ familyKey: 'GIFTCARDS' });

        const preview = await fazerCardsCatalogSvc.getImportPreview(providerProduct._id);

        expect(preview).toMatchObject({
            providerProductId: providerProduct._id.toString(),
            providerProductName: 'A-Cash (MY) - 10 MYR',
            externalProductId: 'FAZER_GIFTCARD:acash_my:10_myr',
            familyKey: 'GIFTCARDS',
            fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
            executionBlocked: false,
            blockReason: null,
            costPrice: '2.6029',
            currency: 'USD',
            requiredFields: [],
            suggestedOrderFields: [],
            stock: 100,
            minQty: 1,
            maxQty: 10,
        });
        expect(preview.warning).toContain('Product will be imported as inactive and not visible to customers.');
    });

    it('imports a gift card as inactive hidden provider-disabled Product metadata', async () => {
        const { provider, providerProduct } = await createFazerCodeDeliveryProviderProduct({ familyKey: 'GIFTCARDS' });

        const result = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 3.25,
            name: 'A-Cash MY 10',
            description: 'Pilot gift card',
        });

        expect(result.action).toBe('created');
        const product = result.product.toObject ? result.product.toObject() : result.product;
        expect(product).toMatchObject({
            name: 'A-Cash MY 10',
            description: 'Pilot gift card',
            basePrice: '3.25',
            providerPrice: '2.6029',
            finalPrice: '3.25',
            currency: 'USD',
            minQty: 1,
            maxQty: 10,
            isActive: false,
            visibleInStore: false,
            status: PRODUCT_STATUSES.UNAVAILABLE,
            executionType: EXECUTION_TYPES.MANUAL,
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            externalProductId: 'FAZER_GIFTCARD:acash_my:10_myr',
            customerPurchaseEnabled: false,
            providerExecutionEnabled: false,
            providerExecutionBlocked: false,
            providerExecutionMode: 'AUTO_PROVIDER',
            providerBlockReason: null,
            familyKey: 'GIFTCARDS',
            fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
            providerCategory: 'acash_my',
            providerCategoryName: 'A-Cash (MY)',
            providerOfferId: '10_myr',
            providerOfferName: '10 MYR',
            providerStock: 100,
            orderFields: [],
            dynamicFields: [],
        });
        expect(product.provider.toString()).toBe(provider._id.toString());
        expect(product.providerProduct.toString()).toBe(providerProduct._id.toString());
        expect(await Order.countDocuments({})).toBe(0);
        expect(await WalletTransaction.countDocuments({})).toBe(0);
        expect(axios.create).not.toHaveBeenCalled();
    });

    it('imports a game key as inactive hidden provider-disabled Product metadata', async () => {
        const { providerProduct } = await createFazerCodeDeliveryProviderProduct({ familyKey: 'GAME_KEYS' });

        const result = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 6.5,
            name: 'Against the Storm Key',
        });

        const product = result.product.toObject ? result.product.toObject() : result.product;
        expect(product).toMatchObject({
            name: 'Against the Storm Key',
            isActive: false,
            visibleInStore: false,
            status: PRODUCT_STATUSES.UNAVAILABLE,
            executionType: EXECUTION_TYPES.MANUAL,
            customerPurchaseEnabled: false,
            providerExecutionEnabled: false,
            providerExecutionBlocked: false,
            providerExecutionMode: 'AUTO_PROVIDER',
            providerBlockReason: null,
            familyKey: 'GAME_KEYS',
            fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
            providerCategory: 'against_the_storm_cis',
            providerOfferId: 'keepers_of_the_stone',
            providerRegion: 'CIS',
            providerPlatform: 'Steam',
            providerStock: 1,
            orderFields: [],
            dynamicFields: [],
        });
        expect(await Order.countDocuments({})).toBe(0);
        expect(await WalletTransaction.countDocuments({})).toBe(0);
        expect(axios.create).not.toHaveBeenCalled();
    });

    it('builds gift card dry-run payload without calling provider, creating orders, or wallet transactions', async () => {
        const { providerProduct } = await createFazerCodeDeliveryProviderProduct({ familyKey: 'GIFTCARDS' });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 3.25,
            name: 'A-Cash MY 10',
        });
        const productCount = await Product.countDocuments({});

        const result = await fazerCardsCatalogSvc.buildCodeDeliveryDryRun({
            productId: product._id,
            quantity: 1,
        });

        expect(result).toMatchObject({
            success: true,
            dryRun: true,
            wouldCall: 'POST /giftcards/order',
            provider: 'FazerCards',
            payload: {
                category_id: 'acash_my',
                card_id: '10_myr',
                quantity: 1,
            },
            product: {
                id: product._id.toString(),
                familyKey: 'GIFTCARDS',
                fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
                providerExecutionEnabled: false,
                providerExecutionBlocked: false,
            },
            providerProduct: {
                externalProductId: 'FAZER_GIFTCARD:acash_my:10_myr',
                stock: 100,
                minQty: 1,
                maxQty: 10,
            },
            requiredFields: [],
        });
        expect(result.warnings).toContain('Dry run only. No FazerCards order was created.');
        expect(result.warnings).toContain('Product execution is currently disabled.');
        expect(await Product.countDocuments({})).toBe(productCount);
        expect(await Order.countDocuments({})).toBe(0);
        expect(await WalletTransaction.countDocuments({})).toBe(0);
        expect(axios.create).not.toHaveBeenCalled();
    });

    it('builds game key dry-run payload without calling provider', async () => {
        const { providerProduct } = await createFazerCodeDeliveryProviderProduct({ familyKey: 'GAME_KEYS' });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 6.5,
            name: 'Against the Storm Key',
        });

        const result = await fazerCardsCatalogSvc.buildCodeDeliveryDryRun({
            productId: product._id,
            quantity: 1,
        });

        expect(result).toMatchObject({
            success: true,
            dryRun: true,
            wouldCall: 'POST /gamekeys/order',
            payload: {
                game_id: 'against_the_storm_cis',
                key_id: 'keepers_of_the_stone',
                quantity: 1,
            },
            providerProduct: {
                familyKey: 'GAME_KEYS',
                region: 'CIS',
                platform: 'Steam',
            },
        });
        expect(axios.create).not.toHaveBeenCalled();
    });

    it('validates code-delivery quantity and stock before dry-run payload build', async () => {
        const { providerProduct } = await createFazerCodeDeliveryProviderProduct({ familyKey: 'GAME_KEYS' });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 6.5,
            name: 'Against the Storm Key',
        });

        await expect(fazerCardsCatalogSvc.buildCodeDeliveryDryRun({
            productId: product._id,
            quantity: 0,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_CODE_DELIVERY_QUANTITY_INVALID' });

        await expect(fazerCardsCatalogSvc.buildCodeDeliveryDryRun({
            productId: product._id,
            quantity: 2,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_CODE_DELIVERY_QUANTITY_INVALID' });

        await ProviderProduct.findByIdAndUpdate(providerProduct._id, { $set: { maxQty: 5 } });
        await expect(fazerCardsCatalogSvc.buildCodeDeliveryDryRun({
            productId: product._id,
            quantity: 2,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_CODE_DELIVERY_STOCK_INSUFFICIENT' });

        expect(axios.create).not.toHaveBeenCalled();
        expect(await Order.countDocuments({})).toBe(0);
        expect(await WalletTransaction.countDocuments({})).toBe(0);
    });

    it('returns code-delivery readiness as safe and not live-executable', async () => {
        const { providerProduct } = await createFazerCodeDeliveryProviderProduct({ familyKey: 'GIFTCARDS' });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 3.25,
            name: 'A-Cash MY 10',
        });

        const result = await fazerCardsCatalogSvc.getCodeDeliveryReadiness(product._id);

        expect(result).toMatchObject({
            success: true,
            productId: product._id.toString(),
            productName: 'A-Cash MY 10',
            readyForLiveExecution: false,
            familyKey: 'GIFTCARDS',
            fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
            checks: {
                productExists: true,
                linkedToFazerCards: true,
                familySupportedForPreview: true,
                fulfillmentModeCodeDelivery: true,
                providerProductExists: true,
                stockSufficient: true,
                costValid: true,
                quantitySupported: true,
                globalRealOrdersEnabled: false,
                providerExecutionEnabled: false,
                codeDeliveryStorageReady: true,
                productHidden: true,
                productInactive: true,
                hasCategoryId: true,
                hasItemId: true,
            },
        });
        expect(result.warnings).toContain('Code delivery live execution is not implemented yet.');
        expect(ProviderDeliveredCode.modelName).toBe('ProviderDeliveredCode');
        expect(await Order.countDocuments({})).toBe(0);
        expect(await WalletTransaction.countDocuments({})).toBe(0);
        expect(axios.create).not.toHaveBeenCalled();
    });
});

describe('FazerCards Phase 6 launch-ready catalog plumbing', () => {
    it.each([
        ['TELEGRAM', FULFILLMENT_MODES.TELEGRAM_STARS_TOPUP, 'TELEGRAM_EXECUTION_NOT_IMPLEMENTED'],
        ['STEAM_TOPUP', FULFILLMENT_MODES.STEAM_TOPUP_WITH_LOGIN, 'STEAM_TOPUP_EXECUTION_NOT_IMPLEMENTED'],
        ['MANUAL_SERVICES', FULFILLMENT_MODES.MANUAL_SERVICE, 'MANUAL_SERVICE_EXECUTION_NOT_IMPLEMENTED'],
    ])('imports %s as inactive hidden provider-blocked draft', async (familyKey, fulfillmentMode, blockReason) => {
        const { providerProduct } = await createFazerCatalogOnlyProviderProduct({ familyKey });

        const result = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 4.25,
            name: `${familyKey} Draft Product`,
        });

        expect(result.product).toMatchObject({
            name: `${familyKey} Draft Product`,
            isActive: false,
            visibleInStore: false,
            status: PRODUCT_STATUSES.UNAVAILABLE,
            executionType: EXECUTION_TYPES.MANUAL,
            providerExecutionEnabled: false,
            providerExecutionBlocked: true,
            providerBlockReason: blockReason,
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            familyKey,
            fulfillmentMode,
            externalProductId: providerProduct.externalProductId,
        });
        expect(result.product.providerProduct.toString()).toBe(providerProduct._id.toString());
        expect(await Order.countDocuments({})).toBe(0);
        expect(await WalletTransaction.countDocuments({})).toBe(0);
        expect(axios.create).not.toHaveBeenCalled();
    });

    it('unified dry-run routes top-ups to the existing top-up payload builder without provider calls', async () => {
        const { providerProduct } = await createFazerTopupProviderProduct();
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.25,
            name: '8 Ball Pool - Golden Spin',
        });

        const result = await fazerCardsCatalogSvc.buildUnifiedDryRun({
            productId: product._id,
            fields: { user_id: '00123456789' },
            orderId: 'order_123',
        });

        expect(result).toMatchObject({
            dryRun: true,
            wouldCall: 'POST /topups/order',
            idempotencyKeyPreview: 'fazercards:topup:order_123',
            payload: {
                category_id: '8_ball_pool',
                offer_id: 'golden_spin',
                fields: { user_id: '00123456789' },
            },
        });
        expect(axios.create).not.toHaveBeenCalled();
        expect(await Order.countDocuments({})).toBe(0);
        expect(await WalletTransaction.countDocuments({})).toBe(0);
    });

    it('unified dry-run refuses unconfirmed family contracts without provider order endpoints', async () => {
        const { providerProduct } = await createFazerCatalogOnlyProviderProduct({ familyKey: 'TELEGRAM' });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.75,
            name: 'Telegram Stars Draft',
        });

        const result = await fazerCardsCatalogSvc.buildUnifiedDryRun({
            productId: product._id,
            fields: { telegram_username: 'pilot_user' },
            quantity: 25,
        });

        expect(result).toMatchObject({
            success: false,
            dryRun: false,
            code: 'CONTRACT_UNCONFIRMED',
            wouldCall: null,
            executionAvailable: false,
            contract: {
                familyKey: 'TELEGRAM',
                supportStage: 'IMPORT_READY',
                executionStage: 'NONE',
                providerPayloadSchema: { confirmed: false },
            },
            product: {
                familyKey: 'TELEGRAM',
                fulfillmentMode: FULFILLMENT_MODES.TELEGRAM_STARS_TOPUP,
                providerExecutionEnabled: false,
                providerExecutionBlocked: true,
            },
            payload: null,
        });
        expect(result.blockers).toContain('Provider order endpoint and payload shape are unconfirmed for auto execution.');
        expect(result.warnings).toContain('Dry run was not built because this FazerCards family contract is unconfirmed.');
        expect(result.warnings).toContain('Telegram live execution is not implemented yet.');
        expect(axios.create).not.toHaveBeenCalled();
        expect(await Order.countDocuments({})).toBe(0);
        expect(await WalletTransaction.countDocuments({})).toBe(0);
    });

    it('unified readiness works for catalog-only families and remains not live-executable', async () => {
        const { providerProduct } = await createFazerCatalogOnlyProviderProduct({ familyKey: 'STEAM_TOPUP' });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 2.25,
            name: 'Steam Wallet Draft',
        });

        const result = await fazerCardsCatalogSvc.getProductReadiness(product._id);

        expect(result).toMatchObject({
            success: true,
            productId: product._id.toString(),
            readyForLiveExecution: false,
            familyKey: 'STEAM_TOPUP',
            fulfillmentMode: FULFILLMENT_MODES.STEAM_TOPUP_WITH_LOGIN,
            supportStage: 'IMPORT_READY',
            executionStage: 'NONE',
            canCustomerPurchase: true,
            canLivePilot: false,
            contract: {
                familyKey: 'STEAM_TOPUP',
                riskLevel: 'HIGH',
                providerPayloadSchema: { confirmed: false },
            },
            checks: {
                familyCatalogSupported: true,
                executionImplemented: false,
                productExecutionEnabled: false,
                productExecutionBlocked: true,
                productHidden: true,
                productInactive: true,
            },
            providerProduct: {
                externalProductId: 'FAZER_STEAM_TOPUP:USD',
                blockReason: 'STEAM_TOPUP_EXECUTION_NOT_IMPLEMENTED',
                requiredFieldKeys: ['steamLogin'],
            },
        });
        expect(result.blockers).toContain('Steam top-up execution contract is unconfirmed.');
        expect(result.requiredCapabilities).toContain('Official Steam top-up input and execution contract confirmation');
        expect(result.warnings).toContain('Steam Wallet Top-up live execution is not implemented yet.');
        expect(axios.create).not.toHaveBeenCalled();
    });

    it('provider delivered code metadata/debug never returns plaintext codes', async () => {
        const { provider, providerProduct, product } = await createReadyCodeDeliveryProduct({ familyKey: 'GIFTCARDS' });
        const pilot = await ProviderPilotOrder.create({
            product: product._id,
            provider: provider._id,
            providerProduct: providerProduct._id,
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            familyKey: 'GIFTCARDS',
            fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
            quantity: 1,
            providerCost: '2.6029',
            providerCostCurrency: 'USD',
            status: ORDER_STATUS.COMPLETED,
            deliveredCodeCount: 1,
            storedEncrypted: true,
        });
        const delivered = new ProviderDeliveredCode({
            pilotOrder: pilot._id,
            provider: provider._id,
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            providerProduct: providerProduct._id,
            product: product._id,
            familyKey: 'GIFTCARDS',
            fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
            deliveryStatus: 'DELIVERED',
            metadata: { code: 'SECRET-CODE-123', source: 'codes' },
            providerRawResponse: { codes: ['SECRET-CODE-123'], order: { id: 'provider_1' } },
            deliveredAt: new Date(),
        });
        delivered.setSecretValue('codeEncrypted', 'SECRET-CODE-123');
        delivered.setSecretValue('pinEncrypted', 'PIN-999');
        await delivered.save();

        const list = await fazerCardsCatalogSvc.listCodeDeliveryPilotDeliveredCodes(pilot._id);
        const debug = await fazerCardsCatalogSvc.getDeliveredCodeDebug(delivered._id);
        const serialized = JSON.stringify({ list, debug });

        expect(list).toMatchObject({
            success: true,
            deliveredCodeCount: 1,
            items: [{
                hasCode: true,
                hasPin: true,
                hasSerial: false,
                storedEncrypted: true,
            }],
        });
        expect(debug.code.hasCode).toBe(true);
        expect(serialized).not.toContain('SECRET-CODE-123');
        expect(serialized).not.toContain('PIN-999');
        expect(serialized).toContain('[REDACTED_CODE]');
    });
});

describe('FazerCards CODE_DELIVERY live pilot guards', () => {
    const enableCodeDeliveryPilotGates = () => {
        config.providers.fazerCards.enabled = true;
        config.providers.fazerCards.realOrdersEnabled = true;
        config.providers.fazerCards.codeDeliveryEnabled = true;
        config.providers.fazerCards.codeDeliveryMaxOrderUsd = 3.00;
    };

    it('rejects live pilot when confirmRealOrder is false', async () => {
        await expect(fazerCardsCatalogSvc.runCodeDeliveryLivePilot({
            productId: '64b64c000000000000000001',
            quantity: 1,
            confirmRealOrder: false,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_CONFIRM_REAL_ORDER_REQUIRED' });
        expect(axios.create).not.toHaveBeenCalled();
        expect(await ProviderPilotOrder.countDocuments({})).toBe(0);
    });

    it('rejects live pilot when global real orders are disabled', async () => {
        const { product } = await createReadyCodeDeliveryProduct({ familyKey: 'GIFTCARDS' });
        config.providers.fazerCards.realOrdersEnabled = false;
        config.providers.fazerCards.codeDeliveryEnabled = true;

        await expect(fazerCardsCatalogSvc.runCodeDeliveryLivePilot({
            productId: product._id,
            quantity: 1,
            confirmRealOrder: true,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_REAL_ORDERS_DISABLED' });
        expect(axios.create).not.toHaveBeenCalled();
        expect(await ProviderPilotOrder.countDocuments({})).toBe(0);
    });

    it('rejects live pilot when code-delivery gate is disabled', async () => {
        const { product } = await createReadyCodeDeliveryProduct({ familyKey: 'GIFTCARDS' });
        config.providers.fazerCards.realOrdersEnabled = true;
        config.providers.fazerCards.codeDeliveryEnabled = false;

        await expect(fazerCardsCatalogSvc.runCodeDeliveryLivePilot({
            productId: product._id,
            quantity: 1,
            confirmRealOrder: true,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_CODE_DELIVERY_DISABLED' });
        expect(axios.create).not.toHaveBeenCalled();
        expect(await ProviderPilotOrder.countDocuments({})).toBe(0);
    });

    it('rejects live pilot when product providerExecutionEnabled is false', async () => {
        enableCodeDeliveryPilotGates();
        const { product } = await createReadyCodeDeliveryProduct({ familyKey: 'GIFTCARDS' });
        await Product.findByIdAndUpdate(product._id, { $set: { providerExecutionEnabled: false } });

        await expect(fazerCardsCatalogSvc.runCodeDeliveryLivePilot({
            productId: product._id,
            quantity: 1,
            confirmRealOrder: true,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_PROVIDER_EXECUTION_DISABLED' });
        expect(axios.create).not.toHaveBeenCalled();
    });

    it('rejects live pilot when product providerExecutionBlocked is true', async () => {
        enableCodeDeliveryPilotGates();
        const { product } = await createReadyCodeDeliveryProduct({ familyKey: 'GIFTCARDS' });
        await Product.findByIdAndUpdate(product._id, { $set: { providerExecutionBlocked: true } });

        await expect(fazerCardsCatalogSvc.runCodeDeliveryLivePilot({
            productId: product._id,
            quantity: 1,
            confirmRealOrder: true,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_PROVIDER_EXECUTION_BLOCKED' });
        expect(axios.create).not.toHaveBeenCalled();
    });

    it('rejects live pilot when ProviderProduct executionBlocked is true', async () => {
        enableCodeDeliveryPilotGates();
        const { product, providerProduct } = await createReadyCodeDeliveryProduct({ familyKey: 'GIFTCARDS' });
        await ProviderProduct.findByIdAndUpdate(providerProduct._id, { $set: { executionBlocked: true } });

        await expect(fazerCardsCatalogSvc.runCodeDeliveryLivePilot({
            productId: product._id,
            quantity: 1,
            confirmRealOrder: true,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_PROVIDER_PRODUCT_EXECUTION_BLOCKED' });
        expect(axios.create).not.toHaveBeenCalled();
    });

    it('rejects live pilot when cost exceeds code-delivery max', async () => {
        enableCodeDeliveryPilotGates();
        config.providers.fazerCards.codeDeliveryMaxOrderUsd = 1.00;
        const { product } = await createReadyCodeDeliveryProduct({ familyKey: 'GIFTCARDS' });

        await expect(fazerCardsCatalogSvc.runCodeDeliveryLivePilot({
            productId: product._id,
            quantity: 1,
            confirmRealOrder: true,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_CODE_DELIVERY_MAX_COST_GUARD' });
        expect(axios.create).not.toHaveBeenCalled();
        expect(await ProviderPilotOrder.countDocuments({})).toBe(0);
    });

    it('rejects live pilot when balance is insufficient', async () => {
        enableCodeDeliveryPilotGates();
        const { product } = await createReadyCodeDeliveryProduct({ familyKey: 'GIFTCARDS' });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: { ok: true, balance: '1.00', currency: 'USD' },
        });

        await expect(fazerCardsCatalogSvc.runCodeDeliveryLivePilot({
            productId: product._id,
            quantity: 1,
            confirmRealOrder: true,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_INSUFFICIENT_PROVIDER_BALANCE' });
        expect(client.request).toHaveBeenCalledTimes(1);
        expect(client.request.mock.calls.some(([call]) => String(call.url).includes('/order'))).toBe(false);
        expect(await ProviderPilotOrder.countDocuments({})).toBe(0);
    });

    it('rejects live pilot when quantity is invalid', async () => {
        enableCodeDeliveryPilotGates();
        const { product } = await createReadyCodeDeliveryProduct({ familyKey: 'GAME_KEYS' });

        await expect(fazerCardsCatalogSvc.runCodeDeliveryLivePilot({
            productId: product._id,
            quantity: 2,
            confirmRealOrder: true,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_CODE_DELIVERY_QUANTITY_INVALID' });
        expect(axios.create).not.toHaveBeenCalled();
        expect(await ProviderPilotOrder.countDocuments({})).toBe(0);
    });

    it('creates a local tracked record before mocked gift card provider call and stores encrypted codes safely', async () => {
        enableCodeDeliveryPilotGates();
        const { product, providerProduct } = await createReadyCodeDeliveryProduct({ familyKey: 'GIFTCARDS' });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockImplementation(async (call) => {
            if (call.url === '/balance') {
                return { status: 200, headers: {}, data: { ok: true, balance: '10.00', currency: 'USD' } };
            }
            if (call.url === '/giftcards/order') {
                const local = await ProviderPilotOrder.findOne({ product: product._id });
                expect(local).toBeTruthy();
                expect(call.headers).toEqual({ 'Idempotency-Key': `fazercards:code-delivery:${local._id.toString()}` });
                return {
                    status: 200,
                    headers: { 'x-request-id': 'req-gift-pilot' },
                    data: {
                        ok: true,
                        order: { id: 'fgc_1', status: 'succeeded' },
                        cards: [{ code: 'SECRET-GIFT-CODE-1', pin: '1234', serial: 'SER-1' }],
                    },
                };
            }
            throw new Error(`Unexpected request ${call.url}`);
        });

        const result = await fazerCardsCatalogSvc.runCodeDeliveryLivePilot({
            productId: product._id,
            quantity: 1,
            confirmRealOrder: true,
            operatorNote: 'First controlled gift card pilot',
        });
        const pilot = await ProviderPilotOrder.findById(result.order.localOrderId).lean();
        const storedCode = await ProviderDeliveredCode.findOne({ pilotOrder: pilot._id })
            .select('+codeEncrypted +pinEncrypted +serialEncrypted')
            .lean();

        expect(result).toMatchObject({
            success: true,
            livePilot: true,
            order: {
                localStatus: ORDER_STATUS.COMPLETED,
                familyKey: 'GIFTCARDS',
                providerOrderId: 'fgc_1',
                providerStatus: 'Completed',
                deliveredCodeCount: 1,
                hasPin: true,
                hasSerial: true,
                storedEncrypted: true,
            },
        });
        expect(pilot.providerIdempotencyKey).toBe(`fazercards:code-delivery:${pilot._id.toString()}`);
        expect(pilot.providerProduct.toString()).toBe(providerProduct._id.toString());
        expect(JSON.stringify(result)).not.toContain('SECRET-GIFT-CODE-1');
        expect(JSON.stringify(result)).not.toContain('1234');
        expect(JSON.stringify(pilot.providerRawResponse)).not.toContain('SECRET-GIFT-CODE-1');
        expect(storedCode.codeEncrypted).not.toBe('SECRET-GIFT-CODE-1');
        expect(isEncryptedSecret(storedCode.codeEncrypted)).toBe(true);
        expect(decryptSecret(storedCode.codeEncrypted)).toBe('SECRET-GIFT-CODE-1');
        expect(await Order.countDocuments({})).toBe(0);
        expect(await WalletTransaction.countDocuments({})).toBe(0);
    });

    it('stores mocked game key success encrypted without returning plaintext', async () => {
        enableCodeDeliveryPilotGates();
        config.providers.fazerCards.codeDeliveryMaxOrderUsd = 10.00;
        const { product } = await createReadyCodeDeliveryProduct({ familyKey: 'GAME_KEYS', sellPrice: 6.5 });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request
            .mockResolvedValueOnce({
                status: 200,
                headers: {},
                data: { ok: true, balance: '20.00', currency: 'USD' },
            })
            .mockResolvedValueOnce({
                status: 200,
                headers: { 'x-request-id': 'req-key-pilot' },
                data: {
                    ok: true,
                    order: { id: 'fgk_1', status: 'success' },
                    keys: [{ key: 'STEAM-KEY-SECRET-1', serial: 'KEY-SER-1' }],
                },
            });

        const result = await fazerCardsCatalogSvc.runCodeDeliveryLivePilot({
            productId: product._id,
            quantity: 1,
            confirmRealOrder: true,
        });
        const storedCode = await ProviderDeliveredCode.findOne({ pilotOrder: result.order.localOrderId })
            .select('+codeEncrypted +serialEncrypted')
            .lean();

        expect(result.order).toMatchObject({
            localStatus: ORDER_STATUS.COMPLETED,
            familyKey: 'GAME_KEYS',
            providerOrderId: 'fgk_1',
            deliveredCodeCount: 1,
            hasSerial: true,
            storedEncrypted: true,
        });
        expect(client.request).toHaveBeenLastCalledWith(expect.objectContaining({
            method: 'post',
            url: '/gamekeys/order',
            data: {
                game_id: 'against_the_storm_cis',
                key_id: 'keepers_of_the_stone',
                quantity: 1,
            },
        }));
        expect(JSON.stringify(result)).not.toContain('STEAM-KEY-SECRET-1');
        expect(decryptSecret(storedCode.codeEncrypted)).toBe('STEAM-KEY-SECRET-1');
    });

    it('moves unknown provider response to manual review without blind refund or plaintext response', async () => {
        enableCodeDeliveryPilotGates();
        const { product } = await createReadyCodeDeliveryProduct({ familyKey: 'GIFTCARDS' });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request
            .mockResolvedValueOnce({
                status: 200,
                headers: {},
                data: { ok: true, balance: '10.00', currency: 'USD' },
            })
            .mockResolvedValueOnce({
                status: 200,
                headers: {},
                data: { ok: true, order: { id: 'fgc_unknown', status: 'succeeded' }, message: 'No code yet' },
            });

        const result = await fazerCardsCatalogSvc.runCodeDeliveryLivePilot({
            productId: product._id,
            quantity: 1,
            confirmRealOrder: true,
        });
        const pilot = await ProviderPilotOrder.findById(result.order.localOrderId).lean();

        expect(result.success).toBe(false);
        expect(result.order.localStatus).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(result.order.deliveredCodeCount).toBe(0);
        expect(pilot.providerErrorCode).toBe('FAZERCARDS_CODE_DELIVERY_CODE_MISSING');
        expect(await ProviderDeliveredCode.countDocuments({ pilotOrder: pilot._id })).toBe(0);
        expect(await WalletTransaction.countDocuments({})).toBe(0);
    });

    it('debug endpoint returns safe live pilot data without plaintext code', async () => {
        enableCodeDeliveryPilotGates();
        const { product } = await createReadyCodeDeliveryProduct({ familyKey: 'GIFTCARDS' });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request
            .mockResolvedValueOnce({
                status: 200,
                headers: {},
                data: { ok: true, balance: '10.00', currency: 'USD' },
            })
            .mockResolvedValueOnce({
                status: 200,
                headers: {},
                data: {
                    ok: true,
                    order: { id: 'fgc_debug', status: 'completed' },
                    codes: ['DEBUG-SECRET-CODE'],
                },
            });
        const result = await fazerCardsCatalogSvc.runCodeDeliveryLivePilot({
            productId: product._id,
            quantity: 1,
            confirmRealOrder: true,
        });

        const debug = await fazerCardsCatalogSvc.getCodeDeliveryLivePilotDebug(result.order.localOrderId);

        expect(debug).toMatchObject({
            localOrderId: result.order.localOrderId,
            localStatus: ORDER_STATUS.COMPLETED,
            familyKey: 'GIFTCARDS',
            fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
            providerOrderId: 'fgc_debug',
            deliveredCodeCount: 1,
            storedEncrypted: true,
        });
        expect(JSON.stringify(debug)).not.toContain('DEBUG-SECRET-CODE');
        expect(JSON.stringify(debug)).toContain('[REDACTED_CODE]');
    });

    it('keeps code-delivery dry-run provider-call-free after live pilot wiring', async () => {
        const { providerProduct } = await createFazerCodeDeliveryProviderProduct({ familyKey: 'GIFTCARDS' });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 3.25,
            name: 'A-Cash MY 10',
        });

        const result = await fazerCardsCatalogSvc.buildCodeDeliveryDryRun({
            productId: product._id,
            quantity: 1,
        });

        expect(result.dryRun).toBe(true);
        expect(result.wouldCall).toBe('POST /giftcards/order');
        expect(axios.create).not.toHaveBeenCalled();
        expect(await ProviderPilotOrder.countDocuments({})).toBe(0);
        expect(await Order.countDocuments({})).toBe(0);
        expect(await WalletTransaction.countDocuments({})).toBe(0);
    });
});

describe('FazerCards controlled top-up order execution', () => {
    it('does not call FazerCards order creation when the global real-order gate is disabled', async () => {
        const { order, customer } = await createFazerTopupOrder();
        const before = (await User.findById(customer._id)).walletBalance;
        const client = makeClient();
        axios.create.mockReturnValue(client);

        const { order: updated, refunded } = await executeOrder(order._id);

        expect(updated.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(updated.refunded).toBe(false);
        expect(updated.providerErrorCode).toBe('FAZERCARDS_REAL_ORDERS_DISABLED');
        expect(updated.rejectionReason).toBe('FazerCards real orders are disabled by global safety gate.');
        expect(refunded).toBe(false);
        expect(client.request).not.toHaveBeenCalled();
        expect((await User.findById(customer._id)).walletBalance).toBe(before);
    });

    it('does not call FazerCards when providerExecutionEnabled is false', async () => {
        const { order, customer } = await createFazerTopupOrder({ providerExecutionEnabled: false });
        const before = (await User.findById(customer._id)).walletBalance;
        const client = makeClient();
        axios.create.mockReturnValue(client);

        const { order: updated, refunded } = await executeOrder(order._id);

        expect(updated.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(updated.refunded).toBe(false);
        expect(updated.providerErrorCode).toBe('FAZERCARDS_PROVIDER_EXECUTION_DISABLED');
        expect(updated.rejectionReason).toBe('FazerCards provider execution is disabled for this product.');
        expect(refunded).toBe(false);
        expect(client.request).not.toHaveBeenCalled();
        expect((await User.findById(customer._id)).walletBalance).toBe(before);
    });

    it('rejects missing required customer fields before calling FazerCards', async () => {
        const { order } = await createFazerTopupOrder({ customerFields: {} });
        const client = makeClient();
        axios.create.mockReturnValue(client);

        const { order: updated } = await executeOrder(order._id);

        expect(updated.status).toBe(ORDER_STATUS.FAILED);
        expect(updated.refunded).toBe(true);
        expect(updated.providerErrorCode).toBe('FAZERCARDS_CUSTOMER_FIELDS_MISSING');
        expect(client.request).not.toHaveBeenCalled();
    });

    it('blocks real orders when provider cost exceeds FAZERCARDS_MAX_ORDER_USD', async () => {
        config.providers.fazerCards.realOrdersEnabled = true;
        config.providers.fazerCards.maxOrderUsd = 0.50;
        const { order, customer } = await createFazerTopupOrder();
        const before = (await User.findById(customer._id)).walletBalance;
        const client = makeClient();
        axios.create.mockReturnValue(client);

        const { order: updated, refunded } = await executeOrder(order._id);

        expect(updated.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(updated.refunded).toBe(false);
        expect(updated.providerErrorCode).toBe('FAZERCARDS_MAX_COST_GUARD');
        expect(updated.rejectionReason).toBe('FazerCards order blocked by max cost guard.');
        expect(refunded).toBe(false);
        expect(client.request).not.toHaveBeenCalled();
        expect((await User.findById(customer._id)).walletBalance).toBe(before);
    });

    it('preflight balance blocks provider call and refunds when provider balance is clearly insufficient', async () => {
        config.providers.fazerCards.realOrdersEnabled = true;
        const { order, customer } = await createFazerTopupOrder({ walletDeducted: 50 });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: { ok: true, balance: '0.10', currency: 'USD' },
        });

        const { order: updated } = await executeOrder(order._id);
        const refunds = await WalletTransaction.find({ userId: customer._id, type: 'REFUND' });

        expect(updated.status).toBe(ORDER_STATUS.FAILED);
        expect(updated.refunded).toBe(true);
        expect(updated.providerErrorCode).toBe('FAZERCARDS_INSUFFICIENT_PROVIDER_BALANCE');
        expect(refunds).toHaveLength(1);
        expect(client.request).toHaveBeenCalledTimes(1);
        expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'get',
            url: '/balance',
        }));
        expect(client.request.mock.calls.some(([call]) => call.url === ['/topups', 'order'].join('/'))).toBe(false);
    });

    it('preflight balance timeout moves to manual review without blind refund or provider order call', async () => {
        config.providers.fazerCards.realOrdersEnabled = true;
        const { order, customer } = await createFazerTopupOrder({ walletDeducted: 50 });
        const before = (await User.findById(customer._id)).walletBalance;
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 20000ms exceeded' });

        const { order: updated, refunded } = await executeOrder(order._id);

        expect(updated.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(updated.refunded).toBe(false);
        expect(updated.providerErrorCode).toBe('FAZERCARDS_BALANCE_UNKNOWN');
        expect(refunded).toBe(false);
        expect((await User.findById(customer._id)).walletBalance).toBe(before);
        expect(client.request).toHaveBeenCalledTimes(1);
        expect(client.request.mock.calls.some(([call]) => call.url === ['/topups', 'order'].join('/'))).toBe(false);
    });

    it('builds the exact top-up payload and stable Idempotency-Key while preserving string IDs', async () => {
        config.providers.fazerCards.realOrdersEnabled = true;
        const { order } = await createFazerTopupOrder({ customerFields: { user_id: '00123456789' } });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request
            .mockResolvedValueOnce({
                status: 200,
                headers: {},
                data: { ok: true, balance: '10.00', currency: 'USD' },
            })
            .mockResolvedValueOnce({
                status: 200,
                headers: { 'x-request-id': 'req-topup' },
                data: {
                    ok: true,
                    order: { id: 'fc_order_1', status: 'processing' },
                },
            });

        const { order: updated, refunded } = await executeOrder(order._id);

        expect(updated.status).toBe(ORDER_STATUS.PROCESSING);
        expect(updated.providerOrderId).toBe('fc_order_1');
        expect(updated.providerStatus).toBe('Pending');
        expect(updated.providerRequestId).toBe('req-topup');
        expect(updated.providerIdempotencyKey).toBe(`fazercards:topup:${order._id.toString()}`);
        expect(refunded).toBe(false);
        expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'post',
            url: '/topups/order',
            data: {
                category_id: '8_ball_pool',
                offer_id: 'golden_spin',
                fields: { user_id: '00123456789' },
            },
            headers: { 'Idempotency-Key': `fazercards:topup:${order._id.toString()}` },
        }));
    });

    it('maps completed FazerCards status to completed orders', async () => {
        config.providers.fazerCards.realOrdersEnabled = true;
        const { order } = await createFazerTopupOrder();
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request
            .mockResolvedValueOnce({
                status: 200,
                headers: {},
                data: { ok: true, balance: '10.00', currency: 'USD' },
            })
            .mockResolvedValueOnce({
                status: 200,
                headers: {},
                data: { ok: true, order: { id: 'fc_done', status: 'succeeded' } },
            });

        const { order: updated, refunded } = await executeOrder(order._id);

        expect(updated.status).toBe(ORDER_STATUS.COMPLETED);
        expect(updated.providerOrderId).toBe('fc_done');
        expect(updated.providerStatus).toBe('Completed');
        expect(refunded).toBe(false);
    });

    it('maps failed FazerCards status to failed and refunds once', async () => {
        config.providers.fazerCards.realOrdersEnabled = true;
        const { order, customer } = await createFazerTopupOrder({ walletDeducted: 50 });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request
            .mockResolvedValueOnce({
                status: 200,
                headers: {},
                data: { ok: true, balance: '10.00', currency: 'USD' },
            })
            .mockResolvedValueOnce({
                status: 200,
                headers: {},
                data: { ok: false, order: { id: 'fc_failed', status: 'failed', errorMessage: 'Rejected' } },
            });

        await executeOrder(order._id);
        await executeOrder(order._id);

        const updated = await Order.findById(order._id);
        const refunds = await WalletTransaction.find({ userId: customer._id, type: 'REFUND' });
        expect(updated.status).toBe(ORDER_STATUS.FAILED);
        expect(updated.refunded).toBe(true);
        expect(updated.providerOrderId).toBe('fc_failed');
        expect(refunds).toHaveLength(1);
    });

    it('moves unknown or timeout top-up outcomes to manual review without refund', async () => {
        for (const scenario of [
            {
                response: { ok: true, order: { id: 'fc_unknown', status: 'mystery' } },
                code: 'FAZERCARDS_TOPUP_ORDER_UNKNOWN_STATUS',
            },
            {
                response: { ok: true, order: { status: 'processing' } },
                code: 'FAZERCARDS_TOPUP_ORDER_ID_MISSING',
            },
            {
                error: { code: 'ECONNABORTED', message: 'timeout of 20000ms exceeded' },
                code: 'FAZERCARDS_TIMEOUT',
            },
        ]) {
            await clearCollections();
            config.providers.fazerCards.realOrdersEnabled = true;
            const { order, customer } = await createFazerTopupOrder();
            const before = (await User.findById(customer._id)).walletBalance;
            const client = makeClient();
            axios.create.mockReturnValue(client);
            client.request.mockResolvedValueOnce({
                status: 200,
                headers: {},
                data: { ok: true, balance: '10.00', currency: 'USD' },
            });
            if (scenario.error) {
                client.request.mockRejectedValueOnce(scenario.error);
            } else {
                client.request.mockResolvedValueOnce({ status: 200, headers: {}, data: scenario.response });
            }

            const { order: updated, refunded } = await executeOrder(order._id);

            expect(updated.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
            expect(updated.refunded).toBe(false);
            expect(updated.providerErrorCode).toBe(scenario.code);
            expect(refunded).toBe(false);
            expect((await User.findById(customer._id)).walletBalance).toBe(before);
        }
    });
});

describe('FazerCards top-up dry-run payload preview', () => {
    it('builds the exact top-up payload without calling FazerCards, creating orders, or wallet transactions', async () => {
        const { product, providerProduct } = await createFazerTopupOrder({
            providerExecutionEnabled: false,
            customerFields: { user_id: 'not-used-by-dry-run' },
        });
        await Order.deleteMany({});
        await WalletTransaction.deleteMany({});

        const result = await fazerCardsCatalogSvc.buildTopupDryRun({
            productId: product._id,
            fields: { user_id: '00123456789' },
        });

        expect(result).toMatchObject({
            success: true,
            dryRun: true,
            wouldCall: 'POST /topups/order',
            provider: 'FazerCards',
            idempotencyKeyPreview: 'fazercards:topup:DRY_RUN_PREVIEW',
            product: {
                id: product._id.toString(),
                name: product.name,
                providerExecutionEnabled: false,
            },
            providerProduct: {
                id: providerProduct._id.toString(),
                externalProductId: 'FAZER_TOPUP:8_ball_pool:golden_spin',
                costPrice: '0.7487',
                currency: 'USD',
            },
            payload: {
                category_id: '8_ball_pool',
                offer_id: 'golden_spin',
                fields: { user_id: '00123456789' },
            },
        });
        expect(result.requiredFields).toHaveLength(1);
        expect(result.warnings).toContain('Dry run only. No FazerCards order was created.');
        expect(result.warnings).toContain('Product execution is currently disabled.');
        expect(axios.create).not.toHaveBeenCalled();
        expect(await Order.countDocuments({})).toBe(0);
        expect(await WalletTransaction.countDocuments({})).toBe(0);
    });

    it('preserves numeric-looking IDs as strings in dry-run payloads', async () => {
        const { product } = await createFazerTopupOrder();
        await Order.deleteMany({});

        const result = await fazerCardsCatalogSvc.buildTopupDryRun({
            productId: product._id,
            fields: { user_id: '000123456789' },
            orderId: 'preview-order-1',
        });

        expect(result.idempotencyKeyPreview).toBe('fazercards:topup:preview-order-1');
        expect(result.payload.fields.user_id).toBe('000123456789');
        expect(typeof result.payload.fields.user_id).toBe('string');
        expect(await Order.countDocuments({})).toBe(0);
    });

    it('fails dry-run when required fields are missing', async () => {
        const { product } = await createFazerTopupOrder();

        await expect(fazerCardsCatalogSvc.buildTopupDryRun({
            productId: product._id,
            fields: {},
        })).rejects.toMatchObject({ code: 'FAZERCARDS_CUSTOMER_FIELDS_MISSING' });
        expect(axios.create).not.toHaveBeenCalled();
    });

    it('fails dry-run for unsupported or blocked FazerCards provider products', async () => {
        for (const providerProductOverrides of [
            { isSupported: false, isBlocked: true, blockReason: 'MISSING_REQUIRED_FIELDS' },
            { isSupported: true, isBlocked: true, blockReason: 'BLOCKED_REGION' },
        ]) {
            await clearCollections();
            const { product } = await createFazerTopupOrder({ providerProductOverrides });

            await expect(fazerCardsCatalogSvc.buildTopupDryRun({
                productId: product._id,
                fields: { user_id: '001234' },
            })).rejects.toMatchObject({
                code: providerProductOverrides.isSupported === false
                    ? 'FAZERCARDS_PROVIDER_PRODUCT_UNSUPPORTED'
                    : 'FAZERCARDS_PROVIDER_PRODUCT_BLOCKED',
            });
        }
    });

    it('fails dry-run for non-FazerCards products', async () => {
        const provider = await Provider.create({
            name: 'Mock Supplier',
            slug: 'mock',
            baseUrl: 'https://mock.example',
            isActive: true,
            syncInterval: 0,
        });
        const providerProduct = await ProviderProduct.create({
            provider: provider._id,
            externalProductId: 'mock-topup',
            rawName: 'Mock Topup',
            rawPrice: '1.00',
            minQty: 1,
            maxQty: 1,
            isActive: true,
            fulfillmentMode: FULFILLMENT_MODES.TOPUP_WITH_FIELDS,
            isSupported: true,
            isBlocked: false,
            requiredFields: [{ key: 'user_id', label: 'User ID', type: 'text', required: true }],
        });
        const product = await Product.create({
            name: 'Mock Product',
            basePrice: '1.50',
            minQty: 1,
            maxQty: 1,
            isActive: true,
            provider: provider._id,
            providerProduct: providerProduct._id,
            executionType: EXECUTION_TYPES.AUTOMATIC,
        });

        await expect(fazerCardsCatalogSvc.buildTopupDryRun({
            productId: product._id,
            fields: { user_id: '001234' },
        })).rejects.toMatchObject({ code: 'FAZERCARDS_PRODUCT_REQUIRED' });
        expect(axios.create).not.toHaveBeenCalled();
    });
});

describe('FazerCards launch readiness gate', () => {
    it('returns safe readiness checks without creating orders or provider top-up calls', async () => {
        const { product, providerProduct } = await createFazerTopupOrder({
            providerExecutionEnabled: false,
            productOverrides: {
                isActive: false,
                visibleInStore: false,
                status: PRODUCT_STATUSES.UNAVAILABLE,
            },
        });
        await Order.deleteMany({});
        await WalletTransaction.deleteMany({});
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: { ok: true, balance: '10.00', currency: 'USD' },
        });

        const result = await fazerCardsCatalogSvc.getProductReadiness(product._id);

        expect(result).toMatchObject({
            success: true,
            productId: product._id.toString(),
            productName: product.name,
            readyForLiveExecution: false,
            checks: {
                fazerCardsEnabled: true,
                globalRealOrdersEnabled: false,
                productExecutionEnabled: false,
                linkedProviderProduct: true,
                supportedProviderProduct: true,
                notBlocked: true,
                hasCategoryId: true,
                hasOfferId: true,
                hasRequiredFields: true,
                costValid: true,
                underMaxCost: true,
                balanceSufficient: true,
                productVisible: false,
                productActive: false,
            },
            providerProduct: {
                id: providerProduct._id.toString(),
                externalProductId: 'FAZER_TOPUP:8_ball_pool:golden_spin',
                costPrice: '0.7487',
                currency: 'USD',
                maxOrderUsd: 1,
                balance: 10,
            },
        });
        expect(result.warnings).toContain('Global real order gate is disabled.');
        expect(result.warnings).toContain('Product is hidden from customers.');
        expect(result.nextActions).toContain('Use a real valid account ID.');
        expect(await Order.countDocuments({})).toBe(0);
        expect(await WalletTransaction.countDocuments({})).toBe(0);
        expect(client.request).toHaveBeenCalledTimes(1);
        expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'get',
            url: '/balance',
        }));
        expect(client.request.mock.calls.some(([call]) => call.url === ['/topups', 'order'].join('/'))).toBe(false);
    });

    it('rejects readiness checks for non-FazerCards products', async () => {
        const provider = await Provider.create({
            name: 'Mock Supplier',
            slug: 'mock',
            baseUrl: 'https://mock.example',
            isActive: true,
            syncInterval: 0,
        });
        const providerProduct = await ProviderProduct.create({
            provider: provider._id,
            externalProductId: 'mock-topup',
            rawName: 'Mock Topup',
            rawPrice: '1.00',
            minQty: 1,
            maxQty: 1,
            isActive: true,
            fulfillmentMode: FULFILLMENT_MODES.TOPUP_WITH_FIELDS,
            isSupported: true,
            isBlocked: false,
            requiredFields: [{ key: 'user_id', label: 'User ID', type: 'text', required: true }],
        });
        const product = await Product.create({
            name: 'Mock Product',
            basePrice: '1.50',
            minQty: 1,
            maxQty: 1,
            isActive: true,
            provider: provider._id,
            providerProduct: providerProduct._id,
            executionType: EXECUTION_TYPES.AUTOMATIC,
        });

        await expect(fazerCardsCatalogSvc.getProductReadiness(product._id))
            .rejects.toMatchObject({ code: 'FAZERCARDS_PRODUCT_REQUIRED' });
        expect(axios.create).not.toHaveBeenCalled();
    });
});

describe('FazerCards order monitoring and reconcile tools', () => {
    const configureStatusEndpoint = (path = '/topups/orders/{providerOrderId}') => {
        config.providers.fazerCards.topupOrderStatusPath = path;
    };

    const markFazerOrderSent = (order, providerOrderId = 'fc_status_1') => Order.findByIdAndUpdate(order._id, {
        $set: {
            providerOrderId,
            providerStatus: 'Pending',
            providerRawResponse: { ok: true, order: { id: providerOrderId, status: 'processing' } },
            providerIdempotencyKey: `fazercards:topup:${order._id.toString()}`,
        },
    }, { new: true });

    it('sync rejects non-FazerCards orders', async () => {
        const provider = await Provider.create({
            name: 'Mock Supplier',
            slug: 'mock',
            baseUrl: 'https://mock.example',
            isActive: true,
            syncInterval: 0,
        });
        const providerProduct = await ProviderProduct.create({
            provider: provider._id,
            externalProductId: 'mock-product',
            rawName: 'Mock Product',
            rawPrice: '1.00',
            minQty: 1,
            maxQty: 1,
            isActive: true,
        });
        const { customer, group } = await createCustomerWithGroup({ walletBalance: 1000 }, { percentage: 0 });
        const product = await Product.create({
            name: 'Mock Product',
            basePrice: '1.00',
            minQty: 1,
            maxQty: 1,
            provider: provider._id,
            providerProduct: providerProduct._id,
            executionType: EXECUTION_TYPES.AUTOMATIC,
        });
        const order = await Order.create({
            userId: customer._id,
            orderNumber: 890001,
            productId: product._id,
            quantity: 1,
            unitPrice: '1.00',
            totalPrice: '1.00',
            basePriceSnapshot: '1.00',
            markupPercentageSnapshot: 0,
            finalPriceCharged: '1.00',
            groupIdSnapshot: group._id,
            walletDeducted: 10,
            creditUsedAmount: '0',
            status: ORDER_STATUS.PROCESSING,
            executionType: ORDER_EXECUTION_TYPES.AUTOMATIC,
            providerCode: 'mock',
            providerOrderId: 'mock_order_1',
        });

        await expect(fazerCardsCatalogSvc.syncOrderStatus(order._id))
            .rejects.toMatchObject({ code: 'INVALID_PROVIDER_ORDER' });
    });

    it('sync rejects FazerCards orders without providerOrderId', async () => {
        const { order } = await createFazerTopupOrder();

        await expect(fazerCardsCatalogSvc.syncOrderStatus(order._id))
            .rejects.toMatchObject({ code: 'FAZERCARDS_ORDER_NOT_SENT' });
    });

    it('sync maps completed status and stores the safe provider response', async () => {
        configureStatusEndpoint();
        const { order } = await createFazerTopupOrder();
        await markFazerOrderSent(order, 'fc_done');
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: { 'x-request-id': 'req-status-done' },
            data: { ok: true, order: { id: 'fc_done', status: 'succeeded' } },
        });

        const result = await fazerCardsCatalogSvc.syncOrderStatus(order._id);
        const updated = await Order.findById(order._id).lean();

        expect(result.action).toBe('completed');
        expect(updated.status).toBe(ORDER_STATUS.COMPLETED);
        expect(updated.providerOrderId).toBe('fc_done');
        expect(updated.providerStatus).toBe('Completed');
        expect(updated.providerRequestId).toBe('req-status-done');
        expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'get',
            url: '/topups/orders/fc_done',
        }));
        expect(client.request.mock.calls.some(([call]) => call.url === ['/topups', 'order'].join('/'))).toBe(false);
    });

    it('sync maps processing status without refunding', async () => {
        configureStatusEndpoint('/topups/order-status');
        const { order, customer } = await createFazerTopupOrder({ walletDeducted: 50 });
        await markFazerOrderSent(order, 'fc_pending');
        const before = (await User.findById(customer._id)).walletBalance;
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: { ok: true, order: { id: 'fc_pending', status: 'processing' } },
        });

        const result = await fazerCardsCatalogSvc.syncOrderStatus(order._id);
        const updated = await Order.findById(order._id);

        expect(result.action).toBe('processing');
        expect(updated.status).toBe(ORDER_STATUS.PROCESSING);
        expect(updated.providerStatus).toBe('Pending');
        expect(updated.refunded).toBe(false);
        expect((await User.findById(customer._id)).walletBalance).toBe(before);
        expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'get',
            url: '/topups/order-status',
            params: { order_id: 'fc_pending' },
        }));
    });

    it('sync maps failed status to failed and refunds only once', async () => {
        configureStatusEndpoint();
        const { order, customer } = await createFazerTopupOrder({ walletDeducted: 50 });
        await markFazerOrderSent(order, 'fc_failed');
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request
            .mockResolvedValueOnce({
                status: 200,
                headers: {},
                data: { ok: false, order: { id: 'fc_failed', status: 'failed', errorMessage: 'Rejected' } },
            })
            .mockResolvedValueOnce({
                status: 200,
                headers: {},
                data: { ok: false, order: { id: 'fc_failed', status: 'failed', errorMessage: 'Rejected' } },
            });

        await fazerCardsCatalogSvc.syncOrderStatus(order._id);
        await fazerCardsCatalogSvc.syncOrderStatus(order._id);

        const updated = await Order.findById(order._id);
        const refunds = await WalletTransaction.find({ userId: customer._id, type: 'REFUND' });
        expect(updated.status).toBe(ORDER_STATUS.FAILED);
        expect(updated.refunded).toBe(true);
        expect(updated.providerStatus).toBe('Cancelled');
        expect(refunds).toHaveLength(1);
    });

    it('sync timeout or unknown status moves to manual review without blind refund', async () => {
        for (const scenario of [
            {
                response: { ok: true, order: { id: 'fc_unknown', status: 'mystery' } },
                code: 'FAZERCARDS_STATUS_UNKNOWN',
            },
            {
                error: { code: 'ECONNABORTED', message: 'timeout of 20000ms exceeded' },
                code: 'FAZERCARDS_STATUS_UNKNOWN',
            },
        ]) {
            await clearCollections();
            configureStatusEndpoint();
            const { order, customer } = await createFazerTopupOrder({ walletDeducted: 50 });
            await markFazerOrderSent(order, 'fc_unknown');
            const before = (await User.findById(customer._id)).walletBalance;
            const client = makeClient();
            axios.create.mockReturnValue(client);
            if (scenario.error) {
                client.request.mockRejectedValueOnce(scenario.error);
            } else {
                client.request.mockResolvedValueOnce({ status: 200, headers: {}, data: scenario.response });
            }

            const result = await fazerCardsCatalogSvc.syncOrderStatus(order._id);
            const updated = await Order.findById(order._id);

            expect(result.action).toBe('manualReview');
            expect(updated.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
            expect(updated.refunded).toBe(false);
            expect(updated.providerErrorCode).toBe(scenario.code);
            expect((await User.findById(customer._id)).walletBalance).toBe(before);
        }
    });

    it('generic status sync stores encrypted gift-card codes and returns only safe admin metadata', async () => {
        configureStatusEndpoint(null);
        const { order } = await createFazerCodeDeliveryOrder({ familyKey: 'GIFTCARDS', providerOrderId: 'fc_gift_status' });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: { 'x-request-id': 'req-gift-status' },
            data: {
                ok: true,
                data: {
                    order: { id: 'fc_gift_status', status: 'completed' },
                    cards: [{ gift_code: 'GIFT-STATUS-CODE-1', pin: 'PIN-S1', serial: 'SER-S1' }],
                },
            },
        });

        const result = await fazerCardsCatalogSvc.syncOrderStatus(order._id);
        const updated = await Order.findById(order._id).lean();
        const stored = await ProviderDeliveredCode.findOne({ order: order._id })
            .select('+codeEncrypted +pinEncrypted +serialEncrypted providerRawResponse')
            .lean();
        const serialized = JSON.stringify(result);

        expect(result).toMatchObject({
            action: 'completed',
            oldStatus: ORDER_STATUS.PROCESSING,
            newStatus: ORDER_STATUS.COMPLETED,
            reviewRequired: false,
            codeStored: true,
            deliveredCodeCount: 1,
            providerResult: {
                providerOrderId: 'fc_gift_status',
                normalizedStatus: 'COMPLETED',
                providerRequestId: 'req-gift-status',
            },
        });
        expect(updated.status).toBe(ORDER_STATUS.COMPLETED);
        expect(isEncryptedSecret(stored.codeEncrypted)).toBe(true);
        expect(decryptSecret(stored.codeEncrypted)).toBe('GIFT-STATUS-CODE-1');
        expect(decryptSecret(stored.pinEncrypted)).toBe('PIN-S1');
        expect(decryptSecret(stored.serialEncrypted)).toBe('SER-S1');
        expect(stored.providerRawResponse.data.cards[0].gift_code).toBe('[REDACTED_CODE]');
        expect(serialized).not.toContain('GIFT-STATUS-CODE-1');
        expect(serialized).not.toContain('PIN-S1');
        expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'get',
            url: '/orders/fc_gift_status',
        }));
    });

    it('generic status sync stores encrypted game keys and deduplicates repeated status payloads', async () => {
        configureStatusEndpoint(null);
        const { order } = await createFazerCodeDeliveryOrder({ familyKey: 'GAME_KEYS', providerOrderId: 'fc_game_status' });
        const statusPayload = {
            ok: true,
            data: {
                order: { order_id: 'fc_game_status', status: 'fulfilled' },
                keys: [{ licenseKey: 'GAME-STATUS-KEY-1', serial: 'GAME-SER-1' }],
            },
        };
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request
            .mockResolvedValueOnce({ status: 200, headers: {}, data: statusPayload })
            .mockResolvedValueOnce({ status: 200, headers: {}, data: statusPayload });

        const first = await fazerCardsCatalogSvc.syncOrderStatus(order._id);
        const second = await fazerCardsCatalogSvc.syncOrderStatus(order._id);
        const stored = await ProviderDeliveredCode.find({ order: order._id })
            .select('+codeEncrypted +serialEncrypted')
            .lean();

        expect(first).toMatchObject({ action: 'completed', codeStored: true, deliveredCodeCount: 1 });
        expect(second).toMatchObject({ action: 'completed', codeStored: true, deliveredCodeCount: 1 });
        expect(stored).toHaveLength(1);
        expect(decryptSecret(stored[0].codeEncrypted)).toBe('GAME-STATUS-KEY-1');
        expect(decryptSecret(stored[0].serialEncrypted)).toBe('GAME-SER-1');
        expect(client.request).toHaveBeenCalledTimes(2);
        expect(client.request.mock.calls.every(([call]) => call.url === '/orders/fc_game_status')).toBe(true);
    });

    it('completed code-delivery status without a recognized code stays in manual review', async () => {
        configureStatusEndpoint(null);
        const { order } = await createFazerCodeDeliveryOrder({ familyKey: 'GIFTCARDS', providerOrderId: 'fc_gift_missing_code' });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: { ok: true, data: { order: { id: 'fc_gift_missing_code', status: 'completed' } } },
        });

        const result = await fazerCardsCatalogSvc.syncOrderStatus(order._id);
        const updated = await Order.findById(order._id).lean();

        expect(result).toMatchObject({
            action: 'manualReview',
            newStatus: ORDER_STATUS.MANUAL_REVIEW,
            reviewRequired: true,
            codeStored: false,
            deliveredCodeCount: 0,
        });
        expect(updated.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(updated.providerErrorCode).toBe('FAZERCARDS_CODE_DELIVERY_CODE_MISSING');
        expect(await ProviderDeliveredCode.countDocuments({ order: order._id })).toBe(0);
    });

    it('provider debug returns sanitized internal info without customer field values or API keys', async () => {
        const { order, product, providerProduct } = await createFazerTopupOrder({ providerExecutionEnabled: false });
        await Order.findByIdAndUpdate(order._id, {
            $set: {
                providerOrderId: 'fc_debug',
                providerStatus: 'Pending',
                providerRawResponse: {
                    ok: true,
                    apiKey: 'test-fazer-key',
                    order: { id: 'fc_debug', status: 'processing' },
                },
            },
        });

        const debug = await fazerCardsCatalogSvc.getOrderProviderDebug(order._id);
        const serialized = JSON.stringify(debug);

        expect(debug).toMatchObject({
            localOrderId: order._id.toString(),
            localStatus: ORDER_STATUS.PROCESSING,
            providerOrderId: 'fc_debug',
            providerStatus: 'Pending',
            providerProduct: {
                id: providerProduct._id.toString(),
                externalProductId: 'FAZER_TOPUP:8_ball_pool:golden_spin',
            },
            categoryId: '8_ball_pool',
            offerId: 'golden_spin',
            requiredFieldKeys: ['user_id'],
            providerExecutionEnabled: false,
        });
        expect(debug.providerCode).toBe('fazer-cards');
        expect(debug.warnings).toContain('Product provider execution is currently disabled.');
        expect(serialized).not.toContain('00123456789');
        expect(serialized).not.toContain('test-fazer-key');
        expect(debug.lastProviderRawResponse.apiKey).toBe('[REDACTED]');
        expect(product.providerExecutionEnabled).toBe(false);
    });
});

describe('FazerCards signed webhooks', () => {
    const enableWebhook = () => {
        config.providers.fazerCards.webhookEnabled = true;
        config.providers.fazerCards.webhookSecret = 'test-webhook-secret';
    };

    const signedWebhook = (payload, headerName = 'x-webhook-signature') => {
        const rawBody = Buffer.from(JSON.stringify(payload));
        return {
            rawBody,
            payload,
            headers: {
                [headerName]: fazerCardsWebhookSvc.hmacRawBody(rawBody, config.providers.fazerCards.webhookSecret),
            },
        };
    };

    const markSent = (order, providerOrderId = 'fc_webhook_1') => Order.findByIdAndUpdate(order._id, {
        $set: {
            providerOrderId,
            providerStatus: 'Pending',
            providerRawResponse: { ok: true, order: { id: providerOrderId, status: 'processing' } },
            providerIdempotencyKey: `fazercards:topup:${order._id.toString()}`,
        },
    }, { new: true });

    it('accepts valid signatures and logs unmatched events safely', async () => {
        enableWebhook();
        const payload = {
            event: 'order.status_changed',
            event_id: 'evt_unmatched',
            data: { order_id: 'fc_missing', status: 'processing' },
        };

        const result = await fazerCardsWebhookSvc.processWebhook(signedWebhook(payload));
        const event = await FazerCardsWebhookEvent.findOne({ eventId: 'evt_unmatched' }).lean();

        expect(result).toMatchObject({ success: true, unmatched: true, processed: false });
        expect(event).toMatchObject({
            event: 'order.status_changed',
            providerOrderId: 'fc_missing',
            matched: false,
            processingStatus: 'unmatched',
        });
        expect(JSON.stringify(event)).not.toContain('test-webhook-secret');
        expect(JSON.stringify(event)).not.toContain('test-fazer-key');
    });

    it('rejects invalid signatures and supports both documented signature headers', async () => {
        enableWebhook();
        const payload = { event: 'order.status_changed', event_id: 'evt_bad_sig', data: { order_id: 'fc_1', status: 'processing' } };
        const rawBody = Buffer.from(JSON.stringify(payload));

        await expect(fazerCardsWebhookSvc.processWebhook({
            rawBody,
            payload,
            headers: { 'x-webhook-signature': 'sha256=bad' },
        })).rejects.toMatchObject({ code: 'FAZERCARDS_WEBHOOK_SIGNATURE_INVALID' });

        const viaFazerHeader = await fazerCardsWebhookSvc.processWebhook(
            signedWebhook({ ...payload, event_id: 'evt_alt_header' }, 'x-fazercards-signature')
        );

        expect(viaFazerHeader).toMatchObject({ success: true, unmatched: true });
        expect(await FazerCardsWebhookEvent.countDocuments({})).toBe(1);
    });

    it('deduplicates event_id and does not process the same event twice', async () => {
        enableWebhook();
        const { order } = await createFazerTopupOrder();
        await markSent(order, 'fc_duplicate');
        const payload = {
            event: 'order.completed',
            event_id: 'evt_duplicate',
            data: { order_id: 'fc_duplicate', status: 'completed' },
        };

        const first = await fazerCardsWebhookSvc.processWebhook(signedWebhook(payload));
        const second = await fazerCardsWebhookSvc.processWebhook(signedWebhook(payload));
        const updated = await Order.findById(order._id).lean();

        expect(first).toMatchObject({ processed: true, action: 'completed' });
        expect(second).toMatchObject({ success: true, duplicate: true, processed: false });
        expect(updated.status).toBe(ORDER_STATUS.COMPLETED);
        expect(await FazerCardsWebhookEvent.countDocuments({ eventId: 'evt_duplicate' })).toBe(1);
    });

    it('completed webhook updates matched non-code FazerCards orders', async () => {
        enableWebhook();
        const { order } = await createFazerTopupOrder();
        await markSent(order, 'fc_completed');

        const result = await fazerCardsWebhookSvc.processWebhook(signedWebhook({
            event: 'order.completed',
            event_id: 'evt_completed',
            data: { order_id: 'fc_completed', status: 'fulfilled' },
        }));
        const updated = await Order.findById(order._id).lean();

        expect(result).toMatchObject({ processed: true, action: 'completed' });
        expect(updated.status).toBe(ORDER_STATUS.COMPLETED);
        expect(updated.providerStatus).toBe('Completed');
    });

    it('completed code-delivery webhook stores encrypted code and never returns plaintext', async () => {
        enableWebhook();
        const { order } = await createFazerCodeDeliveryOrder({ familyKey: 'GIFTCARDS', providerOrderId: 'fc_code_done' });
        const payload = {
            event: 'order.completed',
            event_id: 'evt_code_done',
            data: {
                order_id: 'fc_code_done',
                status: 'completed',
                cards: [{ code: 'ACASH-SECRET-CODE', pin: '1234', serial: 'SER-1' }],
            },
        };

        const result = await fazerCardsWebhookSvc.processWebhook(signedWebhook(payload));
        const updated = await Order.findById(order._id).lean();
        const stored = await ProviderDeliveredCode.findOne({ order: order._id })
            .select('+codeEncrypted +pinEncrypted +serialEncrypted providerRawResponse')
            .lean();
        const event = await FazerCardsWebhookEvent.findOne({ eventId: 'evt_code_done' }).lean();
        const serializedResult = JSON.stringify(result);
        const serializedEvent = JSON.stringify(event);

        expect(result).toMatchObject({ processed: true, action: 'completed' });
        expect(updated.status).toBe(ORDER_STATUS.COMPLETED);
        expect(stored).toBeTruthy();
        expect(isEncryptedSecret(stored.codeEncrypted)).toBe(true);
        expect(decryptSecret(stored.codeEncrypted)).toBe('ACASH-SECRET-CODE');
        expect(serializedResult).not.toContain('ACASH-SECRET-CODE');
        expect(serializedResult).not.toContain('1234');
        expect(serializedEvent).not.toContain('ACASH-SECRET-CODE');
        expect(serializedEvent).not.toContain('1234');
        expect(event.rawPayloadSanitized.data.cards[0].code).toBe('[REDACTED_CODE]');
    });

    it('duplicate completed code-delivery webhooks do not duplicate encrypted delivered codes', async () => {
        enableWebhook();
        const { order } = await createFazerCodeDeliveryOrder({ familyKey: 'GAME_KEYS', providerOrderId: 'fc_key_duplicate' });
        const payload = {
            event: 'order.completed',
            event_id: 'evt_key_duplicate',
            data: {
                order_id: 'fc_key_duplicate',
                status: 'completed',
                keys: [{ license_key: 'DUPLICATE-GAME-KEY', serial: 'DUP-SER-1' }],
            },
        };

        const first = await fazerCardsWebhookSvc.processWebhook(signedWebhook(payload));
        const second = await fazerCardsWebhookSvc.processWebhook(signedWebhook(payload));
        const stored = await ProviderDeliveredCode.find({ order: order._id }).select('+codeEncrypted +serialEncrypted').lean();
        const updated = await Order.findById(order._id).lean();

        expect(first).toMatchObject({ processed: true, action: 'completed' });
        expect(second).toMatchObject({ duplicate: true, processed: false });
        expect(updated.status).toBe(ORDER_STATUS.COMPLETED);
        expect(stored).toHaveLength(1);
        expect(decryptSecret(stored[0].codeEncrypted)).toBe('DUPLICATE-GAME-KEY');
        expect(decryptSecret(stored[0].serialEncrypted)).toBe('DUP-SER-1');
    });

    it('completed code-delivery webhook without code does not falsely complete', async () => {
        enableWebhook();
        const { order } = await createFazerCodeDeliveryOrder({ familyKey: 'GAME_KEYS', providerOrderId: 'fc_key_missing' });

        const result = await fazerCardsWebhookSvc.processWebhook(signedWebhook({
            event: 'order.completed',
            event_id: 'evt_key_missing',
            data: { order_id: 'fc_key_missing', status: 'completed' },
        }));
        const updated = await Order.findById(order._id).lean();

        expect(result).toMatchObject({ processed: true, action: 'manualReview' });
        expect(updated.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(updated.providerErrorCode).toBe('FAZERCARDS_CODE_DELIVERY_CODE_MISSING');
        expect(await ProviderDeliveredCode.countDocuments({ order: order._id })).toBe(0);
    });

    it('failed and refunded webhook events refund once only', async () => {
        enableWebhook();
        const { order, customer } = await createFazerTopupOrder({ walletDeducted: 50 });
        await markSent(order, 'fc_failed_webhook');

        await fazerCardsWebhookSvc.processWebhook(signedWebhook({
            event: 'order.failed',
            event_id: 'evt_failed_once',
            data: { order_id: 'fc_failed_webhook', status: 'failed' },
        }));
        await fazerCardsWebhookSvc.processWebhook(signedWebhook({
            event: 'order.refunded',
            event_id: 'evt_refunded_once',
            data: { order_id: 'fc_failed_webhook', status: 'refunded' },
        }));

        const updated = await Order.findById(order._id).lean();
        const refunds = await WalletTransaction.find({ userId: customer._id, type: 'REFUND' });
        expect(updated.status).toBe(ORDER_STATUS.FAILED);
        expect(updated.refunded).toBe(true);
        expect(refunds).toHaveLength(1);
    });

    it('processing and unknown webhook statuses do not refund blindly', async () => {
        enableWebhook();
        for (const scenario of [
            { eventId: 'evt_processing', status: 'accepted', expectedStatus: ORDER_STATUS.PROCESSING },
            { eventId: 'evt_unknown', status: 'mystery', expectedStatus: ORDER_STATUS.MANUAL_REVIEW },
        ]) {
            await clearCollections();
            enableWebhook();
            const { order, customer } = await createFazerTopupOrder({ walletDeducted: 50 });
            await markSent(order, `fc_${scenario.eventId}`);
            const before = (await User.findById(customer._id)).walletBalance;

            await fazerCardsWebhookSvc.processWebhook(signedWebhook({
                event: 'order.status_changed',
                event_id: scenario.eventId,
                data: { order_id: `fc_${scenario.eventId}`, status: scenario.status },
            }));

            const updated = await Order.findById(order._id).lean();
            expect(updated.status).toBe(scenario.expectedStatus);
            expect(updated.refunded).toBe(false);
            expect((await User.findById(customer._id)).walletBalance).toBe(before);
        }
    });
});

describe('FazerCards Phase 9 launch operations', () => {
    const createManualFazerOrder = async ({ familyKey = 'TELEGRAM', codeDelivery = false, status = ORDER_STATUS.MANUAL_REVIEW } = {}) => {
        const source = codeDelivery
            ? await createFazerCodeDeliveryProviderProduct({ familyKey: familyKey === 'GAME_KEYS' ? 'GAME_KEYS' : 'GIFTCARDS' })
            : await createFazerCatalogOnlyProviderProduct({ familyKey });
        const { provider, providerProduct } = source;
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: codeDelivery ? 3.25 : 1.75,
            name: `${familyKey} Manual Launch Product`,
        });
        await Product.findByIdAndUpdate(product._id, {
            $set: {
                isActive: true,
                visibleInStore: true,
                status: PRODUCT_STATUSES.AVAILABLE,
                customerPurchaseEnabled: true,
                providerExecutionMode: 'MANUAL_FULFILLMENT',
                providerExecutionEnabled: false,
            },
        });
        const { customer, group } = await createCustomerWithGroup({ walletBalance: 1000 }, { percentage: 0 });
        const order = await Order.create({
            userId: customer._id,
            orderNumber: 970000 + Math.floor(Math.random() * 10000),
            productId: product._id,
            quantity: 1,
            unitPrice: codeDelivery ? '3.25' : '1.75',
            totalPrice: codeDelivery ? '3.25' : '1.75',
            basePriceSnapshot: codeDelivery ? '3.25' : '1.75',
            markupPercentageSnapshot: 0,
            finalPriceCharged: codeDelivery ? '3.25' : '1.75',
            groupIdSnapshot: group._id,
            walletDeducted: 20,
            creditUsedAmount: '0',
            status,
            executionType: ORDER_EXECUTION_TYPES.MANUAL,
            providerCode: 'fazer-cards',
            familyKey: codeDelivery ? providerProduct.familyKey : familyKey,
            fulfillmentMode: providerProduct.fulfillmentMode,
            providerErrorCode: 'FAZERCARDS_MANUAL_FULFILLMENT_REQUIRED',
            providerErrorMessage: 'Manual fulfillment required.',
            customerInput: {
                values: codeDelivery ? {} : { telegram_username: 'launch_user' },
                fieldsSnapshot: codeDelivery ? [] : [{ key: 'telegram_username', label: 'Telegram Username', type: 'text', required: true }],
            },
        });
        return { provider, providerProduct, product: await Product.findById(product._id), order, customer };
    };

    it('lists manual FazerCards orders with safe submitted fields and excludes non-manual completed orders', async () => {
        const manual = await createManualFazerOrder({ familyKey: 'TELEGRAM' });
        await createManualFazerOrder({ familyKey: 'STEAM_TOPUP', status: ORDER_STATUS.COMPLETED });

        const result = await fazerCardsCatalogSvc.listManualOrders({ familyKey: 'TELEGRAM' });

        expect(result.pagination.total).toBe(1);
        expect(result.orders[0]).toMatchObject({
            id: manual.order._id.toString(),
            status: ORDER_STATUS.MANUAL_REVIEW,
            familyKey: 'TELEGRAM',
            fulfillmentMode: FULFILLMENT_MODES.TELEGRAM_STARS_TOPUP,
            product: {
                name: 'TELEGRAM Manual Launch Product',
                providerExecutionMode: 'MANUAL_FULFILLMENT',
            },
            submittedFields: [{ key: 'telegram_username', label: 'Telegram Username', type: 'text', value: 'launch_user' }],
            deliveredCodeCount: 0,
        });
        expect(JSON.stringify(result.orders[0])).not.toContain('providerRawResponse');
        expect(JSON.stringify(result.orders[0])).not.toContain('codeEncrypted');
    });

    it('manual detail includes notes/history but not plaintext provider code secrets', async () => {
        const { order } = await createManualFazerOrder({ familyKey: 'TELEGRAM' });
        await fazerCardsCatalogSvc.addManualOrderNote(order._id, {
            adminNote: 'Waiting for manual Telegram processing.',
            proof: 'ticket-123',
        });

        const detail = await fazerCardsCatalogSvc.getManualOrderDetail(order._id);

        expect(detail.order.internalNotes).toHaveLength(1);
        expect(detail.order.internalNotes[0]).toMatchObject({
            note: 'Waiting for manual Telegram processing.',
            proof: 'ticket-123',
            type: 'manual_note',
        });
        expect(JSON.stringify(detail)).not.toContain('codeEncrypted');
        expect(JSON.stringify(detail)).not.toContain('providerRawResponse');
    });

    it('manual complete updates status and records audit-friendly history', async () => {
        const { order } = await createManualFazerOrder({ familyKey: 'TELEGRAM' });

        const result = await fazerCardsCatalogSvc.completeManualOrder(order._id, {
            adminNote: 'Handled manually in provider panel.',
            proof: 'proof-url',
        });

        expect(result.success).toBe(true);
        expect(result.order.status).toBe(ORDER_STATUS.COMPLETED);
        expect(result.order.internalNotes.at(-1)).toMatchObject({
            note: 'Handled manually in provider panel.',
            proof: 'proof-url',
            type: 'manual_complete',
        });
        expect(result.order.statusHistory.at(-1)).toMatchObject({ status: ORDER_STATUS.COMPLETED });
    });

    it('manual complete with delivered code stores encrypted code and never returns plaintext', async () => {
        const { order } = await createManualFazerOrder({ familyKey: 'GIFTCARDS', codeDelivery: true });

        const result = await fazerCardsCatalogSvc.completeManualOrder(order._id, {
            adminNote: 'Gift card fulfilled manually.',
            deliveredCodes: [{ code: 'MANUAL-SECRET-CODE', pin: '1234', serial: 'SER-1' }],
        });
        const stored = await ProviderDeliveredCode.findOne({ order: order._id }).select('+codeEncrypted +pinEncrypted +serialEncrypted');

        expect(result.order.status).toBe(ORDER_STATUS.COMPLETED);
        expect(result.deliveredCodes[0]).toMatchObject({
            hasCode: true,
            hasPin: true,
            hasSerial: true,
            storedEncrypted: true,
        });
        expect(JSON.stringify(result)).not.toContain('MANUAL-SECRET-CODE');
        expect(isEncryptedSecret(stored.codeEncrypted)).toBe(true);
        expect(decryptSecret(stored.codeEncrypted)).toBe('MANUAL-SECRET-CODE');
    });

    it('delivered-code reveal rejects other users, incomplete orders, and non-code-delivery orders', async () => {
        const completed = await createManualFazerOrder({ familyKey: 'GIFTCARDS', codeDelivery: true });
        await fazerCardsCatalogSvc.completeManualOrder(completed.order._id, {
            deliveredCodes: [{ code: 'OWNED-SECRET-CODE' }],
        });
        const { customer: otherCustomer } = await createCustomerWithGroup({ walletBalance: 1000 }, { percentage: 0 });

        await expect(
            orderService.revealDeliveredCodes(completed.order._id, otherCustomer._id)
        ).rejects.toMatchObject({ statusCode: 404 });

        const incomplete = await createManualFazerOrder({ familyKey: 'GAME_KEYS', codeDelivery: true });
        await fazerCardsCatalogSvc.storeManualDeliveredCode({
            orderId: incomplete.order._id,
            code: 'NOT-COMPLETE-CODE',
        });
        await expect(
            orderService.revealDeliveredCodes(incomplete.order._id, incomplete.customer._id)
        ).rejects.toMatchObject({ code: 'ORDER_NOT_COMPLETED' });

        const nonCodeOrder = await createManualFazerOrder({ familyKey: 'TELEGRAM', status: ORDER_STATUS.COMPLETED });
        await expect(
            orderService.revealDeliveredCodes(nonCodeOrder.order._id, nonCodeOrder.customer._id)
        ).rejects.toMatchObject({ code: 'ORDER_NOT_CODE_DELIVERY' });
    });

    it('normal customer order list/detail never expose plaintext delivered codes before reveal', async () => {
        const { order, customer } = await createManualFazerOrder({ familyKey: 'GIFTCARDS', codeDelivery: true });
        await fazerCardsCatalogSvc.completeManualOrder(order._id, {
            deliveredCodes: [{ code: 'LIST-HIDDEN-CODE', pin: '7788', serial: 'SER-HIDDEN' }],
        });

        const detail = await orderService.getOrderById(order._id, customer._id);
        const list = await orderService.listOrdersForUser(customer._id);
        const serialized = JSON.stringify({ detail, list });

        expect(detail.hasDeliveredCodes).toBe(true);
        expect(detail.deliveredCodeCount).toBe(1);
        expect(serialized).not.toContain('LIST-HIDDEN-CODE');
        expect(serialized).not.toContain('7788');
        expect(serialized).not.toContain('SER-HIDDEN');
        expect(serialized).not.toContain('codeEncrypted');
        expect(serialized).not.toContain('pinEncrypted');
        expect(serialized).not.toContain('serialEncrypted');
        expect(serialized).not.toContain('providerRawResponse');
        expect(serialized).not.toContain('providerOrderId');
    });

    it('valid delivered-code reveal returns plaintext only from reveal endpoint and records reveal metadata', async () => {
        const { order, customer } = await createManualFazerOrder({ familyKey: 'GAME_KEYS', codeDelivery: true });
        await fazerCardsCatalogSvc.completeManualOrder(order._id, {
            deliveredCodes: [{ code: 'REVEAL-ONLY-KEY', serial: 'GK-SERIAL-1' }],
        });

        const result = await orderService.revealDeliveredCodes(order._id, customer._id);
        const stored = await ProviderDeliveredCode.findOne({ order: order._id }).select('+codeEncrypted +serialEncrypted');

        expect(result.items).toHaveLength(1);
        expect(result.items[0]).toMatchObject({
            code: 'REVEAL-ONLY-KEY',
            serial: 'GK-SERIAL-1',
            revealCount: 1,
        });
        expect(result.items[0].pin).toBeNull();
        expect(result.warning).toContain('Plaintext codes are returned only by this reveal endpoint.');
        expect(stored.revealCount).toBe(1);
        expect(stored.revealedAt).toBeInstanceOf(Date);
        expect(stored.revealedBy.toString()).toBe(customer._id.toString());
        expect(isEncryptedSecret(stored.codeEncrypted)).toBe(true);
        expect(decryptSecret(stored.codeEncrypted)).toBe('REVEAL-ONLY-KEY');
    });

    it('manual fail refunds once only', async () => {
        const { order, customer } = await createManualFazerOrder({ familyKey: 'TELEGRAM' });

        const first = await fazerCardsCatalogSvc.failManualOrder(order._id, {
            reason: 'Could not fulfill manually.',
            refund: true,
        });
        const second = await fazerCardsCatalogSvc.failManualOrder(order._id, {
            reason: 'Second operator retry.',
            refund: true,
        });
        const refunds = await WalletTransaction.find({ userId: customer._id, type: 'REFUND' });

        expect(first.refunded).toBe(true);
        expect(second.refunded).toBe(true);
        expect(second.alreadyFailed).toBe(true);
        expect(refunds).toHaveLength(1);
        expect((await Order.findById(order._id)).refunded).toBe(true);
    });

    it('bulk launch dry-run rejects invalid auto execution for unconfirmed families and does not modify products', async () => {
        const { providerProduct } = await createFazerCatalogOnlyProviderProduct({ familyKey: 'TELEGRAM' });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.75,
            name: 'Telegram Bulk Candidate',
        });

        const result = await fazerCardsCatalogSvc.bulkUpdateLaunchControls({
            productIds: [product._id.toString()],
            customerPurchaseEnabled: true,
            isActive: true,
            visibleInStore: true,
            status: 'available',
            providerExecutionMode: 'AUTO_PROVIDER',
            dryRun: true,
        });
        const after = await Product.findById(product._id).lean();

        expect(result.success).toBe(false);
        expect(result.updated).toBe(0);
        expect(result.results[0].errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'CONTRACT_AUTO_EXECUTION_NOT_ALLOWED' }),
        ]));
        expect(after.isActive).toBe(false);
        expect(after.visibleInStore).toBe(false);
        expect(after.customerPurchaseEnabled).toBe(false);
    });

    it('bulk launch rejects Steam Gifts customer enablement', async () => {
        const { provider } = await createFazerCatalogOnlyProviderProduct({ familyKey: 'TELEGRAM' });
        const providerProduct = await ProviderProduct.create({
            provider: provider._id,
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            externalProductId: 'FAZER_STEAM_GIFT:unavailable',
            rawName: 'Steam Gift Unavailable',
            rawPrice: '1',
            costPrice: '1',
            currency: 'USD',
            familyKey: 'STEAM_GIFTS',
            fulfillmentMode: FULFILLMENT_MODES.STEAM_GIFT_INVITE,
            isSupported: false,
            isBlocked: true,
            executionBlocked: true,
            blockReason: 'STEAM_GIFTS_CATALOG_UNAVAILABLE',
        });
        const product = await Product.create({
            name: 'Steam Gift Disabled',
            basePrice: '2',
            minQty: 1,
            maxQty: 1,
            isActive: false,
            visibleInStore: false,
            status: PRODUCT_STATUSES.UNAVAILABLE,
            customerPurchaseEnabled: false,
            provider,
            providerProduct,
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            familyKey: 'STEAM_GIFTS',
            fulfillmentMode: FULFILLMENT_MODES.STEAM_GIFT_INVITE,
            providerExecutionMode: 'DISABLED',
        });

        const result = await fazerCardsCatalogSvc.bulkUpdateLaunchControls({
            productIds: [product._id.toString()],
            customerPurchaseEnabled: true,
            isActive: true,
            visibleInStore: true,
            status: 'available',
            providerExecutionMode: 'MANUAL_FULFILLMENT',
            dryRun: true,
        });

        expect(result.success).toBe(false);
        expect(result.results[0].errors.map((error) => error.code)).toContain('FAMILY_DISABLED_UNAVAILABLE');
    });

    it('bulk launch applies valid manual fulfillment controls for unconfirmed families', async () => {
        const { providerProduct } = await createFazerCatalogOnlyProviderProduct({ familyKey: 'TELEGRAM' });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.75,
            name: 'Telegram Bulk Manual Candidate',
        });

        const result = await fazerCardsCatalogSvc.bulkUpdateLaunchControls({
            productIds: [product._id.toString()],
            customerPurchaseEnabled: true,
            isActive: true,
            visibleInStore: true,
            status: 'available',
            providerExecutionMode: 'MANUAL_FULFILLMENT',
        });
        const updated = await Product.findById(product._id).lean();

        expect(result).toMatchObject({ success: true, updated: 1, failed: 0 });
        expect(updated).toMatchObject({
            customerPurchaseEnabled: true,
            isActive: true,
            visibleInStore: true,
            status: PRODUCT_STATUSES.AVAILABLE,
            providerExecutionMode: 'MANUAL_FULFILLMENT',
            providerExecutionEnabled: false,
            executionType: EXECUTION_TYPES.MANUAL,
        });
    });

    it.each(['GIFTCARDS', 'GAME_KEYS'])('allows %s manual launch without customer fields because quantity-only code delivery is valid', async (familyKey) => {
        const { providerProduct } = await createFazerCodeDeliveryProviderProduct({ familyKey });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 3.25,
            name: `${familyKey} Quantity Only Candidate`,
        });

        const result = await fazerCardsCatalogSvc.updateSingleProductLaunchControls(product._id, {
            customerPurchaseEnabled: true,
            isActive: true,
            visibleInStore: true,
            status: PRODUCT_STATUSES.AVAILABLE,
            providerExecutionMode: 'MANUAL_FULFILLMENT',
        });

        expect(result.success).toBe(true);
        expect(result.launchStatus).toEqual({ visibleToCustomer: true, reasons: [] });
    });

    it.each([
        ['TELEGRAM', { requiredFields: [] }],
        ['STEAM_TOPUP', { requiredFields: [] }],
        ['MANUAL_SERVICES', { requiredFields: [] }],
    ])('rejects manual launch for %s when no required customer fields are configured', async (familyKey, overrides) => {
        const { providerProduct } = await createFazerCatalogOnlyProviderProduct({ familyKey, overrides });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.75,
            name: `${familyKey} Missing Fields Candidate`,
        });

        await expect(fazerCardsCatalogSvc.updateSingleProductLaunchControls(product._id, {
            customerPurchaseEnabled: true,
            isActive: true,
            visibleInStore: true,
            status: PRODUCT_STATUSES.AVAILABLE,
            providerExecutionMode: 'MANUAL_FULFILLMENT',
        })).rejects.toMatchObject({ code: 'MANUAL_PRODUCT_REQUIRES_CUSTOMER_FIELDS' });

        const dryRun = await fazerCardsCatalogSvc.bulkUpdateLaunchControls({
            productIds: [product._id.toString()],
            customerPurchaseEnabled: true,
            isActive: true,
            visibleInStore: true,
            status: PRODUCT_STATUSES.AVAILABLE,
            providerExecutionMode: 'MANUAL_FULFILLMENT',
            dryRun: true,
        });

        expect(dryRun.results[0].errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'MANUAL_PRODUCT_REQUIRES_CUSTOMER_FIELDS' }),
        ]));
        expect((await Product.findById(product._id)).customerPurchaseEnabled).toBe(false);
    });

    it('rejects via-login manual launch and customer purchase without login/account fields before debit/order creation', async () => {
        const { providerProduct } = await createFazerCatalogOnlyProviderProduct({
            familyKey: 'MANUAL_SERVICES',
            overrides: {
                externalProductId: 'FAZER_MANUAL_SERVICE:roblox_via_login:160_robux',
                rawName: 'Roblox (Robux via login) - 160 Robux',
                requiredFields: [],
            },
        });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 2.25,
            name: 'Roblox (Robux via login) - 160 Robux',
        });

        await expect(fazerCardsCatalogSvc.updateSingleProductLaunchControls(product._id, {
            customerPurchaseEnabled: true,
            isActive: true,
            visibleInStore: true,
            status: PRODUCT_STATUSES.AVAILABLE,
            providerExecutionMode: 'MANUAL_FULFILLMENT',
        })).rejects.toMatchObject({ code: 'MANUAL_PRODUCT_REQUIRES_CUSTOMER_FIELDS' });

        await Product.findByIdAndUpdate(product._id, {
            $set: {
                customerPurchaseEnabled: true,
                isActive: true,
                visibleInStore: true,
                status: PRODUCT_STATUSES.AVAILABLE,
                providerExecutionMode: 'MANUAL_FULFILLMENT',
                providerExecutionEnabled: false,
            },
        });
        const forcedVisible = await Product.findById(product._id).populate('providerProduct');
        const visibility = productService.attachCustomerVisibilityStatus(forcedVisible).customerVisibilityStatus;
        const { customer } = await createCustomerWithGroup({ walletBalance: 1000 }, { percentage: 0 });
        const beforeWallet = (await User.findById(customer._id)).walletBalance;

        expect(visibility.visibleToCustomer).toBe(false);
        expect(visibility.reasons).toContain('manual fulfillment requires customer fields');
        await expect(orderService.createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
            idempotencyKey: 'roblox-via-login-missing-fields',
        })).rejects.toMatchObject({ code: 'MANUAL_PRODUCT_REQUIRES_CUSTOMER_FIELDS' });
        expect(await Order.countDocuments({ productId: product._id })).toBe(0);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
        expect((await User.findById(customer._id)).walletBalance).toBe(beforeWallet);
    });

    it('allows top-up manual launch when provider required fields were copied to product order fields', async () => {
        const { providerProduct } = await createFazerTopupProviderProduct();
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.25,
            name: '8 Ball Pool Manual Field Candidate',
        });

        const result = await fazerCardsCatalogSvc.updateSingleProductLaunchControls(product._id, {
            customerPurchaseEnabled: true,
            isActive: true,
            visibleInStore: true,
            status: PRODUCT_STATUSES.AVAILABLE,
            providerExecutionMode: 'MANUAL_FULFILLMENT',
        });
        const updated = await Product.findById(product._id).lean();

        expect(result.launchStatus).toEqual({ visibleToCustomer: true, reasons: [] });
        expect(updated.orderFields.map((field) => field.key)).toContain('user_id');
    });

    it('admin product update persists FazerCards launch metadata and reports customer visibility status', async () => {
        const { providerProduct } = await createFazerCatalogOnlyProviderProduct({ familyKey: 'TELEGRAM' });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.75,
            name: 'Telegram Admin Edit Candidate',
        });

        const updated = await productService.updateProduct(product._id, {
            isActive: true,
            visibleInStore: true,
            status: PRODUCT_STATUSES.AVAILABLE,
            customerPurchaseEnabled: true,
            providerExecutionMode: 'MANUAL_FULFILLMENT',
            providerExecutionEnabled: false,
            providerExecutionBlocked: true,
            providerBlockReason: 'TELEGRAM_EXECUTION_NOT_IMPLEMENTED',
            familyKey: 'TELEGRAM',
            fulfillmentMode: FULFILLMENT_MODES.TELEGRAM_STARS_TOPUP,
        });
        const persisted = await Product.findById(product._id).lean();
        const response = productService.attachCustomerVisibilityStatus(updated);

        expect(persisted).toMatchObject({
            isActive: true,
            visibleInStore: true,
            status: PRODUCT_STATUSES.AVAILABLE,
            customerPurchaseEnabled: true,
            providerExecutionMode: 'MANUAL_FULFILLMENT',
            providerExecutionEnabled: false,
            providerExecutionBlocked: true,
            providerBlockReason: 'TELEGRAM_EXECUTION_NOT_IMPLEMENTED',
            familyKey: 'TELEGRAM',
            fulfillmentMode: FULFILLMENT_MODES.TELEGRAM_STARS_TOPUP,
        });
        expect(response.customerVisibilityStatus).toEqual({
            visibleToCustomer: true,
            reasons: [],
        });
    });

    it('imported provider product listing includes linked Winnie Product launch metadata', async () => {
        const { providerProduct } = await createFazerCatalogOnlyProviderProduct({ familyKey: 'TELEGRAM' });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.75,
            name: 'Telegram Imported Metadata Candidate',
        });
        await fazerCardsCatalogSvc.updateSingleProductLaunchControls(product._id, {
            customerPurchaseEnabled: true,
            isActive: true,
            visibleInStore: true,
            status: PRODUCT_STATUSES.AVAILABLE,
            providerExecutionMode: 'MANUAL_FULFILLMENT',
        });

        const listed = await fazerCardsCatalogSvc.listProviderProducts({ imported: 'true', familyKey: 'TELEGRAM' });
        const importedProduct = listed.products[0].importedProduct;

        expect(importedProduct).toMatchObject({
            id: product._id,
            name: 'Telegram Imported Metadata Candidate',
            isActive: true,
            visibleInStore: true,
            status: PRODUCT_STATUSES.AVAILABLE,
            customerPurchaseEnabled: true,
            providerExecutionMode: 'MANUAL_FULFILLMENT',
            visibleToCustomer: true,
            visibilityReasons: [],
        });
    });

    it('single product launch applies valid manual launch controls and returns visibility details', async () => {
        const { providerProduct } = await createFazerCatalogOnlyProviderProduct({ familyKey: 'TELEGRAM' });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.75,
            name: 'Telegram Single Launch Candidate',
        });

        const result = await fazerCardsCatalogSvc.updateSingleProductLaunchControls(product._id, {
            customerPurchaseEnabled: true,
            isActive: true,
            visibleInStore: true,
            status: PRODUCT_STATUSES.AVAILABLE,
            providerExecutionMode: 'MANUAL_FULFILLMENT',
        });
        const updated = await Product.findById(product._id).lean();

        expect(result).toMatchObject({
            success: true,
            launchStatus: { visibleToCustomer: true, reasons: [] },
            result: {
                success: true,
                productId: product._id.toString(),
                productName: 'Telegram Single Launch Candidate',
                visibleToCustomer: true,
                visibilityReasons: [],
            },
        });
        expect(result.result.changedFields).toEqual(expect.arrayContaining([
            'customerPurchaseEnabled',
            'isActive',
            'visibleInStore',
            'status',
        ]));
        expect(updated.customerPurchaseEnabled).toBe(true);
        expect(updated.status).toBe(PRODUCT_STATUSES.AVAILABLE);
    });

    it('single product launch rejects invalid auto execution by family contract', async () => {
        const { providerProduct } = await createFazerCatalogOnlyProviderProduct({ familyKey: 'TELEGRAM' });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.75,
            name: 'Telegram Invalid Auto Candidate',
        });

        await expect(fazerCardsCatalogSvc.updateSingleProductLaunchControls(product._id, {
            customerPurchaseEnabled: true,
            isActive: true,
            visibleInStore: true,
            status: PRODUCT_STATUSES.AVAILABLE,
            providerExecutionMode: 'AUTO_PROVIDER',
        })).rejects.toMatchObject({ code: 'CONTRACT_AUTO_EXECUTION_NOT_ALLOWED' });
    });

    it.each(['TOPUPS', 'GIFTCARDS', 'GAME_KEYS'])('single product launch can enable AUTO_PROVIDER for confirmed %s products', async (familyKey) => {
        const { providerProduct } = familyKey === 'TOPUPS'
            ? await createFazerTopupProviderProduct()
            : await createFazerCodeDeliveryProviderProduct({ familyKey });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: familyKey === 'GAME_KEYS' ? 6.25 : 3.25,
            name: `${familyKey} Auto Provider Candidate`,
        });

        const result = await fazerCardsCatalogSvc.updateSingleProductLaunchControls(product._id, {
            customerPurchaseEnabled: true,
            isActive: true,
            visibleInStore: true,
            status: PRODUCT_STATUSES.AVAILABLE,
            providerExecutionMode: 'AUTO_PROVIDER',
            providerExecutionEnabled: true,
        });
        const updated = await Product.findById(product._id).lean();

        expect(result.launchStatus).toEqual({ visibleToCustomer: true, reasons: [] });
        expect(updated).toMatchObject({
            customerPurchaseEnabled: true,
            isActive: true,
            visibleInStore: true,
            status: PRODUCT_STATUSES.AVAILABLE,
            providerExecutionMode: 'AUTO_PROVIDER',
            providerExecutionEnabled: true,
            providerExecutionBlocked: false,
            executionType: EXECUTION_TYPES.AUTOMATIC,
        });
    });

    it.each([
        ['TOPUPS', { category: null, offerId: null, externalProductId: 'FAZER_TOPUP_MALFORMED', rawPayload: { category: {}, offer: {} } }, 'AUTO_PROVIDER_TOPUP_CATEGORY_ID_MISSING'],
        ['GIFTCARDS', { offerId: null, externalProductId: 'FAZER_GIFTCARD:acash_my', rawPayload: { family: 'GIFTCARDS', category: { category_id: 'acash_my' }, offer: {} } }, 'AUTO_PROVIDER_GIFTCARD_CARD_ID_MISSING'],
        ['GAME_KEYS', { offerId: null, externalProductId: 'FAZER_GAMEKEY:against_the_storm_cis', rawPayload: { family: 'GAME_KEYS', game: { game_id: 'against_the_storm_cis' }, key: {} } }, 'AUTO_PROVIDER_GAMEKEY_KEY_ID_MISSING'],
    ])('single product launch rejects AUTO_PROVIDER for %s when provider identifiers are incomplete', async (familyKey, providerProductPatch, expectedCode) => {
        const { providerProduct } = familyKey === 'TOPUPS'
            ? await createFazerTopupProviderProduct()
            : await createFazerCodeDeliveryProviderProduct({ familyKey });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: familyKey === 'GAME_KEYS' ? 6.25 : 3.25,
            name: `${familyKey} Missing Provider Id Candidate`,
        });
        await ProviderProduct.findByIdAndUpdate(providerProduct._id, { $set: providerProductPatch });

        await expect(fazerCardsCatalogSvc.updateSingleProductLaunchControls(product._id, {
            customerPurchaseEnabled: true,
            isActive: true,
            visibleInStore: true,
            status: PRODUCT_STATUSES.AVAILABLE,
            providerExecutionMode: 'AUTO_PROVIDER',
            providerExecutionEnabled: true,
        })).rejects.toMatchObject({ code: expectedCode });
    });

    it('admin product update rejects enabling AUTO_PROVIDER when code-delivery provider ids are missing', async () => {
        const { providerProduct } = await createFazerCodeDeliveryProviderProduct({ familyKey: 'GIFTCARDS' });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 3.25,
            name: 'GiftCard Product Edit Missing Id Candidate',
        });
        await ProviderProduct.findByIdAndUpdate(providerProduct._id, {
            $set: {
                offerId: null,
                externalProductId: 'FAZER_GIFTCARD:acash_my',
                rawPayload: { family: 'GIFTCARDS', category: { category_id: 'acash_my' }, offer: {} },
            },
        });

        await expect(productService.updateProduct(product._id, {
            customerPurchaseEnabled: true,
            isActive: true,
            visibleInStore: true,
            status: PRODUCT_STATUSES.AVAILABLE,
            providerExecutionMode: 'AUTO_PROVIDER',
            providerExecutionEnabled: true,
        })).rejects.toMatchObject({ code: 'AUTO_PROVIDER_GIFTCARD_CARD_ID_MISSING' });
    });

    it('single product launch rejects enabling AUTO_PROVIDER before the product is customer visible', async () => {
        const { providerProduct } = await createFazerCodeDeliveryProviderProduct({ familyKey: 'GIFTCARDS' });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 3.25,
            name: 'GiftCard Hidden Auto Candidate',
        });

        await expect(fazerCardsCatalogSvc.updateSingleProductLaunchControls(product._id, {
            customerPurchaseEnabled: true,
            isActive: true,
            visibleInStore: false,
            status: PRODUCT_STATUSES.AVAILABLE,
            providerExecutionMode: 'AUTO_PROVIDER',
            providerExecutionEnabled: true,
        })).rejects.toMatchObject({ code: 'AUTO_PROVIDER_REQUIRES_CUSTOMER_VISIBLE_PRODUCT' });
    });

    it('publishes eligible FazerCards products without requiring pasted product IDs', async () => {
        const { providerProduct: giftCardProviderProduct } = await createFazerCodeDeliveryProviderProduct({ familyKey: 'GIFTCARDS' });
        const { product: giftCardProduct } = await fazerCardsCatalogSvc.importProviderProduct(giftCardProviderProduct._id, {
            sellPrice: 3.25,
            name: 'GiftCard Publish Eligible Candidate',
        });
        const { providerProduct: telegramProviderProduct } = await createFazerCatalogOnlyProviderProduct({ familyKey: 'TELEGRAM' });
        const { product: telegramProduct } = await fazerCardsCatalogSvc.importProviderProduct(telegramProviderProduct._id, {
            sellPrice: 1.75,
            name: 'Telegram Publish Eligible Candidate',
        });

        const result = await fazerCardsCatalogSvc.publishEligibleLaunchControls({
            providerExecutionMode: 'MANUAL_FULFILLMENT',
        });
        const updatedGiftCard = await Product.findById(giftCardProduct._id).lean();
        const updatedTelegram = await Product.findById(telegramProduct._id).lean();

        expect(result).toMatchObject({
            success: true,
            updated: 2,
            failed: 0,
            publishScope: expect.objectContaining({
                providerExecutionMode: 'MANUAL_FULFILLMENT',
            }),
        });
        expect(updatedGiftCard).toMatchObject({
            isActive: true,
            visibleInStore: true,
            status: PRODUCT_STATUSES.AVAILABLE,
            customerPurchaseEnabled: true,
            providerExecutionMode: 'MANUAL_FULFILLMENT',
            providerExecutionEnabled: false,
        });
        expect(updatedTelegram).toMatchObject({
            isActive: true,
            visibleInStore: true,
            status: PRODUCT_STATUSES.AVAILABLE,
            customerPurchaseEnabled: true,
            providerExecutionMode: 'MANUAL_FULFILLMENT',
            providerExecutionEnabled: false,
        });
    });

    it('publish eligible AUTO_PROVIDER updates confirmed families only and leaves unconfirmed families unchanged', async () => {
        const { providerProduct: topupProviderProduct } = await createFazerTopupProviderProduct();
        const { product: topupProduct } = await fazerCardsCatalogSvc.importProviderProduct(topupProviderProduct._id, {
            sellPrice: 1.25,
            name: 'Topup Publish Auto Candidate',
        });
        const { providerProduct: giftCardProviderProduct } = await createFazerCodeDeliveryProviderProduct({ familyKey: 'GIFTCARDS' });
        const { product: giftCardProduct } = await fazerCardsCatalogSvc.importProviderProduct(giftCardProviderProduct._id, {
            sellPrice: 3.25,
            name: 'GiftCard Publish Auto Candidate',
        });
        const { providerProduct: telegramProviderProduct } = await createFazerCatalogOnlyProviderProduct({ familyKey: 'TELEGRAM' });
        const { product: telegramProduct } = await fazerCardsCatalogSvc.importProviderProduct(telegramProviderProduct._id, {
            sellPrice: 1.75,
            name: 'Telegram Not Auto Candidate',
        });

        const result = await fazerCardsCatalogSvc.publishEligibleLaunchControls({
            providerExecutionMode: 'AUTO_PROVIDER',
        });
        const updatedTopup = await Product.findById(topupProduct._id).lean();
        const updatedGiftCard = await Product.findById(giftCardProduct._id).lean();
        const updatedTelegram = await Product.findById(telegramProduct._id).lean();

        expect(result).toMatchObject({
            success: true,
            total: 2,
            updated: 2,
            failed: 0,
            publishScope: expect.objectContaining({
                families: expect.arrayContaining(['TOPUPS', 'GIFTCARDS', 'GAME_KEYS']),
                providerExecutionMode: 'AUTO_PROVIDER',
            }),
        });
        expect(updatedTopup).toMatchObject({
            providerExecutionMode: 'AUTO_PROVIDER',
            providerExecutionEnabled: true,
            providerExecutionBlocked: false,
            executionType: EXECUTION_TYPES.AUTOMATIC,
        });
        expect(updatedGiftCard).toMatchObject({
            providerExecutionMode: 'AUTO_PROVIDER',
            providerExecutionEnabled: true,
            providerExecutionBlocked: false,
            executionType: EXECUTION_TYPES.AUTOMATIC,
        });
        expect(updatedTelegram).toMatchObject({
            isActive: false,
            visibleInStore: false,
            customerPurchaseEnabled: false,
            providerExecutionMode: 'MANUAL_FULFILLMENT',
            providerExecutionEnabled: false,
        });
    });

    it('bulk launch returns per-product customer visibility reasons', async () => {
        const { providerProduct } = await createFazerCatalogOnlyProviderProduct({ familyKey: 'TELEGRAM' });
        const { product } = await fazerCardsCatalogSvc.importProviderProduct(providerProduct._id, {
            sellPrice: 1.75,
            name: 'Telegram Bulk Visibility Candidate',
        });

        const result = await fazerCardsCatalogSvc.bulkUpdateLaunchControls({
            productIds: [product._id.toString()],
            customerPurchaseEnabled: true,
            isActive: true,
            visibleInStore: false,
            status: PRODUCT_STATUSES.AVAILABLE,
            providerExecutionMode: 'MANUAL_FULFILLMENT',
            dryRun: true,
        });

        expect(result.results[0]).toMatchObject({
            success: true,
            visibleToCustomer: false,
            visibilityReasons: ['visibleInStore=false'],
        });
        expect(result.results[0].changedFields).toEqual(expect.arrayContaining([
            'customerPurchaseEnabled',
            'isActive',
            'status',
        ]));
    });

    it('catalog sync status reports in-progress flag, last sync, and current summary without order calls', async () => {
        const { providerProduct } = await createFazerCodeDeliveryProviderProduct({ familyKey: 'GIFTCARDS' });

        const status = await fazerCardsCatalogSvc.getCatalogSyncStatus();

        expect(status).toMatchObject({
            success: true,
            inProgress: false,
            catalog: {
                byFamily: {
                    GIFTCARDS: expect.objectContaining({ total: 1 }),
                },
            },
        });
        expect(status.catalog.totalProviderProducts).toBeGreaterThanOrEqual(1);
        expect(providerProduct.familyKey).toBe('GIFTCARDS');
        expect(axios.create).not.toHaveBeenCalled();
    });

    it('launch health returns gates, catalog, product counts, and order counts without exposing secrets', async () => {
        await createManualFazerOrder({ familyKey: 'TELEGRAM' });
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: { ok: true, balance: '12.34', currency: 'USD' },
        });

        const health = await fazerCardsCatalogSvc.getLaunchHealth();

        expect(health).toMatchObject({
            success: true,
            api: {
                enabled: true,
                connectionOk: true,
            },
            gates: {
                customerPurchaseEnabled: true,
                realOrdersEnabled: false,
                codeDeliveryEnabled: false,
            },
            catalog: {
                byFamily: expect.any(Object),
            },
            products: {
                manualFulfillment: expect.any(Number),
            },
            orders: {
                manualReview: 1,
            },
        });
        expect(JSON.stringify(health)).not.toContain('test-fazer-key');
        expect(client.request).toHaveBeenCalledTimes(1);
        expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'get',
            url: '/balance',
        }));
    });

    it('customer order sanitization keeps provider internals out while returning clear status messages', async () => {
        const { order, customer } = await createManualFazerOrder({ familyKey: 'TELEGRAM' });

        const customerOrder = await require('../modules/orders/order.service').getOrderById(order._id, customer._id);
        const serialized = JSON.stringify(customerOrder);

        expect(customerOrder.customerStatusMessage).toBe('طلبك قيد التنفيذ');
        expect(customerOrder.fulfillmentNotice).toBe('طلبك قيد التنفيذ.');
        expect(serialized).not.toContain('providerRawResponse');
        expect(serialized).not.toContain('providerOrderId');
        expect(serialized).not.toContain('providerErrorCode');
        expect(serialized).not.toContain('FAZERCARDS_MANUAL_FULFILLMENT_REQUIRED');
    });
});
