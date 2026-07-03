'use strict';

const mongoose = require('mongoose');
const { Provider } = require('../modules/providers/provider.model');
const { BaseProviderAdapter } = require('../modules/providers/adapters/base.adapter');
const adminProviderService = require('../modules/admin/admin.providers.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
} = require('./testHelpers');
const { migrateProviderCredentials } = require('../../scripts/migrate-provider-credentials');
const {
    decryptSecret,
    encryptSecret,
    isEncryptedSecret,
    VERSION_PREFIX,
} = require('../shared/utils/secretEncryption');

const TEST_KEY = Buffer.alloc(32, 11).toString('base64');
const adminId = new mongoose.Types.ObjectId();

class TokenProbeAdapter extends BaseProviderAdapter {}

beforeAll(async () => {
    process.env.PROVIDER_CREDENTIALS_KEY = TEST_KEY;
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    process.env.PROVIDER_CREDENTIALS_KEY = TEST_KEY;
    await clearCollections();
});

describe('provider credential encryption utility', () => {
    it('encrypts with an enc:v1 marker and decrypts back to the original value', () => {
        const encrypted = encryptSecret('provider-secret');

        expect(encrypted).toMatch(new RegExp(`^${VERSION_PREFIX}:`));
        expect(encrypted).not.toContain('provider-secret');
        expect(isEncryptedSecret(encrypted)).toBe(true);
        expect(decryptSecret(encrypted)).toBe('provider-secret');
    });

    it('fails decryption when ciphertext or auth metadata is tampered with', () => {
        const encrypted = encryptSecret('provider-secret');
        const parts = encrypted.split(':');
        parts[3] = Buffer.alloc(16, 0).toString('base64');

        expect(() => decryptSecret(parts.join(':'))).toThrow(/could not be decrypted|payload is invalid/i);
    });

    it('fails safely when the encryption key is missing or invalid', () => {
        const original = process.env.PROVIDER_CREDENTIALS_KEY;

        delete process.env.PROVIDER_CREDENTIALS_KEY;
        expect(() => encryptSecret('secret')).toThrow(/PROVIDER_CREDENTIALS_KEY is required/);

        process.env.PROVIDER_CREDENTIALS_KEY = 'not-a-valid-key';
        expect(() => encryptSecret('secret')).toThrow(/32-byte AES key/);

        process.env.PROVIDER_CREDENTIALS_KEY = original;
    });
});

describe('provider create/update credential behavior', () => {
    it('creates a quick provider without credentials and stores safe auth metadata', async () => {
        const provider = await adminProviderService.createProvider({
            name: 'quick provider',
            code: 'quick-provider',
            baseUrl: 'https://provider.example.com',
            integrationType: 'API',
            authType: 'NONE',
            isActive: true,
        }, adminId);

        const stored = await Provider.findById(provider._id).lean();
        expect(stored.slug).toBe('quick-provider');
        expect(stored.integrationType).toBe('API');
        expect(stored.authType).toBe('NONE');
        expect(stored.apiToken).toBeNull();
        expect(stored.apiKey).toBeNull();
    });

    it('stores provider credentials encrypted and serializes only safe credential booleans', async () => {
        const provider = await adminProviderService.createProvider({
            name: 'mock',
            baseUrl: 'https://provider.example.com',
            apiToken: 'plain-token',
            apiKey: 'legacy-key',
            username: 'provider-user',
            password: 'provider-password',
        }, adminId);

        const stored = await Provider.findById(provider._id).lean();
        expect(stored.apiToken).toMatch(/^enc:v1:/);
        expect(stored.apiKey).toMatch(/^enc:v1:/);
        expect(stored.username).toMatch(/^enc:v1:/);
        expect(stored.password).toMatch(/^enc:v1:/);
        expect(stored.apiToken).not.toContain('plain-token');
        expect(stored.apiKey).not.toContain('legacy-key');
        expect(stored.username).not.toContain('provider-user');
        expect(stored.password).not.toContain('provider-password');
        expect(decryptSecret(stored.apiToken)).toBe('plain-token');
        expect(decryptSecret(stored.apiKey)).toBe('legacy-key');
        expect(decryptSecret(stored.username)).toBe('provider-user');
        expect(decryptSecret(stored.password)).toBe('provider-password');

        const response = provider.toJSON();
        expect(response.apiToken).toBeUndefined();
        expect(response.apiKey).toBeUndefined();
        expect(response.username).toBeUndefined();
        expect(response.password).toBeUndefined();
        expect(response.hasApiToken).toBe(true);
        expect(response.hasApiKey).toBe(true);
        expect(response.hasUsername).toBe(true);
        expect(response.hasPassword).toBe(true);
        expect(response.credentialConfigured).toBe(true);
        expect(response.credentialsConfigured).toBe(true);
        expect(JSON.stringify(response)).not.toContain('plain-token');
        expect(JSON.stringify(response)).not.toContain('provider-user');
        expect(JSON.stringify(response)).not.toContain('provider-password');
        expect(JSON.stringify(response)).not.toContain('enc:v1:');
    });

    it('maps bearerToken quick-create payloads into encrypted apiToken storage', async () => {
        const provider = await adminProviderService.createProvider({
            name: 'bearer-alias',
            baseUrl: 'https://provider.example.com',
            authType: 'BEARER_TOKEN',
            bearerToken: 'bearer-secret',
        }, adminId);

        const stored = await Provider.findById(provider._id).lean();

        expect(stored.authType).toBe('BEARER_TOKEN');
        expect(stored.apiToken).toMatch(/^enc:v1:/);
        expect(decryptSecret(stored.apiToken)).toBe('bearer-secret');
        expect(stored.apiKey).toBeNull();
    });

    it('keeps an existing credential when update sends a blank credential value', async () => {
        const provider = await adminProviderService.createProvider({
            name: 'blank-preserve',
            baseUrl: 'https://provider.example.com',
            apiToken: 'old-token',
        }, adminId);
        const before = await Provider.findById(provider._id).lean();

        await adminProviderService.updateProvider(provider._id, { apiToken: '' }, adminId);
        const after = await Provider.findById(provider._id).lean();

        expect(after.apiToken).toBe(before.apiToken);
        expect(decryptSecret(after.apiToken)).toBe('old-token');
    });

    it('replaces an existing credential when update sends a new credential value', async () => {
        const provider = await adminProviderService.createProvider({
            name: 'new-token',
            baseUrl: 'https://provider.example.com',
            apiToken: 'old-token',
        }, adminId);
        const before = await Provider.findById(provider._id).lean();

        await adminProviderService.updateProvider(provider._id, { apiToken: 'new-token' }, adminId);
        const after = await Provider.findById(provider._id).lean();

        expect(after.apiToken).not.toBe(before.apiToken);
        expect(decryptSecret(after.apiToken)).toBe('new-token');
    });

    it('keeps username/password credentials when update sends blank credential values', async () => {
        const provider = await adminProviderService.createProvider({
            name: 'blank-user-pass',
            baseUrl: 'https://provider.example.com',
            authType: 'USERNAME_PASSWORD',
            username: 'old-user',
            password: 'old-password',
        }, adminId);
        const before = await Provider.findById(provider._id).lean();

        await adminProviderService.updateProvider(provider._id, { username: '', password: '' }, adminId);
        const after = await Provider.findById(provider._id).lean();

        expect(after.username).toBe(before.username);
        expect(after.password).toBe(before.password);
        expect(decryptSecret(after.username)).toBe('old-user');
        expect(decryptSecret(after.password)).toBe('old-password');
    });

    it('provider list/detail serialization does not expose plaintext or encrypted credentials', async () => {
        const provider = await adminProviderService.createProvider({
            name: 'safe-list',
            baseUrl: 'https://provider.example.com',
            apiToken: 'list-secret',
        }, adminId);

        const list = await adminProviderService.listProviders();
        const detail = await adminProviderService.getProviderById(provider._id);
        const json = JSON.stringify({ list, detail });

        expect(json).not.toContain('list-secret');
        expect(json).not.toContain('enc:v1:');
        expect(list[0].toJSON()).toMatchObject({
            credentialConfigured: true,
            hasApiToken: true,
        });
    });
});

describe('provider internal credential use', () => {
    it('decrypts credentials only inside adapter token resolution', async () => {
        const provider = await Provider.create({
            name: 'adapter-token',
            baseUrl: 'https://provider.example.com',
            apiToken: 'adapter-secret',
            username: 'adapter-user',
            password: 'adapter-password',
        });
        const stored = await Provider.findById(provider._id);

        const adapter = new TokenProbeAdapter(stored);

        expect(stored.apiToken).toMatch(/^enc:v1:/);
        expect(stored.username).toMatch(/^enc:v1:/);
        expect(stored.password).toMatch(/^enc:v1:/);
        expect(adapter._resolveToken()).toBe('adapter-secret');
        expect(adapter._resolveUsername()).toBe('adapter-user');
        expect(adapter._resolvePassword()).toBe('adapter-password');
    });

    it('test connection responses do not include raw or encrypted credentials', async () => {
        const provider = await adminProviderService.createProvider({
            name: 'mock',
            baseUrl: 'https://provider.example.com',
            apiToken: 'connection-secret',
        }, adminId);

        const result = await adminProviderService.testProviderConnection(provider._id);
        const json = JSON.stringify(result);

        expect(result.success).toBe(true);
        expect(json).not.toContain('connection-secret');
        expect(json).not.toContain('enc:v1:');
    });
});

describe('provider credential migration', () => {
    it('encrypts legacy plaintext credentials and skips already encrypted credentials idempotently', async () => {
        const legacyId = new mongoose.Types.ObjectId();
        const encryptedToken = encryptSecret('already-encrypted-token');
        const now = new Date();

        await Provider.collection.insertMany([
            {
                _id: legacyId,
                name: 'legacy-provider',
                slug: 'legacy-provider',
                baseUrl: 'https://legacy.example.com',
                apiToken: 'legacy-token',
                apiKey: 'legacy-key',
                username: 'legacy-user',
                password: 'legacy-password',
                isActive: true,
                syncInterval: 60,
                supportedFeatures: [],
                deletedAt: null,
                createdAt: now,
                updatedAt: now,
            },
            {
                _id: new mongoose.Types.ObjectId(),
                name: 'encrypted-provider',
                slug: 'encrypted-provider',
                baseUrl: 'https://encrypted.example.com',
                apiToken: encryptedToken,
                apiKey: null,
                isActive: true,
                syncInterval: 60,
                supportedFeatures: [],
                deletedAt: null,
                createdAt: now,
                updatedAt: now,
            },
        ]);

        const firstRun = await migrateProviderCredentials();
        const migrated = await Provider.findById(legacyId).lean();

        expect(firstRun.encryptedFields).toBe(4);
        expect(firstRun.updatedProviders).toBe(1);
        expect(isEncryptedSecret(migrated.apiToken)).toBe(true);
        expect(isEncryptedSecret(migrated.apiKey)).toBe(true);
        expect(isEncryptedSecret(migrated.username)).toBe(true);
        expect(isEncryptedSecret(migrated.password)).toBe(true);
        expect(decryptSecret(migrated.apiToken)).toBe('legacy-token');
        expect(decryptSecret(migrated.apiKey)).toBe('legacy-key');
        expect(decryptSecret(migrated.username)).toBe('legacy-user');
        expect(decryptSecret(migrated.password)).toBe('legacy-password');

        const secondRun = await migrateProviderCredentials();

        expect(secondRun.encryptedFields).toBe(0);
        expect(secondRun.updatedProviders).toBe(0);
        expect(secondRun.skippedEncryptedFields).toBeGreaterThanOrEqual(5);
    });
});
