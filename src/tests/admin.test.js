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
const {
    WalletTransaction,
    TRANSACTION_TYPES,
    LEDGER_TRANSACTION_TYPES,
    TRANSACTION_DIRECTIONS,
    TRANSACTION_SOURCE_TYPES,
} = require('../modules/wallet/walletTransaction.model');
const { Currency } = require('../modules/currency/currency.model');
const { Setting, seedDefaultSettings } = require('../modules/admin/setting.model');
const { AuditLog } = require('../modules/audit/audit.model');
const { ADMIN_ACTIONS } = require('../modules/audit/audit.constants');

const adminUsersService = require('../modules/admin/admin.users.service');
const adminWalletService = require('../modules/admin/admin.wallet.service');
const adminSettingService = require('../modules/admin/admin.settings.service');
const adminSecurityPinService = require('../modules/admin/admin.securityPin.service');
const { validateBody, schemas } = require('../modules/admin/admin.validation');
const { authorizeRoles, requirePermission } = require('../shared/middlewares/authorize');

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

    it('converts the target user wallet currency and creates a conversion transaction', async () => {
        const { admin, customer } = await setup();
        await Currency.create({
            code: 'AED',
            name: 'UAE Dirham',
            symbol: 'AED',
            marketRate: 3.67,
            platformRate: 3.68,
            isActive: true,
        });
        customer.walletBalance = 125.5;
        await customer.save();

        const result = await adminUsersService.updateUserCurrency(
            customer._id,
            'AED',
            admin._id,
            'QA currency update'
        );
        const updated = result.user;

        expect(updated.currency).toBe('AED');
        expect(updated.walletBalance).toBe(461.84);
        expect(updated.role).toBe(customer.role);
        expect(updated.groupId._id.toString()).toBe(customer.groupId.toString());
        const txn = await WalletTransaction.findOne({ userId: customer._id });
        expect(txn).toMatchObject({
            semanticType: LEDGER_TRANSACTION_TYPES.ADMIN_CURRENCY_CONVERSION,
            direction: TRANSACTION_DIRECTIONS.NEUTRAL,
            balanceBefore: 125.5,
            balanceAfter: 461.84,
            currency: 'AED',
        });
    });

    it('rejects an inactive currency for an admin user update', async () => {
        const { admin, customer } = await setup();
        await Currency.create({
            code: 'AED',
            name: 'UAE Dirham',
            symbol: 'AED',
            marketRate: 3.67,
            platformRate: 3.68,
            isActive: false,
        });

        await expect(adminUsersService.updateUserCurrency(customer._id, 'AED', admin._id))
            .rejects.toMatchObject({ code: 'INVALID_CURRENCY' });
    });

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

    it('addFunds requires a reason', async () => {
        const { customer, admin } = await setup();
        await expect(adminWalletService.addFunds(customer._id, 50, '', admin._id))
            .rejects.toMatchObject({ code: 'ADJUSTMENT_REASON_REQUIRED' });
    });

    it('deductFunds requires a reason', async () => {
        const { customer, admin } = await setup();
        await expect(adminWalletService.deductFunds(customer._id, 30, '   ', admin._id))
            .rejects.toMatchObject({ code: 'ADJUSTMENT_REASON_REQUIRED' });
    });

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
        expect(txn.reason).toBe('Test credit');
        expect(txn.note).toBe('Test credit');
        expect(txn.metadata.reason).toBe('Test credit');
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
        expect(txn.reason).toBe('Test debit');
        expect(txn.note).toBe('Test debit');
        expect(txn.metadata.reason).toBe('Test debit');
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

    it('listAdminAdjustments returns only manual admin add/deduct ledger entries', async () => {
        const { customer, admin } = await setup();
        await adminWalletService.addFunds(customer._id, 40, 'Support correction', admin._id);
        await adminWalletService.deductFunds(customer._id, 10, 'Incorrect credit reversal', admin._id);

        await WalletTransaction.create({
            userId: customer._id,
            type: TRANSACTION_TYPES.CREDIT,
            semanticType: LEDGER_TRANSACTION_TYPES.CARD_PAYMENT_SUCCESS,
            sourceType: TRANSACTION_SOURCE_TYPES.CARD_PAYMENT,
            direction: TRANSACTION_DIRECTIONS.CREDIT,
            amount: 99,
            balanceBefore: 100,
            balanceAfter: 199,
            currency: customer.currency || 'USD',
            description: 'Payment gateway wallet credit',
        });

        const result = await adminWalletService.listAdminAdjustments({ page: 1, limit: 20 });

        expect(result.items).toHaveLength(2);
        expect(result.items.map((item) => item.action).sort()).toEqual(['ADD', 'DEDUCT']);
        expect(result.items.some((item) => item.amount === 99)).toBe(false);
        expect(result.summary).toMatchObject({
            totalAdded: 40,
            totalDeducted: 10,
            net: 30,
            count: 2,
        });
    });

    it('listAdminAdjustments filters by add/deduct', async () => {
        const { customer, admin } = await setup();
        await adminWalletService.addFunds(customer._id, 25, 'Manual add', admin._id);
        await adminWalletService.deductFunds(customer._id, 5, 'Manual deduct', admin._id);

        const addOnly = await adminWalletService.listAdminAdjustments({ type: 'add' });
        const deductOnly = await adminWalletService.listAdminAdjustments({ type: 'deduct' });

        expect(addOnly.items).toHaveLength(1);
        expect(addOnly.items[0].action).toBe('ADD');
        expect(deductOnly.items).toHaveLength(1);
        expect(deductOnly.items[0].action).toBe('DEDUCT');
    });

    it('listAdminAdjustments searches by user email and reason', async () => {
        const { customer, admin } = await setup();
        await adminWalletService.addFunds(customer._id, 15, 'Unique support review adjustment', admin._id);

        const byEmail = await adminWalletService.listAdminAdjustments({ search: customer.email });
        const byReason = await adminWalletService.listAdminAdjustments({ search: 'support review' });

        expect(byEmail.items).toHaveLength(1);
        expect(byEmail.items[0].user.email).toBe(customer.email);
        expect(byReason.items).toHaveLength(1);
        expect(byReason.items[0].reason).toBe('Unique support review adjustment');
    });

    it('listAdminAdjustments paginates results', async () => {
        const { customer, admin } = await setup();
        await adminWalletService.addFunds(customer._id, 1, 'First adjustment', admin._id);
        await adminWalletService.addFunds(customer._id, 2, 'Second adjustment', admin._id);
        await adminWalletService.addFunds(customer._id, 3, 'Third adjustment', admin._id);

        const result = await adminWalletService.listAdminAdjustments({ page: 2, limit: 2 });

        expect(result.items).toHaveLength(1);
        expect(result.pagination).toMatchObject({ page: 2, limit: 2, total: 3, pages: 2 });
    });

    it('admin adjustment access rejects non-admin roles at the route guard', () => {
        const req = { user: { role: 'CUSTOMER' } };
        const res = {};
        let caught = null;

        try {
            authorizeRoles('ADMIN', 'SUPERVISOR')(req, res, () => undefined);
        } catch (err) {
            caught = err;
        }

        expect(caught).toMatchObject({ code: 'AUTHORIZATION_ERROR' });
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

describe('[3.5] Admin Security PIN Service', () => {
    it('verify accepts legacy 1111 when no PIN hash is configured', async () => {
        await expect(adminSecurityPinService.verifyPin('1111')).resolves.toBe(true);
        await expect(adminSecurityPinService.getStatus()).resolves.toEqual({ configured: false });
    });

    it('change PIN with legacy currentPin stores a hash and creates an audit log', async () => {
        const { admin } = await setup();
        const result = await adminSecurityPinService.updatePin(
            { currentPin: '1111', newPin: '2580', confirmPin: '2580' },
            admin._id,
            { actorId: admin._id, actorRole: 'ADMIN', ipAddress: '127.0.0.1', userAgent: 'jest' }
        );

        expect(result).toEqual({ success: true, configured: true });

        const setting = await Setting.findOne({ key: adminSecurityPinService.ADMIN_SECURITY_PIN_HASH_KEY }).lean();
        expect(setting.value).toEqual(expect.any(String));
        expect(setting.value).not.toBe('2580');
        expect(setting.value).not.toBe('1111');
        expect(setting.value).toMatch(/^\$2[aby]\$/);

        const audit = await AuditLog.findOne({
            action: ADMIN_ACTIONS.SECURITY_PIN_UPDATED,
            entityType: 'SETTING',
            entityId: setting._id,
        }).lean();
        expect(audit).not.toBeNull();
        expect(audit.metadata).toEqual({ key: adminSecurityPinService.ADMIN_SECURITY_PIN_HASH_KEY });
        expect(JSON.stringify(audit.metadata)).not.toContain('2580');
        expect(JSON.stringify(audit.metadata)).not.toContain(setting.value);
    });

    it('after changing PIN, legacy 1111 no longer works and the new PIN verifies', async () => {
        const { admin } = await setup();
        await adminSecurityPinService.updatePin({ currentPin: '1111', newPin: '2580', confirmPin: '2580' }, admin._id);

        await expect(adminSecurityPinService.verifyPin('1111'))
            .rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR', message: 'Invalid security PIN' });
        await expect(adminSecurityPinService.verifyPin('2580')).resolves.toBe(true);
    });

    it('wrong PIN fails with a generic error', async () => {
        const { admin } = await setup();
        await adminSecurityPinService.updatePin({ currentPin: '1111', newPin: '2580', confirmPin: '2580' }, admin._id);

        await expect(adminSecurityPinService.verifyPin('9999'))
            .rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR', message: 'Invalid security PIN' });
    });

    it('new PIN must be exactly 4 digits', async () => {
        const { admin } = await setup();

        await expect(adminSecurityPinService.updatePin({ currentPin: '1111', newPin: '123', confirmPin: '123' }, admin._id))
            .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(adminSecurityPinService.updatePin({ currentPin: '1111', newPin: '12345', confirmPin: '12345' }, admin._id))
            .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(adminSecurityPinService.updatePin({ currentPin: '1111', newPin: '12a4', confirmPin: '12a4' }, admin._id))
            .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('confirmPin must match newPin', async () => {
        const { admin } = await setup();

        await expect(adminSecurityPinService.updatePin({ currentPin: '1111', newPin: '2580', confirmPin: '2581' }, admin._id))
            .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('PIN hash is not returned by status, verify, or change responses', async () => {
        const { admin } = await setup();
        const changeResponse = await adminSecurityPinService.updatePin({ currentPin: '1111', newPin: '2580', confirmPin: '2580' }, admin._id);
        const statusResponse = await adminSecurityPinService.getStatus();
        const verifyResponse = await adminSecurityPinService.verifyPin('2580');
        const setting = await Setting.findOne({ key: adminSecurityPinService.ADMIN_SECURITY_PIN_HASH_KEY }).lean();

        expect(JSON.stringify(changeResponse)).not.toContain(setting.value);
        expect(JSON.stringify(statusResponse)).not.toContain(setting.value);
        expect(JSON.stringify({ valid: verifyResponse })).not.toContain(setting.value);
    });

    it('generic settings APIs do not expose or update the PIN hash setting', async () => {
        const { admin } = await setup();
        await adminSecurityPinService.updatePin({ currentPin: '1111', newPin: '2580', confirmPin: '2580' }, admin._id);

        const settings = await adminSettingService.listSettings();
        expect(settings.map((setting) => setting.key)).not.toContain(adminSecurityPinService.ADMIN_SECURITY_PIN_HASH_KEY);
        await expect(adminSettingService.getSettingByKey(adminSecurityPinService.ADMIN_SECURITY_PIN_HASH_KEY))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(adminSettingService.updateSetting(adminSecurityPinService.ADMIN_SECURITY_PIN_HASH_KEY, 'plain', admin._id))
            .rejects.toMatchObject({ code: 'AUTHORIZATION_ERROR' });
    });

    it('normal customer cannot pass admin security PIN route guards', async () => {
        const { customer } = await setup();
        let roleError = null;

        try {
            authorizeRoles('ADMIN', 'SUPERVISOR')({ user: customer }, {}, () => undefined);
        } catch (err) {
            roleError = err;
        }

        expect(roleError).toMatchObject({ code: 'AUTHORIZATION_ERROR' });
    });

    it('supervisor requires admin_security_pin.manage permission for PIN endpoints', async () => {
        const { customer } = await setup();
        customer.role = 'SUPERVISOR';
        customer.permissions = ['orders.view'];
        let permissionError = null;

        try {
            requirePermission('admin_security_pin.manage')({ user: customer }, {}, () => undefined);
        } catch (err) {
            permissionError = err;
        }

        expect(permissionError).toMatchObject({ code: 'AUTHORIZATION_ERROR' });
    });
});

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

    it('walletAdjustment: accepts note and normalizes it to reason', () => {
        const mw = validateBody(schemas.walletAdjustment);
        const req = { body: { amount: 100, note: 'Admin note alias' } };
        let caught = undefined;

        mw(req, {}, (err) => { caught = err ?? null; });

        expect(caught).toBeNull();
        expect(req.body.reason).toBe('Admin note alias');
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
