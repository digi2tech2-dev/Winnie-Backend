'use strict';

const { Router } = require('express');
const { body } = require('express-validator');
const authenticate = require('../../../shared/middlewares/authenticate');
const requireActiveUser = require('../../../shared/middlewares/requireActiveUser');
const validate = require('../../../shared/middlewares/validate');
const catchAsync = require('../../../shared/utils/catchAsync');
const { sendSuccess } = require('../../../shared/utils/apiResponse');
const { authLimiter } = require('../../../shared/middlewares/rateLimiter');
const service = require('./whatsappNotification.service');

const router = Router();

router.use(authenticate, requireActiveUser);

const preferencesValidation = body('eventPreferences')
    .optional()
    .isObject().withMessage('eventPreferences must be an object');

router.get('/', catchAsync(async (req, res) => {
    const settings = await service.getCustomerSettings(req.user._id);
    sendSuccess(res, { settings }, 'WhatsApp notification settings retrieved');
}));

router.patch(
    '/',
    [
        body('enabled').optional().isBoolean().withMessage('enabled must be boolean').toBoolean(),
        body('phone').optional({ nullable: true }).isString().trim().isLength({ max: 30 }),
        preferencesValidation,
    ],
    validate,
    catchAsync(async (req, res) => {
        const settings = await service.updateCustomerSettings(req.user._id, req.body, req.auditContext);
        sendSuccess(res, { settings }, 'WhatsApp notification settings updated');
    })
);

router.post(
    '/send-code',
    authLimiter,
    [body('phone').exists({ checkFalsy: true }).withMessage('phone is required').isString().trim().isLength({ max: 30 })],
    validate,
    catchAsync(async (req, res) => {
        const result = await service.sendCustomerVerificationCode(req.user._id, req.body.phone, req.auditContext);
        sendSuccess(res, result, 'WhatsApp verification code queued');
    })
);

router.post(
    '/verify',
    [body('code').exists({ checkFalsy: true }).withMessage('code is required').isString().trim().matches(/^\d{6}$/)],
    validate,
    catchAsync(async (req, res) => {
        const settings = await service.verifyCustomerPhone(req.user._id, req.body.code, req.auditContext);
        sendSuccess(res, { settings }, 'WhatsApp phone verified');
    })
);

router.post('/test', authLimiter, catchAsync(async (req, res) => {
    const result = await service.sendCustomerTest(req.user._id, req.auditContext);
    sendSuccess(res, result, 'WhatsApp test message queued');
}));

module.exports = router;
