'use strict';

const express = require('express');

const app = require('../app');
const adminUsersService = require('../modules/admin/admin.users.service');
const { User } = require('../modules/users/user.model');
const { Product } = require('../modules/products/product.model');
const { Category } = require('../modules/categories/category.model');
const { Order, ORDER_STATUS } = require('../modules/orders/order.model');
const { Setting } = require('../modules/admin/setting.model');
const { createClientCompatLimiter } = require('../modules/clientCompat/clientCompat.rateLimiter');
const { mapStatus } = require('../modules/clientCompat/clientCompat.mappers');
const { mapErrorToCompat } = require('../modules/clientCompat/clientCompat.errors');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createAdmin,
    createCustomer,
    createGroup,
    createProduct,
} = require('./testHelpers');

let server;
let canonicalBaseUrl;
let aliasBaseUrl;
let legacyBaseUrl;

beforeAll(async () => {
    await connectTestDB();
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    canonicalBaseUrl = `http://127.0.0.1:${port}/client/api`;
    aliasBaseUrl = `http://127.0.0.1:${port}/api/client/api`;
    legacyBaseUrl = `http://127.0.0.1:${port}/api/client`;
});

afterAll(async () => {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

const setupApiUser = async ({ percentage = 0, walletBalance = 500 } = {}) => {
    const group = await createGroup({ name: `Compat-${Date.now()}-${Math.random()}`, percentage });
    const admin = await createAdmin({ groupId: group._id });
    const customer = await createCustomer({ groupId: group._id, walletBalance, isApiEnabled: false });
    const access = await adminUsersService.enableUserApiAccess(customer._id, admin._id);
    return { group, admin, customer, apiKey: access.apiKey };
};

const apiFetch = (path, apiKey, options = {}, baseUrl = canonicalBaseUrl) => fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'api-token': apiKey, ...(options.headers || {}) },
});

const availableProduct = (overrides = {}) => createProduct({
    name: `Canonical product ${Date.now()}-${Math.random()}`,
    basePrice: 10,
    finalPrice: 10,
    minQty: 1,
    maxQty: 5,
    visibleInStore: true,
    customerPurchaseEnabled: true,
    isAvailableForApi: true,
    status: 'available',
    executionType: 'manual',
    ...overrides,
});

describe('canonical client compatibility API', () => {
    it('mounts both canonical bases, preserves legacy /api/client, and accepts each token alias', async () => {
        const { apiKey } = await setupApiUser();

        const canonical = await apiFetch('/profile', apiKey);
        expect(canonical.status).toBe(200);
        expect((await canonical.json()).balance).toBe('500');

        const alias = await fetch(`${aliasBaseUrl}/profile`, { headers: { 'x-api-key': apiKey } });
        expect(alias.status).toBe(200);

        const bearer = await fetch(`${canonicalBaseUrl}/profile`, { headers: { Authorization: `Bearer ${apiKey}` } });
        expect(bearer.status).toBe(200);

        const legacy = await fetch(`${legacyBaseUrl}/profile`, { headers: { 'x-api-key': apiKey } });
        expect(legacy.status).toBe(200);
    });

    it('uses canonical auth and IP error envelopes without changing legacy auth', async () => {
        const { customer, admin, apiKey } = await setupApiUser();

        const missing = await fetch(`${canonicalBaseUrl}/profile`);
        expect((await missing.json()).code).toBe(120);

        const invalid = await apiFetch('/profile', 'not-a-real-token');
        expect((await invalid.json()).code).toBe(121);

        await adminUsersService.disableUserApiAccess(customer._id, admin._id);
        const disabled = await apiFetch('/profile', apiKey);
        expect((await disabled.json()).code).toBe(122);

        const reenabled = await adminUsersService.enableUserApiAccess(customer._id, admin._id);
        await User.updateOne({ _id: customer._id }, { $set: { whitelistIps: ['203.0.113.7'] } });
        const blocked = await apiFetch('/profile', reenabled.apiKey);
        expect((await blocked.json()).code).toBe(123);

        await User.updateOne({ _id: customer._id }, { $set: { whitelistIps: ['127.0.0.1'] } });
        const allowed = await apiFetch('/profile', reenabled.apiKey);
        expect(allowed.status).toBe(200);
    });

    it('assigns numeric IDs lazily, serializes USD catalog data, and maps nested content', async () => {
        const { apiKey } = await setupApiUser({ percentage: 20 });
        const root = await Category.create({ name: 'Root category' });
        const child = await Category.create({ name: 'Child category', parentCategory: root._id });
        const fieldProduct = await availableProduct({
            name: 'USD Dynamic Product',
            category: String(child._id),
            dynamicFields: [{ name: 'player_id', label: 'Player ID', type: 'text', required: true, isActive: true }],
        });
        const formalFieldProduct = await availableProduct({
            name: 'Formal field product',
            orderFields: [{ id: 'field_server', key: 'server', label: 'Server', type: 'select', required: true, options: ['EU'], isActive: true }],
        });
        const fixedQuantityProduct = await availableProduct({ name: 'Fixed quantity product', minQty: 5, maxQty: 5 });

        const rawCategoryId = new (require('mongoose').Types.ObjectId)();
        const rawProductId = new (require('mongoose').Types.ObjectId)();
        await Category.collection.insertOne({ _id: rawCategoryId, name: 'Legacy category', isActive: true, sortOrder: 0 });
        await Product.collection.insertOne({
            _id: rawProductId,
            name: 'Legacy product',
            basePrice: '5',
            finalPrice: '5',
            minQty: 1,
            maxQty: 1,
            isActive: true,
            visibleInStore: true,
            customerPurchaseEnabled: true,
            isAvailableForApi: true,
            status: 'available',
            executionType: 'manual',
            deletedAt: null,
        });

        const response = await apiFetch('/products', apiKey);
        const products = await response.json();
        expect(response.status).toBe(200);
        const product = products.find((item) => item.name === fieldProduct.name);
        expect(product.id).toBe(fieldProduct.compatProductId);
        expect(typeof product.id).toBe('number');
        expect(product.price).toBe(12);
        expect(product.currency).toBe('USD');
        expect(product.params).toEqual(['Player ID']);
        expect(product.fields).toEqual([{ key: 'player_id', label: 'Player ID', type: 'text', required: true, options: [] }]);
        expect(product.parent_id).toBe(child.compatCategoryId);
        expect(JSON.stringify(products)).not.toContain(fieldProduct._id.toString());
        expect((await Product.findById(rawProductId).lean()).compatProductId).toBeDefined();
        expect((await Category.findById(rawCategoryId).lean()).compatCategoryId).toBeDefined();

        const formal = products.find((item) => item.name === formalFieldProduct.name);
        expect(formal.fields[0]).toMatchObject({ key: 'server', label: 'Server', type: 'select' });
        const fixed = products.find((item) => item.name === fixedQuantityProduct.name);
        expect(fixed).toMatchObject({ qty_values: ['5'], product_type: 'package', min: 5, max: 5 });

        const idsOnly = await apiFetch(`/products?products_id=${fieldProduct.compatProductId}` , apiKey);
        expect((await idsOnly.json()).map((item) => item.id)).toEqual([fieldProduct.compatProductId]);
        const base = await apiFetch('/products?base=1', apiKey);
        expect((await base.json())[0].fields).toBeUndefined();

        const rootContent = await apiFetch('/content/0', apiKey);
        const rootBody = await rootContent.json();
        expect(rootBody.data.categories.map((item) => item.id)).toContain(root.compatCategoryId);
        expect(rootBody.data.products.map((item) => item.name)).toContain(formalFieldProduct.name);
        const childContent = await apiFetch(`/content/${root.compatCategoryId}`, apiKey);
        const childBody = await childContent.json();
        expect(childBody.data.categories.map((item) => item.id)).toContain(child.compatCategoryId);
        const nestedContent = await apiFetch(`/content/${child.compatCategoryId}`, apiKey);
        expect((await nestedContent.json()).data.products.map((item) => item.id)).toContain(fieldProduct.compatProductId);
    });

    it('translates canonical orders through the existing engine, remains idempotent, and supports every check reference', async () => {
        const { customer, apiKey } = await setupApiUser({ walletBalance: 100 });
        const product = await availableProduct({
            orderFields: [{ id: 'field_player', key: 'player_id', label: 'Player ID', type: 'text', required: true, isActive: true }],
        });
        const request = {
            product_id: product.compatProductId,
            qty: 1,
            order_uuid: 'canonical-order-1',
            params: { player_id: 'player-123' },
            price: 0,
            currency: 'EUR',
        };
        const firstResponse = await apiFetch('/orders', apiKey, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
        });
        const first = await firstResponse.json();
        expect(firstResponse.status).toBe(200);
        expect(first.status).toBe('OK');
        expect(first.data.order_id).toMatch(/^ID_/);
        expect(first.data.data).toEqual({ player_id: 'player-123' });

        const secondResponse = await apiFetch('/orders', apiKey, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
        });
        const second = await secondResponse.json();
        expect(second.data.order_id).toBe(first.data.order_id);
        expect(await Order.countDocuments({ userId: customer._id, idempotencyKey: 'canonical-order-1' })).toBe(1);

        const stored = await Order.findOne({ userId: customer._id, idempotencyKey: 'canonical-order-1' });
        expect(stored.source).toBe('client_api');
        expect(stored.compatOrderId).toBe(first.data.order_id);
        await Order.updateOne({ _id: stored._id }, { $set: { status: ORDER_STATUS.COMPLETED }, $unset: { compatOrderId: 1 } });

        const byOrderNumber = await apiFetch(`/check?orders=${stored.orderNumber}`, apiKey);
        const byOrderNumberBody = await byOrderNumber.json();
        expect(byOrderNumberBody.data[0].status).toBe('accept');
        expect(byOrderNumberBody.data[0].order_id).toMatch(/^ID_/);
        const byUuid = await apiFetch('/check?orders=canonical-order-1&uuid=1', apiKey);
        expect((await byUuid.json()).data[0].order_uuid).toBe('canonical-order-1');
        const uuids = await apiFetch('/check?uuids=canonical-order-1', apiKey);
        expect((await uuids.json()).data).toHaveLength(1);
    });

    it('validates compatibility input, blocks only canonical placement in maintenance, and supports legacy newOrder', async () => {
        const { apiKey } = await setupApiUser({ walletBalance: 100 });
        const product = await availableProduct({
            dynamicFields: [{ name: 'player_id', label: 'Player ID', type: 'text', required: true, isActive: true }],
        });

        const badInput = await apiFetch('/orders', apiKey, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ product_id: product.compatProductId, qty: 1, order_uuid: 'bad', params: { internal: 'x' } }),
        });
        expect((await badInput.json()).code).toBe(124);

        const legacy = await apiFetch(`/newOrder/${product.compatProductId}/params?qty=1&order_uuid=legacy-order&player_id=ok`, apiKey);
        expect((await legacy.json()).status).toBe('OK');

        await Setting.updateOne(
            { key: 'maintenanceMode' },
            { $set: { key: 'maintenanceMode', value: true, description: 'test' } },
            { upsert: true }
        );
        expect((await apiFetch('/profile', apiKey)).status).toBe(200);
        const blocked = await apiFetch('/orders', apiKey, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ product_id: product.compatProductId, qty: 1, order_uuid: 'maintenance', params: { player_id: 'ok' } }),
        });
        expect((await blocked.json()).code).toBe(130);
    });

    it('uses canonical rate-limit envelope', async () => {
        const rateApp = express();
        rateApp.use(createClientCompatLimiter({ max: 1, windowMs: 60_000 }));
        rateApp.get('/', (_req, res) => res.json({ ok: true }));
        const rateServer = rateApp.listen(0);
        await new Promise((resolve) => rateServer.once('listening', resolve));
        try {
            const { port } = rateServer.address();
            expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
            const limited = await fetch(`http://127.0.0.1:${port}/`);
            expect(limited.status).toBe(429);
            expect((await limited.json()).code).toBe(111);
        } finally {
            await new Promise((resolve, reject) => rateServer.close((err) => (err ? reject(err) : resolve())));
        }
    });

    it('maps every internal order state to the canonical status vocabulary', () => {
        expect(mapStatus(ORDER_STATUS.COMPLETED)).toBe('accept');
        expect(mapStatus(ORDER_STATUS.FAILED)).toBe('reject');
        expect(mapStatus(ORDER_STATUS.CANCELED)).toBe('reject');
        expect(mapStatus(ORDER_STATUS.PENDING)).toBe('wait');
        expect(mapStatus(ORDER_STATUS.PROCESSING)).toBe('wait');
        expect(mapStatus(ORDER_STATUS.MANUAL_REVIEW)).toBe('wait');
        expect(mapStatus(ORDER_STATUS.PARTIAL)).toBe('wait');
    });

    it('maps existing provider-unavailable business codes to canonical unavailable', () => {
        for (const code of [
            'FAZERCARDS_CUSTOMER_PURCHASE_DISABLED',
            'FAMILY_DISABLED_UNAVAILABLE',
            'CUSTOMER_PURCHASE_NOT_ALLOWED',
        ]) {
            expect(mapErrorToCompat({ code, message: 'Unavailable', isOperational: true })).toMatchObject({ code: 110 });
        }
    });
});
