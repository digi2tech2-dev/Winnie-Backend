'use strict';

const { Router } = require('express');
const { body, param, query } = require('express-validator');
const authenticate = require('../../shared/middlewares/authenticate');
const requireActiveUser = require('../../shared/middlewares/requireActiveUser');
const authorize = require('../../shared/middlewares/authorize');
const { authorizeRoles, requirePermission, requireAnyPermission } = authorize;
const validate = require('../../shared/middlewares/validate');
const { createUpload } = require('../../shared/middlewares/upload');
const referralController = require('./referral.controller');
const { GROUP_REQUEST_PERMISSIONS } = require('../groupRequests/groupRequest.constants');
const {
    validateCodeValidation,
    referralSettingsValidation,
    relationshipListValidation,
    commissionListValidation,
    myCommissionListValidation,
    payoutListValidation,
    createPayoutValidation,
    rejectPayoutValidation,
} = require('./referral.validation');

const router = Router();
const subAgentProofUpload = createUpload('sub-agent-requests', {
    allowedMimes: new Set(['image/jpeg', 'image/png', 'image/webp']),
    allowedExts: new Set(['.jpg', '.jpeg', '.png', '.webp']),
    acceptedLabel: 'JPG, JPEG, PNG, and WebP',
    maxFileSize: 5 * 1024 * 1024,
});

router.post(
    '/referrals/validate-code',
    validateCodeValidation,
    validate,
    referralController.validateCode
);

router.get(
    '/me/referrals',
    authenticate,
    requireActiveUser,
    referralController.getMyReferrals
);

router.get(
    '/me/sub-agent',
    authenticate,
    requireActiveUser,
    referralController.getMySubAgent
);

router.post(
    '/me/sub-agent/request',
    authenticate,
    requireActiveUser,
    authorizeRoles('CUSTOMER'),
    subAgentProofUpload.single('proofImage'),
    body('requestedMessage').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
    body('message').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
    body('reason').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
    validate,
    referralController.requestSubAgent
);

router.get(
    '/me/referrals/commissions',
    authenticate,
    requireActiveUser,
    myCommissionListValidation,
    validate,
    referralController.getMyCommissions
);

router.get(
    '/me/referrals/payout-summary',
    authenticate,
    requireActiveUser,
    referralController.getMyPayoutSummary
);

router.get(
    '/me/referrals/payouts',
    authenticate,
    requireActiveUser,
    payoutListValidation,
    validate,
    referralController.getMyPayouts
);

router.post(
    '/me/referrals/payouts',
    authenticate,
    requireActiveUser,
    authorizeRoles('CUSTOMER'),
    createPayoutValidation,
    validate,
    referralController.createMyPayout
);

router.get(
    '/me/sub-agent/commissions',
    authenticate,
    requireActiveUser,
    myCommissionListValidation,
    validate,
    referralController.getMyCommissions
);

router.get(
    '/me/sub-agent/referred-users',
    authenticate,
    requireActiveUser,
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    validate,
    referralController.getMyReferredUsers
);

router.get(
    '/admin/referral-settings',
    authenticate,
    authorizeRoles('ADMIN', 'SUPERVISOR'),
    requirePermission('referrals.view'),
    referralController.getReferralSettings
);

router.patch(
    '/admin/referral-settings',
    authenticate,
    authorizeRoles('ADMIN'),
    referralSettingsValidation,
    validate,
    referralController.updateReferralSettings
);

router.get(
    '/admin/referrals/relationships',
    authenticate,
    authorizeRoles('ADMIN', 'SUPERVISOR'),
    requirePermission('referrals.view'),
    relationshipListValidation,
    validate,
    referralController.adminListRelationships
);

router.get(
    '/admin/referrals/commissions',
    authenticate,
    authorizeRoles('ADMIN', 'SUPERVISOR'),
    requirePermission('referrals.view'),
    commissionListValidation,
    validate,
    referralController.adminListCommissions
);

router.get(
    '/admin/referral-payouts',
    authenticate,
    authorizeRoles('ADMIN', 'SUPERVISOR'),
    requireAnyPermission('referral_payouts.read', 'referrals.view'),
    payoutListValidation,
    validate,
    referralController.adminListReferralPayouts
);

router.get(
    '/admin/referral-payouts/:id',
    authenticate,
    authorizeRoles('ADMIN', 'SUPERVISOR'),
    requireAnyPermission('referral_payouts.read', 'referrals.view'),
    param('id').isMongoId(),
    validate,
    referralController.adminGetReferralPayout
);

router.post(
    '/admin/referral-payouts/:id/approve-wallet-credit',
    authenticate,
    authorizeRoles('ADMIN', 'SUPERVISOR'),
    requireAnyPermission('referral_payouts.manage', 'wallet.adjust'),
    param('id').isMongoId(),
    validate,
    referralController.adminApproveReferralPayoutWalletCredit
);

router.post(
    '/admin/referral-payouts/:id/mark-paid',
    authenticate,
    authorizeRoles('ADMIN', 'SUPERVISOR'),
    requirePermission('referral_payouts.manage'),
    param('id').isMongoId(),
    body('adminNotes').optional({ nullable: true }).isString().trim().isLength({ max: 2000 }),
    body('adminNote').optional({ nullable: true }).isString().trim().isLength({ max: 2000 }),
    validate,
    referralController.adminMarkReferralPayoutPaid
);

router.post(
    '/admin/referral-payouts/:id/reject',
    authenticate,
    authorizeRoles('ADMIN', 'SUPERVISOR'),
    requirePermission('referral_payouts.manage'),
    param('id').isMongoId(),
    rejectPayoutValidation,
    validate,
    referralController.adminRejectReferralPayout
);

router.get(
    '/admin/sub-agents/requests',
    authenticate,
    authorizeRoles('ADMIN', 'SUPERVISOR'),
    requireAnyPermission(GROUP_REQUEST_PERMISSIONS.VIEW, GROUP_REQUEST_PERMISSIONS.MANAGE),
    referralController.adminListSubAgentRequests
);

router.post(
    '/admin/sub-agents/requests/:id/approve',
    authenticate,
    authorizeRoles('ADMIN', 'SUPERVISOR'),
    requirePermission(GROUP_REQUEST_PERMISSIONS.MANAGE),
    param('id').isMongoId(),
    body('approvedGroupId').optional({ nullable: true, checkFalsy: true }).isMongoId(),
    body('groupId').optional({ nullable: true, checkFalsy: true }).isMongoId(),
    body('approvedCommissionPercent').optional({ nullable: true }).isFloat({ min: 0, max: 100 }),
    body('commissionPercent').optional({ nullable: true }).isFloat({ min: 0, max: 100 }),
    validate,
    referralController.adminApproveSubAgentRequest
);

router.post(
    '/admin/sub-agents/requests/:id/reject',
    authenticate,
    authorizeRoles('ADMIN', 'SUPERVISOR'),
    requirePermission(GROUP_REQUEST_PERMISSIONS.MANAGE),
    param('id').isMongoId(),
    body('rejectionReason').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
    body('adminNote').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
    validate,
    referralController.adminRejectSubAgentRequest
);

router.get(
    '/admin/sub-agents',
    authenticate,
    authorizeRoles('ADMIN', 'SUPERVISOR'),
    requirePermission('referrals.view'),
    referralController.adminListSubAgents
);

router.patch(
    '/admin/sub-agents/:userId',
    authenticate,
    authorizeRoles('ADMIN'),
    param('userId').isMongoId(),
    body('commissionPercent').optional({ nullable: true }).isFloat({ min: 0, max: 100 }),
    body('referralCommissionPercentOverride').optional({ nullable: true }).isFloat({ min: 0, max: 100 }),
    body('useDefault').optional().isBoolean().toBoolean(),
    body('groupId').optional({ nullable: true, checkFalsy: true }).isMongoId(),
    body('status').optional().isIn(['active', 'inactive']),
    body('active').optional().isBoolean(),
    validate,
    referralController.adminUpdateSubAgent
);

router.get(
    '/admin/sub-agents/:userId/referred-users',
    authenticate,
    authorizeRoles('ADMIN', 'SUPERVISOR'),
    requirePermission('referrals.view'),
    param('userId').isMongoId(),
    validate,
    referralController.adminGetSubAgentReferredUsers
);

router.get(
    '/admin/sub-agents/commissions',
    authenticate,
    authorizeRoles('ADMIN', 'SUPERVISOR'),
    requirePermission('referrals.view'),
    commissionListValidation,
    validate,
    referralController.adminListCommissions
);

module.exports = router;
