'use strict';

const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { buildProviderProductSearchFields } = require('../modules/providers/providerProductSearch');
const { listProductProviderProductOptions } = require('../modules/admin/admin.catalog.controller');
const { connectTestDB, disconnectTestDB, clearCollections } = require('./testHelpers');

beforeAll(async () => connectTestDB());
afterAll(async () => disconnectTestDB());
beforeEach(async () => clearCollections());

const invoke = (query, providerId) => new Promise((resolve, reject) => {
    const response = {
        status: () => response,
        json: (payload) => resolve(payload),
    };
    listProductProviderProductOptions({
        params: { providerId: String(providerId) },
        query,
        user: { role: 'ADMIN' },
    }, response, reject);
});

describe('provider product option search', () => {
    it('searches the full active catalog by name and Luban supplier identifiers with bounded pagination', async () => {
        const provider = await Provider.create({
            name: 'Luban Play test',
            slug: `luban-options-${Date.now()}`,
            adapterType: 'luban-play',
            providerCode: 'LUBAN_PLAY',
            baseUrl: 'https://api.lubanplay.example/index.php?s=/api/openapi',
            apiToken: 'test-token',
            isActive: true,
        });
        await ProviderProduct.insertMany(Array.from({ length: 10_000 }, (_, index) => {
            const product = {
                provider: provider._id,
                externalProductId: `LUBAN_GIFTCARD:gift-${index + 1}`,
                rawName: `Catalog product ${index + 1}`,
                rawPrice: '9',
                isActive: true,
                rawPayload: { product_id: `gift-${index + 1}`, sku_id: `SKU-${index + 1}`, package_id: String(index + 1), code: `CODE-${index + 1}` },
            };
            return { ...product, ...buildProviderProductSearchFields(product) };
        }));
        const inactiveProduct = {
            provider: provider._id,
            externalProductId: 'LUBAN_GIFTCARD:inactive',
            rawName: 'Inactive known product',
            rawPrice: '9',
            isActive: false,
            rawPayload: { product_id: 'inactive-known', sku_id: 'SKU-INACTIVE' },
        };
        await ProviderProduct.create({ ...inactiveProduct, ...buildProviderProductSearchFields(inactiveProduct) });

        const firstPage = await invoke({ page: '1' }, provider._id);
        expect(firstPage.pagination).toMatchObject({ page: 1, limit: 40, total: 10_000, pages: 250 });
        expect(firstPage.data).toHaveLength(40);

        const bySku = await invoke({ search: 'SKU-9999', page: '1' }, provider._id);
        expect(bySku.pagination.total).toBe(1);
        expect(bySku.data[0]).toMatchObject({ supplierCode: 'SKU-9999', externalProductId: 'LUBAN_GIFTCARD:gift-9999' });

        const byName = await invoke({ search: 'Catalog product 9999', page: '1' }, provider._id);
        expect(byName.pagination.total).toBe(1);

        const byProductId = await invoke({ search: 'gift-9999', page: '1' }, provider._id);
        expect(byProductId.pagination.total).toBe(1);

        expect((await invoke({ search: '9999', page: '1' }, provider._id)).pagination.total).toBe(1);
        expect((await invoke({ search: 'CODE-9999', page: '1' }, provider._id)).pagination.total).toBe(1);

        const noMatch = await invoke({ search: 'does-not-exist', page: '1' }, provider._id);
        expect(noMatch.pagination.total).toBe(0);
        expect(noMatch.data).toEqual([]);

        const inactive = await invoke({ search: 'inactive-known', page: '1' }, provider._id);
        expect(inactive.pagination.total).toBe(0);
    });
});
