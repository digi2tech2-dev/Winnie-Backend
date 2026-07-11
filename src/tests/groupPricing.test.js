'use strict';

const orderService = require('../modules/orders/order.service');
const { Currency } = require('../modules/currency/currency.model');
const { buildCustomerPricingFields } = require('../modules/products/customerPricingPresenter');
const {
    calculateFinalPrice,
    calculateUserPrice,
    getProductFinalUnitPrice,
} = require('../modules/orders/pricing.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomer,
    createGroup,
    createProduct,
    expectDecimalString,
} = require('./testHelpers');

const SOULSTAR_UNIT_PRICE = '0.00010780225539945481';

const createSoulStar = () => createProduct({
    name: 'SoulStar',
    basePrice: SOULSTAR_UNIT_PRICE,
    finalPrice: SOULSTAR_UNIT_PRICE,
    minQty: 10000,
    maxQty: 5000000,
});

describe('Customer group percentage pricing', () => {
    beforeAll(async () => {
        await connectTestDB();
    });

    afterAll(async () => {
        await disconnectTestDB();
    });

    beforeEach(async () => {
        await clearCollections();
        await Currency.create({
            code: 'EGP',
            name: 'Egyptian Pound',
            symbol: 'EGP',
            platformRate: 51,
            isActive: true,
        });
    });

    it('quotes group 0 without changing the existing product price', async () => {
        const group = await createGroup({ name: 'Default', percentage: 0 });
        const customer = await createCustomer({ groupId: group._id, currency: 'EGP', walletBalance: 100 });
        const product = await createSoulStar();

        const quote = await orderService.quoteOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 10000,
        });

        expect(quote.groupPercentage).toBe(0);
        expectDecimalString(quote.productFinalUnitPriceUsd, SOULSTAR_UNIT_PRICE);
        expectDecimalString(quote.customerUnitPriceUsd, SOULSTAR_UNIT_PRICE);
        expect(quote.payableAmount).toBe(54.98);
    });

    it('quotes group 3 by applying markup over product final price', async () => {
        const group = await createGroup({ name: 'Normal', percentage: 3 });
        const customer = await createCustomer({ groupId: group._id, currency: 'EGP', walletBalance: 100 });
        const product = await createSoulStar();

        const quote = await orderService.quoteOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 10000,
        });

        expect(quote.groupName).toBe('Normal');
        expect(quote.groupPercentage).toBe(3);
        expectDecimalString(quote.customerUnitPriceUsd, calculateFinalPrice(SOULSTAR_UNIT_PRICE, 3));
        expect(quote.payableAmount).toBe(56.63);
    });

    it('quotes group 1 by applying the lower merchant markup', async () => {
        const group = await createGroup({ name: 'Merchant', percentage: 1 });
        const customer = await createCustomer({ groupId: group._id, currency: 'EGP', walletBalance: 100 });
        const product = await createSoulStar();

        const quote = await orderService.quoteOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 10000,
        });

        expect(quote.groupPercentage).toBe(1);
        expect(quote.payableAmount).toBe(55.53);
    });

    it('order creation matches quote and stores group snapshots', async () => {
        const group = await createGroup({ name: 'Normal', percentage: 3 });
        const customer = await createCustomer({ groupId: group._id, currency: 'EGP', walletBalance: 100 });
        const product = await createSoulStar();

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
        expect(order.walletDeducted).toBe(quote.payableAmount);
        expect(order.groupIdSnapshot.toString()).toBe(group._id.toString());
        expect(order.groupNameSnapshot).toBe('Normal');
        expect(order.groupPercentageSnapshot).toBe(3);
        expect(order.markupPercentageSnapshot).toBe(3);
        expectDecimalString(order.finalPriceCharged, quote.customerUnitPriceUsd);
        expectDecimalString(order.unitPrice, quote.customerUnitPriceUsd);
    });

    it('catalog display is higher for group 3 than group 1', async () => {
        const normal = await createGroup({ name: 'Normal', percentage: 3 });
        const merchant = await createGroup({ name: 'Merchant', percentage: 1 });
        const normalUser = await createCustomer({ groupId: normal._id });
        const merchantUser = await createCustomer({ groupId: merchant._id });
        const product = await createSoulStar();

        const normalPrice = await calculateUserPrice(
            normalUser._id,
            getProductFinalUnitPrice(product),
            null,
            { baseUnitPriceUsd: product.basePrice }
        );
        const merchantPrice = await calculateUserPrice(
            merchantUser._id,
            getProductFinalUnitPrice(product),
            null,
            { baseUnitPriceUsd: product.basePrice }
        );

        const normalFields = buildCustomerPricingFields({
            product,
            productFinalUnitPriceUsd: normalPrice.productFinalUnitPriceUsd,
            groupPercentage: normalPrice.groupPercentage,
            customerUnitPriceUsd: normalPrice.customerUnitPriceUsd,
            currency: 'EGP',
            rate: 51,
        });
        const merchantFields = buildCustomerPricingFields({
            product,
            productFinalUnitPriceUsd: merchantPrice.productFinalUnitPriceUsd,
            groupPercentage: merchantPrice.groupPercentage,
            customerUnitPriceUsd: merchantPrice.customerUnitPriceUsd,
            currency: 'EGP',
            rate: 51,
        });

        expect(normalFields.minTotalCustomerCurrency).toBeGreaterThan(merchantFields.minTotalCustomerCurrency);
        expect(normalFields.displayPriceLabel).toBe('10,000 = EGP 56.63');
        expect(merchantFields.displayPriceLabel).toBe('10,000 = EGP 55.53');
    });

    it('group markup does not create a fake discount badge', async () => {
        const group = await createGroup({ name: 'Normal', percentage: 3 });
        const customer = await createCustomer({ groupId: group._id });
        const product = await createSoulStar();
        const pricing = await calculateUserPrice(customer._id, getProductFinalUnitPrice(product));

        const fields = buildCustomerPricingFields({
            product,
            productFinalUnitPriceUsd: pricing.productFinalUnitPriceUsd,
            groupPercentage: pricing.groupPercentage,
            customerUnitPriceUsd: pricing.customerUnitPriceUsd,
            currency: 'EGP',
            rate: 51,
        });

        expect(fields.hasDiscount).toBe(false);
        expect(fields.discountPercent).toBe(0);
    });

    it('falls back to highest active group when the user has no valid group', async () => {
        const fallback = await createGroup({ name: 'Default', percentage: 3 });
        await createGroup({ name: 'Merchant', percentage: 1 });
        const customer = await createCustomer({ groupId: null, currency: 'EGP', walletBalance: 100 });
        const product = await createSoulStar();

        const quote = await orderService.quoteOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 10000,
        });

        expect(quote.groupId).toBe(fallback._id.toString());
        expect(quote.groupPercentage).toBe(3);
        expect(quote.payableAmount).toBe(56.63);
    });

    it('uses 0 percent when no active group exists', async () => {
        const customer = await createCustomer({ groupId: null, currency: 'EGP', walletBalance: 100 });
        const product = await createSoulStar();

        const quote = await orderService.quoteOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 10000,
        });

        expect(quote.groupId).toBeNull();
        expect(quote.groupName).toBeNull();
        expect(quote.groupPercentage).toBe(0);
        expect(quote.payableAmount).toBe(54.98);
    });
});
