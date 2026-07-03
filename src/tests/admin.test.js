'use strict';

/**
 * admin.test.js — Admin Dashboard API Test Suite
 *
 * Covers:
 *  [1] Admin Users Service — list + filter, get, update, soft-delete
 *  [2] Admin Wallet Service — add funds, deduct funds, balance guards
 *  [3] Admin Settings Service — list, get, update
 *  [4] Admin validation — Joi schema guards
 */

const mongoose = require('mongoose');
const { User, USER_STATUS } = require('../modules/users/user.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { Setting, seedDefaultSettings } = require('../modules/admin/setting.model');

const adminUsersService = require('../modules/admin/admin.users.service');
const adminWalletService = require('../modules/admin/admin.wallet.service');
const adminSettingService = require('../modules/admin/admin.settings.service');
const { validateBody, schemas } = require('../modules/admin/admin.validation');

const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createAdmin,
    USER_STATUS: _STATUS,
} = require('./testHelpers');

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => { await clearCollections(); });

// ─── Helpers ─────────────────────────────────────────────────────────────────

const setup = async () => {
    const group = await createGroup({ name: 'Standard', percentage: 10 });
    const admin = await createAdmin({ groupId: group._id });
    const customer = await createCustomer({ groupId: group._id });
    return { group, admin, customer };
};

// ═══════════════════════════════════════════════════════════════════════════════
// [1] Admin Users Service
// ═══════════════════════════════════════════════════════════════════════════════

describe('[1] Admin Users Service', () => {

    it('listUsers returns all users with pagination', async () => {
        const { group } = await setup();
        await createCustomer({ groupId: group._id });
        await createCustomer({ groupId: group._id });

        const result = await adminUsersService.listUsers({ page: 1, limit: 10 });
        // admin + 2 customers created in beforeEach + 2 here = at least 4
        expect(result.users.length).toBeGreaterThanOrEqual(2);
        expect(result.pagination).toMatchObject({ page: 1, limit: 10 });
        expect(typeof result.pagination.total).toBe('number');
    });

    it('listUsers filters by status=PENDING', async () => {
        const { group, admin } = await setup();
        const pending = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.PENDING,
        });

        const result = await adminUsersService.listUsers({ status: 'PENDING' });
        const ids = result.users.map((u) => u._id.toString());
        expect(ids).toContain(pending._id.toString());
        // admin is ACTIVE — should not appear
        expect(ids).not.toContain(admin._id.toString());
    });

    it('listUsers filters by email (partial match)', async () => {
        const { group } = await setup();
        const unique = await createCustomer({
            groupId: group._id,
            email: `xyzUnique-${Date.now()}@example.com`,
        });

        const result = await adminUsersService.listUsers({ email: 'xyzUnique' });
        expect(result.users.map((u) => u._id.toString())).toContain(unique._id.toString());
    });

    it('listUsers excludes soft-deleted users', async () => {
        const { group, admin, customer } = await setup();
        await adminUsersService.deleteUser(customer._id, admin._id);

        const result = await adminUsersService.listUsers({});
        const ids = result.users.map((u) => u._id.toString());
        expect(ids).not.toContain(customer._id.toString());
    });

    it('getUserById returns full user with groupId populated', async () => {
        const { customer } = await setup();
        const user = await adminUsersService.getUserById(customer._id);
        expect(user._id.toString()).toBe(customer._id.toString());
        expect(user.groupId).toBeDefined();
    });

    it('getUserById throws NotFoundError for unknown id', async () => {
        const fakeId = new mongoose.Types.ObjectId();
        await expect(adminUsersService.getUserById(fakeId))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('updateUser changes name and status', async () => {
        const { customer, admin } = await setup();
        const updated = await adminUsersService.updateUser(
            customer._id,
            { name: 'Updated Name', status: USER_STATUS.ACTIVE },
            admin._id
        );
        expect(updated.name).toBe('Updated Name');
        expect(updated.status).toBe(USER_STATUS.ACTIVE);
    });

    it('updateUser enables API access and creates apiToken when missing', async () => {
        const { customer, admin } = await setup();
        await User.findByIdAndUpdate(customer._id, { $set: { isApiEnabled: false, apiToken: null } });

        await adminUsersService.updateUser(
            customer._id,
            { isApiEnabled: true },
            admin._id
        );

        const updated = await User.findById(customer._id).select('+apiToken');
        expect(updated.isApiEnabled).toBe(true);
        expect(typeof updated.apiToken).toBe('string');
        expect(updated.apiToken.length).toBeGreaterThan(0);
    });

    it('updateUser keeps existing apiToken when API access is enabled', async () => {
        const { customer, admin } = await setup();
        const existingToken = 'existing-api-token-123';
        await User.findByIdAndUpdate(customer._id, {
            $set: { isApiEnabled: false, apiToken: existingToken },
        });

        await adminUsersService.updateUser(
            customer._id,
            { isApiEnabled: true },
            admin._id
        );

        const updated = await User.findById(customer._id).select('+apiToken');
        expect(updated.isApiEnabled).toBe(true);
        expect(updated.apiToken).toBe(existingToken);
    });

    it('updateUser rejects duplicate email', async () => {
        const { group, admin, customer } = await setup();
        const other = await createCustomer({ groupId: group._id });
        await expect(
            adminUsersService.updateUser(customer._id, { email: other.email }, admin._id)
        ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('deleteUser soft-deletes: sets deletedAt and blocks from list', async () => {
        const { customer, admin } = await setup();
        await adminUsersService.deleteUser(customer._id, admin._id);

        const fresh = await User.findById(customer._id);
        expect(fresh.deletedAt).not.toBeNull();
        expect(fresh.status).toBe(USER_STATUS.REJECTED);
    });

    it('deleteUser throws if already deleted', async () => {
        const { customer, admin } = await setup();
        await adminUsersService.deleteUser(customer._id, admin._id);
        await expect(adminUsersService.deleteUser(customer._id, admin._id))
            .rejects.toMatchObject({ code: 'ALREADY_DELETED' });
    });

    it('deleteUser throws CANNOT_DELETE_ADMIN for admin accounts', async () => {
        const { admin } = await setup();
        await expect(adminUsersService.deleteUser(admin._id, admin._id))
            .rejects.toMatchObject({ code: 'CANNOT_DELETE_ADMIN' });
    });

    it('approveUser transitions PENDING → ACTIVE', async () => {
        const { group, admin } = await setup();
        const pending = await createCustomer({
            groupId: group._id,
            status: USER_STATUS.PENDING,
        });
        const result = await adminUsersService.approveUser(pending._id, admin._id);
        expect(result.status).toBe(USER_STATUS.ACTIVE);
    });

    it('rejectUser transitions ACTIVE → REJECTED', async () => {
        const { customer, admin } = await setup();
        const result = await adminUsersService.rejectUser(customer._id, admin._id);
        expect(result.status).toBe(USER_STATUS.REJECTED);
    });

    it('updateUserCreditLimit updates limit without creating a wallet transaction', async () => {
        const { customer, admin } = await setup();

        const updated = await adminUsersService.updateUserCreditLimit(
            customer._id,
            500,
            admin._id,
            'Trusted reseller'
        );

        expect(updated.creditLimit).toBe(500);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('updateUserCreditLimit rejects negative limits', async () => {
        const { customer, admin } = await setup();

        await expect(adminUsersService.updateUserCreditLimit(
            customer._id,
            -1,
            admin._id,
            'Invalid limit'
        )).rejects.toMatchObject({ code: 'INVALID_CREDIT_LIMIT' });
    });

    it('updateUserGroup assigns an active group without changing user role', async () => {
        const { customer, admin } = await setup();
        const newGroup = await createGroup({ name: 'Resellers', percentage: 6 });
        const previousRole = customer.role;

        const updated = await adminUsersService.updateUserGroup(
            customer._id,
            { groupId: newGroup._id, reason: 'Moved to reseller group' },
            admin._id
        );

        expect(updated.groupId._id.toString()).toBe(newGroup._id.toString());
        expect(updated.groupId.name).toBe('Resellers');
        expect(updated.role).toBe(previousRole);
    });

    it('updateUserGroup rejects inactive groups', async () => {
        const { customer, admin } = await setup();
        const inactiveGroup = await createGroup({
            name: 'Inactive Tier',
            percentage: 3,
            isActive: false,
        });

        await expect(adminUsersService.updateUserGroup(
            customer._id,
            { groupId: inactiveGroup._id, reason: 'Should fail' },
            admin._id
        )).rejects.toMatchObject({ code: 'GROUP_INACTIVE' });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// [2] Admin Wallet Service
// ═══════════════════════════════════════════════════════════════════════════════

describe('[2] Admin Wallet Service', () => {

    it('addFunds credits the user wallet and creates a CREDIT transaction', async () => {
        const { customer, admin } = await setup();
        const before = customer.walletBalance;

        await adminWalletService.addFunds(customer._id, 50, 'Test credit', admin._id);

        const updated = await User.findById(customer._id);
        expect(updated.walletBalance).toBeCloseTo(before + 50, 2);

        const txn = await WalletTransaction.findOne({ userId: customer._id, type: 'CREDIT' });
        expect(txn).not.toBeNull();
        expect(txn.amount).toBe(50);
        expect(txn.semanticType).toBe('ADMIN_ADJUSTMENT');
        expect(txn.sourceType).toBe('ADMIN_ADJUSTMENT');
        expect(txn.direction).toBe('CREDIT');
        expect(txn.currency).toBe(customer.currency || 'USD');
        expect(txn.actorId.toString()).toBe(admin._id.toString());
    });

    it('addFunds rejects amount = 0', async () => {
        const { customer, admin } = await setup();
        await expect(adminWalletService.addFunds(customer._id, 0, 'bad', admin._id))
            .rejects.toMatchObject({ code: 'INVALID_ADJUSTMENT_AMOUNT' });
    });

    it('addFunds rejects amount > 100000', async () => {
        const { customer, admin } = await setup();
        await expect(adminWalletService.addFunds(customer._id, 100_001, 'too big', admin._id))
            .rejects.toMatchObject({ code: 'INVALID_ADJUSTMENT_AMOUNT' });
    });

    it('deductFunds reduces wallet and creates a DEBIT transaction', async () => {
        const { customer, admin } = await setup();
        const before = customer.walletBalance;   // 100 from helper

        await adminWalletService.deductFunds(customer._id, 30, 'Test debit', admin._id);

        const updated = await User.findById(customer._id);
        expect(updated.walletBalance).toBeCloseTo(before - 30, 2);

        const txn = await WalletTransaction.findOne({ userId: customer._id, type: 'DEBIT' });
        expect(txn).not.toBeNull();
        expect(txn.amount).toBe(30);
        expect(txn.semanticType).toBe('ADMIN_ADJUSTMENT');
        expect(txn.sourceType).toBe('ADMIN_ADJUSTMENT');
        expect(txn.direction).toBe('DEBIT');
        expect(txn.currency).toBe(customer.currency || 'USD');
        expect(txn.actorId.toString()).toBe(admin._id.toString());
    });

    it('deductFunds throws INSUFFICIENT_BALANCE when wallet is too low', async () => {
        const { customer, admin } = await setup();
        // customer has 100 — try to deduct 200
        await expect(adminWalletService.deductFunds(customer._id, 200, 'overdraft', admin._id))
            .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });

        // Wallet must be unchanged
        const after = await User.findById(customer._id);
        expect(after.walletBalance).toBe(customer.walletBalance);
    });

    it('deductFunds extends existing debt without double-counting credit used', async () => {
        const { customer, admin } = await setup();
        await User.findByIdAndUpdate(customer._id, {
            $set: {
                walletBalance: -20,
                creditLimit: 100,
                creditUsed: 20,
            },
        });

        await adminWalletService.deductFunds(customer._id, 10, 'Debt extension', admin._id);

        const updated = await User.findById(customer._id);
        expect(updated.walletBalance).toBe(-30);
        expect(updated.creditUsed).toBe(30);

        const txn = await WalletTransaction.findOne({ userId: customer._id, type: 'DEBIT' });
        expect(txn.metadata.creditDrawn).toBe(10);
        expect(txn.metadata.creditUsedBefore).toBe(20);
        expect(txn.metadata.creditUsedAfter).toBe(30);
    });

    it('getWallet returns user with balance fields', async () => {
        const { customer } = await setup();
        const wallet = await adminWalletService.getWallet(customer._id);
        expect(wallet.user.walletBalance).toBeDefined();
        expect(wallet.user.creditLimit).toBeDefined();
        expect(Array.isArray(wallet.recentTransactions)).toBe(true);
    });

    it('getTransactionHistory returns paginated transactions', async () => {
        const { customer, admin } = await setup();
        await adminWalletService.addFunds(customer._id, 10, 'r1', admin._id);
        await adminWalletService.addFunds(customer._id, 20, 'r2', admin._id);

        const result = await adminWalletService.getTransactionHistory(customer._id, { page: 1, limit: 5 });
        expect(result.transactions.length).toBeGreaterThanOrEqual(2);
        expect(result.pagination.total).toBeGreaterThanOrEqual(2);
    });

    it('listWallets returns paginated users summary', async () => {
        await setup();
        const result = await adminWalletService.listWallets({ page: 1, limit: 10 });
        expect(Array.isArray(result.wallets)).toBe(true);
        expect(result.pagination).toBeDefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// [3] Admin Settings Service
// ═══════════════════════════════════════════════════════════════════════════════

describe('[3] Admin Settings Service', () => {
    beforeEach(async () => {
        await seedDefaultSettings();
    });

    it('listSettings returns all seeded settings', async () => {
        const settings = await adminSettingService.listSettings();
        expect(settings.length).toBeGreaterThanOrEqual(5);
        const keys = settings.map((s) => s.key);
        expect(keys).toContain('maintenanceMode');
        expect(keys).toContain('orderTimeoutMinutes');
    });

    it('getSettingByKey retrieves a known setting', async () => {
        const s = await adminSettingService.getSettingByKey('maintenanceMode');
        expect(s.key).toBe('maintenanceMode');
        expect(typeof s.value).toBe('boolean');
    });

    it('getSettingByKey throws NOT_FOUND for unknown key', async () => {
        await expect(adminSettingService.getSettingByKey('nonExistentKey99'))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('updateSetting changes the value and records updatedBy', async () => {
        const { admin } = await setup();
        const updated = await adminSettingService.updateSetting('maintenanceMode', true, admin._id);
        expect(updated.value).toBe(true);
        expect(updated.updatedBy.toString()).toBe(admin._id.toString());

        // Verify persisted
        const fresh = await adminSettingService.getSettingByKey('maintenanceMode');
        expect(fresh.value).toBe(true);
    });

    it('updateSetting creates unknown keys using current upsert behavior', async () => {
        const { admin } = await setup();
        const updated = await adminSettingService.updateSetting('unknownSetting', 999, admin._id);

        expect(updated.key).toBe('unknownSetting');
        expect(updated.value).toBe(999);
        expect(updated.updatedBy.toString()).toBe(admin._id.toString());
    });

    it('seedDefaultSettings is idempotent — re-seeding does NOT overwrite admin changes', async () => {
        const { admin } = await setup();
        await adminSettingService.updateSetting('orderTimeoutMinutes', 999, admin._id);
        await seedDefaultSettings();   // re-seed
        const s = await adminSettingService.getSettingByKey('orderTimeoutMinutes');
        expect(s.value).toBe(999);    // admin value preserved
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// [4] Validation Schemas
// ═══════════════════════════════════════════════════════════════════════════════

describe('[4] Joi Validation Schemas', () => {

    const runBodyValidation = (schema, body) => {
        const mw = validateBody(schema);
        const req = { body };
        const res = {};
        let caught = undefined;   // undefined = next not yet called
        mw(req, res, (err) => { caught = err ?? null; });
        return caught;  // null = valid, Error instance = invalid
    };

    it('updateUser: rejects empty body', () => {
        const err = runBodyValidation(schemas.updateUser, {});
        expect(err).not.toBeNull();
        expect(err.code).toBe('VALIDATION_ERROR');
    });

    it('updateUser: accepts valid name + status', () => {
        const err = runBodyValidation(schemas.updateUser, { name: 'Alice', status: 'ACTIVE' });
        expect(err).toBeNull();
    });

    it('updateUser: accepts isApiEnabled boolean', () => {
        const err = runBodyValidation(schemas.updateUser, { isApiEnabled: true });
        expect(err).toBeNull();
    });

    it('updateUser: rejects invalid status', () => {
        const err = runBodyValidation(schemas.updateUser, { status: 'BANNED' });
        expect(err).not.toBeNull();
    });

    it('walletAdjustment: requires positive amount', () => {
        const err = runBodyValidation(schemas.walletAdjustment, { amount: -5, reason: 'x' });
        expect(err).not.toBeNull();
    });

    it('walletAdjustment: requires reason', () => {
        const err = runBodyValidation(schemas.walletAdjustment, { amount: 10 });
        expect(err).not.toBeNull();
    });

    it('walletAdjustment: accepts valid payload', () => {
        const err = runBodyValidation(schemas.walletAdjustment, { amount: 100, reason: 'Admin top-up' });
        expect(err).toBeNull();
    });

    it('updateCreditLimit: requires a non-negative limit and reason', () => {
        expect(runBodyValidation(schemas.updateCreditLimit, { creditLimit: 100 })).not.toBeNull();
        expect(runBodyValidation(schemas.updateCreditLimit, { creditLimit: -1, reason: 'Bad limit' })).not.toBeNull();
        expect(runBodyValidation(schemas.updateCreditLimit, { creditLimit: 100, reason: 'Trusted reseller' })).toBeNull();
    });

    it('updateUserGroup: requires groupId and reason', () => {
        const groupId = new mongoose.Types.ObjectId().toString();
        expect(runBodyValidation(schemas.updateUserGroup, { groupId })).not.toBeNull();
        expect(runBodyValidation(schemas.updateUserGroup, { groupId, reason: 'Move to reseller tier' })).toBeNull();
    });

    it('createProvider: requires name and baseUrl', () => {
        const err = runBodyValidation(schemas.createProvider, { name: 'X' });
        expect(err).not.toBeNull();
    });

    it('createProvider: rejects invalid baseUrl', () => {
        const err = runBodyValidation(schemas.createProvider, { name: 'My Provider', baseUrl: 'not-a-url' });
        expect(err).not.toBeNull();
    });

    it('createProvider: accepts simplified quick-create auth metadata', () => {
        const err = runBodyValidation(schemas.createProvider, {
            name: 'My Provider',
            code: 'my-provider',
            baseUrl: 'https://provider.example.com/api',
            integrationType: 'API',
            authType: 'NONE',
            isActive: true,
        });
        expect(err).toBeNull();
    });

    it('createProvider: accepts conditional quick-create credential fields', () => {
        expect(runBodyValidation(schemas.createProvider, {
            name: 'API Key Provider',
            code: 'api-key-provider',
            baseUrl: 'https://provider.example.com/api',
            integrationType: 'API',
            authType: 'API_KEY',
            apiKey: 'secret-api-key',
        })).toBeNull();

        expect(runBodyValidation(schemas.createProvider, {
            name: 'Bearer Provider',
            code: 'bearer-provider',
            baseUrl: 'https://provider.example.com/api',
            integrationType: 'API',
            authType: 'BEARER_TOKEN',
            bearerToken: 'secret-bearer-token',
        })).toBeNull();

        expect(runBodyValidation(schemas.createProvider, {
            name: 'Username Provider',
            code: 'username-provider',
            baseUrl: 'https://provider.example.com/api',
            integrationType: 'API',
            authType: 'USERNAME_PASSWORD',
            username: 'provider-user',
            password: 'provider-password',
        })).toBeNull();
    });

    it('updateSetting: requires value', () => {
        const err = runBodyValidation(schemas.updateSetting, {});
        expect(err).not.toBeNull();
    });

    it('updateSetting: accepts boolean, number, or string', () => {
        expect(runBodyValidation(schemas.updateSetting, { value: false })).toBeNull();
        expect(runBodyValidation(schemas.updateSetting, { value: 42 })).toBeNull();
        expect(runBodyValidation(schemas.updateSetting, { value: 'text' })).toBeNull();
    });
});
