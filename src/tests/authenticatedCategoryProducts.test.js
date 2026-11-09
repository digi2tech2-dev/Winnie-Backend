'use strict';

const jwt = require('jsonwebtoken');
const app = require('../app');
const config = require('../config/config');
const { Category } = require('../modules/categories/category.model');
const { Product } = require('../modules/products/product.model');
const meController = require('../modules/me/me.controller');
const {
    clearCollections,
    connectTestDB,
    createAdmin,
    createCustomerWithGroup,
    disconnectTestDB,
} = require('./testHelpers');

beforeAll(async () => { await connectTestDB(); });
let server;
beforeAll(async () => {
    server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
});
afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await disconnectTestDB();
});
beforeEach(async () => { await clearCollections(); });

const callGetProducts = (user, query = {}) => new Promise((resolve, reject) => {
    const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn((payload) => resolve({ statusCode: res.status.mock.calls[0][0], payload })),
    };
    meController.getProducts({ query, user }, res, reject);
});

const product = (name, category, overrides = {}) => ({
    basePrice: '10',
    category,
    maxQty: 1,
    minQty: 1,
    name,
    ...overrides,
});

const customerToken = (customer) => jwt.sign(
    { id: customer._id, role: customer.role },
    config.jwt.secret,
    { expiresIn: '1h' },
);

const requestProductsRoute = (query = {}, token = '') => {
    const url = new URL(`http://127.0.0.1:${server.address().port}/api/me/products`);
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
    return fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
};

describe('GET /api/me/products category pagination', () => {
    it('returns all 23 PUBG products when the first global page contains none', async () => {
        const { customer } = await createCustomerWithGroup({ currency: 'USD' });
        const pubg = await Category.create({ name: 'PUBG', slug: 'pubg' });

        await Product.create([
            ...Array.from({ length: 101 }, (_, index) => product(`Alpha ${index}`, 'other-category')),
            ...Array.from({ length: 23 }, (_, index) => product(`PUBG UC ${index}`, pubg._id.toString())),
        ]);

        const { payload } = await callGetProducts(customer, {
            category: pubg.slug,
            limit: '100',
            page: '1',
        });

        expect(payload.pagination).toEqual({ page: 1, limit: 100, total: 23, pages: 1 });
        expect(payload.data).toHaveLength(23);
        expect(payload.data.every((item) => item.name.startsWith('PUBG UC'))).toBe(true);
    });

    it('recognizes category id, slug, English name, Arabic name, and compatibility id', async () => {
        const { customer } = await createCustomerWithGroup({ currency: 'USD' });
        const pubg = await Category.create({
            compatCategoryId: 742,
            name: 'PUBG',
            nameAr: 'ببجي',
            slug: 'pubg-mobile',
        });
        await Product.create(product('PUBG UC', pubg._id.toString()));

        for (const category of [pubg._id.toString(), pubg.slug, pubg.name, pubg.nameAr, String(pubg.compatCategoryId)]) {
            const { payload } = await callGetProducts(customer, { category });
            expect(payload.pagination.total).toBe(1);
            expect(payload.data.map((item) => item.name)).toEqual(['PUBG UC']);
        }
    });

    it('returns an empty page for an active category without products', async () => {
        const { customer } = await createCustomerWithGroup({ currency: 'USD' });
        const empty = await Category.create({ name: 'Empty category', slug: 'empty-category' });
        await Product.create(product('Elsewhere', 'elsewhere'));

        const { payload } = await callGetProducts(customer, { category: empty._id.toString() });

        expect(payload.data).toEqual([]);
        expect(payload.pagination).toEqual({ page: 1, limit: 20, total: 0, pages: 0 });
    });

    it('applies search within the selected category before pagination', async () => {
        const { customer } = await createCustomerWithGroup({ currency: 'USD' });
        const pubg = await Category.create({ name: 'PUBG', slug: 'pubg' });
        const mobile = await Category.create({ name: 'Mobile Legends', slug: 'mobile-legends' });
        await Product.create([
            ...Array.from({ length: 20 }, (_, index) => product(`PUBG UC ${String(index).padStart(3, '0')}`, pubg.slug)),
            product('PUBG UC late-match', pubg.slug),
            product('Mobile UC 60', mobile.slug),
        ]);

        const { payload } = await callGetProducts(customer, {
            category: pubg.slug,
            search: 'late-match',
        });

        expect(payload.pagination).toEqual({ page: 1, limit: 20, total: 1, pages: 1 });
        expect(payload.data.map((item) => item.name)).toEqual(['PUBG UC late-match']);
    });

    it('searches the established category title field before pagination', async () => {
        const { customer } = await createCustomerWithGroup({ currency: 'USD' });
        const pubg = await Category.create({ name: 'PUBG Mobile', slug: 'pubg-mobile' });
        await Product.create([
            product('UC 60', pubg.slug),
            product('UC 325', pubg.slug),
            product('Other', 'elsewhere'),
        ]);

        const { payload } = await callGetProducts(customer, {
            category: pubg.slug,
            search: 'PUBG Mobile',
            limit: '1',
            page: '2',
        });

        expect(payload.pagination).toEqual({ page: 2, limit: 1, total: 2, pages: 2 });
        expect(payload.data.map((item) => item.name)).toEqual(['UC 60']);
    });

    it('searches the customer-visible displayed price label, not the raw base price', async () => {
        const { customer } = await createCustomerWithGroup({ currency: 'USD' }, { percentage: 10 });
        const pubg = await Category.create({ name: 'PUBG', slug: 'pubg' });
        await Product.create([
            product('Ten base price', pubg.slug, { basePrice: '10' }),
            product('Twenty base price', pubg.slug, { basePrice: '20' }),
        ]);

        const customerPrice = await callGetProducts(customer, { category: pubg.slug, search: 'USD 11.00' });
        expect(customerPrice.payload.pagination.total).toBe(1);
        expect(customerPrice.payload.data.map((item) => item.name)).toEqual(['Ten base price']);
        expect(customerPrice.payload.data[0].displayPriceLabel).toBe('USD 11.00');

        const rawBasePrice = await callGetProducts(customer, { category: pubg.slug, search: '10' });
        expect(rawBasePrice.payload.pagination.total).toBe(0);
        expect(rawBasePrice.payload.data).toEqual([]);
    });

    it('preserves regex search behavior for non-category product callers', async () => {
        const { customer } = await createCustomerWithGroup({ currency: 'USD' });
        await Product.create([
            product('PUBG UC 60', 'pubg'),
            product('Mobile UC 60', 'mobile'),
        ]);

        const { payload } = await callGetProducts(customer, { search: '^PUBG' });

        expect(payload.pagination.total).toBe(1);
        expect(payload.data.map((item) => item.name)).toEqual(['PUBG UC 60']);
    });

    it('counts and pages within the selected category before applying skip', async () => {
        const { customer } = await createCustomerWithGroup({ currency: 'USD' });
        const pubg = await Category.create({ name: 'PUBG', slug: 'pubg' });
        await Product.create([
            product('PUBG A', pubg.slug),
            product('PUBG B', pubg.slug),
            product('PUBG C', pubg.slug),
            product('PUBG D', pubg.slug),
            product('PUBG E', pubg.slug),
            ...Array.from({ length: 10 }, (_, index) => product(`AAA unrelated ${index}`, 'unrelated')),
        ]);

        const firstPage = await callGetProducts(customer, { category: pubg._id.toString(), limit: '2', page: '1' });
        const thirdPage = await callGetProducts(customer, { category: pubg._id.toString(), limit: '2', page: '3' });

        expect(firstPage.payload.pagination).toEqual({ page: 1, limit: 2, total: 5, pages: 3 });
        expect(firstPage.payload.data.map((item) => item.name)).toEqual(['PUBG A', 'PUBG B']);
        expect(thirdPage.payload.pagination).toEqual({ page: 3, limit: 2, total: 5, pages: 3 });
        expect(thirdPage.payload.data.map((item) => item.name)).toEqual(['PUBG E']);
    });

    it('keeps customer visibility and FazerCards restrictions while switching categories', async () => {
        const { customer } = await createCustomerWithGroup({ currency: 'USD' });
        const pubg = await Category.create({ name: 'PUBG', slug: 'pubg' });
        const mobile = await Category.create({ name: 'Mobile Legends', slug: 'mobile-legends' });
        await Product.create([
            product('PUBG visible', pubg.slug),
            product('PUBG hidden', pubg.slug, { visibleInStore: false }),
            product('PUBG inactive', pubg.slug, { isActive: false }),
            product('PUBG Fazer disabled', pubg.slug, {
                customerPurchaseEnabled: false,
                providerCode: 'FAZER_CARDS',
                status: 'available',
            }),
            product('PUBG Fazer unavailable', pubg.slug, {
                customerPurchaseEnabled: true,
                providerCode: 'FAZER_CARDS',
                status: 'unavailable',
            }),
            product('Mobile visible', mobile.slug),
        ]);

        const pubgResult = await callGetProducts(customer, { category: pubg.slug });
        const mobileResult = await callGetProducts(customer, { category: mobile.slug });

        expect(pubgResult.payload.data.map((item) => item.name)).toEqual(['PUBG visible']);
        expect(mobileResult.payload.data.map((item) => item.name)).toEqual(['Mobile visible']);
    });

    it('uses a stable _id tie-breaker for equal-name products across pages', async () => {
        const { customer } = await createCustomerWithGroup({ currency: 'USD' });
        const pubg = await Category.create({ name: 'PUBG', slug: 'pubg' });
        const created = await Product.create([
            product('PUBG UC', pubg.slug),
            product('PUBG UC', pubg.slug),
            product('PUBG UC', pubg.slug),
            product('PUBG UC', pubg.slug),
        ]);
        const expectedIds = created.map((item) => item._id.toString()).sort();

        const firstPage = await callGetProducts(customer, { category: pubg.slug, limit: '2', page: '1' });
        const secondPage = await callGetProducts(customer, { category: pubg.slug, limit: '2', page: '2' });
        const actualIds = [...firstPage.payload.data, ...secondPage.payload.data]
            .map((item) => item._id.toString())
            .sort();

        expect(firstPage.payload.data.map((item) => item._id.toString())).toEqual(expectedIds.slice(0, 2));
        expect(secondPage.payload.data.map((item) => item._id.toString())).toEqual(expectedIds.slice(2));
        expect(actualIds).toEqual(expectedIds);
        expect(new Set(actualIds).size).toBe(4);
    });

    it('protects the category query with authentication and route validation', async () => {
        const unauthenticated = await requestProductsRoute({ category: 'pubg' });
        expect(unauthenticated.status).toBe(401);

        const { customer } = await createCustomerWithGroup({ currency: 'USD' });
        const invalid = await requestProductsRoute({ category: 'x'.repeat(101) }, customerToken(customer));
        expect(invalid.status).toBe(400);
    });

    it('serves successful customer and admin requests through the authenticated route', async () => {
        const { customer } = await createCustomerWithGroup({ currency: 'USD' }, { percentage: 10 });
        const admin = await createAdmin();
        const pubg = await Category.create({ name: 'PUBG', slug: 'pubg' });
        await Product.create([
            product('Visible PUBG', pubg.slug, { basePrice: '10' }),
            product('Hidden PUBG', pubg.slug, { visibleInStore: false }),
            product('Inactive PUBG', pubg.slug, { isActive: false }),
            product('Fazer disabled', pubg.slug, {
                providerCode: 'FAZER_CARDS',
                customerPurchaseEnabled: false,
                status: 'available',
            }),
            product('Fazer unavailable', pubg.slug, {
                providerCode: 'FAZER_CARDS',
                customerPurchaseEnabled: true,
                status: 'unavailable',
            }),
        ]);

        const customerResponse = await requestProductsRoute(
            { category: pubg.slug, limit: '1', page: '1' },
            customerToken(customer),
        );
        expect(customerResponse.status).toBe(200);
        const customerPayload = await customerResponse.json();
        expect(customerPayload.pagination).toEqual({ page: 1, limit: 1, total: 1, pages: 1 });
        expect(customerPayload.data).toHaveLength(1);
        expect(customerPayload.data[0].name).toBe('Visible PUBG');
        expect(customerPayload.data[0].groupPercentage).toBe(10);
        expect(customerPayload.data[0].displayPriceLabel).toBe('USD 11.00');

        const adminResponse = await requestProductsRoute(
            { category: pubg.slug, limit: '1', page: '1' },
            customerToken(admin),
        );
        expect(adminResponse.status).toBe(200);
        const adminPayload = await adminResponse.json();
        expect(adminPayload.pagination).toEqual({ page: 1, limit: 1, total: 1, pages: 1 });
        expect(adminPayload.data.map((item) => item.name)).toEqual(['Visible PUBG']);
    });
});
