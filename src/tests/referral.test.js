'use strict';

const referralService = require('../modules/referrals/referral.service');
const referralController = require('../modules/referrals/referral.controller');
const depositService = require('../modules/deposits/deposit.service');
const paymentService = require('../modules/payments/payment.service');
const adminWalletService = require('../modules/admin/admin.wallet.service');
const orderService = require('../modules/orders/order.service');
const { register } = require('../modules/auth/auth.service');
const { User } = require('../modules/users/user.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { ReferralRelationship, ReferralCommission } = require('../modules/referrals/referral.model');
const {
    REFERRAL_COMMISSION_STATUS,
    REFERRAL_COMMISSION_PAYOUT_STATUS,
    REFERRAL_PAYOUT_STATUS,
    REFERRAL_SOURCE_TYPES,
} = require('../modules/referrals/referral.constants');
const { PAYMENT_GATEWAYS } = require('../modules/payments/payment.constants');

const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createCustomerWithGroup,
    createAdmin,
    createProduct,
} = require('./testHelpers');

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.PAYMENTS_ENABLED;
    delete process.env.PAYMENT_ALLOWED_GATEWAYS;
    await clearCollections();
});

const VALID_DEPOSIT = {
    paymentMethodId: 'bank-transfer-usd',
    requestedAmount: 500,
    currency: 'USD',
    exchangeRate: 1,
    amountUsd: 500,
    receiptImage: 'uploads/deposits/referral-test.jpg',
};

const setupActors = async ({ percentage = 10, inviterBalance = 0, invitedBalance = 0 } = {}) => {
    const group = await createGroup({ name: `ReferralGroup-${Date.now()}`, percentage: 0 });
    const admin = await createAdmin({ groupId: group._id });
    const inviter = await createCustomer({
        groupId: group._id,
        walletBalance: inviterBalance,
        currency: 'USD',
    });
    const invited = await createCustomer({
        groupId: group._id,
        walletBalance: invitedBalance,
        currency: 'USD',
    });

    await referralService.updateReferralSettings(
        { enabled: true, depositCommissionPercentage: percentage },
        { actorId: admin._id, actorRole: 'ADMIN' }
    );

    const relationship = await referralService.createReferralRelationship({
        inviterUserId: inviter._id,
        invitedUserId: invited._id,
        referralCode: inviter.referralCode,
    });

    return { group, admin, inviter, invited, relationship: relationship.relationship };
};

const createPendingDeposit = (userId, overrides = {}) => (
    depositService.createDepositRequest({
        userId,
        ...VALID_DEPOSIT,
        antiScamConfirmed: true,
        termsAccepted: true,
        ...overrides,
    })
);

const createMockPayment = async (customer, overrides = {}) => {
    const result = await paymentService.createPaymentIntent({
        userId: customer._id,
        amount: 50,
        currency: 'USD',
        gateway: PAYMENT_GATEWAYS.MOCK,
        returnUrl: 'http://localhost:5173/wallet',
        cancelUrl: 'http://localhost:5173/wallet',
        antiScamConfirmed: true,
        termsAccepted: true,
        ...overrides,
    });
    return result.payment;
};

const invokeController = (handler, req) => new Promise((resolve, reject) => {
    const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn((body) => {
            resolve({ res, body });
            return res;
        }),
    };
    handler(req, res, (err) => {
        if (err) reject(err);
    });
});

describe('Referral registration', () => {
    it('new user gets a unique referralCode automatically', async () => {
        await createGroup({ name: 'Default', percentage: 0 });

        const result = await register({
            name: 'Referral New User',
            email: `ref-new-${Date.now()}@example.com`,
            password: 'SecurePass@1',
        });

        const user = await User.findById(result.user._id);
        expect(user.referralCode).toMatch(/^K[A-Z2-9]{7}$/);
    });

    it('registration with a valid inviteCode sets referredBy and creates a relationship', async () => {
        const group = await createGroup({ name: 'ReferralReg', percentage: 0 });
        const inviter = await createCustomer({ groupId: group._id });

        const result = await register({
            name: 'Invited User',
            email: `invited-${Date.now()}@example.com`,
            password: 'SecurePass@1',
            inviteCode: inviter.referralCode,
        });

        const invited = await User.findById(result.user._id);
        expect(invited.referredBy.toString()).toBe(inviter._id.toString());

        const relationship = await ReferralRelationship.findOne({ invitedUserId: invited._id });
        expect(relationship).not.toBeNull();
        expect(relationship.inviterUserId.toString()).toBe(inviter._id.toString());
        expect(relationship.referralCode).toBe(inviter.referralCode);
    });

    it('rejects an invalid inviteCode during registration', async () => {
        await createGroup({ name: 'InvalidInvite', percentage: 0 });

        await expect(register({
            name: 'Bad Invite',
            email: `bad-invite-${Date.now()}@example.com`,
            password: 'SecurePass@1',
            inviteCode: 'KNOPE123',
        })).rejects.toMatchObject({ code: 'INVALID_REFERRAL_CODE' });
    });

    it('rejects self-referral by registering email', async () => {
        const group = await createGroup({ name: 'SelfReferral', percentage: 0 });
        const email = `self-${Date.now()}@example.com`;
        const inviter = await createCustomer({ groupId: group._id, email });

        await expect(register({
            name: 'Self Referral',
            email,
            password: 'SecurePass@1',
            inviteCode: inviter.referralCode,
        })).rejects.toMatchObject({ code: 'SELF_REFERRAL_NOT_ALLOWED' });
    });

    it('prevents an invited user from receiving a second inviter', async () => {
        const { inviter, invited } = await setupActors();
        const otherInviter = await createCustomer({
            groupId: inviter.groupId,
            walletBalance: 0,
            currency: 'USD',
        });

        await expect(referralService.createReferralRelationship({
            inviterUserId: otherInviter._id,
            invitedUserId: invited._id,
            referralCode: otherInviter.referralCode,
        })).rejects.toMatchObject({ code: 'INVITER_ALREADY_SET' });
    });
});

describe('Referral settings', () => {
    it('admin can read and update referral settings', async () => {
        const admin = await createAdmin();

        const updated = await referralService.updateReferralSettings(
            { enabled: true, depositCommissionPercentage: 7.5, minSourceAmount: 10 },
            { actorId: admin._id, actorRole: 'ADMIN' }
        );
        const current = await referralService.getReferralSettings();

        expect(updated.depositCommissionPercentage).toBe(7.5);
        expect(current.depositCommissionPercentage).toBe(7.5);
        expect(current.minSourceAmount).toBe(10);
    });

    it('rejects invalid commission percentages', async () => {
        const admin = await createAdmin();

        await expect(referralService.updateReferralSettings(
            { depositCommissionPercentage: 101 },
            { actorId: admin._id, actorRole: 'ADMIN' }
        )).rejects.toMatchObject({ code: 'INVALID_REFERRAL_PERCENTAGE' });
    });

    it('customer cannot update referral settings', async () => {
        const { customer } = await createCustomerWithGroup();

        await expect(referralService.updateReferralSettings(
            { depositCommissionPercentage: 5 },
            { actorId: customer._id, actorRole: 'CUSTOMER' }
        )).rejects.toMatchObject({ statusCode: 403 });
    });
});

describe('Referral commission processing', () => {
    it('deposit approval creates a pending commission, then payout approval credits the inviter exactly once', async () => {
        const { admin, inviter, invited } = await setupActors({ percentage: 10 });
        const deposit = await createPendingDeposit(invited._id);

        await depositService.approveDeposit(deposit._id, admin._id);

        const freshInviter = await User.findById(inviter._id);
        expect(freshInviter.walletBalance).toBe(0);

        const commission = await ReferralCommission.findOne({ inviterUserId: inviter._id });
        expect(commission.status).toBe(REFERRAL_COMMISSION_STATUS.PENDING);
        expect(commission.payoutStatus).toBe(REFERRAL_COMMISSION_PAYOUT_STATUS.AVAILABLE);
        expect(commission.commissionAmount).toBe(50);
        expect(commission.walletTransactionId).toBeNull();

        expect(await WalletTransaction.countDocuments({
            userId: inviter._id,
            semanticType: 'REFERRAL_COMMISSION_PAYOUT',
        })).toBe(0);

        const payout = await referralService.createReferralPayoutRequest(inviter._id, {
            method: 'wallet_credit',
            currency: 'USD',
            amount: 50,
        });
        expect(payout.status).toBe(REFERRAL_PAYOUT_STATUS.PENDING);

        const firstApproval = await referralService.approveReferralPayoutWalletCredit(payout.id, {
            actorId: admin._id,
            actorRole: 'ADMIN',
        });
        const secondApproval = await referralService.approveReferralPayoutWalletCredit(payout.id, {
            actorId: admin._id,
            actorRole: 'ADMIN',
        });

        expect(firstApproval.alreadyProcessed).toBe(false);
        expect(secondApproval.alreadyProcessed).toBe(true);
        expect(firstApproval.payout.status).toBe(REFERRAL_PAYOUT_STATUS.PAID);
        expect(secondApproval.payout.status).toBe(REFERRAL_PAYOUT_STATUS.PAID);

        const paidInviter = await User.findById(inviter._id);
        expect(paidInviter.walletBalance).toBe(50);
        const paidCommission = await ReferralCommission.findById(commission._id);
        expect(paidCommission.status).toBe(REFERRAL_COMMISSION_STATUS.PAID);
        expect(paidCommission.payoutStatus).toBe(REFERRAL_COMMISSION_PAYOUT_STATUS.PAID);
        expect(paidCommission.walletTransactionId).not.toBeNull();

        const tx = await WalletTransaction.findById(paidCommission.walletTransactionId);
        expect(tx.semanticType).toBe('REFERRAL_COMMISSION_PAYOUT');
        expect(tx.sourceType).toBe('REFERRAL_PAYOUT');
        expect(tx.amount).toBe(50);
        expect(await WalletTransaction.countDocuments({
            userId: inviter._id,
            semanticType: 'REFERRAL_COMMISSION_PAYOUT',
        })).toBe(1);
    });

    it('payment mock confirmation creates a pending commission without immediate wallet credit', async () => {
        const { inviter, invited } = await setupActors({ percentage: 10 });
        const payment = await createMockPayment(invited);

        await paymentService.confirmMockPayment(payment._id, { actor: invited });

        const freshInviter = await User.findById(inviter._id);
        expect(freshInviter.walletBalance).toBe(0);

        const commission = await ReferralCommission.findOne({ inviterUserId: inviter._id });
        expect(commission.status).toBe(REFERRAL_COMMISSION_STATUS.PENDING);
        expect(commission.payoutStatus).toBe(REFERRAL_COMMISSION_PAYOUT_STATUS.AVAILABLE);
        expect(commission.sourceType).toBe(REFERRAL_SOURCE_TYPES.PAYMENT);
        expect(commission.sourceSemanticType).toBe('CARD_PAYMENT_SUCCESS');
        expect(commission.commissionAmount).toBe(5);
    });

    it('admin wallet adjustment does not trigger commission', async () => {
        const { admin, inviter, invited } = await setupActors({ percentage: 10 });

        await adminWalletService.addFunds(invited._id, 100, 'manual adjustment', admin._id);

        const freshInviter = await User.findById(inviter._id);
        expect(freshInviter.walletBalance).toBe(0);
        expect(await ReferralCommission.countDocuments()).toBe(0);
    });

    it('order debit and refund do not trigger commission', async () => {
        const { inviter, invited } = await setupActors({ percentage: 10, invitedBalance: 200 });
        const product = await createProduct({ basePrice: 100, minQty: 1, maxQty: 1 });

        const { order } = await orderService.createOrder({
            userId: invited._id,
            productId: product._id,
            quantity: 1,
        });
        await orderService.markOrderAsFailed(order._id);

        const freshInviter = await User.findById(inviter._id);
        expect(freshInviter.walletBalance).toBe(0);
        expect(await ReferralCommission.countDocuments()).toBe(0);
    });

    it('percentage 0 creates neither a referral commission nor a payout wallet credit', async () => {
        const { admin, inviter, invited } = await setupActors({ percentage: 0 });
        const deposit = await createPendingDeposit(invited._id);

        await depositService.approveDeposit(deposit._id, admin._id);

        const payoutTransactionCount = await WalletTransaction.countDocuments({
            userId: inviter._id,
            semanticType: 'REFERRAL_COMMISSION_PAYOUT',
        });

        expect((await User.findById(inviter._id)).walletBalance).toBe(0);
        expect(payoutTransactionCount).toBe(0);
        expect(await ReferralCommission.findOne({ inviterUserId: inviter._id })).toBeNull();
    });

    it('disabled setting creates neither a referral commission nor a payout wallet credit', async () => {
        const { admin, inviter, invited } = await setupActors({ percentage: 10 });
        await referralService.updateReferralSettings(
            { enabled: false },
            { actorId: admin._id, actorRole: 'ADMIN' }
        );
        const deposit = await createPendingDeposit(invited._id);

        await depositService.approveDeposit(deposit._id, admin._id);

        const payoutTransactionCount = await WalletTransaction.countDocuments({
            userId: inviter._id,
            semanticType: 'REFERRAL_COMMISSION_PAYOUT',
        });

        expect((await User.findById(inviter._id)).walletBalance).toBe(0);
        expect(payoutTransactionCount).toBe(0);
        expect(await ReferralCommission.findOne({ inviterUserId: inviter._id })).toBeNull();
    });

    it('duplicate source-credit processing creates one pending commission and no immediate wallet credit', async () => {
        const { admin, inviter, invited } = await setupActors({ percentage: 10 });
        const deposit = await createPendingDeposit(invited._id);
        await depositService.approveDeposit(deposit._id, admin._id);

        const sourceTx = await WalletTransaction.findOne({
            userId: invited._id,
            semanticType: 'DEPOSIT_APPROVED',
        });

        await referralService.processWalletCredit(sourceTx);
        await referralService.processWalletCredit(sourceTx);

        const freshInviter = await User.findById(inviter._id);
        expect(freshInviter.walletBalance).toBe(0);
        expect(await ReferralCommission.countDocuments({ sourceWalletTransactionId: sourceTx._id })).toBe(1);
        expect((await ReferralCommission.findOne({ sourceWalletTransactionId: sourceTx._id })).status)
            .toBe(REFERRAL_COMMISSION_STATUS.PENDING);
        expect(await WalletTransaction.countDocuments({ userId: inviter._id, semanticType: 'REFERRAL_COMMISSION_PAYOUT' })).toBe(0);
    });
});

describe('Referral access helpers', () => {
    it('current user can view own referral summary and commission history', async () => {
        const { admin, inviter, invited } = await setupActors({ percentage: 10 });
        const deposit = await createPendingDeposit(invited._id);
        await depositService.approveDeposit(deposit._id, admin._id);

        const summary = await referralService.getReferralSummary(inviter._id);
        const history = await referralService.listCommissions({ inviterUserId: inviter._id });

        expect(summary.referralCode).toBe(inviter.referralCode);
        expect(summary.invitedUsersCount).toBe(1);
        expect(summary.totalCommission[0].amount).toBe(50);
        expect(history.commissions).toHaveLength(1);
    });

    it('my commissions controller ignores another user id in the query', async () => {
        const { admin, inviter, invited } = await setupActors({ percentage: 10 });
        const other = await createCustomer({ groupId: inviter.groupId, walletBalance: 0 });
        const deposit = await createPendingDeposit(invited._id);
        await depositService.approveDeposit(deposit._id, admin._id);

        const { body } = await invokeController(referralController.getMyCommissions, {
            user: inviter,
            query: { inviterUserId: other._id.toString() },
        });

        expect(body.data.commissions).toHaveLength(1);
        expect(body.data.commissions[0].inviterUserId._id.toString()).toBe(inviter._id.toString());
    });

    it('admin can list commissions and relationships', async () => {
        const { admin, invited } = await setupActors({ percentage: 10 });
        const deposit = await createPendingDeposit(invited._id);
        await depositService.approveDeposit(deposit._id, admin._id);

        const relationships = await referralService.listRelationships();
        const commissions = await referralService.listCommissions({ admin: true });

        expect(relationships.relationships).toHaveLength(1);
        expect(commissions.commissions).toHaveLength(1);
    });
});
