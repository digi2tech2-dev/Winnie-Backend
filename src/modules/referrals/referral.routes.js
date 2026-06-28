'use strict';

const { Router } = require('express');
const authenticate = require('../../shared/middlewares/authenticate');
const requireActiveUser = require('../../shared/middlewares/requireActiveUser');
const authorize = require('../../shared/middlewares/authorize');
const { authorizeRoles, requirePermission } = authorize;
const validate = require('../../shared/middlewares/validate');
const referralController = require('./referral.controller');
const {
    validateCodeValidation,
    referralSettingsValidation,
    relationshipListValidation,
    commissionListValidation,
    myCommissionListValidation,
} = require('./referral.validation');

const router = Router();

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
    '/me/referrals/commissions',
    authenticate,
    requireActiveUser,
    myCommissionListValidation,
    validate,
    referralController.getMyCommissions
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

module.exports = router;
