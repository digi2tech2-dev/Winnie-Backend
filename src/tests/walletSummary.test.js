'use strict';

const meController = require('../modules/me/me.controller');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
} = require('./testHelpers');

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => {
    await clearCollections();
});

const callGetWallet = (user) => new Promise((resolve, reject) => {
    const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn((payload) => resolve({ statusCode: res.status.mock.calls[0][0], payload })),
    };
    meController.getWallet({ user: { _id: user._id } }, res, reject);
});

describe('Customer wallet summary aggregates', () => {
    it('returns zero aggregate fields for an empty wallet', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 0, currency: 'USD' });

        const { payload } = await callGetWallet(customer);

        expect(payload.data).toMatchObject({
            walletBalance: 0,
            currency: 'USD',
            recentTransactions: [],
            totalDeposits: 0,
            totalSpent: 0,
            totalRefunds: 0,
            transactionCount: 0,
            totalTransactions: 0,
        });
        expect(payload.data.lastTransactionAt).toBeNull();
    });

    it('sums completed credits, debits, refunds, and latest transaction date', async () => {
        const { customer } = await createCustomerWithGroup({ walletBalance: 75, currency: 'USD' });
        const base = {
            userId: customer._id,
            currency: 'USD',
            balanceBefore: 0,
            balanceAfter: 0,
            status: 'COMPLETED',
        };
        const credit = await WalletTransaction.create({ ...base, type: 'CREDIT', amount: 100, description: 'Deposit' });
        await WalletTransaction.create({ ...base, type: 'DEBIT', amount: 40, description: 'Order' });
        const refund = await WalletTransaction.create({ ...base, type: 'REFUND', amount: 15, description: 'Refund' });
        await WalletTransaction.create({ ...base, type: 'CREDIT', amount: 999, status: 'FAILED', description: 'Failed credit' });

        const { payload } = await callGetWallet(customer);

        expect(payload.data.totalDeposits).toBe(100);
        expect(payload.data.totalSpent).toBe(40);
        expect(payload.data.totalRefunds).toBe(15);
        expect(payload.data.transactionCount).toBe(3);
        expect(payload.data.totalTransactions).toBe(3);
        expect(new Date(payload.data.lastTransactionAt).getTime()).toBeGreaterThanOrEqual(credit.createdAt.getTime());
        expect(new Date(payload.data.lastTransactionAt).getTime()).toBeGreaterThanOrEqual(refund.createdAt.getTime());
    });
});
