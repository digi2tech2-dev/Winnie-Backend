'use strict';

// This suite uses only mongodb-memory-server's isolated database. No provider
// client is allowed to make a network request: automatic cases fail before
// dispatch, and the manual case never enters automatic fulfillment.
process.env.FAZERCARDS_ENABLED = 'true';
process.env.FAZERCARDS_REAL_ORDERS_ENABLED = 'false';
process.env.FAZERCARDS_CODE_DELIVERY_ENABLED = 'false';

const config = require('../config/config');
const orderService = require('../modules/orders/order.service');
const productService = require('../modules/products/product.service');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct, FULFILLMENT_MODES } = require('../modules/providers/providerProduct.model');
const { Product, EXECUTION_TYPES, PRODUCT_STATUSES, PROVIDER_EXECUTION_MODES } = require('../modules/products/product.model');
const { Order, ORDER_STATUS } = require('../modules/orders/order.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { executeOrder } = require('../modules/orders/orderFulfillment.service');
const { PROVIDER_CODES } = require('../modules/providers/provider.constants');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
} = require('./testHelpers');

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
afterEach(clearCollections);

const createGiftCardFixture = async ({ manual = false, sourceAvailability = 'UNKNOWN' } = {}) => {
    const provider = await Provider.create({
        name: `FazerCards pre-debit ${Date.now()}-${Math.random()}`,
        slug: `fazer-pre-debit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        baseUrl: 'https://api.example.test',
        isActive: true,
    });
    const providerProduct = await ProviderProduct.create({
        provider: provider._id,
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        externalProductId: `FAZER_GIFTCARD:steam_wallet_test:${Date.now()}`,
        rawName: 'Steam Wallet Test',
        rawPrice: '1.00',
        costPrice: '1.00',
        category: 'steam_wallet_test',
        offerId: 'gift_test',
        familyKey: 'GIFTCARDS',
        fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
        minQty: 1,
        maxQty: 10,
        stock: 10,
        isActive: false,
        available: true,
        isSupported: true,
        isBlocked: false,
        executionBlocked: false,
        supportLevel: 'CATALOG_ONLY',
        sourceAvailability,
    });
    const product = await Product.create({
        name: `Gift-card pre-debit ${Date.now()}-${Math.random()}`,
        basePrice: '2.00',
        finalPrice: '2.00',
        minQty: 1,
        maxQty: 10,
        isActive: true,
        visibleInStore: true,
        status: PRODUCT_STATUSES.AVAILABLE,
        customerPurchaseEnabled: true,
        executionType: manual ? EXECUTION_TYPES.MANUAL : EXECUTION_TYPES.AUTOMATIC,
        provider: provider._id,
        providerProduct: providerProduct._id,
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        familyKey: 'GIFTCARDS',
        fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
        providerExecutionMode: manual ? PROVIDER_EXECUTION_MODES.MANUAL_FULFILLMENT : PROVIDER_EXECUTION_MODES.AUTO_PROVIDER,
        providerExecutionEnabled: !manual,
        providerExecutionBlocked: false,
    });
    const { customer } = await createCustomerWithGroup({ walletBalance: 25 }, { percentage: 0 });
    return { customer, product, provider, providerProduct };
};

const expectNoFinancialMutation = async (customerId) => {
    expect(await Order.countDocuments({ userId: customerId })).toBe(0);
    expect(await WalletTransaction.countDocuments({ userId: customerId })).toBe(0);
};

describe('FazerCards deterministic pre-debit safety', () => {
    it('creates one debited automatic gift-card order and makes exactly one fake supplier placement', async () => {
        config.providers.fazerCards.enabled = true;
        config.providers.fazerCards.realOrdersEnabled = true;
        config.providers.fazerCards.codeDeliveryEnabled = true;
        const { customer, product } = await createGiftCardFixture({ sourceAvailability: 'AVAILABLE' });
        const adapter = {
            getBalance: jest.fn().mockResolvedValue({ balance: 100, currency: 'USD' }),
            client: {
                createGiftCardOrder: jest.fn().mockResolvedValue({
                    requestId: 'fake-gift-request',
                    data: { ok: true, order: { id: 'fake-gift-order', status: 'processing' } },
                }),
            },
        };

        const result = await orderService.createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
            idempotencyKey: `fake-gift-${Date.now()}`,
            provider: adapter,
        });

        let stored = null;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            stored = await Order.findById(result.order._id);
            if (stored?.providerOrderId === 'fake-gift-order') break;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(await Order.countDocuments({ userId: customer._id })).toBe(1);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(1);
        expect(adapter.client.createGiftCardOrder).toHaveBeenCalledTimes(1);
        expect(stored.status).toBe(ORDER_STATUS.PROCESSING);
        expect(stored.providerOrderId).toBe('fake-gift-order');
        expect(stored.providerRequestId).toBe('fake-gift-request');
        expect(stored.refunded).toBe(false);
    });

    it('rejects an automatic gift-card checkout before debit when real orders are globally disabled', async () => {
        config.providers.fazerCards.enabled = true;
        config.providers.fazerCards.realOrdersEnabled = false;
        config.providers.fazerCards.codeDeliveryEnabled = true;
        const { customer, product } = await createGiftCardFixture();

        await expect(orderService.createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
            provider: {},
        })).rejects.toMatchObject({ code: 'FAZERCARDS_REAL_ORDERS_DISABLED' });

        await expectNoFinancialMutation(customer._id);
    });

    it('rejects an automatic CODE_DELIVERY checkout before debit when code delivery is disabled', async () => {
        config.providers.fazerCards.enabled = true;
        config.providers.fazerCards.realOrdersEnabled = true;
        config.providers.fazerCards.codeDeliveryEnabled = false;
        const { customer, product } = await createGiftCardFixture();

        await expect(orderService.createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
            provider: {},
        })).rejects.toMatchObject({ code: 'FAZERCARDS_CODE_DELIVERY_DISABLED' });

        await expectNoFinancialMutation(customer._id);
    });

    it('preserves the explicit manual FazerCards workflow when automatic execution is not selected', async () => {
        config.providers.fazerCards.enabled = true;
        config.providers.fazerCards.realOrdersEnabled = false;
        config.providers.fazerCards.codeDeliveryEnabled = false;
        const { customer, product } = await createGiftCardFixture({ manual: true });

        const { order } = await orderService.createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
            provider: {},
        });

        expect(order.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(1);
    });

    it('rejects confirmed source removal before debit and cannot be re-exposed through ordinary Product PATCH', async () => {
        config.providers.fazerCards.enabled = true;
        config.providers.fazerCards.realOrdersEnabled = true;
        config.providers.fazerCards.codeDeliveryEnabled = true;
        const { customer, product } = await createGiftCardFixture({ sourceAvailability: 'MISSING_CONFIRMED' });

        await expect(orderService.createOrder({ userId: customer._id, productId: product._id, quantity: 1, provider: {} }))
            .rejects.toMatchObject({ code: 'FAZERCARDS_SOURCE_MISSING_CONFIRMED' });
        await expectNoFinancialMutation(customer._id);

        await expect(productService.updateProduct(product._id, {
            status: PRODUCT_STATUSES.AVAILABLE,
            customerPurchaseEnabled: true,
        })).rejects.toMatchObject({ code: 'FAZERCARDS_SOURCE_UNAVAILABLE_LOCKED' });
    });

    it.each(['MISSING_CONFIRMED', 'EXPLICITLY_UNAVAILABLE'])('holds an already-debited %s order before any supplier POST', async (sourceAvailability) => {
        config.providers.fazerCards.enabled = true;
        config.providers.fazerCards.realOrdersEnabled = true;
        config.providers.fazerCards.codeDeliveryEnabled = true;
        const { customer, product, providerProduct } = await createGiftCardFixture({ sourceAvailability });
        const order = await Order.create({
            userId: customer._id, orderNumber: Math.floor(Math.random() * 1000000) + 100000,
            productId: product._id, quantity: 1, unitPrice: '2', totalPrice: '2', basePriceSnapshot: '2',
            markupPercentageSnapshot: 0, finalPriceCharged: '2', groupIdSnapshot: customer.groupId,
            walletDeducted: '2', creditUsedAmount: 0, status: ORDER_STATUS.PROCESSING, executionType: 'automatic',
            providerCode: PROVIDER_CODES.FAZER_CARDS, familyKey: 'GIFTCARDS', fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
        });
        const adapter = { placeOrder: jest.fn(), checkOrder: jest.fn() };
        const beforeTransactions = await WalletTransaction.countDocuments({ userId: customer._id });
        const result = await executeOrder(order._id, adapter);
        expect(adapter.placeOrder).not.toHaveBeenCalled();
        expect(result.order.status).toBe(ORDER_STATUS.MANUAL_REVIEW);
        expect(result.order.providerErrorCode).toBe('FAZERCARDS_SOURCE_UNAVAILABLE');
        expect(result.order.refunded).toBe(false);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(beforeTransactions);
        expect((await Order.findById(order._id)).providerOrderId).toBeNull();
        expect(providerProduct.sourceAvailability).toBe(sourceAvailability);
    });
});
