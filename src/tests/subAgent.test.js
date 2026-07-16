'use strict';

const groupRequestService = require('../modules/groupRequests/groupRequest.service');
const referralService = require('../modules/referrals/referral.service');
const depositService = require('../modules/deposits/deposit.service');
const paymentService = require('../modules/payments/payment.service');
const adminWalletService = require('../modules/admin/admin.wallet.service');
const { register } = require('../modules/auth/auth.service');
const { User, SUB_AGENT_STATUS } = require('../modules/users/user.model');
const { ReferralRelationship, ReferralCommission } = require('../modules/referrals/referral.model');
const { GROUP_REQUEST_TYPES, GROUP_REQUEST_STATUS } = require('../modules/groupRequests/groupRequest.constants');
const { PAYMENT_GATEWAYS } = require('../modules/payments/payment.constants');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { Currency } = require('../modules/currency/currency.model');
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
beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.PAYMENTS_ENABLED;
    delete process.env.PAYMENT_ALLOWED_GATEWAYS;
    await clearCollections();
});

const depositPayload = {
    paymentMethodId: 'bank-transfer-usd',
    requestedAmount: 500,
    currency: 'USD',
    exchangeRate: 1,
    amountUsd: 500,
    receiptImage: 'uploads/deposits/sub-agent-test.jpg',
    antiScamConfirmed: true,
    termsAccepted: true,
};

const createPendingDeposit = (userId, overrides = {}) => depositService.createDepositRequest({
    userId,
    ...depositPayload,
    ...overrides,
});

const proofImage = {
    proofImagePath: 'uploads/sub-agent-requests/sub-agent-test.jpg',
    proofImageUrl: '/uploads/sub-agent-requests/sub-agent-test.jpg',
    proofImageOriginalName: 'sub-agent-test.jpg',
    proofImageMimeType: 'image/jpeg',
    proofImageSize: 12345,
};

const approveAsSubAgent = async ({ user, admin, group, percent = 1 }) => {
    const request = await groupRequestService.createGroupRequest({
        userId: user._id,
        requestType: GROUP_REQUEST_TYPES.SUB_AGENT,
        reason: 'I want to become a sub-agent',
        proofImage,
    });

    const result = await groupRequestService.approveGroupRequest(request.id, {
        approvedGroupId: group._id,
        adminId: admin._id,
    });

    await referralService.updateSubAgent(user._id, { commissionPercent: percent }, {
        actorId: admin._id,
        actorRole: 'ADMIN',
    });

    return { request: result.request, user: await User.findById(user._id) };
};

const setupAgent = async ({ percent = 1 } = {}) => {
    const group = await createGroup({ percentage: 0 });
    const agentGroup = await createGroup({ percentage: 5 });
    const admin = await createAdmin({ groupId: group._id });
    const agent = await createCustomer({ groupId: group._id, walletBalance: 0, currency: 'USD' });
    await approveAsSubAgent({ user: agent, admin, group: agentGroup, percent });
    return { admin, group, agentGroup, agent: await User.findById(agent._id) };
};

const createReferredCustomer = async (agent, group, overrides = {}) => {
    const referred = await createCustomer({
        groupId: group._id,
        walletBalance: 0,
        currency: 'USD',
        ...overrides,
    });
    await referralService.createReferralRelationship({
        inviterUserId: agent._id,
        invitedUserId: referred._id,
        referralCode: agent.agentProfile.code,
    });
    return User.findById(referred._id);
};

const createMockPayment = async (customer, overrides = {}) => {
    const result = await paymentService.createPaymentIntent({
        userId: customer._id,
        amount: 100,
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

describe('Sub-agent request workflow', () => {
    it('user can submit a sub-agent request and duplicate pending request is rejected', async () => {
        const group = await createGroup();
        const user = await createCustomer({ groupId: group._id });

        const request = await groupRequestService.createGroupRequest({
            userId: user._id,
            requestType: GROUP_REQUEST_TYPES.SUB_AGENT,
            reason: 'Please review me',
            proofImage,
        });

        expect(request.status).toBe(GROUP_REQUEST_STATUS.PENDING);
        await expect(groupRequestService.createGroupRequest({
            userId: user._id,
            requestType: GROUP_REQUEST_TYPES.SUB_AGENT,
        })).rejects.toMatchObject({ code: 'GROUP_REQUEST_PENDING_EXISTS' });
    });

    it('already-approved sub-agent cannot submit another request', async () => {
        const { admin, agentGroup } = await setupAgent();
        const agent = await createCustomer({ groupId: agentGroup._id });
        await approveAsSubAgent({ user: agent, admin, group: agentGroup, percent: 1 });

        await expect(groupRequestService.createGroupRequest({
            userId: agent._id,
            requestType: GROUP_REQUEST_TYPES.SUB_AGENT,
            proofImage,
        })).rejects.toMatchObject({ code: 'SUB_AGENT_ALREADY_ACTIVE' });
    });

    it('admin approval requires group, assigns group, and keeps referral code stable', async () => {
        const currentGroup = await createGroup();
        const targetGroup = await createGroup();
        const admin = await createAdmin({ groupId: currentGroup._id });
        const user = await createCustomer({ groupId: currentGroup._id });
        const request = await groupRequestService.createGroupRequest({
            userId: user._id,
            requestType: GROUP_REQUEST_TYPES.SUB_AGENT,
            proofImage,
        });

        await groupRequestService.approveGroupRequest(request.id, {
            approvedGroupId: targetGroup._id,
            adminId: admin._id,
        });

        const fresh = await User.findById(user._id);
        expect(fresh.isSubAgent).toBe(true);
        expect(fresh.subAgentStatus).toBe(SUB_AGENT_STATUS.ACTIVE);
        expect(fresh.groupId.toString()).toBe(targetGroup._id.toString());
        expect(fresh.agentProfile.code).toBe(fresh.referralCode);
        expect(fresh.agentProfile.commissionPercent).toBe(0);
    });

    it('admin rejects request with reason and user remains normal customer', async () => {
        const group = await createGroup();
        const admin = await createAdmin({ groupId: group._id });
        const user = await createCustomer({ groupId: group._id });
        const request = await groupRequestService.createGroupRequest({
            userId: user._id,
            requestType: GROUP_REQUEST_TYPES.SUB_AGENT,
            proofImage,
        });

        const result = await groupRequestService.rejectGroupRequest(request.id, {
            adminId: admin._id,
            adminNote: 'Not enough volume',
        });

        const fresh = await User.findById(user._id);
        expect(result.request.status).toBe(GROUP_REQUEST_STATUS.REJECTED);
        expect(result.request.adminNote).toBe('Not enough volume');
        expect(fresh.isSubAgent).toBe(false);
    });
});

describe('Sub-agent referral and commission rules', () => {
    it('every user has a stable referral code that does not change', async () => {
        const group = await createGroup();
        const user = await createCustomer({ groupId: group._id });

        const first = await referralService.ensureReferralCode(user._id);
        const second = await referralService.ensureReferralCode(user._id);

        const fresh = await User.findById(user._id);
        expect(first).toBe(second);
        expect(fresh.referralCode).toBe(first);
    });

    it('registration with referral code links direct referred user for 30 days', async () => {
        const { agent, agentGroup } = await setupAgent({ percent: 1 });

        const result = await register({
            name: 'Referred Registration',
            email: `sub-agent-reg-${Date.now()}@example.com`,
            password: 'SecurePass@1',
            inviteCode: agent.agentProfile.code,
        });

        const referred = await User.findById(result.user._id);
        expect(referred.referredByAgentId.toString()).toBe(agent._id.toString());
        expect(referred.referralCodeUsed).toBe(agent.agentProfile.code);
        expect(referred.referralCommissionEligibleUntil.getTime() - referred.referredAt.getTime())
            .toBe(30 * 24 * 60 * 60 * 1000);
        expect(referred.groupId.toString()).toBe(agentGroup._id.toString());
    });

    it('registration accepts any valid referral code but rejects invalid codes', async () => {
        const group = await createGroup();
        const normalUser = await createCustomer({ groupId: group._id });

        await expect(register({
            name: 'Invalid Code',
            email: `invalid-code-${Date.now()}@example.com`,
            password: 'SecurePass@1',
            inviteCode: 'KNOPE123',
        })).rejects.toMatchObject({ code: 'INVALID_REFERRAL_CODE' });

        const referred = await register({
            name: 'Normal Code',
            email: `normal-code-${Date.now()}@example.com`,
            password: 'SecurePass@1',
            inviteCode: normalUser.referralCode,
        });

        const fresh = await User.findById(referred.user._id);
        expect(fresh.referredByAgentId.toString()).toBe(normalUser._id.toString());
    });

    it('successful gateway top-up within 30 days creates pending commission without wallet credit', async () => {
        const { agent, agentGroup } = await setupAgent({ percent: 2 });
        const referred = await createReferredCustomer(agent, agentGroup);
        const payment = await createMockPayment(referred);

        await paymentService.confirmMockPayment(payment._id, { actor: referred });

        const commission = await ReferralCommission.findOne({ inviterUserId: agent._id });
        const freshAgent = await User.findById(agent._id);
        expect(commission.status).toBe('pending');
        expect(commission.sourceType).toBe('payment');
        expect(commission.commissionAmount).toBe(2);
        expect(commission.commissionCurrency).toBe('USD');
        expect(commission.walletTransactionId).toBeNull();
        expect(freshAgent.walletBalance).toBe(0);
    });

    it('approved manual deposit within 30 days creates pending commission', async () => {
        const { admin, agent, agentGroup } = await setupAgent({ percent: 1 });
        const referred = await createReferredCustomer(agent, agentGroup);
        const deposit = await createPendingDeposit(referred._id);

        await depositService.approveDeposit(deposit._id, admin._id);

        const commission = await ReferralCommission.findOne({ inviterUserId: agent._id });
        expect(commission.status).toBe('pending');
        expect(commission.sourceType).toBe('manual_deposit');
        expect(commission.topupAmount).toBe(500);
        expect(commission.commissionAmount).toBe(5);
    });

    it('normal user with no override uses default referral commission 1%', async () => {
        const group = await createGroup();
        const admin = await createAdmin({ groupId: group._id });
        const referrer = await createCustomer({ groupId: group._id, walletBalance: 0, currency: 'USD' });
        const referred = await createReferredCustomer(referrer, group);

        const deposit = await createPendingDeposit(referred._id, { requestedAmount: 500, amountUsd: 500 });
        await depositService.approveDeposit(deposit._id, admin._id);

        const commission = await ReferralCommission.findOne({ inviterUserId: referrer._id });
        expect(commission.status).toBe('pending');
        expect(commission.commissionPercent).toBe(1);
        expect(commission.commissionAmount).toBe(5);
        expect(commission.commissionCurrency).toBe('USD');
    });

    it('admin can set and reset a custom referral commission percent', async () => {
        const group = await createGroup();
        const admin = await createAdmin({ groupId: group._id });
        const referrer = await createCustomer({ groupId: group._id, walletBalance: 0 });

        const custom = await referralService.updateSubAgent(referrer._id, { commissionPercent: 2.25 }, {
            actorId: admin._id,
            actorRole: 'ADMIN',
        });
        expect(custom.referralCommissionPercentOverride).toBe(2.25);
        expect(custom.commissionPercentEffective).toBe(2.25);
        expect(custom.usingDefaultCommission).toBe(false);

        const reset = await referralService.updateSubAgent(referrer._id, { useDefault: true }, {
            actorId: admin._id,
            actorRole: 'ADMIN',
        });
        expect(reset.referralCommissionPercentOverride).toBeNull();
        expect(reset.commissionPercentEffective).toBe(1);
        expect(reset.usingDefaultCommission).toBe(true);
    });

    it('custom referral commission percent 0 is respected and creates no commission', async () => {
        const group = await createGroup();
        const admin = await createAdmin({ groupId: group._id });
        const referrer = await createCustomer({ groupId: group._id, walletBalance: 0 });
        const referred = await createReferredCustomer(referrer, group);
        await referralService.updateSubAgent(referrer._id, { commissionPercent: 0 }, {
            actorId: admin._id,
            actorRole: 'ADMIN',
        });

        const deposit = await createPendingDeposit(referred._id);
        await depositService.approveDeposit(deposit._id, admin._id);

        expect(await ReferralCommission.countDocuments()).toBe(0);
    });

    it('admin referrals page includes users with referred signups or custom override before top-up', async () => {
        const group = await createGroup();
        const admin = await createAdmin({ groupId: group._id });
        const referrer = await createCustomer({ groupId: group._id, walletBalance: 0 });
        const overrideOnly = await createCustomer({ groupId: group._id, walletBalance: 0 });
        await createReferredCustomer(referrer, group);
        await referralService.updateSubAgent(overrideOnly._id, { commissionPercent: 3 }, {
            actorId: admin._id,
            actorRole: 'ADMIN',
        });

        const result = await referralService.listSubAgents({ page: 1, limit: 20 });
        const ids = result.subAgents.map((agent) => agent.userId);
        expect(ids).toContain(referrer._id.toString());
        expect(ids).toContain(overrideOnly._id.toString());
        expect(result.subAgents.find((agent) => agent.userId === referrer._id.toString()).referredUsersCount).toBe(1);
        expect(await ReferralCommission.countDocuments()).toBe(0);
    });

    it('changing custom referral percent affects future commissions only', async () => {
        const group = await createGroup();
        const admin = await createAdmin({ groupId: group._id });
        const referrer = await createCustomer({ groupId: group._id, walletBalance: 0 });
        const referred = await createReferredCustomer(referrer, group);

        await referralService.updateSubAgent(referrer._id, { commissionPercent: 1 }, { actorId: admin._id, actorRole: 'ADMIN' });
        const first = await createPendingDeposit(referred._id, { requestedAmount: 100, amountUsd: 100 });
        await depositService.approveDeposit(first._id, admin._id);

        await referralService.updateSubAgent(referrer._id, { commissionPercent: 2 }, { actorId: admin._id, actorRole: 'ADMIN' });
        const second = await createPendingDeposit(referred._id, { requestedAmount: 100, amountUsd: 100 });
        await depositService.approveDeposit(second._id, admin._id);

        const commissions = await ReferralCommission.find({ inviterUserId: referrer._id }).sort({ earnedAt: 1 });
        expect(commissions[0].commissionPercent).toBe(1);
        expect(commissions[0].commissionAmount).toBe(1);
        expect(commissions[1].commissionPercent).toBe(2);
        expect(commissions[1].commissionAmount).toBe(2);
    });

    it('converts cross-currency commission into referrer account currency', async () => {
        const group = await createGroup();
        const admin = await createAdmin({ groupId: group._id });
        await Currency.create({
            code: 'EGP',
            name: 'Egyptian Pound',
            symbol: 'E£',
            platformRate: 50,
            marketRate: 50,
            isActive: true,
        });
        const referrer = await createCustomer({ groupId: group._id, walletBalance: 0, currency: 'USD' });
        const referred = await createReferredCustomer(referrer, group, { currency: 'EGP' });
        await referralService.updateSubAgent(referrer._id, { commissionPercent: 2 }, {
            actorId: admin._id,
            actorRole: 'ADMIN',
        });

        const deposit = await createPendingDeposit(referred._id, {
            requestedAmount: 1000,
            currency: 'EGP',
            exchangeRate: 50,
            amountUsd: 20,
        });
        await depositService.approveDeposit(deposit._id, admin._id);

        const commission = await ReferralCommission.findOne({ inviterUserId: referrer._id });
        expect(commission.sourceTopupAmount).toBe(1000);
        expect(commission.sourceTopupCurrency).toBe('EGP');
        expect(commission.commissionOriginalAmount).toBe(20);
        expect(commission.commissionOriginalCurrency).toBe('EGP');
        expect(commission.commissionAmount).toBe(0.4);
        expect(commission.commissionCurrency).toBe('USD');
        expect(commission.fxRateUsed).toBe(0.02);
    });

    it('sub-agent request without proof image is rejected', async () => {
        const group = await createGroup();
        const user = await createCustomer({ groupId: group._id });

        await expect(groupRequestService.createGroupRequest({
            userId: user._id,
            requestType: GROUP_REQUEST_TYPES.SUB_AGENT,
            reason: 'No proof',
        })).rejects.toMatchObject({ code: 'PROOF_IMAGE_REQUIRED' });
    });

    it('sub-agent request can be submitted with proof image', async () => {
        const group = await createGroup();
        const user = await createCustomer({ groupId: group._id });

        const request = await groupRequestService.createGroupRequest({
            userId: user._id,
            requestType: GROUP_REQUEST_TYPES.SUB_AGENT,
            reason: 'With proof',
            proofImage,
        });

        expect(request.proofImageUrl).toContain('/uploads/sub-agent-requests/');
    });

    it('admin wallet adjustment does not create commission', async () => {
        const { admin, agent, agentGroup } = await setupAgent({ percent: 10 });
        const referred = await createReferredCustomer(agent, agentGroup);

        await adminWalletService.addFunds(referred._id, 100, 'manual adjustment', admin._id);

        expect(await ReferralCommission.countDocuments()).toBe(0);
    });

    it('top-up after 30 days creates no commission and marks referral expired', async () => {
        const { admin, agent, agentGroup } = await setupAgent({ percent: 10 });
        const referred = await createReferredCustomer(agent, agentGroup);
        const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await ReferralRelationship.updateOne({ invitedUserId: referred._id }, { $set: { eligibleUntil: past } });
        await User.updateOne({ _id: referred._id }, { $set: { referralCommissionEligibleUntil: past } });

        const deposit = await createPendingDeposit(referred._id);
        await depositService.approveDeposit(deposit._id, admin._id);

        const freshReferred = await User.findById(referred._id);
        expect(await ReferralCommission.countDocuments()).toBe(0);
        expect(freshReferred.referralCommissionStoppedReason).toBe('expired');
    });

    it('promotion stops old referrer immediately, preserves old records, and prevents multi-level commission', async () => {
        const { admin, agent, agentGroup } = await setupAgent({ percent: 10 });
        const promoted = await createReferredCustomer(agent, agentGroup);
        const firstDeposit = await createPendingDeposit(promoted._id);
        await depositService.approveDeposit(firstDeposit._id, admin._id);

        await approveAsSubAgent({ user: promoted, admin, group: agentGroup, percent: 5 });
        const afterPromotionDeposit = await createPendingDeposit(promoted._id, { requestedAmount: 100, amountUsd: 100 });
        await depositService.approveDeposit(afterPromotionDeposit._id, admin._id);

        const promotedFresh = await User.findById(promoted._id);
        expect(promotedFresh.referralCommissionStoppedReason).toBe('promoted_to_sub_agent');
        expect(await ReferralCommission.countDocuments({ inviterUserId: agent._id })).toBe(1);

        const child = await createReferredCustomer(promotedFresh, agentGroup);
        const childDeposit = await createPendingDeposit(child._id, { requestedAmount: 200, amountUsd: 200 });
        await depositService.approveDeposit(childDeposit._id, admin._id);

        expect(await ReferralCommission.countDocuments({ inviterUserId: agent._id })).toBe(1);
        const childCommission = await ReferralCommission.findOne({ inviterUserId: promoted._id });
        expect(childCommission.commissionAmount).toBe(10);
    });

    it('commission idempotency prevents duplicate commission on repeated processing', async () => {
        const { admin, agent, agentGroup } = await setupAgent({ percent: 10 });
        const referred = await createReferredCustomer(agent, agentGroup);
        const deposit = await createPendingDeposit(referred._id);
        await depositService.approveDeposit(deposit._id, admin._id);
        const sourceTx = await WalletTransaction.findOne({ userId: referred._id, semanticType: 'DEPOSIT_APPROVED' });

        await referralService.processWalletCredit(sourceTx);
        await referralService.processWalletCredit(sourceTx);

        expect(await ReferralCommission.countDocuments({ sourceWalletTransactionId: sourceTx._id })).toBe(1);
    });

    it('changing agent commission percent affects future commissions only', async () => {
        const { admin, agent, agentGroup } = await setupAgent({ percent: 1 });
        const referred = await createReferredCustomer(agent, agentGroup);
        const first = await createPendingDeposit(referred._id, { requestedAmount: 100, amountUsd: 100 });
        await depositService.approveDeposit(first._id, admin._id);

        await referralService.updateSubAgent(agent._id, { commissionPercent: 2 }, { actorId: admin._id, actorRole: 'ADMIN' });
        const second = await createPendingDeposit(referred._id, { requestedAmount: 100, amountUsd: 100 });
        await depositService.approveDeposit(second._id, admin._id);

        const commissions = await ReferralCommission.find({ inviterUserId: agent._id }).sort({ earnedAt: 1 });
        expect(commissions[0].commissionPercent).toBe(1);
        expect(commissions[0].commissionAmount).toBe(1);
        expect(commissions[1].commissionPercent).toBe(2);
        expect(commissions[1].commissionAmount).toBe(2);
    });

    it('inactive agent does not earn new commissions', async () => {
        const { admin, agent, agentGroup } = await setupAgent({ percent: 10 });
        const referred = await createReferredCustomer(agent, agentGroup);
        await referralService.updateSubAgent(agent._id, { active: false }, { actorId: admin._id, actorRole: 'ADMIN' });

        const deposit = await createPendingDeposit(referred._id);
        await depositService.approveDeposit(deposit._id, admin._id);

        expect(await ReferralCommission.countDocuments()).toBe(0);
    });
});

