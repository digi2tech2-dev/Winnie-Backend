'use strict';

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
    createCustomerWithGroup,
} = require('./testHelpers');

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => { await clearCollections(); });

describe('Wallet ledger taxonomy', () => {
    it('defaults legacy transaction records to compatible semantic fields', async () => {
        const { customer } = await createCustomerWithGroup();

        const tx = await WalletTransaction.create({
            userId: customer._id,
            type: TRANSACTION_TYPES.CREDIT,
            amount: 25,
            balanceBefore: 0,
            balanceAfter: 25,
            description: 'Legacy credit',
        });

        expect(tx.type).toBe(TRANSACTION_TYPES.CREDIT);
        expect(tx.semanticType).toBe(LEDGER_TRANSACTION_TYPES.CREDIT);
        expect(tx.direction).toBe(TRANSACTION_DIRECTIONS.CREDIT);
        expect(tx.currency).toBe('USD');
    });

    it('allows reserved future semantic types without using them in active flows', async () => {
        const { customer } = await createCustomerWithGroup();

        const tx = await WalletTransaction.create({
            userId: customer._id,
            type: TRANSACTION_TYPES.CREDIT,
            semanticType: LEDGER_TRANSACTION_TYPES.CARD_PAYMENT_SUCCESS,
            sourceType: TRANSACTION_SOURCE_TYPES.CARD_PAYMENT,
            direction: TRANSACTION_DIRECTIONS.CREDIT,
            amount: 40,
            balanceBefore: 10,
            balanceAfter: 50,
            currency: 'USD',
            description: 'Reserved card payment semantic type',
            idempotencyKey: `test-card-success-${customer._id.toString()}`,
        });

        expect(tx.semanticType).toBe(LEDGER_TRANSACTION_TYPES.CARD_PAYMENT_SUCCESS);
        expect(tx.sourceType).toBe(TRANSACTION_SOURCE_TYPES.CARD_PAYMENT);
    });

    it('rejects duplicate idempotency keys', async () => {
        const { customer } = await createCustomerWithGroup();
        const idempotencyKey = `wallet-ledger-${customer._id.toString()}`;

        await WalletTransaction.create({
            userId: customer._id,
            type: TRANSACTION_TYPES.CREDIT,
            semanticType: LEDGER_TRANSACTION_TYPES.DEPOSIT_APPROVED,
            sourceType: TRANSACTION_SOURCE_TYPES.DEPOSIT,
            direction: TRANSACTION_DIRECTIONS.CREDIT,
            amount: 10,
            balanceBefore: 0,
            balanceAfter: 10,
            currency: 'USD',
            description: 'First ledger entry',
            idempotencyKey,
        });

        await expect(WalletTransaction.create({
            userId: customer._id,
            type: TRANSACTION_TYPES.CREDIT,
            semanticType: LEDGER_TRANSACTION_TYPES.DEPOSIT_APPROVED,
            sourceType: TRANSACTION_SOURCE_TYPES.DEPOSIT,
            direction: TRANSACTION_DIRECTIONS.CREDIT,
            amount: 10,
            balanceBefore: 10,
            balanceAfter: 20,
            currency: 'USD',
            description: 'Duplicate ledger entry',
            idempotencyKey,
        })).rejects.toMatchObject({ code: 11000 });
    });
});
