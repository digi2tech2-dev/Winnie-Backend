'use strict';

const referralService = require('./referral.service');
const groupRequestService = require('../groupRequests/groupRequest.service');
const {
    GROUP_REQUEST_TYPES,
} = require('../groupRequests/groupRequest.constants');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess, sendPaginated } = require('../../shared/utils/apiResponse');

const actorFrom = (req) => ({
    actorId: req.user?._id,
    actorRole: req.user?.role,
    role: req.user?.role,
    ipAddress: req.ip || null,
    userAgent: req.get('User-Agent') || null,
});

const proofImageFromFile = (file) => {
    if (!file) return null;
    const relativePath = `uploads/sub-agent-requests/${file.filename}`;
    return {
        proofImagePath: relativePath,
        proofImageUrl: `/${relativePath}`,
        proofImageOriginalName: file.originalname || null,
        proofImageMimeType: file.mimetype || null,
        proofImageSize: file.size || null,
    };
};

const validateCode = catchAsync(async (req, res) => {
    const code = req.body.inviteCode || req.body.referralCode;
    const result = await referralService.validateReferralCode(code, {
        email: req.body.email || null,
        userId: req.user?._id || null,
    });
    sendSuccess(res, result, result.valid ? 'Referral code is valid.' : 'Referral code is invalid.');
});

const getMyReferrals = catchAsync(async (req, res) => {
    const summary = await referralService.getReferralSummary(req.user._id);
    sendSuccess(res, summary, 'Referral summary retrieved.');
});

const getMySubAgent = catchAsync(async (req, res) => {
    const summary = await referralService.getReferralSummary(req.user._id);
    sendSuccess(res, summary, 'Sub-agent summary retrieved.');
});

const requestSubAgent = catchAsync(async (req, res) => {
    const request = await groupRequestService.createGroupRequest({
        userId: req.user._id,
        requestType: GROUP_REQUEST_TYPES.SUB_AGENT,
        reason: req.body.requestedMessage || req.body.reason || req.body.message || null,
        proofImage: proofImageFromFile(req.file),
        metadata: { source: 'sub-agent-api' },
        actor: actorFrom(req),
    });

    sendSuccess(res, { request }, 'تم إرسال الطلب، وهيتم مراجعته من الإدارة، وفي حالة الموافقة هيتم تحويل حسابك إلى وكيل فرعي.');
});

const getMyCommissions = catchAsync(async (req, res) => {
    const result = await referralService.listCommissions({
        inviterUserId: req.user._id,
        status: req.query.status,
        page: req.query.page,
        limit: req.query.limit,
        admin: false,
    });

    sendPaginated(res, { commissions: result.commissions }, result.pagination, 'Referral commissions retrieved.');
});

const getMyPayoutSummary = catchAsync(async (req, res) => {
    const summary = await referralService.getReferralPayoutSummary(req.user._id);
    sendSuccess(res, summary, 'Referral payout summary retrieved.');
});

const getMyPayouts = catchAsync(async (req, res) => {
    const result = await referralService.listReferralPayouts({
        userId: req.user._id,
        status: req.query.status,
        method: req.query.method,
        currency: req.query.currency,
        page: req.query.page,
        limit: req.query.limit,
        admin: false,
    });

    sendPaginated(res, { payouts: result.payouts }, result.pagination, 'Referral payout requests retrieved.');
});

const createMyPayout = catchAsync(async (req, res) => {
    const payout = await referralService.createReferralPayoutRequest(req.user._id, req.body, actorFrom(req));
    sendSuccess(res, { payout }, 'Referral payout request submitted.');
});

const getMyReferredUsers = catchAsync(async (req, res) => {
    const result = await referralService.getReferredUsers(req.user._id, {
        page: req.query.page,
        limit: req.query.limit,
    });

    sendPaginated(res, { referredUsers: result.referredUsers }, result.pagination, 'Referred users retrieved.');
});

const getReferralSettings = catchAsync(async (req, res) => {
    const settings = await referralService.getReferralSettings();
    sendSuccess(res, { settings }, 'Referral settings retrieved.');
});

const updateReferralSettings = catchAsync(async (req, res) => {
    const settings = await referralService.updateReferralSettings(req.body, actorFrom(req));
    sendSuccess(res, { settings }, 'Referral settings updated.');
});

const adminListRelationships = catchAsync(async (req, res) => {
    const result = await referralService.listRelationships({
        inviterUserId: req.query.inviterUserId,
        invitedUserId: req.query.invitedUserId,
        status: req.query.status,
        from: req.query.from,
        to: req.query.to,
        page: req.query.page,
        limit: req.query.limit,
    });

    sendPaginated(res, { relationships: result.relationships }, result.pagination, 'Referral relationships retrieved.');
});

const adminListCommissions = catchAsync(async (req, res) => {
    const result = await referralService.listCommissions({
        inviterUserId: req.query.inviterUserId,
        invitedUserId: req.query.invitedUserId,
        status: req.query.status,
        from: req.query.from,
        to: req.query.to,
        page: req.query.page,
        limit: req.query.limit,
        admin: true,
    });

    sendPaginated(res, { commissions: result.commissions }, result.pagination, 'Referral commissions retrieved.');
});

const adminListReferralPayouts = catchAsync(async (req, res) => {
    const result = await referralService.listReferralPayouts({
        userId: req.query.userId || req.query.user,
        status: req.query.status,
        method: req.query.method,
        currency: req.query.currency,
        from: req.query.from,
        to: req.query.to,
        page: req.query.page,
        limit: req.query.limit,
        admin: true,
    });

    sendPaginated(res, { payouts: result.payouts }, result.pagination, 'Referral payout requests retrieved.');
});

const adminGetReferralPayout = catchAsync(async (req, res) => {
    const payout = await referralService.getReferralPayoutById(req.params.id, { admin: true });
    sendSuccess(res, { payout }, 'Referral payout request retrieved.');
});

const adminApproveReferralPayoutWalletCredit = catchAsync(async (req, res) => {
    const result = await referralService.approveReferralPayoutWalletCredit(req.params.id, actorFrom(req));
    sendSuccess(
        res,
        result,
        result.alreadyProcessed ? 'Referral payout request already paid.' : 'Referral payout credited to wallet.'
    );
});

const adminMarkReferralPayoutPaid = catchAsync(async (req, res) => {
    const result = await referralService.markReferralPayoutPaid(
        req.params.id,
        { adminNotes: req.body.adminNotes || req.body.adminNote || null },
        actorFrom(req)
    );
    sendSuccess(
        res,
        result,
        result.alreadyProcessed ? 'Referral payout request already paid.' : 'Referral payout request marked paid.'
    );
});

const adminRejectReferralPayout = catchAsync(async (req, res) => {
    const result = await referralService.rejectReferralPayout(
        req.params.id,
        {
            reason: req.body.reason || req.body.rejectionReason,
            adminNotes: req.body.adminNotes || req.body.adminNote || null,
        },
        actorFrom(req)
    );
    sendSuccess(
        res,
        result,
        result.alreadyProcessed ? 'Referral payout request already rejected.' : 'Referral payout request rejected.'
    );
});

const adminListSubAgentRequests = catchAsync(async (req, res) => {
    const result = await groupRequestService.listRequests({
        status: req.query.status,
        requestType: GROUP_REQUEST_TYPES.SUB_AGENT,
        userId: req.query.userId,
        from: req.query.from,
        to: req.query.to,
        page: req.query.page,
        limit: req.query.limit,
    });

    sendPaginated(res, { requests: result.requests }, result.pagination, 'Sub-agent requests retrieved.');
});

const adminApproveSubAgentRequest = catchAsync(async (req, res) => {
    const result = await groupRequestService.approveGroupRequest(req.params.id, {
        approvedGroupId: req.body.approvedGroupId || req.body.groupId || null,
        adminNote: req.body.adminNote || null,
        adminId: req.user._id,
        actor: actorFrom(req),
    });

    sendSuccess(res, result, result.alreadyProcessed ? 'Sub-agent request already approved.' : 'Sub-agent request approved.');
});

const adminRejectSubAgentRequest = catchAsync(async (req, res) => {
    const result = await groupRequestService.rejectGroupRequest(req.params.id, {
        adminNote: req.body.rejectionReason || req.body.adminNote || null,
        adminId: req.user._id,
        actor: actorFrom(req),
    });

    sendSuccess(res, result, result.alreadyProcessed ? 'Sub-agent request already rejected.' : 'Sub-agent request rejected.');
});

const adminListSubAgents = catchAsync(async (req, res) => {
    const result = await referralService.listSubAgents({
        status: req.query.status,
        page: req.query.page,
        limit: req.query.limit,
    });

    sendPaginated(res, { subAgents: result.subAgents }, result.pagination, 'Sub-agents retrieved.');
});

const adminUpdateSubAgent = catchAsync(async (req, res) => {
    const subAgent = await referralService.updateSubAgent(req.params.userId, req.body, actorFrom(req));
    sendSuccess(res, { subAgent }, 'Sub-agent updated.');
});

const adminGetSubAgentReferredUsers = catchAsync(async (req, res) => {
    const result = await referralService.getReferredUsers(req.params.userId, {
        page: req.query.page,
        limit: req.query.limit,
    });

    sendPaginated(res, { referredUsers: result.referredUsers }, result.pagination, 'Sub-agent referred users retrieved.');
});

module.exports = {
    validateCode,
    getMyReferrals,
    getMySubAgent,
    requestSubAgent,
    getMyCommissions,
    getMyPayoutSummary,
    getMyPayouts,
    createMyPayout,
    getMyReferredUsers,
    getReferralSettings,
    updateReferralSettings,
    adminListRelationships,
    adminListCommissions,
    adminListReferralPayouts,
    adminGetReferralPayout,
    adminApproveReferralPayoutWalletCredit,
    adminMarkReferralPayoutPaid,
    adminRejectReferralPayout,
    adminListSubAgentRequests,
    adminApproveSubAgentRequest,
    adminRejectSubAgentRequest,
    adminListSubAgents,
    adminUpdateSubAgent,
    adminGetSubAgentReferredUsers,
};
