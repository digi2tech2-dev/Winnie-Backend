'use strict';

const mongoose = require('mongoose');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const adminProviderService = require('../modules/admin/admin.providers.service');
const xenaProductService = require('../modules/providers/xena/xenaProduct.service');
const { XenaConnection } = require('../modules/providers/xena/xenaConnection.model');
const { getProviderAdapter } = require('../modules/providers/adapters/adapter.factory');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
} = require('./testHelpers');

const TEST_KEY = Buffer.alloc(32, 23).toString('base64');
const adminId = new mongoose.Types.ObjectId();

const createXenaProvider = (overrides = {}) => (
    adminProviderService.createProvider({
        name: 'Xena Recharge',
        code: 'xena-recharge',
        baseUrl: 'https://api.digiteech.me',
        authType: 'BEARER_TOKEN',
        apiToken: 'digiteech-client-key',
        isActive: true,
        ...overrides,
    }, adminId)
);

const createNonXenaProvider = () => (
    adminProviderService.createProvider({
        name: 'Regular Provider',
        code: 'regular-provider',
        baseUrl: 'https://provider.example.com',
        authType: 'NONE',
        isActive: true,
    }, adminId)
);

const validConfig = (overrides = {}) => ({
    name: 'Xena Dynamic Recharge (Any Amount)',
    minAmount: 1,
    maxAmount: 1000000,
    providerUnitPrice: '0.00001',
    isActive: true,
    ...overrides,
});

const json = (value) => JSON.stringify(value);

beforeAll(async () => {
    process.env.PROVIDER_CREDENTIALS_KEY = TEST_KEY;
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    process.env.PROVIDER_CREDENTIALS_KEY = TEST_KEY;
    process.env.XENA_RECHARGE_ENABLED = 'true';
    await clearCollections();
});

afterEach(() => {
    delete process.env.XENA_RECHARGE_ENABLED;
});

describe('Xena synthetic product config', () => {
    it('GET product config returns safe defaults for a Xena provider', async () => {
        const provider = await createXenaProvider();

        const config = await xenaProductService.getProductConfig({ provider: provider._id });

        expect(config).toMatchObject({
            externalProductId: 'xena-dynamic-recharge',
            name: 'Xena Dynamic Recharge (Any Amount)',
            minAmount: 1,
            maxAmount: 1000000,
            providerUnitPrice: null,
            isActive: true,
        });
        expect(config.orderField).toMatchObject({
            key: 'target_uid',
            label: 'Xena ID',
            type: 'text',
            required: true,
            isActive: true,
            verifiable: true,
        });
    });

    it('PATCH product config stores a valid admin configuration', async () => {
        const provider = await createXenaProvider();

        const config = await xenaProductService.updateProductConfig({
            provider: provider._id,
            data: validConfig({ minAmount: 10, maxAmount: 5000, providerUnitPrice: '1.25' }),
            updatedBy: adminId,
        });

        expect(config).toMatchObject({
            minAmount: 10,
            maxAmount: 5000,
            providerUnitPrice: '1.25',
            isActive: true,
        });

        const state = await XenaConnection.findOne({ provider: provider._id }).lean();
        expect(state.productConfig.updatedBy.toString()).toBe(adminId.toString());
        expect(state.productConfig.providerUnitPrice).toBe('1.25');
    });

    it('rejects invalid min/max values', async () => {
        const provider = await createXenaProvider();

        await expect(xenaProductService.updateProductConfig({
            provider: provider._id,
            data: validConfig({ minAmount: 0 }),
            updatedBy: adminId,
        })).rejects.toMatchObject({ code: 'XENA_INVALID_PRODUCT_CONFIG' });

        await expect(xenaProductService.updateProductConfig({
            provider: provider._id,
            data: validConfig({ maxAmount: Number.MAX_SAFE_INTEGER + 1 }),
            updatedBy: adminId,
        })).rejects.toMatchObject({ code: 'XENA_INVALID_PRODUCT_CONFIG' });
    });

    it('rejects maxAmount smaller than minAmount', async () => {
        const provider = await createXenaProvider();

        await expect(xenaProductService.updateProductConfig({
            provider: provider._id,
            data: validConfig({ minAmount: 100, maxAmount: 99 }),
            updatedBy: adminId,
        })).rejects.toMatchObject({ code: 'XENA_INVALID_PRODUCT_CONFIG' });
    });

    it('rejects invalid providerUnitPrice values', async () => {
        const provider = await createXenaProvider();

        for (const providerUnitPrice of ['0', '-1', 'abc', '', null]) {
            await expect(xenaProductService.updateProductConfig({
                provider: provider._id,
                data: validConfig({ providerUnitPrice }),
                updatedBy: adminId,
            })).rejects.toMatchObject({ code: 'XENA_INVALID_PRODUCT_CONFIG' });
        }
    });

    it('product config response does not expose API key or connectionId', async () => {
        const provider = await createXenaProvider();
        const state = await XenaConnection.create({ provider: provider._id });
        state.setConnectionId('con_secret_config');
        await state.save();

        const config = await xenaProductService.getProductConfig({ provider: provider._id });
        const payload = json(config);

        expect(payload).not.toContain('digiteech-client-key');
        expect(payload).not.toContain('con_secret_config');
        expect(payload).not.toContain('enc:v1:');
    });

    it('non-Xena provider cannot use Xena product config services', async () => {
        const provider = await createNonXenaProvider();

        await expect(xenaProductService.getProductConfig({ provider: provider._id }))
            .rejects.toMatchObject({ code: 'XENA_PROVIDER_REQUIRED' });
        await expect(xenaProductService.updateProductConfig({
            provider: provider._id,
            data: validConfig(),
            updatedBy: adminId,
        })).rejects.toMatchObject({ code: 'XENA_PROVIDER_REQUIRED' });
    });
});

describe('Xena synthetic ProviderProduct sync', () => {
    it('sync-product creates exactly one ProviderProduct with configured values', async () => {
        const provider = await createXenaProvider();
        await xenaProductService.updateProductConfig({
            provider: provider._id,
            data: validConfig({ minAmount: 5, maxAmount: 2500, providerUnitPrice: '0.5', isActive: false }),
            updatedBy: adminId,
        });

        const result = await xenaProductService.syncSyntheticProduct({ provider: provider._id });
        const products = await ProviderProduct.find({ provider: provider._id }).lean();

        expect(result.externalProductId).toBe('xena-dynamic-recharge');
        expect(products).toHaveLength(1);
        expect(products[0]).toMatchObject({
            externalProductId: 'xena-dynamic-recharge',
            rawName: 'Xena Dynamic Recharge (Any Amount)',
            rawPrice: '0.5',
            minQty: 5,
            maxQty: 2500,
            isActive: false,
        });
        expect(products[0].rawPayload).toMatchObject({
            synthetic: true,
            providerCode: 'xena-recharge',
            externalProductId: 'xena-dynamic-recharge',
            providerUnitPrice: '0.5',
            minAmount: 5,
            maxAmount: 2500,
            isActive: false,
        });
    });

    it('sync-product is idempotent and updates the same ProviderProduct', async () => {
        const provider = await createXenaProvider();
        await xenaProductService.updateProductConfig({
            provider: provider._id,
            data: validConfig({ providerUnitPrice: '0.25' }),
            updatedBy: adminId,
        });

        await xenaProductService.syncSyntheticProduct({ provider: provider._id });
        const first = await ProviderProduct.findOne({ provider: provider._id, externalProductId: 'xena-dynamic-recharge' });

        await xenaProductService.updateProductConfig({
            provider: provider._id,
            data: validConfig({ minAmount: 10, maxAmount: 999, providerUnitPrice: '0.75', isActive: false }),
            updatedBy: adminId,
        });
        await xenaProductService.syncSyntheticProduct({ provider: provider._id });

        const products = await ProviderProduct.find({ provider: provider._id });
        expect(products).toHaveLength(1);
        expect(products[0]._id.toString()).toBe(first._id.toString());
        expect(products[0].rawPrice).toBe('0.75');
        expect(products[0].minQty).toBe(10);
        expect(products[0].maxQty).toBe(999);
        expect(products[0].isActive).toBe(false);
    });

    it('target_uid metadata exists as text and preserves string semantics', async () => {
        const provider = await createXenaProvider();
        await xenaProductService.updateProductConfig({
            provider: provider._id,
            data: validConfig(),
            updatedBy: adminId,
        });
        await xenaProductService.syncSyntheticProduct({ provider: provider._id });

        const product = await ProviderProduct.findOne({ provider: provider._id }).lean();
        const field = product.rawPayload.orderField;

        expect(field).toMatchObject({
            key: 'target_uid',
            label: 'Xena ID',
            type: 'text',
            required: true,
            isActive: true,
            verifiable: true,
            validation: {
                digitsOnly: true,
                minLength: 1,
                maxLength: 50,
            },
        });
        expect(field.type).not.toBe('number');
        expect(Number.isNaN(Number('001234'))).toBe(false);
        expect('001234').toBe('001234');
    });

    it('Xena adapter getProducts returns only the configured synthetic product', async () => {
        const provider = await createXenaProvider();
        await xenaProductService.updateProductConfig({
            provider: provider._id,
            data: validConfig({ minAmount: 7, maxAmount: 700, providerUnitPrice: '0.33' }),
            updatedBy: adminId,
        });

        const storedProvider = await Provider.findById(provider._id);
        const adapter = getProviderAdapter(storedProvider, { strict: true });
        const products = await adapter.getProducts();

        expect(products).toHaveLength(1);
        expect(products[0]).toMatchObject({
            externalProductId: 'xena-dynamic-recharge',
            rawName: 'Xena Dynamic Recharge (Any Amount)',
            rawPrice: '0.33',
            minQty: 7,
            maxQty: 700,
            isActive: true,
        });
        expect(products[0].rawPayload.orderField.key).toBe('target_uid');
        expect(json(products)).not.toContain('digiteech-client-key');
    });
});
