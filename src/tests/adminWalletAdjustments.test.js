'use strict';

const jwt = require('jsonwebtoken');
const app = require('../app');
const config = require('../config/config');
const adminWalletService = require('../modules/admin/admin.wallet.service');
const {
    WalletTransaction,
    TRANSACTION_TYPES,
    LEDGER_TRANSACTION_TYPES,
    TRANSACTION_DIRECTIONS,
    TRANSACTION_SOURCE_TYPES,
} = require('../modules/wallet/walletTransaction.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createAdmin,
    createCustomer,
    createGroup,
} = require('./testHelpers');

let server;
let baseUrl;

beforeAll(async () => {
    await connectTestDB();
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}/api`;
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

const tokenFor = (user) => jwt.sign({ id: user._id, role: user.role }, config.jwt.secret, { expiresIn: '1h' });

const setup = async () => {
    const group = await createGroup({ name: `WalletAdjustments-${Date.now()}` });
    const admin = await createAdmin({ groupId: group._id });
    const usdCustomer = await createCustomer({
        groupId: group._id,
        currency: 'USD',
        email: `usd-${Date.now()}@test.com`,
        name: 'USD Customer',
    });
    const egpCustomer = await createCustomer({
        groupId: group._id,
        currency: 'EGP',
        email: `egp-${Date.now()}@test.com`,
        name: 'EGP Customer',
    });

    return { admin, egpCustomer, group, usdCustomer };
};

const setCreatedAt = async (transaction, value) => {
    const date = new Date(value);
    await transaction.constructor.collection.updateOne(
        { _id: transaction._id },
        { $set: { createdAt: date, updatedAt: date } }
    );
};

const seedLedgerAdminAdjustment = ({
    actorId,
    amount,
    currency,
    direction,
    reason,
    userId,
}) => WalletTransaction.create({
    userId,
    type: direction === TRANSACTION_DIRECTIONS.DEBIT ? TRANSACTION_TYPES.DEBIT : TRANSACTION_TYPES.CREDIT,
    semanticType: LEDGER_TRANSACTION_TYPES.ADMIN_ADJUSTMENT,
    sourceType: TRANSACTION_SOURCE_TYPES.ADMIN_ADJUSTMENT,
    direction,
    amount,
    balanceBefore: direction === TRANSACTION_DIRECTIONS.DEBIT ? amount : 0,
    balanceAfter: direction === TRANSACTION_DIRECTIONS.DEBIT ? 0 : amount,
    currency,
    status: 'COMPLETED',
    description: reason,
    reason,
    actorId,
    actorRole: 'ADMIN',
    metadata: { reason },
});

describe('admin wallet adjustments listing', () => {
    it('admin can fetch wallet adjustments', async () => {
        const { admin, egpCustomer, usdCustomer } = await setup();
        await adminWalletService.addFunds(usdCustomer._id, 1000, 'Admin credit route test', admin._id);
        await adminWalletService.addFunds(egpCustomer._id, 500, 'Admin EGP route test', admin._id);

        const response = await fetch(`${baseUrl}/admin/wallet-adjustments`, {
            headers: { authorization: `Bearer ${tokenFor(admin)}` },
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.items).toHaveLength(2);
        expect(body.data.pagination).toMatchObject({ total: 2 });
        expect(body.data.summary).toBeDefined();
        expect(body.summary.count).toBe(2);
        expect(body.data.summary.count).toBe(body.data.pagination.total);
        expect(body.summary.mode).toBe('grouped');
        expect(body.data.summary.totalsByCurrency).toEqual(expect.arrayContaining([
            expect.objectContaining({ currency: 'USD', totalAdditions: 1000 }),
            expect.objectContaining({ currency: 'EGP', totalAdditions: 500 }),
        ]));
    });

    it('non-admin cannot fetch wallet adjustments', async () => {
        const { usdCustomer } = await setup();

        const response = await fetch(`${baseUrl}/admin/wallet-adjustments`, {
            headers: { authorization: `Bearer ${tokenFor(usdCustomer)}` },
        });

        expect(response.status).toBe(403);
    });

    it('summary includes credit additions, debit deductions, and net', async () => {
        const { admin, usdCustomer } = await setup();
        await adminWalletService.addFunds(usdCustomer._id, 1000, 'Credit adjustment', admin._id);
        await adminWalletService.deductFunds(usdCustomer._id, 250, 'Debit adjustment', admin._id);

        const result = await adminWalletService.listAdminAdjustments({ currency: 'USD' });

        expect(result.summary).toMatchObject({
            count: 2,
            currency: 'USD',
            mode: 'single',
            totalAdded: 1000,
            totalAdditions: 1000,
            totalDeducted: 250,
            totalDeductions: 250,
            net: 750,
        });
    });

    it('currency filter returns matching rows only and summary uses the same filter', async () => {
        const { admin, egpCustomer, usdCustomer } = await setup();
        await adminWalletService.addFunds(usdCustomer._id, 1000, 'USD only', admin._id);
        await adminWalletService.addFunds(egpCustomer._id, 500, 'EGP only', admin._id);

        const result = await adminWalletService.listAdminAdjustments({ currency: 'EGP' });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].currency).toBe('EGP');
        expect(result.summary).toMatchObject({
            count: 1,
            currency: 'EGP',
            mode: 'single',
            totalAdded: 500,
            net: 500,
        });
    });

    it('mixed currencies are grouped instead of summed into one unlabeled total', async () => {
        const { admin, egpCustomer, usdCustomer } = await setup();
        await adminWalletService.addFunds(usdCustomer._id, 1000, 'USD mixed', admin._id);
        await adminWalletService.addFunds(egpCustomer._id, 500, 'EGP mixed', admin._id);

        const result = await adminWalletService.listAdminAdjustments();

        expect(result.summary.count).toBe(2);
        expect(result.summary.mode).toBe('grouped');
        expect(result.summary.currency).toBeNull();
        expect(result.summary.totalAdded).toBeNull();
        expect(result.summary.totalsByCurrency).toEqual(expect.arrayContaining([
            expect.objectContaining({ currency: 'USD', totalAdded: 1000, net: 1000 }),
            expect.objectContaining({ currency: 'EGP', totalAdded: 500, net: 500 }),
        ]));
    });

    it('aggregates realistic ledger direction rows by currency without metadata.operation', async () => {
        const { admin, egpCustomer, usdCustomer } = await setup();
        await seedLedgerAdminAdjustment({
            actorId: admin._id,
            userId: usdCustomer._id,
            amount: 100,
            currency: 'USD',
            direction: TRANSACTION_DIRECTIONS.CREDIT,
            reason: 'Ledger USD credit',
        });
        await seedLedgerAdminAdjustment({
            actorId: admin._id,
            userId: egpCustomer._id,
            amount: 46000,
            currency: 'EGP',
            direction: TRANSACTION_DIRECTIONS.DEBIT,
            reason: 'Ledger EGP debit',
        });

        const response = await fetch(`${baseUrl}/admin/wallet-adjustments`, {
            headers: { authorization: `Bearer ${tokenFor(admin)}` },
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.items).toHaveLength(2);
        expect(body.data.pagination).toMatchObject({ total: 2 });
        expect(body.data.summary).toBeDefined();
        expect(body.data.summary.count).toBe(body.data.pagination.total);
        expect(body.data.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ currency: 'USD', action: 'ADD', amount: 100 }),
            expect.objectContaining({ currency: 'EGP', action: 'DEDUCT', amount: 46000 }),
        ]));
        expect(body.data.summary).toMatchObject({ count: 2, mode: 'grouped' });
        expect(body.data.summary.totalsByCurrency).toEqual(expect.arrayContaining([
            expect.objectContaining({
                currency: 'USD',
                totalAdditions: 100,
                totalDeductions: 0,
                net: 100,
            }),
            expect.objectContaining({
                currency: 'EGP',
                totalAdditions: 0,
                totalDeductions: 46000,
                net: -46000,
            }),
        ]));
    });

    it('aggregates realistic ledger USD currency filter as a single summary', async () => {
        const { admin, egpCustomer, usdCustomer } = await setup();
        await seedLedgerAdminAdjustment({
            actorId: admin._id,
            userId: usdCustomer._id,
            amount: 100,
            currency: 'USD',
            direction: TRANSACTION_DIRECTIONS.CREDIT,
            reason: 'Ledger USD credit',
        });
        await seedLedgerAdminAdjustment({
            actorId: admin._id,
            userId: egpCustomer._id,
            amount: 46000,
            currency: 'EGP',
            direction: TRANSACTION_DIRECTIONS.DEBIT,
            reason: 'Ledger EGP debit',
        });

        const response = await fetch(`${baseUrl}/admin/wallet-adjustments?currency=USD`, {
            headers: { authorization: `Bearer ${tokenFor(admin)}` },
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.items).toHaveLength(1);
        expect(body.data.pagination).toMatchObject({ total: 1 });
        expect(body.data.summary).toBeDefined();
        expect(body.data.summary.count).toBe(body.data.pagination.total);
        expect(body.data.items[0]).toMatchObject({ currency: 'USD', action: 'ADD', amount: 100 });
        expect(body.data.summary).toMatchObject({
            count: 1,
            mode: 'single',
            currency: 'USD',
            totalAdditions: 100,
            totalDeductions: 0,
            net: 100,
        });
    });

    it('aggregates realistic ledger EGP currency filter as a single summary', async () => {
        const { admin, egpCustomer, usdCustomer } = await setup();
        await seedLedgerAdminAdjustment({
            actorId: admin._id,
            userId: usdCustomer._id,
            amount: 100,
            currency: 'USD',
            direction: TRANSACTION_DIRECTIONS.CREDIT,
            reason: 'Ledger USD credit',
        });
        await seedLedgerAdminAdjustment({
            actorId: admin._id,
            userId: egpCustomer._id,
            amount: 46000,
            currency: 'EGP',
            direction: TRANSACTION_DIRECTIONS.DEBIT,
            reason: 'Ledger EGP debit',
        });

        const response = await fetch(`${baseUrl}/admin/wallet-adjustments?currency=EGP`, {
            headers: { authorization: `Bearer ${tokenFor(admin)}` },
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.items).toHaveLength(1);
        expect(body.data.pagination).toMatchObject({ total: 1 });
        expect(body.data.summary).toBeDefined();
        expect(body.data.summary.count).toBe(body.data.pagination.total);
        expect(body.data.items[0]).toMatchObject({ currency: 'EGP', action: 'DEDUCT', amount: 46000 });
        expect(body.data.summary).toMatchObject({
            count: 1,
            mode: 'single',
            currency: 'EGP',
            totalAdditions: 0,
            totalDeductions: 46000,
            net: -46000,
        });
    });

    it('empty currency-filtered result returns zero totals for that currency', async () => {
        const { admin, usdCustomer } = await setup();
        await adminWalletService.addFunds(usdCustomer._id, 25, 'USD only empty EGP test', admin._id);

        const result = await adminWalletService.listAdminAdjustments({ currency: 'EGP' });

        expect(result.items).toHaveLength(0);
        expect(result.summary).toMatchObject({
            count: 0,
            currency: 'EGP',
            mode: 'single',
            totalAdded: 0,
            totalDeducted: 0,
            net: 0,
        });
    });

    it('search filter works for user email and reason', async () => {
        const { admin, usdCustomer } = await setup();
        await adminWalletService.addFunds(usdCustomer._id, 75, 'Unique search reason', admin._id);

        const byEmail = await adminWalletService.listAdminAdjustments({ search: usdCustomer.email });
        const byReason = await adminWalletService.listAdminAdjustments({ search: 'Unique search' });

        expect(byEmail.items).toHaveLength(1);
        expect(byReason.items).toHaveLength(1);
        expect(byReason.summary.totalAdded).toBe(75);
    });

    it('type aliases credit and debit filter rows and summaries', async () => {
        const { admin, usdCustomer } = await setup();
        await adminWalletService.addFunds(usdCustomer._id, 80, 'Credit alias', admin._id);
        await adminWalletService.deductFunds(usdCustomer._id, 30, 'Debit alias', admin._id);

        const creditOnly = await adminWalletService.listAdminAdjustments({ type: 'credit', currency: 'USD' });
        const debitOnly = await adminWalletService.listAdminAdjustments({ type: 'debit', currency: 'USD' });

        expect(creditOnly.items).toHaveLength(1);
        expect(creditOnly.items[0].action).toBe('ADD');
        expect(creditOnly.summary.totalAdded).toBe(80);
        expect(creditOnly.summary.totalDeducted).toBe(0);
        expect(debitOnly.items).toHaveLength(1);
        expect(debitOnly.items[0].action).toBe('DEDUCT');
        expect(debitOnly.summary.totalAdded).toBe(0);
        expect(debitOnly.summary.totalDeducted).toBe(30);
    });

    it('date and min/max filters apply to summary and table together', async () => {
        const { admin, usdCustomer } = await setup();
        const oldTx = (await adminWalletService.addFunds(usdCustomer._id, 20, 'Old small', admin._id)).transaction;
        const inRangeTx = (await adminWalletService.addFunds(usdCustomer._id, 150, 'Current medium', admin._id)).transaction;
        const tooLargeTx = (await adminWalletService.addFunds(usdCustomer._id, 500, 'Current large', admin._id)).transaction;

        await setCreatedAt(oldTx, '2026-06-01T12:00:00.000Z');
        await setCreatedAt(inRangeTx, '2026-07-05T12:00:00.000Z');
        await setCreatedAt(tooLargeTx, '2026-07-06T12:00:00.000Z');

        const result = await adminWalletService.listAdminAdjustments({
            currency: 'USD',
            dateFrom: '2026-07-01',
            dateTo: '2026-07-10',
            minAmount: 100,
            maxAmount: 200,
        });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].amount).toBe(150);
        expect(result.summary).toMatchObject({
            count: 1,
            totalAdded: 150,
            net: 150,
        });
    });

    it('currency="" behaves like no currency filter', async () => {
        const { admin, egpCustomer, usdCustomer } = await setup();
        await adminWalletService.addFunds(usdCustomer._id, 100, 'USD empty filter', admin._id);
        await adminWalletService.deductFunds(egpCustomer._id, 40, 'EGP empty filter', admin._id);

        const response = await fetch(`${baseUrl}/admin/wallet-adjustments?currency=`, {
            headers: { authorization: `Bearer ${tokenFor(admin)}` },
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.items).toHaveLength(2);
        expect(body.summary).toMatchObject({ count: 2, mode: 'grouped' });
        expect(body.summary.totalsByCurrency).toEqual(expect.arrayContaining([
            expect.objectContaining({ currency: 'USD', totalAdditions: 100, net: 100 }),
            expect.objectContaining({ currency: 'EGP', totalDeductions: 40, net: -40 }),
        ]));
    });

    it('currency=USD route returns only USD rows and USD summary', async () => {
        const { admin, egpCustomer, usdCustomer } = await setup();
        await adminWalletService.addFunds(usdCustomer._id, 100, 'USD route filter', admin._id);
        await adminWalletService.addFunds(egpCustomer._id, 500, 'EGP excluded route filter', admin._id);

        const response = await fetch(`${baseUrl}/admin/wallet-adjustments?currency=USD`, {
            headers: { authorization: `Bearer ${tokenFor(admin)}` },
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.items).toHaveLength(1);
        expect(body.data.items[0].currency).toBe('USD');
        expect(body.summary).toMatchObject({
            count: 1,
            currency: 'USD',
            mode: 'single',
            totalAdditions: 100,
            net: 100,
        });
    });

    it('currency=EGP route returns only EGP rows and EGP summary', async () => {
        const { admin, egpCustomer, usdCustomer } = await setup();
        await adminWalletService.addFunds(usdCustomer._id, 100, 'USD excluded route filter', admin._id);
        await adminWalletService.deductFunds(egpCustomer._id, 45, 'EGP route filter', admin._id);

        const response = await fetch(`${baseUrl}/admin/wallet-adjustments?currency=EGP`, {
            headers: { authorization: `Bearer ${tokenFor(admin)}` },
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.items).toHaveLength(1);
        expect(body.data.items[0].currency).toBe('EGP');
        expect(body.summary).toMatchObject({
            count: 1,
            currency: 'EGP',
            mode: 'single',
            totalDeductions: 45,
            net: -45,
        });
    });

    it('currency=U fails with a controlled validation response', async () => {
        const { admin } = await setup();

        const response = await fetch(`${baseUrl}/admin/wallet-adjustments?currency=U`, {
            headers: { authorization: `Bearer ${tokenFor(admin)}` },
        });
        const body = await response.json();

        expect(response.status).toBe(422);
        expect(body.message).toContain('Please choose a valid 3-letter currency code');
        expect(body.message).not.toContain('/^[A-Z]{3}$/');
    });
});
