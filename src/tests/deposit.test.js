'use strict';

/**
 * Deposit Request System Test Suite
 *
 * Current baseline contract:
 * - deposit requests use requestedAmount, paymentMethodId, currency,
 *   exchangeRate, amountUsd, and receiptImage.
 * - only one PENDING deposit is allowed per user.
 * - approval credits the user's wallet in the user's wallet currency.
 */

const mongoose = require('mongoose');
const { DepositRequest, DEPOSIT_STATUS } = require('../modules/deposits/deposit.model');
const depositService = require('../modules/deposits/deposit.service');
const { AuditLog } = require('../modules/audit/audit.model');
const { DEPOSIT_ACTIONS, WALLET_ACTIONS, ENTITY_TYPES } = require('../modules/audit/audit.constants');
const { User } = require('../modules/users/user.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');

const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createAdmin,
} = require('./testHelpers');

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

const flushAudit = () => new Promise((resolve) => setTimeout(resolve, 100));

const VALID_DEPOSIT = {
    paymentMethodId: 'bank-transfer-usd',
    requestedAmount: 500,
    currency: 'USD',
    exchangeRate: 1,
    amountUsd: 500,
    receiptImage: 'uploads/deposits/test-receipt.jpg',
    notes: 'Test receipt uploaded',
};

let group;
const ensureGroup = async () => {
    if (!group) group = await createGroup({ name: 'Default', percentage: 0 });
    return group;
};

beforeEach(() => {
    group = null;
});

const makeCustomer = async (overrides = {}) => {
    const defaultGroup = await ensureGroup();
    return createCustomer({
        groupId: defaultGroup._id,
        currency: 'USD',
        ...overrides,
    });
};

const createPendingDeposit = async (userId, overrides = {}) => (
    depositService.createDepositRequest({
        userId,
        ...VALID_DEPOSIT,
        ...overrides,
    })
);

describe('[1] Model validation', () => {
    let userId;

    beforeEach(async () => {
        const customer = await makeCustomer();
        userId = customer._id;
    });

    it('creates a valid deposit request with all required fields', async () => {
        const doc = await DepositRequest.create({ userId, ...VALID_DEPOSIT });
        expect(doc._id).toBeDefined();
        expect(doc.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(doc.paymentMethodId).toBe(VALID_DEPOSIT.paymentMethodId);
        expect(doc.requestedAmount).toBe(500);
        expect(doc.currency).toBe('USD');
        expect(doc.exchangeRate).toBe(1);
        expect(doc.amountUsd).toBe(500);
        expect(doc.receiptImage).toBe(VALID_DEPOSIT.receiptImage);
        expect(doc.reviewedBy).toBeNull();
        expect(doc.reviewedAt).toBeNull();
    });

    it('rejects when userId is missing', async () => {
        await expect(DepositRequest.create({ ...VALID_DEPOSIT }))
            .rejects.toThrow(/userId is required/);
    });

    it('rejects when paymentMethodId is missing', async () => {
        const { paymentMethodId, ...payload } = VALID_DEPOSIT;
        await expect(DepositRequest.create({ userId, ...payload }))
            .rejects.toThrow(/paymentMethodId is required/);
    });

    it('rejects when requestedAmount is missing', async () => {
        const { requestedAmount, ...payload } = VALID_DEPOSIT;
        await expect(DepositRequest.create({ userId, ...payload }))
            .rejects.toThrow(/requestedAmount is required/);
    });

    it('rejects when requestedAmount <= 0', async () => {
        await expect(DepositRequest.create({ userId, ...VALID_DEPOSIT, requestedAmount: 0 }))
            .rejects.toThrow(/greater than 0/);
    });

    it('rejects when currency is missing', async () => {
        const { currency, ...payload } = VALID_DEPOSIT;
        await expect(DepositRequest.create({ userId, ...payload }))
            .rejects.toThrow(/currency is required/);
    });

    it('rejects invalid currency codes', async () => {
        await expect(DepositRequest.create({ userId, ...VALID_DEPOSIT, currency: 'US' }))
            .rejects.toThrow(/3-letter ISO 4217/);
    });

    it('rejects when exchangeRate is missing', async () => {
        const { exchangeRate, ...payload } = VALID_DEPOSIT;
        await expect(DepositRequest.create({ userId, ...payload }))
            .rejects.toThrow(/exchangeRate is required/);
    });

    it('rejects when amountUsd is missing', async () => {
        const { amountUsd, ...payload } = VALID_DEPOSIT;
        await expect(DepositRequest.create({ userId, ...payload }))
            .rejects.toThrow(/amountUsd is required/);
    });

    it('rejects when receiptImage is missing', async () => {
        const { receiptImage, ...payload } = VALID_DEPOSIT;
        await expect(DepositRequest.create({ userId, ...payload }))
            .rejects.toThrow(/receiptImage is required/);
    });

    it('rejects invalid status value', async () => {
        await expect(DepositRequest.create({ userId, ...VALID_DEPOSIT, status: 'INVALID_STATUS' }))
            .rejects.toThrow();
    });

    it('exposes status virtuals', async () => {
        const approved = await DepositRequest.create({
            userId,
            ...VALID_DEPOSIT,
            status: DEPOSIT_STATUS.APPROVED,
        });
        const rejected = await DepositRequest.create({
            userId,
            ...VALID_DEPOSIT,
            paymentMethodId: 'bank-transfer-usd-2',
            receiptImage: 'uploads/deposits/test-receipt-2.jpg',
            status: DEPOSIT_STATUS.REJECTED,
        });
        const pending = await DepositRequest.create({
            userId,
            ...VALID_DEPOSIT,
            paymentMethodId: 'bank-transfer-usd-3',
            receiptImage: 'uploads/deposits/test-receipt-3.jpg',
        });

        expect(approved.isApproved).toBe(true);
        expect(approved.isRejected).toBe(false);
        expect(approved.isPending).toBe(false);
        expect(rejected.isRejected).toBe(true);
        expect(pending.isPending).toBe(true);
    });
});

describe('[2] createDepositRequest', () => {
    let customer;

    beforeEach(async () => {
        customer = await makeCustomer();
    });

    it('creates a PENDING deposit request with current fields', async () => {
        const deposit = await createPendingDeposit(customer._id);

        expect(deposit.status).toBe(DEPOSIT_STATUS.PENDING);
        expect(deposit.userId.toString()).toBe(customer._id.toString());
        expect(deposit.paymentMethodId).toBe(VALID_DEPOSIT.paymentMethodId);
        expect(deposit.requestedAmount).toBe(500);
        expect(deposit.currency).toBe('USD');
        expect(deposit.exchangeRate).toBe(1);
        expect(deposit.amountUsd).toBe(500);
        expect(deposit.receiptImage).toBe(VALID_DEPOSIT.receiptImage);
        expect(deposit.reviewedBy).toBeNull();
    });

    it('persists to the database', async () => {
        const deposit = await createPendingDeposit(customer._id);
        const found = await DepositRequest.findById(deposit._id);

        expect(found).not.toBeNull();
        expect(found.status).toBe(DEPOSIT_STATUS.PENDING);
    });

    it('creates DEPOSIT_REQUESTED audit log', async () => {
        const deposit = await createPendingDeposit(customer._id);
        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.REQUESTED }).lean();
        expect(log).not.toBeNull();
        expect(log.entityType).toBe(ENTITY_TYPES.DEPOSIT);
        expect(log.entityId.toString()).toBe(deposit._id.toString());
        expect(log.metadata.requestedAmount).toBe(500);
        expect(log.metadata.paymentMethodId).toBe(VALID_DEPOSIT.paymentMethodId);
        expect(log.metadata.currency).toBe('USD');
        expect(log.metadata.amountUsd).toBe(500);
    });

    it('rejects a second pending deposit for the same user', async () => {
        await createPendingDeposit(customer._id);

        await expect(
            createPendingDeposit(customer._id, { requestedAmount: 200, amountUsd: 200 })
        ).rejects.toMatchObject({ code: 'DUPLICATE_PENDING_DEPOSIT' });
    });
});

describe('[3] approveDeposit', () => {
    let customer;
    let admin;
    let deposit;

    beforeEach(async () => {
        customer = await makeCustomer({ walletBalance: 0 });
        admin = await createAdmin();
        deposit = await createPendingDeposit(customer._id);
    });

    it('transitions status PENDING to APPROVED', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);
        const updated = await DepositRequest.findById(deposit._id);
        expect(updated.status).toBe(DEPOSIT_STATUS.APPROVED);
    });

    it('sets reviewedBy and reviewedAt on approval', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);
        const updated = await DepositRequest.findById(deposit._id);

        expect(updated.reviewedBy.toString()).toBe(admin._id.toString());
        expect(updated.reviewedAt).toBeInstanceOf(Date);
    });

    it('credits the user wallet by the approved amount in matching currency', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);
        const after = await User.findById(customer._id);
        expect(after.walletBalance).toBe(500);
    });

    it('creates a WalletTransaction CREDIT record', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);

        const tx = await WalletTransaction.findOne({ userId: customer._id, type: 'CREDIT' });
        expect(tx).not.toBeNull();
        expect(tx.amount).toBe(500);
        expect(tx.balanceBefore).toBe(0);
        expect(tx.balanceAfter).toBe(500);
        expect(tx.semanticType).toBe('DEPOSIT_APPROVED');
        expect(tx.sourceType).toBe('DEPOSIT');
        expect(tx.sourceId.toString()).toBe(deposit._id.toString());
        expect(tx.direction).toBe('CREDIT');
        expect(tx.currency).toBe('USD');
        expect(tx.idempotencyKey).toBe(`deposit:${deposit._id.toString()}:approved`);
    });

    it('uses admin amount override when provided', async () => {
        await depositService.approveDeposit(deposit._id, admin._id, { amount: 300 });

        const updated = await DepositRequest.findById(deposit._id);
        expect(updated.requestedAmount).toBe(300);

        const after = await User.findById(customer._id);
        expect(after.walletBalance).toBe(300);
    });

    it('creates DEPOSIT_APPROVED and WALLET_CREDIT audit logs', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);
        await flushAudit();

        const approveLog = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.APPROVED }).lean();
        expect(approveLog).not.toBeNull();
        expect(approveLog.entityType).toBe(ENTITY_TYPES.DEPOSIT);
        expect(approveLog.metadata.finalAmount).toBe(500);
        expect(approveLog.metadata.finalCurrency).toBe('USD');
        expect(approveLog.metadata.originalRequestedAmount).toBe(500);
        expect(approveLog.metadata.walletCreditAmount).toBe(500);

        const walletLog = await AuditLog.findOne({ action: WALLET_ACTIONS.CREDIT }).lean();
        expect(walletLog).not.toBeNull();
        expect(walletLog.entityType).toBe(ENTITY_TYPES.WALLET);
        expect(walletLog.entityId.toString()).toBe(customer._id.toString());
        expect(walletLog.metadata.walletCreditAmount).toBe(500);
    });

    it('throws DEPOSIT_ALREADY_APPROVED when approving a second time', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);

        await expect(depositService.approveDeposit(deposit._id, admin._id))
            .rejects.toMatchObject({ code: 'DEPOSIT_ALREADY_APPROVED' });
    });

    it('throws DEPOSIT_ALREADY_REJECTED when approving a rejected deposit', async () => {
        await depositService.rejectDeposit(deposit._id, admin._id);

        await expect(depositService.approveDeposit(deposit._id, admin._id))
            .rejects.toMatchObject({ code: 'DEPOSIT_ALREADY_REJECTED' });
    });

    it('throws NotFoundError for a non-existent deposit ID', async () => {
        await expect(depositService.approveDeposit(new mongoose.Types.ObjectId(), admin._id))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('does not credit wallet twice when approval fails', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);
        const balanceAfterFirst = (await User.findById(customer._id)).walletBalance;

        await expect(depositService.approveDeposit(deposit._id, admin._id))
            .rejects.toBeDefined();

        const balanceAfterSecond = (await User.findById(customer._id)).walletBalance;
        expect(balanceAfterSecond).toBe(balanceAfterFirst);
    });
});

describe('[4] rejectDeposit', () => {
    let customer;
    let admin;
    let deposit;

    beforeEach(async () => {
        customer = await makeCustomer({ walletBalance: 0 });
        admin = await createAdmin();
        deposit = await createPendingDeposit(customer._id);
    });

    it('transitions status PENDING to REJECTED', async () => {
        await depositService.rejectDeposit(deposit._id, admin._id);
        const updated = await DepositRequest.findById(deposit._id);
        expect(updated.status).toBe(DEPOSIT_STATUS.REJECTED);
    });

    it('sets reviewedBy and reviewedAt on rejection', async () => {
        await depositService.rejectDeposit(deposit._id, admin._id);
        const updated = await DepositRequest.findById(deposit._id);

        expect(updated.reviewedBy.toString()).toBe(admin._id.toString());
        expect(updated.reviewedAt).toBeInstanceOf(Date);
    });

    it('does not credit the wallet on rejection', async () => {
        const before = (await User.findById(customer._id)).walletBalance;
        await depositService.rejectDeposit(deposit._id, admin._id);
        const after = (await User.findById(customer._id)).walletBalance;

        expect(after).toBe(before);
    });

    it('does not create a WalletTransaction on rejection', async () => {
        await depositService.rejectDeposit(deposit._id, admin._id);
        const count = await WalletTransaction.countDocuments({ userId: customer._id });
        expect(count).toBe(0);
    });

    it('creates DEPOSIT_REJECTED audit log', async () => {
        await depositService.rejectDeposit(deposit._id, admin._id, 'Receipt unclear');
        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.REJECTED }).lean();
        expect(log).not.toBeNull();
        expect(log.entityId.toString()).toBe(deposit._id.toString());
        expect(log.actorId.toString()).toBe(admin._id.toString());
        expect(log.metadata.reviewedBy).toBe(admin._id.toString());
        expect(log.metadata.adminNotes).toBe('Receipt unclear');
    });

    it('throws DEPOSIT_ALREADY_REJECTED when rejecting a second time', async () => {
        await depositService.rejectDeposit(deposit._id, admin._id);

        await expect(depositService.rejectDeposit(deposit._id, admin._id))
            .rejects.toMatchObject({ code: 'DEPOSIT_ALREADY_REJECTED' });
    });

    it('throws DEPOSIT_ALREADY_APPROVED when rejecting an approved deposit', async () => {
        await depositService.approveDeposit(deposit._id, admin._id);

        await expect(depositService.rejectDeposit(deposit._id, admin._id))
            .rejects.toMatchObject({ code: 'DEPOSIT_ALREADY_APPROVED' });
    });

    it('throws NotFoundError for a non-existent deposit ID', async () => {
        await expect(depositService.rejectDeposit(new mongoose.Types.ObjectId(), admin._id))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
});

describe('[5] Concurrency', () => {
    it('two concurrent approve calls: only one succeeds, wallet credited once', async () => {
        const customer = await makeCustomer({ walletBalance: 0 });
        const admin = await createAdmin();
        const deposit = await createPendingDeposit(customer._id);

        const results = await Promise.allSettled([
            depositService.approveDeposit(deposit._id, admin._id),
            depositService.approveDeposit(deposit._id, admin._id),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

        const user = await User.findById(customer._id);
        expect(user.walletBalance).toBe(500);

        const txCount = await WalletTransaction.countDocuments({ userId: customer._id, type: 'CREDIT' });
        expect(txCount).toBe(1);
    });
});

describe('[6] listDeposits / listMyDeposits', () => {
    let customerA;
    let customerB;
    let customerC;
    let admin;

    beforeEach(async () => {
        customerA = await makeCustomer();
        customerB = await makeCustomer();
        customerC = await makeCustomer();
        admin = await createAdmin();

        const approved = await createPendingDeposit(customerA._id, { receiptImage: 'uploads/deposits/a.jpg' });
        await depositService.approveDeposit(approved._id, admin._id);

        await createPendingDeposit(customerB._id, {
            requestedAmount: 200,
            amountUsd: 200,
            receiptImage: 'uploads/deposits/b.jpg',
        });
        await createPendingDeposit(customerC._id, {
            requestedAmount: 300,
            amountUsd: 300,
            receiptImage: 'uploads/deposits/c.jpg',
        });
    });

    it('listDeposits returns all deposits for admin', async () => {
        const result = await depositService.listDeposits();
        expect(result.deposits.length).toBe(3);
        expect(result.pagination.total).toBe(3);
    });

    it('listDeposits filters by status=PENDING', async () => {
        const result = await depositService.listDeposits({ status: DEPOSIT_STATUS.PENDING });
        expect(result.deposits).toHaveLength(2);
        expect(result.deposits.every((deposit) => deposit.status === DEPOSIT_STATUS.PENDING)).toBe(true);
    });

    it('listDeposits filters by status=APPROVED', async () => {
        const result = await depositService.listDeposits({ status: DEPOSIT_STATUS.APPROVED });
        expect(result.deposits).toHaveLength(1);
        expect(result.deposits[0].status).toBe(DEPOSIT_STATUS.APPROVED);
    });

    it('listMyDeposits returns only the requesting user deposits', async () => {
        const result = await depositService.listMyDeposits(customerA._id);
        expect(result.deposits).toHaveLength(1);
        expect(result.deposits[0].userId.toString()).toBe(customerA._id.toString());
    });

    it('listDeposits paginates correctly', async () => {
        const page1 = await depositService.listDeposits({ page: 1, limit: 2 });
        const page2 = await depositService.listDeposits({ page: 2, limit: 2 });

        expect(page1.deposits).toHaveLength(2);
        expect(page2.deposits).toHaveLength(1);
        expect(page1.pagination.total).toBe(3);
        expect(page1.pagination.pages).toBe(2);
    });
});

describe('[7] getDepositById', () => {
    let customer;
    let otherCustomer;
    let deposit;

    beforeEach(async () => {
        customer = await makeCustomer();
        otherCustomer = await makeCustomer();
        deposit = await createPendingDeposit(customer._id);
    });

    it('returns the correct deposit when called without userId restriction', async () => {
        const found = await depositService.getDepositById(deposit._id);
        expect(found._id.toString()).toBe(deposit._id.toString());
    });

    it('returns the deposit when requestingUserId matches', async () => {
        const found = await depositService.getDepositById(deposit._id, customer._id);
        expect(found._id.toString()).toBe(deposit._id.toString());
    });

    it('throws AuthorizationError when requestingUserId does not match', async () => {
        await expect(depositService.getDepositById(deposit._id, otherCustomer._id))
            .rejects.toMatchObject({ statusCode: 403 });
    });

    it('throws NotFoundError for a non-existent deposit ID', async () => {
        await expect(depositService.getDepositById(new mongoose.Types.ObjectId()))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
});

describe('[8] Audit log correctness', () => {
    let customer;
    let admin;

    beforeEach(async () => {
        customer = await makeCustomer({ walletBalance: 0 });
        admin = await createAdmin();
    });

    it('DEPOSIT_REQUESTED log does not contain sensitive token fields', async () => {
        await createPendingDeposit(customer._id);
        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.REQUESTED }).lean();
        expect(log.metadata.password).toBeUndefined();
        expect(log.metadata.token).toBeUndefined();
        expect(log.metadata.accessToken).toBeUndefined();
    });

    it('DEPOSIT_REQUESTED log entityId matches the deposit _id', async () => {
        const deposit = await createPendingDeposit(customer._id);
        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.REQUESTED }).lean();
        expect(log.entityId.toString()).toBe(deposit._id.toString());
    });

    it('DEPOSIT_APPROVED log records approval metadata', async () => {
        const deposit = await createPendingDeposit(customer._id);
        await depositService.approveDeposit(deposit._id, admin._id, { amount: 450 });
        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.APPROVED }).lean();
        expect(log.metadata.finalAmount).toBe(450);
        expect(log.metadata.originalRequestedAmount).toBe(500);
        expect(log.metadata.walletCreditAmount).toBe(450);
    });

    it('DEPOSIT_REJECTED log records the admin reviewer', async () => {
        const deposit = await createPendingDeposit(customer._id);
        await depositService.rejectDeposit(deposit._id, admin._id);
        await flushAudit();

        const log = await AuditLog.findOne({ action: DEPOSIT_ACTIONS.REJECTED }).lean();
        expect(log.actorId.toString()).toBe(admin._id.toString());
        expect(log.metadata.reviewedBy).toBe(admin._id.toString());
    });

    it('no DEPOSIT_APPROVED or WALLET_CREDIT logs when approval fails', async () => {
        const deposit = await createPendingDeposit(customer._id);
        await DepositRequest.findByIdAndUpdate(deposit._id, { status: DEPOSIT_STATUS.REJECTED });

        await expect(depositService.approveDeposit(deposit._id, admin._id))
            .rejects.toBeDefined();

        await flushAudit();

        expect(await AuditLog.countDocuments({ action: DEPOSIT_ACTIONS.APPROVED })).toBe(0);
        expect(await AuditLog.countDocuments({ action: WALLET_ACTIONS.CREDIT })).toBe(0);
    });
});
