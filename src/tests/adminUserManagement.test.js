'use strict';

const adminUsersService = require('../modules/admin/admin.users.service');
const authService = require('../modules/auth/auth.service');
const requireActiveUser = require('../shared/middlewares/requireActiveUser');
const { User, USER_STATUS } = require('../modules/users/user.model');
const { Currency } = require('../modules/currency/currency.model');
const {
    WalletTransaction,
    LEDGER_TRANSACTION_TYPES,
} = require('../modules/wallet/walletTransaction.model');
const { AuditLog } = require('../modules/audit/audit.model');
const { ADMIN_ACTIONS } = require('../modules/audit/audit.constants');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createAdmin,
} = require('./testHelpers');

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => { await clearCollections(); });

const waitForAudit = () => new Promise((resolve) => setTimeout(resolve, 20));

const seedCurrencies = async () => {
    await Currency.create([
        {
            code: 'USD',
            name: 'US Dollar',
            symbol: '$',
            marketRate: 1,
            platformRate: 1,
            isActive: true,
        },
        {
            code: 'EGP',
            name: 'Egyptian Pound',
            symbol: 'EGP',
            marketRate: 50,
            platformRate: 50,
            isActive: true,
        },
    ]);
};

const setup = async () => {
    const group = await createGroup({ name: `AdminUsers-${Date.now()}`, percentage: 0 });
    const admin = await createAdmin({ groupId: group._id });
    const customer = await createCustomer({ groupId: group._id });
    return { admin, customer, group };
};

describe('admin user wallet currency conversion', () => {
    it('converts 10 USD to 500 EGP and creates a neutral ledger/audit record', async () => {
        await seedCurrencies();
        const { admin, customer } = await setup();
        customer.walletBalance = 10;
        customer.currency = 'USD';
        await customer.save();

        const result = await adminUsersService.updateUserCurrency(customer._id, 'EGP', admin._id, 'QA conversion');
        await waitForAudit();

        expect(result.user.currency).toBe('EGP');
        expect(result.user.walletBalance).toBe(500);
        expect(result.wallet).toMatchObject({
            previousCurrency: 'USD',
            currency: 'EGP',
            previousBalance: 10,
            balance: 500,
        });
        expect(result.conversion.rateSnapshot).toMatchObject({ USD: 1, EGP: 50 });

        const tx = await WalletTransaction.findOne({ userId: customer._id });
        expect(tx).toMatchObject({
            semanticType: LEDGER_TRANSACTION_TYPES.ADMIN_CURRENCY_CONVERSION,
            direction: 'NEUTRAL',
            balanceBefore: 10,
            balanceAfter: 500,
            currency: 'EGP',
        });

        const audit = await AuditLog.findOne({
            entityId: customer._id,
            action: ADMIN_ACTIONS.USER_CURRENCY_CONVERTED,
        });
        expect(audit?.metadata).toMatchObject({
            previousCurrency: 'USD',
            newCurrency: 'EGP',
            previousBalance: 10,
            newBalance: 500,
        });
    });

    it('converts 500 EGP back to 10 USD', async () => {
        await seedCurrencies();
        const { admin, customer } = await setup();
        customer.walletBalance = 500;
        customer.currency = 'EGP';
        await customer.save();

        const result = await adminUsersService.updateUserCurrency(customer._id, 'USD', admin._id);

        expect(result.user.currency).toBe('USD');
        expect(result.user.walletBalance).toBe(10);
        expect(result.conversion).toMatchObject({
            fromCurrency: 'EGP',
            toCurrency: 'USD',
            fromAmount: 500,
            toAmount: 10,
        });
    });

    it('changes zero-balance wallet currency without creating a ledger transaction', async () => {
        await seedCurrencies();
        const { admin, customer } = await setup();
        customer.walletBalance = 0;
        customer.currency = 'USD';
        await customer.save();

        const result = await adminUsersService.updateUserCurrency(customer._id, 'EGP', admin._id);

        expect(result.user.currency).toBe('EGP');
        expect(result.user.walletBalance).toBe(0);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('rejects inactive currency and preserves customer self-change disablement', async () => {
        const { admin, customer } = await setup();
        await Currency.create({
            code: 'EGP',
            name: 'Egyptian Pound',
            symbol: 'EGP',
            platformRate: 50,
            isActive: false,
        });

        await expect(adminUsersService.updateUserCurrency(customer._id, 'EGP', admin._id))
            .rejects.toMatchObject({ code: 'INVALID_CURRENCY' });

        const userService = require('../modules/users/user.service');
        await expect(userService.updateMyCurrency(customer._id, 'EGP'))
            .rejects.toMatchObject({ code: 'CUSTOMER_CURRENCY_CHANGE_DISABLED' });
    });
});

describe('admin password reset and block/unblock', () => {
    it('admin resets a user password without returning password fields', async () => {
        const { admin, customer } = await setup();
        await adminUsersService.resetUserPassword(customer._id, 'NewPass123', admin._id);

        await expect(authService.login({ email: customer.email, password: 'HashedPass@1' }))
            .rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });

        const login = await authService.login({ email: customer.email, password: 'NewPass123' });
        expect(login.user.password).toBeUndefined();
        expect(login.user).not.toHaveProperty('password');
    });

    it('blocks login and active guarded actions, then unblocks login again', async () => {
        const { admin, customer } = await setup();

        const blocked = await adminUsersService.blockUser(customer._id, admin._id, 'risk review');
        expect(blocked.blockedAt).toBeTruthy();
        await expect(authService.login({ email: customer.email, password: 'HashedPass@1' }))
            .rejects.toMatchObject({ code: 'USER_BLOCKED' });

        const req = { user: await User.findById(customer._id) };
        expect(() => requireActiveUser(req, {}, () => {}))
            .toThrow(expect.objectContaining({ code: 'USER_BLOCKED' }));

        const unblocked = await adminUsersService.unblockUser(customer._id, admin._id, 'cleared');
        expect(unblocked.blockedAt).toBeNull();
        await expect(authService.login({ email: customer.email, password: 'HashedPass@1' }))
            .resolves.toHaveProperty('token');
    });

    it('does not allow an admin to block their own account', async () => {
        const { admin } = await setup();

        await expect(adminUsersService.blockUser(admin._id, admin._id, 'mistake'))
            .rejects.toMatchObject({ code: 'CANNOT_BLOCK_SELF' });
    });
});

describe('admin user filters and restore', () => {
    it('filters active, blocked, deleted, and all display states', async () => {
        const { admin, group } = await setup();
        const active = await createCustomer({ groupId: group._id, email: `active-${Date.now()}@test.com` });
        const blocked = await createCustomer({ groupId: group._id, email: `blocked-${Date.now()}@test.com` });
        const deleted = await createCustomer({ groupId: group._id, email: `deleted-${Date.now()}@test.com` });

        await adminUsersService.blockUser(blocked._id, admin._id, 'blocked filter');
        await adminUsersService.deleteUser(deleted._id, admin._id);

        const activeResult = await adminUsersService.listUsers({ status: 'active', limit: 20 });
        expect(activeResult.users.map((u) => String(u._id))).toContain(String(active._id));
        expect(activeResult.users.map((u) => String(u._id))).not.toContain(String(blocked._id));
        expect(activeResult.users.map((u) => String(u._id))).not.toContain(String(deleted._id));

        const blockedResult = await adminUsersService.listUsers({ status: 'blocked', limit: 20 });
        expect(blockedResult.users.map((u) => String(u._id))).toContain(String(blocked._id));

        const deletedResult = await adminUsersService.listUsers({ status: 'deleted', limit: 20 });
        expect(deletedResult.users.map((u) => String(u._id))).toContain(String(deleted._id));

        const allResult = await adminUsersService.listUsers({ status: 'all', limit: 20 });
        const allIds = allResult.users.map((u) => String(u._id));
        expect(allIds).toEqual(expect.arrayContaining([
            String(active._id),
            String(blocked._id),
            String(deleted._id),
        ]));
    });

    it('restores a deleted user and preserves blocked state when present', async () => {
        const { admin, customer } = await setup();
        customer.blockedAt = new Date();
        customer.blockedBy = admin._id;
        customer.blockReason = 'restore behavior';
        customer.deletedAt = new Date();
        customer.status = USER_STATUS.REJECTED;
        await customer.save();

        const restored = await adminUsersService.restoreUser(customer._id, admin._id);

        expect(restored.deletedAt).toBeNull();
        expect(restored.blockedAt).toBeTruthy();

        const blockedResult = await adminUsersService.listUsers({ status: 'blocked', limit: 20 });
        expect(blockedResult.users.map((u) => String(u._id))).toContain(String(customer._id));
    });
});
