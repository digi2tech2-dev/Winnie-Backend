'use strict';

/**
 * admin.users.controller.js
 *
 * Thin HTTP adapter — all logic lives in admin.users.service.js.
 */

const svc = require('./admin.users.service');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');

// GET /admin/users
const listUsers = catchAsync(async (req, res) => {
    const { status, verified, email, role, includeDeleted, includeBlocked, from, to, page, limit, sortBy, sortOrder } = req.query;
    const normalizedSortBy = typeof sortBy === 'string' && sortBy.trim() ? sortBy.trim() : 'walletBalance';
    const normalizedSortOrder = String(sortOrder || '').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';
    const result = await svc.listUsers({
        status,
        verified: verified !== undefined ? verified === 'true' : undefined,
        email,
        role,
        includeDeleted: includeDeleted === true || includeDeleted === 'true',
        includeBlocked: includeBlocked === undefined ? true : (includeBlocked === true || includeBlocked === 'true'),
        from,
        to,
        page: parseInt(page ?? 1, 10),
        limit: parseInt(limit ?? 20, 10),
        sortBy: normalizedSortBy,
        sortOrder: normalizedSortOrder,
    });
    sendPaginated(res, result.users, result.pagination, 'Users retrieved');
});

// GET /admin/users/:id
const getUserById = catchAsync(async (req, res) => {
    const user = await svc.getUserById(req.params.id);
    sendSuccess(res, { user }, 'User retrieved');
});

// GET /admin/supervisors
const listSupervisors = catchAsync(async (req, res) => {
    const { status, verified, email, search, from, to, page, limit, sortBy, sortOrder } = req.query;
    const result = await svc.listSupervisors({
        status,
        verified: verified !== undefined ? verified === 'true' : undefined,
        email,
        search,
        from,
        to,
        page: parseInt(page ?? 1, 10),
        limit: parseInt(limit ?? 20, 10),
        sortBy,
        sortOrder,
    });
    sendSuccess(res, result, 'Supervisors retrieved');
});

// GET /admin/supervisors/permissions
const listSupervisorPermissions = catchAsync(async (_req, res) => {
    const result = await svc.listSupervisorPermissions();
    sendSuccess(res, result, 'Supervisor permissions retrieved');
});

// GET /admin/supervisors/eligible-users
const listEligibleSupervisorUsers = catchAsync(async (req, res) => {
    const result = await svc.listEligibleSupervisorUsers({
        search: req.query.search,
        page: parseInt(req.query.page ?? 1, 10),
        limit: parseInt(req.query.limit ?? 10, 10),
        currentAdminId: req.user._id,
    });
    sendSuccess(res, result, 'Eligible supervisor users retrieved');
});

// POST /admin/supervisors
const createSupervisor = catchAsync(async (req, res) => {
    const supervisor = await svc.createSupervisor(req.body, req.user._id);
    sendCreated(res, { supervisor }, 'Supervisor assigned');
});

// DELETE /admin/supervisors/:id
const deleteSupervisor = catchAsync(async (req, res) => {
    const supervisor = await svc.deleteSupervisor(req.params.id, req.user._id);
    sendSuccess(res, { supervisor }, 'Supervisor access removed');
});

// PATCH /admin/supervisors/:id/restore
const restoreSupervisor = catchAsync(async (req, res) => {
    const supervisor = await svc.restoreSupervisor(req.params.id, req.user._id);
    sendSuccess(res, { supervisor }, 'Supervisor restored');
});

// PATCH /admin/users/:id
const updateUser = catchAsync(async (req, res) => {
    const user = await svc.updateUser(req.params.id, req.body, req.user._id);
    sendSuccess(res, { user }, 'User updated');
});

// DELETE /admin/users/:id
const deleteUser = catchAsync(async (req, res) => {
    const user = await svc.deleteUser(req.params.id, req.user._id);
    sendSuccess(res, { user }, 'User soft-deleted');
});

// GET /admin/users/deleted
const listDeletedUsers = catchAsync(async (req, res) => {
    const { page, limit } = req.query;
    const result = await svc.listDeletedUsers({
        page: parseInt(page ?? 1, 10),
        limit: parseInt(limit ?? 100, 10),
    });
    sendPaginated(res, result.users, result.pagination, 'Deleted users retrieved');
});

// PATCH /admin/users/:id/restore
const restoreUser = catchAsync(async (req, res) => {
    const user = await svc.restoreUser(req.params.id, req.user._id);
    sendSuccess(res, { user }, 'User restored');
});

// PATCH /admin/users/:id/approve
const approveUser = catchAsync(async (req, res) => {
    const user = await svc.approveUser(req.params.id, req.user._id);
    sendSuccess(res, { user }, 'User approved');
});

// PATCH /admin/users/:id/reject
const rejectUser = catchAsync(async (req, res) => {
    const user = await svc.rejectUser(req.params.id, req.user._id);
    sendSuccess(res, { user }, 'User rejected');
});

// PATCH /admin/users/:id/role
const updateUserRole = catchAsync(async (req, res) => {
    const user = await svc.updateUserRole(
        req.params.id,
        req.body.role,
        req.user._id,
        req.body.permissions
    );
    sendSuccess(res, { user }, 'User role updated');
});

// PATCH /admin/supervisors/:id/permissions
const updateSupervisorPermissions = catchAsync(async (req, res) => {
    const supervisor = await svc.updateSupervisorPermissions(
        req.params.id,
        req.body.permissions,
        req.user._id
    );
    sendSuccess(res, { supervisor }, 'Supervisor permissions updated');
});

// GET /admin/supervisors/:id/logs
const getSupervisorLogs = catchAsync(async (req, res) => {
    const result = await svc.getSupervisorLogs(req.params.id, {
        page: parseInt(req.query.page ?? 1, 10),
        limit: parseInt(req.query.limit ?? 20, 10),
    });
    sendSuccess(res, result, 'Supervisor logs retrieved');
});

// GET /admin/supervisors/logs
const getAllSupervisorLogs = catchAsync(async (req, res) => {
    const result = await svc.getAllSupervisorLogs({
        page: parseInt(req.query.page ?? 1, 10),
        limit: parseInt(req.query.limit ?? 20, 10),
    });
    sendSuccess(res, result, 'Supervisor logs retrieved');
});

// PATCH /admin/users/:id/currency
const updateUserCurrency = catchAsync(async (req, res) => {
    const result = await svc.updateUserCurrency(
        req.params.id,
        req.body.currency,
        req.user._id,
        req.body.reason
    );
    sendSuccess(res, result, 'User currency updated');
});

// PATCH /admin/users/:id/identity-verification
const updateIdentityVerificationHold = catchAsync(async (req, res) => {
    const user = await svc.updateIdentityVerificationHold(
        req.params.id,
        {
            required: req.body.required,
            reason: req.body.reason,
        },
        req.user._id
    );
    sendSuccess(
        res,
        { user },
        user.identityVerificationRequired
            ? 'Identity verification hold enabled.'
            : 'Identity verification hold cleared.'
    );
});

// POST /admin/users/:id/reset-password
const resetUserPassword = catchAsync(async (req, res) => {
    const user = await svc.resetUserPassword(
        req.params.id,
        req.body.newPassword || req.body.password,
        req.user._id
    );
    sendSuccess(res, { user }, 'User password reset');
});

// PATCH /admin/users/:id/block
const blockUser = catchAsync(async (req, res) => {
    const user = await svc.blockUser(req.params.id, req.user._id, req.body.reason);
    sendSuccess(res, { user }, 'User blocked');
});

// PATCH /admin/users/:id/unblock
const unblockUser = catchAsync(async (req, res) => {
    const user = await svc.unblockUser(req.params.id, req.user._id, req.body.reason);
    sendSuccess(res, { user }, 'User unblocked');
});

// PATCH /admin/users/:id/avatar
const updateUserAvatar = catchAsync(async (req, res) => {
    const relativePath = req.file ? `/uploads/avatars/${req.file.filename}` : null;
    const user = await svc.updateUserAvatar(req.params.id, relativePath, req.user._id);
    sendSuccess(res, { user }, 'User avatar updated');
});

// PATCH /admin/users/:id/credit-limit
const updateUserCreditLimit = catchAsync(async (req, res) => {
    const user = await svc.updateUserCreditLimit(
        req.params.id,
        req.body.creditLimit,
        req.user._id,
        req.body.reason
    );
    sendSuccess(res, { user }, 'User credit limit updated');
});

// PATCH /admin/users/:id/group
const updateUserGroup = catchAsync(async (req, res) => {
    const user = await svc.updateUserGroup(
        req.params.id,
        {
            groupId: req.body.groupId,
            reason: req.body.reason,
        },
        req.user._id
    );
    sendSuccess(res, { user }, 'User group updated');
});

module.exports = {
    listUsers,
    listSupervisors,
    listSupervisorPermissions,
    listEligibleSupervisorUsers,
    listDeletedUsers,
    getUserById,
    createSupervisor,
    updateUser,
    deleteUser,
    deleteSupervisor,
    restoreUser,
    restoreSupervisor,
    approveUser,
    rejectUser,
    updateUserRole,
    updateSupervisorPermissions,
    getSupervisorLogs,
    getAllSupervisorLogs,
    updateUserCurrency,
    updateIdentityVerificationHold,
    updateUserCreditLimit,
    updateUserGroup,
    resetUserPassword,
    blockUser,
    unblockUser,
    updateUserAvatar,
};
