'use strict';

const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product } = require('../modules/products/product.model');
const productService = require('../modules/products/product.service');
const { syncProviderProducts } = require('../modules/providers/providerProductSync.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
} = require('./testHelpers');

beforeAll(async () => connectTestDB());
afterAll(async () => disconnectTestDB());
beforeEach(async () => clearCollections());

let sequence = 0;
const envelope = (data) => ({ data: { success: true, message: 'success', data, request_id: 'req-catalog' } });

const createProvider = () => Provider.create({
    name: `Luban catalog ${++sequence}`,
    slug: `luban-catalog-${sequence}`,
    adapterType: 'luban-play',
    providerCode: 'LUBAN_PLAY',
    baseUrl: 'https://api.lubanplay.example/index.php?s=/api/openapi',
    apiToken: 'test-token',
    isActive: true,
});

describe('Luban Play catalog integration', () => {
    it('syncs fixed USD offers, retains excluded offers inactive, and publishes the eligible product through the normal flow', async () => {
        const provider = await createProvider();
        const client = {
            post: jest.fn((path) => {
                if (path === '/products') return Promise.resolve(envelope([
                    { type: 'giftcard', product_id: 'fixed-usd', name: 'Fixed USD', face_value_min: '10', face_value_max: '10.00', amount_required: false, currency: 'USD', price: '9.500000', status: 'available' },
                    { type: 'giftcard', product_id: 'open-usd', name: 'Open USD', face_value_min: '10', face_value_max: '50', amount_required: true, currency: 'USD', price_min: '9', price_max: '49', status: 'available' },
                    { type: 'giftcard', product_id: 'fixed-eur', name: 'Fixed EUR', face_value_min: '10', face_value_max: '10', amount_required: false, currency: 'EUR', price: '9', status: 'available' },
                ]));
                if (path === '/topupProducts') return Promise.resolve(envelope([]));
                throw new Error(`unexpected ${path}`);
            }),
        };

        const result = await syncProviderProducts(provider._id, { httpClient: client, packageRequestDelayMs: 0 });
        expect(result).toMatchObject({ totalFetched: 3, upserted: 3, errors: [] });

        const [eligible, openValue, nonUsd] = await Promise.all([
            ProviderProduct.findOne({ provider: provider._id, externalProductId: 'LUBAN_GIFTCARD:fixed-usd' }),
            ProviderProduct.findOne({ provider: provider._id, externalProductId: 'LUBAN_GIFTCARD:open-usd' }),
            ProviderProduct.findOne({ provider: provider._id, externalProductId: 'LUBAN_GIFTCARD:fixed-eur' }),
        ]);
        expect(eligible).toMatchObject({ isActive: true, currency: 'USD', rawPrice: '9.500000' });
        expect(openValue.isActive).toBe(false);
        expect(nonUsd.isActive).toBe(false);

        const product = await productService.publishFromProviderProduct({
            providerProductId: eligible._id,
            name: 'Published Luban Gift',
            basePrice: '12.00',
        });
        expect(product).toMatchObject({
            providerCode: 'LUBAN_PLAY',
            familyKey: 'GIFTCARDS',
            fulfillmentMode: 'CODE_DELIVERY',
            currency: 'USD',
        });
        await expect(productService.publishFromProviderProduct({
            providerProductId: nonUsd._id,
            name: 'Must not publish',
        })).rejects.toMatchObject({ code: 'PROVIDER_PRODUCT_INACTIVE' });
        expect(await Product.countDocuments({ provider: provider._id })).toBe(1);
    });

    it('does not deactivate an existing offer when a top-up package response is structurally incomplete', async () => {
        const provider = await createProvider();
        const existing = await ProviderProduct.create({
            provider: provider._id,
            externalProductId: 'LUBAN_TOPUP:12:301',
            rawName: 'Existing valid package',
            rawPrice: '0.90',
            currency: 'USD',
            minQty: 1,
            maxQty: 20,
            isActive: true,
            rawPayload: { lubanKind: 'topup', game_id: 12, package_id: 301 },
        });
        const client = {
            post: jest.fn((path) => {
                if (path === '/products') return Promise.resolve(envelope([
                    { type: 'giftcard', product_id: 'fixed-usd', name: 'Fixed USD', face_value_min: '10', face_value_max: '10', amount_required: false, currency: 'USD', price: '9', status: 'available' },
                ]));
                if (path === '/topupProducts') return Promise.resolve(envelope([{ game_id: 12, name: 'Game', status: 'available' }]));
                if (path === '/topupPackages') return Promise.resolve(envelope({ game_id: 12 }));
                throw new Error(`unexpected ${path}`);
            }),
        };

        await expect(syncProviderProducts(provider._id, { httpClient: client, packageRequestDelayMs: 0 }))
            .rejects.toThrow(/invalid package envelope/);
        expect((await ProviderProduct.findById(existing._id)).isActive).toBe(true);
    });
});
