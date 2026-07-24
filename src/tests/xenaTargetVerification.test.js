'use strict';

jest.mock('axios');

const mongoose = require('mongoose');
const axios = require('axios');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product } = require('../modules/products/product.model');
const adminProviderService = require('../modules/admin/admin.providers.service');
const xenaTargetService = require('../modules/providers/xena/xenaTarget.service');
const xenaService = require('../modules/providers/xena/xena.service');
const { XenaConnection } = require('../modules/providers/xena/xenaConnection.model');
const { validateBody, schemas } = require('../modules/admin/admin.validation');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
} = require('./testHelpers');

const TEST_KEY = Buffer.alloc(32, 29).toString('base64');
const adminId = new mongoose.Types.ObjectId();

const makeClient = () => ({
    request: jest.fn(),
});

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

const createXenaProduct = async () => {
    const provider = await createXenaProvider();
    const providerProduct = await ProviderProduct.create({
        provider: provider._id,
        externalProductId: 'xena-dynamic-recharge',
        rawName: 'Xena Dynamic Recharge (Any Amount)',
        rawPrice: '0.00001',
        minQty: 1,
        maxQty: 1000000,
        isActive: true,
    });
    const product = await Product.create({
        name: `Xena Product ${Date.now()} ${Math.random()}`,
        basePrice: '1',
        minQty: 1,
        maxQty: 1000000,
        isActive: true,
        executionType: 'automatic',
        provider: provider._id,
        providerProduct: providerProduct._id,
    });
    return { provider, providerProduct, product };
};

const connectXenaProvider = async (provider, connectionId = 'con_target') => {
    const state = await XenaConnection.create({
        provider: provider._id,
        status: 'connected',
    });
    state.setConnectionId(connectionId);
    await state.save();
    return state;
};

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
    axios.create.mockReset();
    await clearCollections();
});

describe('Xena target UID local validation', () => {
    it('valid targetUid string succeeds and preserves leading zeroes', async () => {
        const { provider, product } = await createXenaProduct();
        await connectXenaProvider(provider, 'con_valid');
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            data: { uid: '001234', nickname: 'Safe nickname', country: 'EG' },
            status: 200,
            headers: { 'x-request-id': 'req-target' },
        });

        const result = await xenaTargetService.verifyProductTargetUid({
            productId: product._id,
            targetUid: '001234',
        });

        expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'get',
            url: '/v1/connections/con_valid/users/001234',
        }));
        expect(result).toEqual({
            valid: true,
            targetUid: '001234',
            user: {
                uid: '001234',
                nickname: 'Safe nickname',
                avatar: null,
                country: 'EG',
            },
        });
        expect(result.targetUid).toBe('001234');
    });

    it('validation rejects invalid values without casting numbers', () => {
        expect(() => xenaTargetService.validateTargetUid('abc123')).toThrow(expect.objectContaining({ code: 'XENA_TARGET_INVALID' }));
        expect(() => xenaTargetService.validateTargetUid('12-34')).toThrow(expect.objectContaining({ code: 'XENA_TARGET_INVALID' }));
        expect(() => xenaTargetService.validateTargetUid('1'.repeat(51))).toThrow(expect.objectContaining({ code: 'XENA_TARGET_INVALID' }));
        expect(() => xenaTargetService.validateTargetUid(1234)).toThrow(expect.objectContaining({ code: 'XENA_TARGET_INVALID' }));
        expect(xenaTargetService.validateTargetUid(' 001234 ')).toBe('001234');
    });

    it('admin target validation is strict and does not coerce numbers to strings', () => {
        const middleware = validateBody(schemas.xenaTargetVerification);
        const req = { body: { targetUid: 1234 } };
        let caught = null;

        middleware(req, {}, (err) => { caught = err || null; });

        expect(caught).toMatchObject({ code: 'VALIDATION_ERROR' });
    });
});

describe('Xena target response normalization', () => {
    it.each([
        [{ valid: true, uid: '001234', nickname: 'Safe nickname' }],
        [{ uid: '001234', nickname: 'Safe nickname' }],
        [{ data: { valid: true, uid: '001234' } }],
        [{ data: { uid: '001234', nickname: 'Safe nickname' } }],
    ])('accepts response shape %#', (payload) => {
        const result = xenaService.normalizeTargetUserResponse(payload, '001234');

        expect(result.valid).toBe(true);
        expect(result.targetUid).toBe('001234');
        expect(result.user.uid).toBe('001234');
        expect(result.targetUid).not.toBe(1234);
    });

    it('rejects empty object, uid mismatch, and valid:false as invalid target', () => {
        for (const payload of [{}, { uid: '999' }, { valid: false, uid: '001234' }]) {
            expect(() => xenaService.normalizeTargetUserResponse(payload, '001234'))
                .toThrow(expect.objectContaining({ code: 'XENA_TARGET_INVALID' }));
        }
    });
});

describe('Xena target verification error mapping and safety', () => {
    it('maps 404 and valid:false to XENA_TARGET_INVALID', async () => {
        const { provider, product } = await createXenaProduct();
        await connectXenaProvider(provider);
        const client = makeClient();
        axios.create.mockReturnValue(client);

        client.request.mockRejectedValueOnce({
            response: { status: 404, data: { message: 'not found' }, headers: {} },
            message: 'not found',
        });
        await expect(xenaTargetService.verifyProductTargetUid({ productId: product._id, targetUid: '001234' }))
            .rejects.toMatchObject({ code: 'XENA_TARGET_INVALID' });

        client.request.mockResolvedValueOnce({
            data: { valid: false },
            status: 200,
            headers: {},
        });
        await expect(xenaTargetService.verifyProductTargetUid({ productId: product._id, targetUid: '001234' }))
            .rejects.toMatchObject({ code: 'XENA_TARGET_INVALID' });
    });

    it('maps 401/403 to auth or reconnect errors, not invalid UID', async () => {
        const { provider, product } = await createXenaProduct();
        await connectXenaProvider(provider);
        const client = makeClient();
        axios.create.mockReturnValue(client);

        for (const status of [401, 403]) {
            client.request.mockRejectedValueOnce({
                response: {
                    status,
                    data: { message: 'Authorization: Bearer digiteech-client-key failed' },
                    headers: {},
                },
                message: 'auth failed',
            });

            await expect(xenaTargetService.verifyProductTargetUid({ productId: product._id, targetUid: '001234' }))
                .rejects.toMatchObject({ code: 'XENA_PROVIDER_AUTH_FAILED' });
        }
    });

    it('maps 409 to XENA_REAUTHENTICATION_REQUIRED', async () => {
        const { provider, product } = await createXenaProduct();
        await connectXenaProvider(provider);
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockRejectedValueOnce({
            response: { status: 409, data: { code: 'REAUTHENTICATION_REQUIRED' }, headers: {} },
            message: 'reauth required',
        });

        await expect(xenaTargetService.verifyProductTargetUid({ productId: product._id, targetUid: '001234' }))
            .rejects.toMatchObject({ code: 'XENA_REAUTHENTICATION_REQUIRED' });
    });

    it('maps 429 to XENA_RATE_LIMITED and timeout/5xx to XENA_VERIFICATION_UNAVAILABLE', async () => {
        const { provider, product } = await createXenaProduct();
        await connectXenaProvider(provider);
        const client = makeClient();
        axios.create.mockReturnValue(client);

        client.request.mockRejectedValueOnce({
            response: { status: 429, data: { code: 'RATE_LIMITED' }, headers: {} },
            message: 'rate limited',
        });
        await expect(xenaTargetService.verifyProductTargetUid({ productId: product._id, targetUid: '001234' }))
            .rejects.toMatchObject({ code: 'XENA_RATE_LIMITED' });

        client.request.mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 20000ms exceeded' });
        await expect(xenaTargetService.verifyProductTargetUid({ productId: product._id, targetUid: '001234' }))
            .rejects.toMatchObject({ code: 'XENA_VERIFICATION_UNAVAILABLE' });

        client.request.mockRejectedValueOnce({
            response: { status: 500, data: { message: 'temporary failure' }, headers: {} },
            message: 'server error',
        });
        await expect(xenaTargetService.verifyProductTargetUid({ productId: product._id, targetUid: '001234' }))
            .rejects.toMatchObject({ code: 'XENA_VERIFICATION_UNAVAILABLE' });
    });

    it('missing or unusable connection state maps to connection errors', async () => {
        const { provider, product } = await createXenaProduct();

        await expect(xenaTargetService.verifyProductTargetUid({ productId: product._id, targetUid: '001234' }))
            .rejects.toMatchObject({ code: 'XENA_CONNECTION_REQUIRED' });

        const state = await XenaConnection.create({
            provider: provider._id,
            status: 'reauthentication_required',
        });
        state.setConnectionId('con_reauth');
        await state.save();

        await expect(xenaTargetService.verifyProductTargetUid({ productId: product._id, targetUid: '001234' }))
            .rejects.toMatchObject({ code: 'XENA_REAUTHENTICATION_REQUIRED' });
    });

    it('safe response and stored errors do not expose connectionId, API key, or auth headers', async () => {
        const { provider, product } = await createXenaProduct();
        await connectXenaProvider(provider, 'con_secret_target');
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockRejectedValueOnce({
            response: {
                status: 401,
                data: { message: 'Authorization: Bearer digiteech-client-key failed for con_secret_target' },
                headers: {},
            },
            message: 'auth failed',
        });

        await expect(xenaTargetService.verifyProductTargetUid({ productId: product._id, targetUid: '001234' }))
            .rejects.toMatchObject({ code: 'XENA_PROVIDER_AUTH_FAILED' });

        const state = await XenaConnection.findOne({ provider: provider._id }).lean();
        const payload = json(state);
        expect(payload).not.toContain('digiteech-client-key');
        expect(payload).not.toContain('con_secret_target');
        expect(payload).not.toContain('Authorization');
    });
});

describe('Xena product/provider resolution', () => {
    it('rejects non-Xena and unlinked products safely', async () => {
        const nonXenaProvider = await createNonXenaProvider();
        const nonXenaProviderProduct = await ProviderProduct.create({
            provider: nonXenaProvider._id,
            externalProductId: 'regular-product',
            rawName: 'Regular Product',
            rawPrice: '1',
            minQty: 1,
            maxQty: 10,
            isActive: true,
        });
        const nonXenaProduct = await Product.create({
            name: `Regular Product ${Date.now()}`,
            basePrice: '1',
            minQty: 1,
            maxQty: 10,
            provider: nonXenaProvider._id,
            providerProduct: nonXenaProviderProduct._id,
        });
        const manualProduct = await Product.create({
            name: `Manual Product ${Date.now()}`,
            basePrice: '1',
            minQty: 1,
            maxQty: 10,
        });

        await expect(xenaTargetService.verifyProductTargetUid({ productId: nonXenaProduct._id, targetUid: '001234' }))
            .rejects.toMatchObject({ code: 'XENA_PROVIDER_REQUIRED' });
        await expect(xenaTargetService.verifyProductTargetUid({ productId: manualProduct._id, targetUid: '001234' }))
            .rejects.toMatchObject({ code: 'XENA_PROVIDER_REQUIRED' });
    });

    it('admin provider verification rejects non-Xena providers', async () => {
        const provider = await createNonXenaProvider();

        await expect(xenaTargetService.verifyProviderTargetUid({ provider: provider._id, targetUid: '001234' }))
            .rejects.toMatchObject({ code: 'XENA_PROVIDER_REQUIRED' });
    });
});
