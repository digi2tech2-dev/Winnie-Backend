'use strict';

/**
 * Regression coverage for the generic (non-FazerCards) pre-debit provider
 * price guard. All supplier responses are local mocks; the suite uses the
 * MongoMemoryReplSet configured by Jest's global setup.
 */

const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product, PRICING_MODES } = require('../modules/products/product.model');
const { Order, ORDER_EXECUTION_TYPES } = require('../modules/orders/order.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { createOrder } = require('../modules/orders/order.service');
const orderFulfillmentService = require('../modules/orders/orderFulfillment.service');
const mongoose = require('mongoose');
const {
    syncProviderProducts,
    syncDueProviders,
    applyLiveProviderPrice,
} = require('../modules/providers/providerProductSync.service');
const { clearAll: clearPriceCache } = require('../modules/providers/providerPriceCache');
const { registerAdapter } = require('../modules/providers/adapters/adapter.factory');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
} = require('./testHelpers');

let catalog = [];
let catalogRequests = 0;
let executeOrderSpy;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class PriceGuardAdapter {
    constructor(provider) {
        this.provider = provider;
    }

    async getProducts() {
        catalogRequests++;
        return catalog.map((item) => ({ ...item }));
    }

    async fetchProducts() {
        return this.getProducts();
    }
}

registerAdapter('price-guard-test', PriceGuardAdapter);

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => {
    await clearCollections();
    clearPriceCache();
    catalogRequests = 0;
    catalog = [{
        externalProductId: 'zaffa-live',
        rawName: 'Zaffa live',
        rawPrice: '1.00',
        minQty: 1,
        maxQty: 5000000,
        isActive: true,
    }];
    executeOrderSpy = jest.spyOn(orderFulfillmentService, 'executeOrder')
        .mockResolvedValue({ order: null, placed: false, refunded: false });
});

afterEach(() => {
    executeOrderSpy?.mockRestore();
    delete process.env.CHECKOUT_PROVIDER_PRICE_GUARD_TIMEOUT_MS;
});

const createFixture = async ({
    catalogPrice = '1.00',
    storedCost = '1.00',
    sellPrice = '1.50',
    pricingMode = PRICING_MODES.SYNC,
    markupType = 'fixed',
    markupValue = 0.5,
    syncInterval = 60,
    executionType = 'manual',
} = {}) => {
    catalog[0].rawPrice = catalogPrice;
    const suffix = Date.now() + '-' + Math.random();
    const provider = await Provider.create({
        name: 'Price Guard ' + suffix,
        slug: 'price-guard-test',
        baseUrl: 'https://supplier.invalid',
        isActive: true,
        syncInterval,
    });
    const providerProduct = await ProviderProduct.create({
        provider: provider._id,
        externalProductId: 'zaffa-live',
        rawName: 'Zaffa live',
        rawPrice: storedCost,
        minQty: 1,
        maxQty: 5000000,
        isActive: true,
    });
    const product = await Product.create({
        name: 'Zaffa live ' + suffix,
        provider: provider._id,
        providerProduct: providerProduct._id,
        providerPrice: storedCost,
        basePrice: sellPrice,
        finalPrice: sellPrice,
        minQty: 1,
        maxQty: 5000000,
        isActive: true,
        visibleInStore: true,
        executionType,
        pricingMode,
        syncPriceWithProvider: pricingMode === PRICING_MODES.SYNC,
        markupType,
        markupValue,
    });
    const { customer } = await createCustomerWithGroup({ walletBalance: 100 }, { percentage: 0 });
    return { provider, providerProduct, product, customer, adapter: new PriceGuardAdapter(provider) };
};

const submit = ({ customer, product, adapter, quantity = 1, idempotencyKey = null }) => createOrder({
    userId: customer._id,
    productId: product._id,
    quantity,
    provider: adapter,
    idempotencyKey,
});

describe('generic provider price increase guard', () => {
    it('keeps a slow catalog lookup outside the MongoDB transaction lifetime', async () => {
        const previousLimit = (await mongoose.connection.db.admin().command({
            getParameter: 1,
            transactionLifetimeLimitSeconds: 1,
        })).transactionLifetimeLimitSeconds;
        process.env.CHECKOUT_PROVIDER_PRICE_GUARD_TIMEOUT_MS = '5000';
        const fixture = await createFixture({ executionType: ORDER_EXECUTION_TYPES.AUTOMATIC });
        let catalogReadFinished = false;
        fixture.adapter.getProducts = jest.fn(async () => {
            await delay(1250);
            catalogReadFinished = true;
            return catalog.map((item) => ({ ...item }));
        });
        const originalStartSession = mongoose.startSession.bind(mongoose);
        const startSessionSpy = jest.spyOn(mongoose, 'startSession').mockImplementation(async () => {
            expect(catalogReadFinished).toBe(true);
            return originalStartSession();
        });

        try {
            const { order } = await submit(fixture);

            expect(order.status).toBe('PROCESSING');
            expect(await Order.countDocuments({ userId: fixture.customer._id })).toBe(1);
            expect(await WalletTransaction.countDocuments({
                userId: fixture.customer._id,
                type: 'DEBIT',
            })).toBe(1);
            expect(executeOrderSpy).toHaveBeenCalledTimes(1);
        } finally {
            startSessionSpy.mockRestore();
            await mongoose.connection.db.admin().command({
                setParameter: 1,
                transactionLifetimeLimitSeconds: previousLimit,
            });
        }
    });

    it('bounds an unavailable catalog read and still commits one durable checkout', async () => {
        process.env.CHECKOUT_PROVIDER_PRICE_GUARD_TIMEOUT_MS = '100';
        const fixture = await createFixture({ executionType: ORDER_EXECUTION_TYPES.AUTOMATIC });
        fixture.adapter.getProducts = jest.fn(async () => {
            await delay(350);
            return catalog.map((item) => ({ ...item }));
        });
        const startedAt = Date.now();

        const { order } = await submit(fixture);
        const elapsedMs = Date.now() - startedAt;

        expect(elapsedMs).toBeLessThan(1000);
        expect(order.status).toBe('PROCESSING');
        expect(await Order.countDocuments({ userId: fixture.customer._id })).toBe(1);
        expect(await WalletTransaction.countDocuments({
            userId: fixture.customer._id,
            type: 'DEBIT',
        })).toBe(1);
        expect(executeOrderSpy).toHaveBeenCalledTimes(1);
        await delay(350);
    });

    it('returns the committed checkout before a slow provider dispatch settles', async () => {
        const fixture = await createFixture({ executionType: ORDER_EXECUTION_TYPES.AUTOMATIC });
        let settleDispatch;
        executeOrderSpy.mockImplementation(() => new Promise((resolve) => {
            settleDispatch = resolve;
        }));

        const { order } = await submit(fixture);

        expect(order.status).toBe('PROCESSING');
        expect(await Order.countDocuments({ userId: fixture.customer._id })).toBe(1);
        expect(await WalletTransaction.countDocuments({
            userId: fixture.customer._id,
            type: 'DEBIT',
        })).toBe(1);
        expect(executeOrderSpy).toHaveBeenCalledTimes(1);
        settleDispatch({ order, placed: false, refunded: false });
    });

    it('concurrently retries one idempotency key without duplicate debit, order, or dispatch', async () => {
        const fixture = await createFixture({ executionType: ORDER_EXECUTION_TYPES.AUTOMATIC });
        const idempotencyKey = 'checkout-retry-' + fixture.product._id;

        const [first, second] = await Promise.all([
            submit({ ...fixture, idempotencyKey }),
            submit({ ...fixture, idempotencyKey }),
        ]);

        expect([first.idempotent, second.idempotent].filter(Boolean)).toHaveLength(1);
        expect(await Order.countDocuments({ userId: fixture.customer._id, idempotencyKey })).toBe(1);
        expect(await WalletTransaction.countDocuments({
            userId: fixture.customer._id,
            type: 'DEBIT',
        })).toBe(1);
        expect(executeOrderSpy).toHaveBeenCalledTimes(1);
    });

    it('retries one labeled transaction abort without duplicate financial effects', async () => {
        const fixture = await createFixture({ executionType: ORDER_EXECUTION_TYPES.AUTOMATIC });
        const originalStartSession = mongoose.startSession.bind(mongoose);
        let startedTransactions = 0;
        const startSessionSpy = jest.spyOn(mongoose, 'startSession').mockImplementation(async () => {
            const session = await originalStartSession();
            startedTransactions++;
            if (startedTransactions === 1) {
                const abort = session.abortTransaction.bind(session);
                session.commitTransaction = async () => {
                    await abort();
                    const error = new Error('Transaction has been aborted.');
                    error.code = 251;
                    error.codeName = 'NoSuchTransaction';
                    error.errorLabels = ['TransientTransactionError'];
                    throw error;
                };
            }
            return session;
        });

        try {
            const { order } = await submit({
                ...fixture,
                idempotencyKey: 'transaction-abort-' + fixture.product._id,
            });

            expect(order.status).toBe('PROCESSING');
            expect(startedTransactions).toBe(2);
            expect(await Order.countDocuments({ userId: fixture.customer._id })).toBe(1);
            expect(await WalletTransaction.countDocuments({
                userId: fixture.customer._id,
                type: 'DEBIT',
            })).toBe(1);
            expect(executeOrderSpy).toHaveBeenCalledTimes(1);
        } finally {
            startSessionSpy.mockRestore();
        }
    });

    it('accepts an unchanged supplier price and debits once', async () => {
        const fixture = await createFixture();

        const { order } = await submit(fixture);

        expect(order.status).toBe('PENDING');
        expect(await WalletTransaction.countDocuments({ userId: fixture.customer._id, type: 'DEBIT' })).toBe(1);
        expect(catalogRequests).toBe(1);
    });

    it('confirms a supplier increase, refreshes the linked sync product, and rejects before debit', async () => {
        const fixture = await createFixture({ catalogPrice: '1.25' });

        await expect(submit(fixture)).rejects.toMatchObject({ code: 'PROVIDER_PRICE_INCREASED' });

        expect(await Order.countDocuments()).toBe(0);
        expect(await WalletTransaction.countDocuments({ userId: fixture.customer._id })).toBe(0);
        expect(catalogRequests).toBe(2);
        expect((await ProviderProduct.findById(fixture.providerProduct._id)).rawPrice).toBe('1.25');
        const refreshed = await Product.findById(fixture.product._id);
        expect(refreshed.providerPrice).toBe('1.25');
        expect(refreshed.basePrice).toBe('1.75');
    });

    it('does not reject a reverted price merely because an earlier cache entry was higher', async () => {
        const fixture = await createFixture({ catalogPrice: '1.25' });
        const adapter = {
            getProducts: jest.fn()
                .mockResolvedValueOnce([{ ...catalog[0], rawPrice: '1.25' }])
                .mockResolvedValueOnce([{ ...catalog[0], rawPrice: '1.00' }]),
        };

        const { order } = await submit({ ...fixture, adapter });

        expect(order.status).toBe('PENDING');
        expect(adapter.getProducts).toHaveBeenCalledTimes(2);
        expect(await WalletTransaction.countDocuments({ userId: fixture.customer._id, type: 'DEBIT' })).toBe(1);
    });

    it('keeps a manual public price unchanged and blocks it when it is below confirmed cost', async () => {
        const fixture = await createFixture({
            catalogPrice: '1.25',
            sellPrice: '1.10',
            pricingMode: PRICING_MODES.MANUAL,
            markupValue: 0,
        });

        await expect(submit(fixture)).rejects.toMatchObject({ code: 'PROVIDER_PRICE_INCREASED' });
        const updated = await Product.findById(fixture.product._id);
        expect(updated.providerPrice).toBe('1.25');
        expect(updated.basePrice).toBe('1.10');

        await expect(submit(fixture)).rejects.toMatchObject({ code: 'PROVIDER_PRICE_INCREASED' });
        expect(await WalletTransaction.countDocuments({ userId: fixture.customer._id })).toBe(0);
    });

    it('allows a customer retry after a synchronized price refresh and does not place a supplier order', async () => {
        const fixture = await createFixture({ catalogPrice: '1.25' });
        await expect(submit(fixture)).rejects.toMatchObject({ code: 'PROVIDER_PRICE_INCREASED' });

        const refreshed = await Product.findById(fixture.product._id);
        const result = await submit({ ...fixture, product: refreshed });

        expect(result.order.status).toBe('PENDING');
        expect(await WalletTransaction.countDocuments({ userId: fixture.customer._id, type: 'DEBIT' })).toBe(1);
    });

    it('manual and scheduled sync use the same linked price propagation and respect syncInterval', async () => {
        const fixture = await createFixture({ catalogPrice: '1.25', syncInterval: 60 });
        const manual = await syncProviderProducts(fixture.provider._id);
        expect(manual.errors).toEqual([]);
        expect((await Product.findById(fixture.product._id)).basePrice).toBe('1.75');

        catalog[0].rawPrice = '1.10';
        await Provider.updateOne({ _id: fixture.provider._id }, { $set: { lastCatalogSyncedAt: new Date() } });
        expect(await syncDueProviders()).toEqual([]);

        await Provider.updateOne({ _id: fixture.provider._id }, { $set: { lastCatalogSyncedAt: new Date(Date.now() - 61 * 60 * 1000) } });
        const due = await syncDueProviders();
        expect(due).toHaveLength(1);
        expect((await Product.findById(fixture.product._id)).basePrice).toBe('1.6');
    });

    it('does not let an older live observation overwrite a newer provider cost', async () => {
        const fixture = await createFixture();
        const newer = new Date(Date.now() + 1000);
        const older = new Date(Date.now() - 1000);
        await applyLiveProviderPrice({ providerProductId: fixture.providerProduct._id, rawPrice: '1.40', observedAt: newer });
        const stale = await applyLiveProviderPrice({ providerProductId: fixture.providerProduct._id, rawPrice: '1.10', observedAt: older });

        expect(stale).toMatchObject({ applied: false });
        expect((await ProviderProduct.findById(fixture.providerProduct._id)).rawPrice).toBe('1.40');
    });

    it('does not let a slower catalog snapshot overwrite a newer JIT refresh or linked sell price', async () => {
        const fixture = await createFixture({ catalogPrice: '1.10' });
        const newer = new Date(Date.now() + 1000);

        await applyLiveProviderPrice({
            providerProductId: fixture.providerProduct._id,
            rawPrice: '1.40',
            observedAt: newer,
        });

        const result = await syncProviderProducts(fixture.provider._id);
        expect(result.errors).toEqual([]);

        const providerProduct = await ProviderProduct.findById(fixture.providerProduct._id);
        const product = await Product.findById(fixture.product._id);
        expect(providerProduct.rawPrice).toBe('1.40');
        expect(product.providerPrice).toBe('1.40');
        expect(product.basePrice).toBe('1.9');
        expect(product.providerPriceSyncedAt.getTime()).toBe(newer.getTime());
    });
});
