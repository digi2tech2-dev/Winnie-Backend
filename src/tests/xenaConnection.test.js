'use strict';

jest.mock('axios');

const mongoose = require('mongoose');
const axios = require('axios');
const { Provider } = require('../modules/providers/provider.model');
const adminProviderService = require('../modules/admin/admin.providers.service');
const xenaService = require('../modules/providers/xena/xena.service');
const { XenaConnection } = require('../modules/providers/xena/xenaConnection.model');
const { getProviderAdapter } = require('../modules/providers/adapters/adapter.factory');
const {
    decryptSecret,
    isEncryptedSecret,
} = require('../shared/utils/secretEncryption');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
} = require('./testHelpers');

const TEST_KEY = Buffer.alloc(32, 17).toString('base64');
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

const responseJson = (value) => JSON.stringify(value);

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

describe('Xena provider credentials and adapter registration', () => {
    it('stores the Xena API key encrypted through the provider credentials path', async () => {
        const provider = await createXenaProvider();
        const stored = await Provider.findById(provider._id).lean();

        expect(stored.authType).toBe('BEARER_TOKEN');
        expect(stored.apiToken).toMatch(/^enc:v1:/);
        expect(stored.apiToken).not.toContain('digiteech-client-key');
        expect(decryptSecret(stored.apiToken)).toBe('digiteech-client-key');
        expect(responseJson(provider.toJSON())).not.toContain('digiteech-client-key');
    });

    it('preserves the old encrypted Xena API key when update sends a blank credential', async () => {
        const provider = await createXenaProvider();
        const before = await Provider.findById(provider._id).lean();

        await adminProviderService.updateProvider(provider._id, { apiToken: '' }, adminId);
        const after = await Provider.findById(provider._id).lean();

        expect(after.apiToken).toBe(before.apiToken);
        expect(decryptSecret(after.apiToken)).toBe('digiteech-client-key');
    });

    it('registers Xena without falling back to the mock adapter', async () => {
        const provider = await createXenaProvider();
        const adapter = getProviderAdapter(provider, { strict: true });

        expect(adapter.constructor.name).toBe('XenaRechargeAdapter');
        await expect(adapter.placeOrder({})).rejects.toMatchObject({
            code: 'XENA_RECHARGE_NOT_IMPLEMENTED',
        });
    });
});

describe('Xena challenge and verify flow', () => {
    it('challenge without existing connectionId does not send connectionId and stores the returned id encrypted', async () => {
        const provider = await createXenaProvider();
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            data: {
                connectionId: 'con_first',
                status: 'verification_required',
                expiresAt: '2026-07-25T10:00:00.000Z',
            },
            status: 200,
            headers: { 'x-request-id': 'req-1' },
        });

        const result = await xenaService.challengeConnection({
            provider: provider._id,
            displayName: 'Main Agency',
            username: 'agency@example.com',
            password: 'agency-password',
        });

        expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'post',
            url: '/v1/connections/challenge',
            data: expect.not.objectContaining({ connectionId: expect.anything() }),
        }));
        expect(result).toMatchObject({
            status: 'verification_required',
            displayName: 'Main Agency',
            maskedUsername: 'ag***@example.com',
        });
        expect(responseJson(result)).not.toContain('con_first');
        expect(responseJson(result)).not.toContain('agency-password');

        const state = await XenaConnection.findOne({ provider: provider._id }).select('+encryptedConnectionId');
        expect(state.encryptedConnectionId).toMatch(/^enc:v1:/);
        expect(state.encryptedConnectionId).not.toContain('con_first');
        expect(decryptSecret(state.encryptedConnectionId)).toBe('con_first');
        expect(responseJson(state.toJSON())).not.toContain('con_first');
        expect(responseJson(state.toJSON())).not.toContain('enc:v1:');
    });

    it('reconnect sends the existing decrypted connectionId internally and does not expose it', async () => {
        const provider = await createXenaProvider();
        const state = await XenaConnection.create({
            provider: provider._id,
            status: 'connected',
            displayName: 'Old Agency',
            maskedUsername: 'ol***@example.com',
        });
        state.setConnectionId('con_existing');
        await state.save();

        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            data: { connectionId: 'con_existing', status: 'verification_required' },
            status: 200,
            headers: {},
        });

        const result = await xenaService.reconnectConnection({
            provider: provider._id,
            displayName: 'Main Agency',
            username: 'agency@example.com',
            password: 'new-password',
        });

        expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ connectionId: 'con_existing' }),
        }));
        expect(responseJson(result)).not.toContain('con_existing');
        expect(responseJson(result)).not.toContain('new-password');
    });

    it('failed reconnect records a safe error without erasing the old connected connectionId', async () => {
        const provider = await createXenaProvider();
        const state = await XenaConnection.create({
            provider: provider._id,
            status: 'connected',
            displayName: 'Main Agency',
        });
        state.setConnectionId('con_keep');
        await state.save();

        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockRejectedValueOnce({
            response: {
                status: 500,
                data: { message: 'Authorization: Bearer digiteech-client-key failed' },
                headers: {},
            },
            message: 'server error',
        });

        await expect(xenaService.reconnectConnection({
            provider: provider._id,
            displayName: 'Main Agency',
            username: 'agency@example.com',
            password: 'new-password',
        })).rejects.toMatchObject({ code: 'XENA_INTEGRATION_UNAVAILABLE' });

        const after = await XenaConnection.findOne({ provider: provider._id }).select('+encryptedConnectionId');
        expect(decryptSecret(after.encryptedConnectionId)).toBe('con_keep');
        expect(after.status).toBe('connected');
        expect(after.lastErrorMessage).not.toContain('digiteech-client-key');
        expect(after.lastErrorMessage).not.toContain('Bearer');
    });

    it('verify uses the stored connectionId internally and returns a safe connected response', async () => {
        const provider = await createXenaProvider();
        const state = await XenaConnection.create({
            provider: provider._id,
            status: 'verification_required',
            displayName: 'Main Agency',
            maskedUsername: 'ag***@example.com',
        });
        state.setConnectionId('con_verify');
        await state.save();

        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            data: { status: 'connected' },
            status: 200,
            headers: { 'x-request-id': 'req-verify' },
        });

        const result = await xenaService.verifyConnection({
            provider: provider._id,
            code: '1234',
        });

        expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'post',
            url: '/v1/connections/verify',
            data: { connectionId: 'con_verify', code: '1234' },
        }));
        expect(result.status).toBe('connected');
        expect(responseJson(result)).not.toContain('con_verify');
        expect(responseJson(result)).not.toContain('1234');

        const after = await XenaConnection.findOne({ provider: provider._id }).select('+encryptedConnectionId');
        expect(after.status).toBe('connected');
        expect(Object.keys(after.toJSON())).not.toContain('encryptedConnectionId');
    });

    it('does not store password or OTP in connection state', async () => {
        const provider = await createXenaProvider();
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request
            .mockResolvedValueOnce({ data: { connectionId: 'con_secret', status: 'verification_required' }, status: 200, headers: {} })
            .mockResolvedValueOnce({ data: { status: 'connected' }, status: 200, headers: {} });

        await xenaService.challengeConnection({
            provider: provider._id,
            displayName: 'Main Agency',
            username: 'agency@example.com',
            password: 'do-not-store-password',
        });
        await xenaService.verifyConnection({ provider: provider._id, code: '9876' });

        const state = await XenaConnection.findOne({ provider: provider._id }).select('+encryptedConnectionId').lean();
        const storedJson = responseJson(state);
        expect(storedJson).not.toContain('do-not-store-password');
        expect(storedJson).not.toContain('9876');
    });
});

describe('Xena status and balance', () => {
    it('status response is safe and does not expose connectionId or provider secrets', async () => {
        const provider = await createXenaProvider();
        const state = await XenaConnection.create({
            provider: provider._id,
            status: 'connected',
            displayName: 'Main Agency',
            maskedUsername: 'ag***@example.com',
        });
        state.setConnectionId('con_status');
        await state.save();

        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            data: { status: 'connected', tokenExpiresAt: '2026-07-25T11:00:00.000Z' },
            status: 200,
            headers: {},
        });

        const result = await xenaService.getConnectionStatus({ provider: provider._id });

        expect(result.status).toBe('connected');
        expect(result.needsReconnect).toBe(false);
        expect(responseJson(result)).not.toContain('con_status');
        expect(responseJson(result)).not.toContain('digiteech-client-key');
        expect(responseJson(result)).not.toContain('enc:v1:');
    });

    it.each([
        [19439706, '19439706'],
        ['19439706', '19439706'],
        [{ balance: 19439706 }, '19439706'],
        [{ data: { balance: '19439706' } }, '19439706'],
    ])('normalizes balance shape %# to a scalar string', async (balancePayload, expected) => {
        const provider = await createXenaProvider({ name: `Xena Recharge ${expected} ${Math.random()}` });
        const state = await XenaConnection.create({ provider: provider._id, status: 'connected' });
        state.setConnectionId('con_balance');
        await state.save();

        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            data: balancePayload,
            status: 200,
            headers: { 'x-request-id': 'req-balance' },
        });

        const result = await xenaService.refreshBalance({ provider: provider._id });

        expect(result).toMatchObject({
            balance: expected,
            currency: null,
            source: 'xena_live',
            requestId: 'req-balance',
        });
        expect(result.balance).not.toBe('[object Object]');
    });

    it('malformed balance returns a controlled Xena error and stores safe metadata', async () => {
        const provider = await createXenaProvider();
        const state = await XenaConnection.create({ provider: provider._id, status: 'connected' });
        state.setConnectionId('con_balance_bad');
        await state.save();

        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockResolvedValueOnce({
            data: { data: { balance: { amount: 1 } } },
            status: 200,
            headers: {},
        });

        await expect(xenaService.refreshBalance({ provider: provider._id }))
            .rejects.toMatchObject({ code: 'XENA_MALFORMED_RESPONSE' });

        const after = await XenaConnection.findOne({ provider: provider._id }).lean();
        expect(after.lastErrorCode).toBe('XENA_MALFORMED_RESPONSE');
        expect(responseJson(after)).not.toContain('con_balance_bad');
    });
});

describe('Xena error mapping', () => {
    it('maps 401 challenge errors to provider auth failed without leaking Authorization values', async () => {
        const provider = await createXenaProvider();
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockRejectedValueOnce({
            response: {
                status: 401,
                data: { message: 'Authorization: Bearer digiteech-client-key is invalid' },
                headers: {},
            },
            message: 'unauthorized',
        });

        await expect(xenaService.challengeConnection({
            provider: provider._id,
            displayName: 'Main Agency',
            username: 'agency@example.com',
            password: 'agency-password',
        })).rejects.toMatchObject({ code: 'XENA_PROVIDER_AUTH_FAILED' });

        const state = await XenaConnection.findOne({ provider: provider._id }).lean();
        expect(state.lastErrorCode).toBe('XENA_PROVIDER_AUTH_FAILED');
        expect(state.lastErrorMessage).not.toContain('digiteech-client-key');
        expect(state.lastErrorMessage).not.toContain('Bearer');
    });

    it('maps 429 to XENA_RATE_LIMITED', async () => {
        const provider = await createXenaProvider();
        const state = await XenaConnection.create({ provider: provider._id, status: 'connected' });
        state.setConnectionId('con_rate_limited');
        await state.save();

        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockRejectedValueOnce({
            response: { status: 429, data: { code: 'RATE_LIMITED' }, headers: {} },
            message: 'too many requests',
        });

        await expect(xenaService.refreshBalance({ provider: provider._id }))
            .rejects.toMatchObject({ code: 'XENA_RATE_LIMITED' });
    });

    it('maps timeout and 5xx balance errors to XENA_BALANCE_UNAVAILABLE', async () => {
        const provider = await createXenaProvider();
        const state = await XenaConnection.create({ provider: provider._id, status: 'connected' });
        state.setConnectionId('con_timeout');
        await state.save();

        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request.mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 20000ms exceeded' });

        await expect(xenaService.refreshBalance({ provider: provider._id }))
            .rejects.toMatchObject({ code: 'XENA_BALANCE_UNAVAILABLE' });

        client.request.mockRejectedValueOnce({
            response: { status: 500, data: { message: 'temporary failure' }, headers: {} },
            message: 'server error',
        });

        await expect(xenaService.refreshBalance({ provider: provider._id }))
            .rejects.toMatchObject({ code: 'XENA_BALANCE_UNAVAILABLE' });
    });

    it('requires an encrypted connection before verify or balance', async () => {
        const provider = await createXenaProvider();

        await expect(xenaService.verifyConnection({ provider: provider._id, code: '1234' }))
            .rejects.toMatchObject({ code: 'XENA_CONNECTION_REQUIRED' });
        await expect(xenaService.refreshBalance({ provider: provider._id }))
            .rejects.toMatchObject({ code: 'XENA_CONNECTION_REQUIRED' });
    });

    it('never stores Authorization header, API key, password, or OTP in connection metadata', async () => {
        const provider = await createXenaProvider();
        const client = makeClient();
        axios.create.mockReturnValue(client);
        client.request
            .mockRejectedValueOnce({
                response: {
                    status: 401,
                    data: { message: 'Authorization: Bearer digiteech-client-key bad password=agency-password code=1234' },
                    headers: {},
                },
                message: 'unauthorized',
            });

        await expect(xenaService.challengeConnection({
            provider: provider._id,
            displayName: 'Main Agency',
            username: 'agency@example.com',
            password: 'agency-password',
        })).rejects.toMatchObject({ code: 'XENA_PROVIDER_AUTH_FAILED' });

        const state = await XenaConnection.findOne({ provider: provider._id }).lean();
        const json = responseJson(state);
        expect(json).not.toContain('digiteech-client-key');
        expect(json).not.toContain('agency-password');
        expect(json).not.toContain('1234');
        expect(json).not.toContain('Authorization');
        expect(isEncryptedSecret(state.encryptedConnectionId || '')).toBe(false);
    });
});
