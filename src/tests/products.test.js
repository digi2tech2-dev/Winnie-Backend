'use strict';

const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct, FULFILLMENT_MODES } = require('../modules/providers/providerProduct.model');
const { PROVIDER_CODES } = require('../modules/providers/provider.constants');
const productService = require('../modules/products/product.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createProduct,
    expectDecimalString,
} = require('./testHelpers');

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

describe('Product provider linking smoke coverage', () => {
    it('keeps existing provider linking behavior working for non-FazerCards products', async () => {
        const provider = await Provider.create({
            name: 'Mock Supplier',
            slug: 'mock',
            baseUrl: 'https://api.example.com',
            isActive: true,
        });
        const providerProduct = await ProviderProduct.create({
            provider: provider._id,
            externalProductId: 'mock-1',
            rawName: 'Mock Provider Product',
            rawPrice: '12.34',
            minQty: 2,
            maxQty: 25,
            isActive: true,
        });

        const product = await productService.publishFromProviderProduct({
            providerProductId: providerProduct._id,
            name: 'Published Mock Product',
            pricingMode: 'sync',
            markupValue: 0,
        });

        expect(product.provider.toString()).toBe(provider._id.toString());
        expect(product.providerProduct.toString()).toBe(providerProduct._id.toString());
        expect(product.minQty).toBe(2);
        expect(product.maxQty).toBe(25);
        expectDecimalString(product.providerPrice, '12.34');
        expectDecimalString(product.basePrice, '12.34');
    });

    it('prevents linking FazerCards raw catalog rows into customer products in phase 1', async () => {
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
            externalProductId: 'fazer-unknown',
            rawName: 'Fazer Unknown',
            rawPrice: '1.00',
            isActive: true,
            fulfillmentMode: FULFILLMENT_MODES.UNKNOWN,
            isSupported: false,
            isBlocked: true,
            blockReason: 'UNSUPPORTED_FULFILLMENT_MODE',
        });
        const product = await createProduct({ name: 'Manual Product', basePrice: '5.00' });

        await expect(productService.updateProduct(product._id, {
            providerProduct: providerProduct._id,
            executionType: 'automatic',
            pricingMode: 'sync',
        })).rejects.toMatchObject({ code: 'FAZERCARDS_PURCHASE_UNSUPPORTED' });
    });
});
