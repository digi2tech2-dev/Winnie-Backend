'use strict';

// This suite starts the Express app only on an ephemeral loopback port and
// uses Jest's MongoMemoryReplSet from globalSetup.  It never creates an
// external listener or contacts a supplier.
process.env.FAZERCARDS_ENABLED = 'true';
process.env.FAZERCARDS_REAL_ORDERS_ENABLED = 'false';

const jwt = require('jsonwebtoken');
const app = require('../app');
const config = require('../config/config');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct, FULFILLMENT_MODES } = require('../modules/providers/providerProduct.model');
const { Product, PRODUCT_STATUSES } = require('../modules/products/product.model');
const { PROVIDER_CODES } = require('../modules/providers/provider.constants');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createAdmin,
    createGroup,
} = require('./testHelpers');

let server;
let baseUrl;

const tokenFor = (user) => jwt.sign({ id: user._id, role: user.role }, config.jwt.secret, { expiresIn: '1h' });

const request = async (path, { method = 'GET', token, body } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            authorization: `Bearer ${token}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { response, body: await response.json() };
};

const createFixture = async ({ sourceAvailability = 'AVAILABLE', fazerCards = true } = {}) => {
    if (!fazerCards) {
        return {
            providerProduct: null,
            product: await Product.create({
                name: 'Generic route fixture', basePrice: '2', finalPrice: '2', minQty: 1, maxQty: 1,
                isActive: true, visibleInStore: true, status: PRODUCT_STATUSES.AVAILABLE,
                customerPurchaseEnabled: true, executionType: 'manual',
            }),
        };
    }
    const provider = await Provider.create({
        name: `Route provider ${Date.now()}-${Math.random()}`,
        slug: `route-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        baseUrl: 'https://api.example.test',
        isActive: true,
    });
    const providerProduct = await ProviderProduct.create({
        provider: provider._id,
        providerCode: provider.providerCode,
        externalProductId: `FAZER_GIFTCARD:route:${Date.now()}-${Math.random()}`,
        rawName: 'Route test product', rawPrice: '1', costPrice: '1',
        category: 'route', offerId: 'one', familyKey: 'GIFTCARDS',
        fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY, minQty: 1, maxQty: 1,
        isActive: true, available: true, isSupported: true, isBlocked: false,
        executionBlocked: false, sourceAvailability,
        rawPayload: { family: 'GIFTCARDS', category: { category_id: 'route' }, offer: { card_id: 'one', price_usd: '1' } },
    });
    const unavailable = ['MISSING_CONFIRMED', 'EXPLICITLY_UNAVAILABLE'].includes(sourceAvailability);
    const product = await Product.create({
        name: 'Route fixture', basePrice: '2', finalPrice: '2', minQty: 1, maxQty: 1,
        provider: provider._id, providerProduct: providerProduct._id,
        providerCode: provider.providerCode, familyKey: providerProduct.familyKey,
        fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
        isActive: !unavailable, visibleInStore: !unavailable,
        status: unavailable ? PRODUCT_STATUSES.UNAVAILABLE : PRODUCT_STATUSES.AVAILABLE,
        customerPurchaseEnabled: !unavailable,
        executionType: 'manual', providerExecutionMode: 'MANUAL_FULFILLMENT',
        providerExecutionEnabled: false, providerExecutionBlocked: unavailable,
        providerBlockReason: unavailable ? 'FAZERCARDS_SOURCE_UNAVAILABLE' : null,
    });
    return { providerProduct, product };
};

beforeAll(async () => {
    await connectTestDB();
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});
afterEach(clearCollections);
afterAll(async () => {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await disconnectTestDB();
});

describe('FazerCards launch route authorization and source safety', () => {
    it('requires an explicit supplier-management grant for launch controls while ordinary metadata remains editable', async () => {
        const group = await createGroup({ name: `route-group-${Date.now()}` });
        const limited = await createAdmin({ groupId: group._id, permissions: ['products.manage'] });
        const { product } = await createFixture();
        const token = tokenFor(limited);

        const metadata = await request(`/admin/products/${product._id}`, { method: 'PATCH', token, body: { name: 'Permitted rename' } });
        expect(metadata.response.status).toBe(200);
        expect((await Product.findById(product._id)).name).toBe('Permitted rename');

        const ordinaryControl = await request(`/admin/products/${product._id}`, { method: 'PATCH', token, body: { providerExecutionEnabled: true } });
        expect(ordinaryControl.response.status).toBe(422);
        expect(ordinaryControl.body.code).toBe('FAZERCARDS_LAUNCH_OPS_REQUIRED');

        const launch = await request(`/admin/providers/fazercards/products/${product._id}/launch`, {
            method: 'POST', token, body: { providerExecutionMode: 'MANUAL_FULFILLMENT' },
        });
        expect(launch.response.status).toBe(403);
    });

    it('allows explicitly authorized single and bulk launch operations and returns per-product results', async () => {
        const group = await createGroup({ name: `route-authorized-${Date.now()}` });
        const admin = await createAdmin({ groupId: group._id, permissions: ['products.manage', 'suppliers.manage'] });
        const first = await createFixture();
        const second = await createFixture();
        const token = tokenFor(admin);
        const single = await request(`/admin/providers/fazercards/products/${first.product._id}/launch`, {
            method: 'POST', token,
            body: { customerPurchaseEnabled: true, isActive: true, visibleInStore: true, status: 'available', providerExecutionMode: 'MANUAL_FULFILLMENT' },
        });
        expect(single.response.status).toBe(200);
        expect(single.body.data.result.ok).toBe(true);

        const bulk = await request('/admin/providers/fazercards/products/bulk-update-launch', {
            method: 'POST', token,
            body: { productIds: [second.product._id.toString()], customerPurchaseEnabled: true, isActive: true, visibleInStore: true, status: 'available', providerExecutionMode: 'MANUAL_FULFILLMENT' },
        });
        expect(bulk.response.status).toBe(200);
        expect(bulk.body.data.results).toEqual([expect.objectContaining({ productId: second.product._id.toString(), ok: true })]);
    });

    it.each(['MISSING_CONFIRMED', 'EXPLICITLY_UNAVAILABLE'])('does not let PATCH or Launch Ops re-expose %s', async (sourceAvailability) => {
        const group = await createGroup({ name: `route-source-${Date.now()}-${sourceAvailability}` });
        const admin = await createAdmin({ groupId: group._id, permissions: ['products.manage', 'suppliers.manage'] });
        const { product } = await createFixture({ sourceAvailability });
        const token = tokenFor(admin);
        const patch = await request(`/admin/products/${product._id}`, {
            method: 'PATCH', token, body: { isActive: true, visibleInStore: true, status: 'available', customerPurchaseEnabled: true },
        });
        expect(patch.response.status).toBe(422);
        expect(patch.body.code).toBe('FAZERCARDS_SOURCE_UNAVAILABLE_LOCKED');
        const launch = await request(`/admin/providers/fazercards/products/${product._id}/launch`, {
            method: 'POST', token,
            body: { isActive: true, visibleInStore: true, status: 'available', customerPurchaseEnabled: true, providerExecutionMode: 'MANUAL_FULFILLMENT' },
        });
        expect(launch.response.status).toBe(422);
        expect(launch.body.code).toBe('FAZERCARDS_SOURCE_UNAVAILABLE_LOCKED');
        const persisted = await Product.findById(product._id);
        expect(persisted.customerPurchaseEnabled).toBe(false);
        expect(persisted.providerExecutionBlocked).toBe(true);
    });

    it('keeps generic provider product edits compatible', async () => {
        const group = await createGroup({ name: `route-generic-${Date.now()}` });
        const admin = await createAdmin({ groupId: group._id, permissions: ['products.manage'] });
        const { product } = await createFixture({ fazerCards: false });
        const result = await request(`/admin/products/${product._id}`, { method: 'PATCH', token: tokenFor(admin), body: { name: 'Generic product rename' } });
        expect(result.response.status).toBe(200);
        expect((await Product.findById(product._id)).name).toBe('Generic product rename');
    });
});
