'use strict';

const { Product } = require('../modules/products/product.model');
const { Order } = require('../modules/orders/order.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { CheckoutQuote, CHECKOUT_QUOTE_STATUS } = require('../modules/orders/checkoutQuote.model');
const { quoteOrder, createOrder } = require('../modules/orders/order.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
    createProduct,
} = require('./testHelpers');

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(clearCollections);

const fixture = async () => {
    const { customer } = await createCustomerWithGroup({ walletBalance: 100 });
    const product = await createProduct({ basePrice: '10', finalPrice: '10', minQty: 1, maxQty: 10 });
    return { customer, product };
};

const createWithQuote = async ({ customer, product, quote, quantity = 1, idempotencyKey = null }) => createOrder({
    userId: customer._id,
    productId: product._id,
    quantity,
    idempotencyKey,
    quoteId: quote.quoteId,
    requireQuoteConsent: true,
});

describe('checkout quote consent', () => {
    it('fails closed without a quote before any financial mutation', async () => {
        const { customer, product } = await fixture();

        await expect(createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
            requireQuoteConsent: true,
        })).rejects.toMatchObject({ code: 'QUOTE_REQUIRED' });

        expect(await Order.countDocuments()).toBe(0);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('binds an unchanged quote to exactly one debit and one order', async () => {
        const { customer, product } = await fixture();
        const quote = await quoteOrder({ userId: customer._id, productId: product._id, quantity: 1 });
        const result = await createWithQuote({ customer, product, quote, idempotencyKey: 'quote-ok-1' });

        expect(result.order.status).toBe('PENDING');
        expect(await Order.countDocuments()).toBe(1);
        expect(await WalletTransaction.countDocuments({ userId: customer._id, semanticType: 'ORDER_DEBIT' })).toBe(1);
        expect((await CheckoutQuote.findById(quote.quoteId)).status).toBe(CHECKOUT_QUOTE_STATUS.CONSUMED);
    });

    it('rejects a changed sync selling price before any debit or order', async () => {
        const { customer, product } = await fixture();
        const quote = await quoteOrder({ userId: customer._id, productId: product._id, quantity: 1 });
        await Product.updateOne({ _id: product._id }, { $set: { basePrice: '12', finalPrice: '12' } });

        await expect(createWithQuote({ customer, product, quote })).rejects.toMatchObject({ code: 'QUOTE_PRICE_CHANGED' });
        expect(await Order.countDocuments()).toBe(0);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
        expect((await CheckoutQuote.findById(quote.quoteId)).status).toBe(CHECKOUT_QUOTE_STATUS.ACTIVE);
    });

    it('rejects expired, foreign, and altered quote bindings before debit', async () => {
        const { customer, product } = await fixture();
        const other = (await createCustomerWithGroup({ walletBalance: 100 })).customer;
        const quote = await quoteOrder({ userId: customer._id, productId: product._id, quantity: 1 });
        await CheckoutQuote.updateOne({ _id: quote.quoteId }, { $set: { expiresAt: new Date(Date.now() - 1) } });
        await expect(createWithQuote({ customer, product, quote })).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });

        const fresh = await quoteOrder({ userId: customer._id, productId: product._id, quantity: 1 });
        await expect(createWithQuote({ customer: other, product, quote: fresh })).rejects.toMatchObject({ code: 'QUOTE_INVALID' });
        await expect(createWithQuote({ customer, product, quote: fresh, quantity: 2 })).rejects.toMatchObject({ code: 'QUOTE_INVALID' });
        expect(await WalletTransaction.countDocuments()).toBe(0);
    });

    it('consumes a quote once when duplicate checkout submissions race', async () => {
        const { customer, product } = await fixture();
        const quote = await quoteOrder({ userId: customer._id, productId: product._id, quantity: 1 });
        const results = await Promise.allSettled([
            createWithQuote({ customer, product, quote, idempotencyKey: 'quote-race-a' }),
            createWithQuote({ customer, product, quote, idempotencyKey: 'quote-race-b' }),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(await Order.countDocuments()).toBe(1);
        expect(await WalletTransaction.countDocuments({ userId: customer._id, semanticType: 'ORDER_DEBIT' })).toBe(1);
    });
});
