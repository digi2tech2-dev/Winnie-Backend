'use strict';

const svc = require('./admin.securityPin.service');
const catchAsync = require('../../shared/utils/catchAsync');

const status = catchAsync(async (_req, res) => {
    const result = await svc.getStatus();
    res.status(200).json(result);
});

const verify = catchAsync(async (req, res) => {
    await svc.verifyPin(req.body?.pin);
    res.status(200).json({ valid: true });
});

const update = catchAsync(async (req, res) => {
    const result = await svc.updatePin(req.body, req.user._id, req.auditContext);
    res.status(200).json(result);
});

module.exports = { status, verify, update };
