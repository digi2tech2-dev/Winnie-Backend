'use strict';

const app = require('../app');
const jwt = require('jsonwebtoken');
const config = require('../config/config');
const adminUsersService = require('../modules/admin/admin.users.service');
const { Order } = require('../modules/orders/order.model');
const { User, USER_STATUS } = require('../modules/users/user.model');
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
let baseUrl;

beforeAll(async () => {
    await connectTestDB();
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}/api/client`;
});

afterAll(async () => {
    await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

const setupEnabledApiUser = async (customerOverrides = {}) => {
    const group = await createGroup({ name: `ClientApi-${Date.now()}`, percentage: 0 });
    const admin = await createAdmin({ groupId: group._id });
    const customer = await createCustomer({
        groupId: group._id,
        walletBalance: 500,
        isApiEnabled: false,
        ...customerOverrides,
    });
    const access = await adminUsersService.enableUserApiAccess(customer._id, admin._id);
    return { admin, customer, group, apiKey: access.apiKey };
};

const apiFetch = (path, apiKey, options = {}) => fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
        'X-API-Key': apiKey,
        ...(options.headers || {}),
    },
});

const tokenFor = (user) => jwt.sign({ id: user._id, role: user.role }, config.jwt.secret, { expiresIn: '1h' });

describe('client API access hardening', () => {
    it('accepts X-API-Key and Authorization Bearer for hashed keys', async () => {
        const { customer, apiKey } = await setupEnabledApiUser();

        const xKeyResponse = await apiFetch('/profile', apiKey);
        const xKeyBody = await xKeyResponse.json();
        expect(xKeyResponse.status).toBe(200);
        expect(xKeyBody.email).toBe(customer.email);

        const bearerResponse = await fetch(`${baseUrl}/profile`, {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        expect(bearerResponse.status).toBe(200);

        const legacyHeaderResponse = await fetch(`${baseUrl}/profile`, {
            headers: { 'api-token': apiKey },
        });
        expect(legacyHeaderResponse.status).toBe(200);
    });

    it('/api/me returns safe API access metadata only', async () => {
        const { customer, apiKey } = await setupEnabledApiUser();

        const response = await fetch(`${baseUrl.replace('/client', '')}/me`, {
            headers: { Authorization: `Bearer ${tokenFor(customer)}` },
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.apiAccessEnabled).toBe(true);
        expect(body.data.hasApiKey).toBe(true);
        expect(body.data.apiKeyPrefix).toBe('winnie');
        expect(body.data.apiKeyHash).toBeUndefined();
        expect(body.data.apiToken).toBeUndefined();
        expect(JSON.stringify(body)).not.toContain(apiKey);
    });

    it('rejects invalid, revoked, disabled, blocked, and rejected users', async () => {
        const { customer, admin, apiKey } = await setupEnabledApiUser();

        expect((await apiFetch('/profile', 'not-a-real-key')).status).toBe(401);

        await adminUsersService.disableUserApiAccess(customer._id, admin._id);
        expect([401, 403]).toContain((await apiFetch('/profile', apiKey)).status);

        const second = await adminUsersService.enableUserApiAccess(customer._id, admin._id);
        await User.updateOne({ _id: customer._id }, { $set: { blockedAt: new Date() } });
        expect((await apiFetch('/profile', second.apiKey)).status).toBe(403);

        await User.updateOne(
            { _id: customer._id },
            { $set: { blockedAt: null, status: USER_STATUS.REJECTED } }
        );
        expect((await apiFetch('/profile', second.apiKey)).status).toBe(403);
    });

    it('returns only customer-safe catalog products and no provider internals', async () => {
        const { apiKey } = await setupEnabledApiUser();
        const visible = await createProduct({
            name: 'Visible API Product',
            basePrice: 5,
            finalPrice: 5,
            visibleInStore: true,
            customerPurchaseEnabled: true,
            isAvailableForApi: true,
            status: 'available',
            providerPrice: '1.00',
            providerOrderId: 'provider-secret',
        });
        await createProduct({
            name: 'Hidden Product',
            visibleInStore: false,
            customerPurchaseEnabled: true,
            isAvailableForApi: true,
            status: 'available',
        });
        await createProduct({
            name: 'Not Purchasable Product',
            visibleInStore: true,
            customerPurchaseEnabled: false,
            isAvailableForApi: true,
            status: 'available',
        });

        const response = await apiFetch('/products', apiKey);
        const products = await response.json();

        expect(response.status).toBe(200);
        expect(products.map((item) => item.id)).toEqual([visible._id.toString()]);
        expect(products[0].providerPrice).toBeUndefined();
        expect(products[0].providerOrderId).toBeUndefined();
    });

    it('creates manual orders with Idempotency-Key once and scopes status to the API user', async () => {
        const { customer, apiKey } = await setupEnabledApiUser();
        const product = await createProduct({
            name: 'Manual API Product',
            basePrice: 10,
            finalPrice: 10,
            minQty: 1,
            maxQty: 5,
            visibleInStore: true,
            customerPurchaseEnabled: true,
            isAvailableForApi: true,
            status: 'available',
            executionType: 'manual',
        });

        const body = JSON.stringify({ productId: product._id.toString(), qty: 1 });
        const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'external-order-1' };

        const firstResponse = await apiFetch('/orders', apiKey, { method: 'POST', headers, body });
        const first = await firstResponse.json();
        const secondResponse = await apiFetch('/orders', apiKey, { method: 'POST', headers, body });
        const second = await secondResponse.json();

        expect(firstResponse.status).toBe(201);
        expect(secondResponse.status).toBe(200);
        expect(second.order_id).toBe(first.order_id);
        expect(await Order.countDocuments({ userId: customer._id, idempotencyKey: 'external-order-1' })).toBe(1);

        const stored = await Order.findById(first.order_id).lean();
        expect(stored.source).toBe('client_api');
        expect(stored.externalOrderId).toBe('external-order-1');
        expect(stored.apiKeyPrefix).toBe('winnie');

        const statusResponse = await apiFetch(`/check?orders=${encodeURIComponent(first.order_id)}`, apiKey);
        const statuses = await statusResponse.json();
        expect(statusResponse.status).toBe(200);
        expect(statuses).toHaveLength(1);
        expect(statuses[0].order_id).toBe(first.order_id);
        expect(statuses[0].providerOrderId).toBeUndefined();
    });
});
