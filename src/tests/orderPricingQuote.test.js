'use strict';

const orderService = require('../modules/orders/order.service');
const { Currency } = require('../modules/currency/currency.model');
const { buildCustomerPricingFields, calculateDiscount } = require('../modules/products/customerPricingPresenter');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomer,
    createGroup,
    createProduct,
    freshUser,
    expectDecimalString,
} = require('./testHelpers');

describe('High precision order quote pricing', () => {
    let group;

    beforeAll(async () => {
        await connectTestDB();
    });

    afterAll(async () => {
        await disconnectTestDB();
    });

    beforeEach(async () => {
        await clearCollections();
        group = await createGroup({ name: 'No Markup', percentage: 0 });
        await Currency.create({
            code: 'EGP',
            name: 'Egyptian Pound',
            symbol: 'EGP',
            platformRate: 51,
            isActive: true,
        });
    });

    it('quotes a high precision synced product in customer currency', async () => {
        const customer = await createCustomer({
            groupId: group._id,
            currency: 'EGP',
            walletBalance: 945.02,
        });
        const product = await createProduct({
            name: 'SoulStar',
            basePrice: '0.00010780225539945481',
            finalPrice: '0.00010780225539945481',
            minQty: 10000,
            maxQty: 5000000,
        });

        const quote = await orderService.quoteOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 10000,
        });

        expect(quote.currency).toBe('EGP');
        expectDecimalString(quote.unitPriceUsd, '0.00010780225539945481');
        expectDecimalString(quote.totalUsd, '1.0780225539945481');
        expect(quote.rateSnapshot).toBe(51);
        expect(quote.payableAmount).toBe(54.98);
        expect(quote.chargedAmount).toBe(54.98);
        expect(quote.hasEnoughBalance).toBe(true);
    });

    it('creates an order that charges the same amount as the quote', async () => {
        const customer = await createCustomer({
            groupId: group._id,
            currency: 'EGP',
            walletBalance: 100,
        });
        const product = await createProduct({
            name: 'SoulStar',
            basePrice: '0.00010780225539945481',
            finalPrice: '0.00010780225539945481',
            minQty: 10000,
            maxQty: 5000000,
        });

        const quote = await orderService.quoteOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 10000,
        });
        const { order } = await orderService.createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 10000,
        });

        expect(order.chargedAmount).toBe(quote.payableAmount);
        expect(order.walletDeducted).toBe(54.98);
        expectDecimalString(order.totalPrice, '54.98');
        expectDecimalString(order.usdAmount, '1.0780225539945481');

        const user = await freshUser(customer._id);
        expect(user.walletBalance).toBe(45.02);
    });

    it('does not produce a discount when basePrice and finalPrice are equal', () => {
        const discount = calculateDiscount('0.00010780225539945481', '0.00010780225539945481');

        expect(discount.hasDiscount).toBe(false);
        expect(discount.discountPercent).toBe(0);
    });

    it('returns min-total display fields for tiny unit prices', () => {
        const product = {
            basePrice: '0.00010780225539945481',
            minQty: 10000,
        };

        const fields = buildCustomerPricingFields({
            product,
            unitPriceUsd: '0.00010780225539945481',
            currency: 'EGP',
            rate: 51,
        });

        expect(fields.priceDisplayMode).toBe('min_total');
        expect(fields.minTotalUsd).toBe('1.0780225539945481');
        expect(fields.minTotalCustomerCurrency).toBe(54.98);
        expect(fields.displayPriceLabel).toBe('10,000 = EGP 54.98');
        expect(fields.hasDiscount).toBe(false);
        expect(fields.discountPercent).toBe(0);
    });

    it('hides discounts for missing or invalid final prices', () => {
        expect(calculateDiscount('10', null)).toEqual({ hasDiscount: false, discountPercent: 0 });
        expect(calculateDiscount('10', 'not-a-number')).toEqual({ hasDiscount: false, discountPercent: 0 });
        expect(calculateDiscount('10', '0')).toEqual({ hasDiscount: false, discountPercent: 0 });
    });
});
