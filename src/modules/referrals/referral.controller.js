'use strict';

const referralService = require('./referral.service');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess, sendPaginated } = require('../../shared/utils/apiResponse');

const actorFrom = (req) => ({
    actorId: req.user?._id,
    actorRole: req.user?.role,
    role: req.user?.role,
    ipAddress: req.ip || null,
    userAgent: req.get('User-Agent') || null,
});

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

module.exports = {
    validateCode,
    getMyReferrals,
    getMyCommissions,
    getReferralSettings,
    updateReferralSettings,
    adminListRelationships,
    adminListCommissions,
};
