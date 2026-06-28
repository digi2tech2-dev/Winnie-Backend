'use strict';

const groupRequestService = require('./groupRequest.service');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');

const actorFrom = (req) => ({
    actorId: req.user?._id,
    actorRole: req.user?.role,
    ipAddress: req.ip || null,
    userAgent: req.get('User-Agent') || null,
});

const createMyRequest = catchAsync(async (req, res) => {
    const request = await groupRequestService.createGroupRequest({
        userId: req.user._id,
        requestType: req.body.requestType,
        requestedGroupId: req.body.requestedGroupId || null,
        reason: req.body.reason || null,
        metadata: { source: 'customer-api' },
        actor: actorFrom(req),
    });

    sendCreated(res, { request }, 'Group request submitted.');
});

const listMyRequests = catchAsync(async (req, res) => {
    const result = await groupRequestService.listMyRequests(req.user._id, {
        status: req.query.status,
        requestType: req.query.requestType,
        page: req.query.page,
        limit: req.query.limit,
    });

    sendPaginated(res, { requests: result.requests }, result.pagination, 'Group requests retrieved.');
});

const getMyRequest = catchAsync(async (req, res) => {
    const request = await groupRequestService.getMyRequestById(req.user._id, req.params.id);
    sendSuccess(res, { request }, 'Group request retrieved.');
});

const cancelMyRequest = catchAsync(async (req, res) => {
    const request = await groupRequestService.cancelMyRequest(req.user._id, req.params.id, {
        actor: actorFrom(req),
    });

    sendSuccess(res, { request }, 'Group request canceled.');
});

const adminListRequests = catchAsync(async (req, res) => {
    const result = await groupRequestService.listRequests({
        status: req.query.status,
        requestType: req.query.requestType,
        userId: req.query.userId,
        requestedGroupId: req.query.requestedGroupId,
        from: req.query.from,
        to: req.query.to,
        page: req.query.page,
        limit: req.query.limit,
    });

    sendPaginated(res, { requests: result.requests }, result.pagination, 'Group requests retrieved.');
});

const adminGetRequest = catchAsync(async (req, res) => {
    const request = await groupRequestService.getRequestById(req.params.id);
    sendSuccess(res, { request }, 'Group request retrieved.');
});

const adminApproveRequest = catchAsync(async (req, res) => {
    const result = await groupRequestService.approveGroupRequest(req.params.id, {
        approvedGroupId: req.body.approvedGroupId || null,
        adminNote: req.body.adminNote || null,
        adminId: req.user._id,
        actor: actorFrom(req),
    });

    sendSuccess(
        res,
        { request: result.request, alreadyProcessed: result.alreadyProcessed },
        result.alreadyProcessed ? 'Group request already approved.' : 'Group request approved.'
    );
});

const adminRejectRequest = catchAsync(async (req, res) => {
    const result = await groupRequestService.rejectGroupRequest(req.params.id, {
        adminNote: req.body.adminNote || null,
        adminId: req.user._id,
        actor: actorFrom(req),
    });

    sendSuccess(
        res,
        { request: result.request, alreadyProcessed: result.alreadyProcessed },
        result.alreadyProcessed ? 'Group request already rejected.' : 'Group request rejected.'
    );
});

module.exports = {
    createMyRequest,
    listMyRequests,
    getMyRequest,
    cancelMyRequest,
    adminListRequests,
    adminGetRequest,
    adminApproveRequest,
    adminRejectRequest,
};
