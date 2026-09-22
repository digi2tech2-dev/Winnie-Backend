'use strict';

const { Router } = require('express');
const { body } = require('express-validator');
const authenticate = require('../../../shared/middlewares/authenticate');
const authorize = require('../../../shared/middlewares/authorize');
const validate = require('../../../shared/middlewares/validate');
const catchAsync = require('../../../shared/utils/catchAsync');
const { sendSuccess } = require('../../../shared/utils/apiResponse');
const { WHATSAPP_PERMISSIONS } = require('./whatsapp.constants');
const { getWhatsAppStatus, reconnectWhatsApp, resetWhatsAppSession } = require('../../whatsapp/whatsapp.service');
const { getPolicy, updatePolicy, DEFAULT_EVENT_PREFERENCES, listBalanceCapableProviders } = require('../../whatsapp/adminNotificationPolicy.service');

const { authorizeRoles, requirePermission } = authorize;
const router = Router();
router.use(authenticate, authorizeRoles('ADMIN', 'SUPERVISOR'));

router.get('/status', requirePermission(WHATSAPP_PERMISSIONS.READ), catchAsync(async (_req, res) => {
    const [status, settings, balanceProviders] = await Promise.all([Promise.resolve(getWhatsAppStatus()), getPolicy(), listBalanceCapableProviders()]);
    sendSuccess(res, { status, settings: { ...settings, balanceProviders } }, 'WhatsApp status and policy retrieved');
}));
router.patch('/settings', requirePermission(WHATSAPP_PERMISSIONS.MANAGE), [
    body('eventPreferences').exists().isObject(),
    body('providerBalanceThresholds').optional().isObject(),
    ...Object.keys(DEFAULT_EVENT_PREFERENCES).map((key) => body(`eventPreferences.${key}`).optional().isBoolean().toBoolean()),
], validate, catchAsync(async (req, res) => {
    const settings = await updatePolicy(req.body, req.user._id);
    sendSuccess(res, { settings }, 'WhatsApp event policy saved');
}));
router.post('/reconnect', requirePermission(WHATSAPP_PERMISSIONS.MANAGE), catchAsync(async (_req, res) => {
    const status = await reconnectWhatsApp();
    sendSuccess(res, { status }, 'WhatsApp reconnect requested');
}));
router.post('/reset', requirePermission(WHATSAPP_PERMISSIONS.MANAGE), catchAsync(async (_req, res) => {
    const status = await resetWhatsAppSession();
    sendSuccess(res, { status }, 'WhatsApp session reset requested');
}));

module.exports = router;
