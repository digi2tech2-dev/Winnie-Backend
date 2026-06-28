'use strict';

const { Router } = require('express');
const authenticate = require('../../shared/middlewares/authenticate');
const requireActiveUser = require('../../shared/middlewares/requireActiveUser');
const authorize = require('../../shared/middlewares/authorize');
const { authorizeRoles, requirePermission, requireAnyPermission } = authorize;
const validate = require('../../shared/middlewares/validate');
const groupRequestController = require('./groupRequest.controller');
const {
    createGroupRequestValidation,
    myGroupRequestListValidation,
    adminGroupRequestListValidation,
    requestIdValidation,
    approveGroupRequestValidation,
    rejectGroupRequestValidation,
} = require('./groupRequest.validation');
const { GROUP_REQUEST_PERMISSIONS } = require('./groupRequest.constants');

const router = Router();

router.post(
    '/me/group-change-requests',
    authenticate,
    requireActiveUser,
    authorizeRoles('CUSTOMER'),
    createGroupRequestValidation,
    validate,
    groupRequestController.createMyRequest
);

router.get(
    '/me/group-change-requests',
    authenticate,
    requireActiveUser,
    authorizeRoles('CUSTOMER'),
    myGroupRequestListValidation,
    validate,
    groupRequestController.listMyRequests
);

router.get(
    '/me/group-change-requests/:id',
    authenticate,
    requireActiveUser,
    authorizeRoles('CUSTOMER'),
    requestIdValidation,
    validate,
    groupRequestController.getMyRequest
);

router.post(
    '/me/group-change-requests/:id/cancel',
    authenticate,
    requireActiveUser,
    authorizeRoles('CUSTOMER'),
    requestIdValidation,
    validate,
    groupRequestController.cancelMyRequest
);

router.get(
    '/admin/group-change-requests',
    authenticate,
    authorizeRoles('ADMIN', 'SUPERVISOR'),
    requireAnyPermission(
        GROUP_REQUEST_PERMISSIONS.VIEW,
        GROUP_REQUEST_PERMISSIONS.MANAGE
    ),
    adminGroupRequestListValidation,
    validate,
    groupRequestController.adminListRequests
);

router.get(
    '/admin/group-change-requests/:id',
    authenticate,
    authorizeRoles('ADMIN', 'SUPERVISOR'),
    requireAnyPermission(
        GROUP_REQUEST_PERMISSIONS.VIEW,
        GROUP_REQUEST_PERMISSIONS.MANAGE
    ),
    requestIdValidation,
    validate,
    groupRequestController.adminGetRequest
);

router.patch(
    '/admin/group-change-requests/:id/approve',
    authenticate,
    authorizeRoles('ADMIN', 'SUPERVISOR'),
    requirePermission(GROUP_REQUEST_PERMISSIONS.MANAGE),
    approveGroupRequestValidation,
    validate,
    groupRequestController.adminApproveRequest
);

router.patch(
    '/admin/group-change-requests/:id/reject',
    authenticate,
    authorizeRoles('ADMIN', 'SUPERVISOR'),
    requirePermission(GROUP_REQUEST_PERMISSIONS.MANAGE),
    rejectGroupRequestValidation,
    validate,
    groupRequestController.adminRejectRequest
);

module.exports = router;
