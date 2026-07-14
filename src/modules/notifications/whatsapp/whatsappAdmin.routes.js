'use strict';

const { Router } = require('express');
const { body, param, query } = require('express-validator');
const authenticate = require('../../../shared/middlewares/authenticate');
const authorize = require('../../../shared/middlewares/authorize');
const validate = require('../../../shared/middlewares/validate');
const catchAsync = require('../../../shared/utils/catchAsync');
const { sendSuccess, sendPaginated } = require('../../../shared/utils/apiResponse');
const { authLimiter } = require('../../../shared/middlewares/rateLimiter');
const service = require('./whatsappNotification.service');
const { WHATSAPP_PERMISSIONS } = require('./whatsapp.constants');

const { authorizeRoles, requirePermission } = authorize;
const router = Router();

router.use(authenticate);
router.use(authorizeRoles('ADMIN', 'SUPERVISOR'));

const recipientValidation = [
    body('name').optional().isString().trim().isLength({ min: 1, max: 120 }),
    body('phone').optional().isString().trim().isLength({ min: 8, max: 30 }),
    body('enabled').optional().isBoolean().toBoolean(),
    body('eventPreferences').optional().isObject().withMessage('eventPreferences must be an object'),
];

router.get('/status', requirePermission(WHATSAPP_PERMISSIONS.READ), catchAsync(async (_req, res) => {
    const status = await service.getOpenWaStatus();
    sendSuccess(res, { status }, 'OpenWA status retrieved');
}));

router.get('/recipients', requirePermission(WHATSAPP_PERMISSIONS.READ), catchAsync(async (_req, res) => {
    const recipients = await service.listRecipients();
    sendSuccess(res, { recipients }, 'WhatsApp recipients retrieved');
}));

router.post(
    '/recipients',
    requirePermission(WHATSAPP_PERMISSIONS.MANAGE),
    [
        body('name').exists({ checkFalsy: true }).withMessage('name is required').isString().trim().isLength({ min: 1, max: 120 }),
        body('phone').exists({ checkFalsy: true }).withMessage('phone is required').isString().trim().isLength({ min: 8, max: 30 }),
        body('enabled').optional().isBoolean().toBoolean(),
        body('eventPreferences').optional().isObject(),
    ],
    validate,
    catchAsync(async (req, res) => {
        const recipient = await service.createRecipient(req.body, req.user._id, req.auditContext);
        res.status(201).json({ success: true, message: 'WhatsApp recipient created', data: { recipient } });
    })
);

router.patch(
    '/recipients/:id',
    requirePermission(WHATSAPP_PERMISSIONS.MANAGE),
    [param('id').isMongoId(), ...recipientValidation],
    validate,
    catchAsync(async (req, res) => {
        const recipient = await service.updateRecipient(req.params.id, req.body, req.user._id, req.auditContext);
        sendSuccess(res, { recipient }, 'WhatsApp recipient updated');
    })
);

router.delete(
    '/recipients/:id',
    requirePermission(WHATSAPP_PERMISSIONS.MANAGE),
    [param('id').isMongoId()],
    validate,
    catchAsync(async (req, res) => {
        const recipient = await service.deleteRecipient(req.params.id, req.user._id, req.auditContext);
        sendSuccess(res, { recipient }, 'WhatsApp recipient deleted');
    })
);

router.post(
    '/recipients/:id/test',
    requirePermission(WHATSAPP_PERMISSIONS.SEND_TEST),
    authLimiter,
    [param('id').isMongoId()],
    validate,
    catchAsync(async (req, res) => {
        const result = await service.sendRecipientTest(req.params.id, req.user._id, req.auditContext);
        sendSuccess(res, result, 'WhatsApp recipient test queued');
    })
);

router.get(
    '/logs',
    requirePermission(WHATSAPP_PERMISSIONS.LOGS),
    [
        query('status').optional().isString().trim(),
        query('eventType').optional().isString().trim(),
        query('recipientType').optional().isString().trim(),
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 100 }),
    ],
    validate,
    catchAsync(async (req, res) => {
        const result = await service.listLogs(req.query);
        sendPaginated(res, result.logs, result.pagination, 'WhatsApp notification logs retrieved');
    })
);

router.post(
    '/retry/:logId',
    requirePermission(WHATSAPP_PERMISSIONS.MANAGE),
    [param('logId').isMongoId()],
    validate,
    catchAsync(async (req, res) => {
        const log = await service.retryLog(req.params.logId, req.user._id, req.auditContext);
        sendSuccess(res, { log }, 'WhatsApp notification queued for retry');
    })
);

router.post(
    '/test-openwa',
    requirePermission(WHATSAPP_PERMISSIONS.SEND_TEST),
    authLimiter,
    [body('phone').exists({ checkFalsy: true }).withMessage('phone is required').isString().trim().isLength({ min: 8, max: 30 })],
    validate,
    catchAsync(async (req, res) => {
        const log = await service.sendOpenWaTest(req.body.phone, req.user._id, req.auditContext);
        sendSuccess(res, { log }, 'OpenWA test message queued');
    })
);

module.exports = router;
