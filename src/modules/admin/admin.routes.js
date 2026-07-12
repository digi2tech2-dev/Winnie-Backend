'use strict';

/**
 * admin.routes.js — Master Admin Router
 *
 * All routes require:
 *   1. authenticate  — valid JWT
 *   2. authorize('ADMIN') — ADMIN role only
 *
 * Route Map:
 * DEPOSITS
 *   GET    /admin/deposits                    — list + filter (status, page, limit)
 *   GET    /admin/deposits/:id                — get one
 *   PATCH  /admin/deposits/:id/approve        — approve + credit wallet
 *   PATCH  /admin/deposits/:id/reject         — reject
 *
 * USERS
 *   GET    /admin/users                     — list + filter + paginate
 *   GET    /admin/users/:id                 — get one
 *   PATCH  /admin/users/:id                 — update
 *   DELETE /admin/users/:id                 — soft delete
 *   PATCH  /admin/users/:id/approve         — approve
 *   PATCH  /admin/users/:id/reject          — reject
 *   POST   /admin/users/adjust-debt          — bulk debt adjustment for currency devaluation
 *
 * PROVIDERS
 *   GET    /admin/providers                  — list
 *   GET    /admin/providers/:id              — get one
 *   POST   /admin/providers                  — create
 *   PATCH  /admin/providers/:id              — update
 *   DELETE /admin/providers/:id              — soft delete
 *   PATCH  /admin/providers/:id/toggle       — toggle active
 *   GET    /admin/providers/:id/balance      — live provider balance
 *   GET    /admin/providers/:id/products     — live provider product list
 *
 * ORDERS
 *   GET    /admin/orders                     — list + filter + paginate
 *   GET    /admin/orders/:id                 — get one
 *   POST   /admin/orders/:id/retry           — retry failed order
 *   POST   /admin/orders/:id/refund          — manual refund
 *
 * WALLETS
 *   GET    /admin/wallets                    — list all user wallets
 *   GET    /admin/wallets/:userId            — single user wallet
 *   GET    /admin/wallets/:userId/transactions — tx history
 *   POST   /admin/wallets/:userId/add        — add funds
 *   POST   /admin/wallets/:userId/deduct     — deduct funds
 *
 * CURRENCIES  (existing, re-mounted here for cohesion)
 *   GET    /admin/currencies                 — list
 *   PATCH  /admin/currencies/:code          — update platformRate
 *
 * GROUPS  (existing, already mounted separately — proxied here too)
 *   GET    /admin/groups                     — list
 *   POST   /admin/groups                     — create
 *   PATCH  /admin/groups/:id                 — update
 *   DELETE /admin/groups/:id                 — deactivate
 *
 * SETTINGS
 *   GET    /admin/settings                   — list all
 *   GET    /admin/settings/:key              — get one
 *   PATCH  /admin/settings/:key              — update value
 *
 * AUDIT LOGS
 *   GET    /admin/audit                      — get entity audit logs
 *   GET    /admin/audit/actor/:actorId       — get actor audit logs
 * DEPOSITS
 *   GET    /admin/deposits                    — list + filter (status, page, limit)
 *   GET    /admin/deposits/:id                — get one
 *   PATCH  /admin/deposits/:id/approve        — approve + credit wallet
 *   PATCH  /admin/deposits/:id/reject         — reject
 *
 */

const { Router } = require('express');
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');
const { authorizeRoles, requirePermission, requireAnyPermission } = authorize;
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess, sendPaginated } = require('../../shared/utils/apiResponse');
const { createUpload } = require('../../shared/middlewares/upload');
const { walletLimiter } = require('../../shared/middlewares/rateLimiter');
const validate = require('../../shared/middlewares/validate');

const { validateBody, validateQuery, schemas } = require('./admin.validation');
const {
    paymentIdValidation,
    listPaymentsValidation,
} = require('../payments/payment.validation');

const avatarUpload = createUpload('avatars');

// ── Controllers ───────────────────────────────────────────────────────────────
const usersCtrl = require('./admin.users.controller');
const providersCtrl = require('./admin.providers.controller');
const ordersCtrl = require('./admin.orders.controller');
const walletCtrl = require('./admin.wallet.controller');
const settingsCtrl = require('./admin.settings.controller');
const statsCtrl = require('./admin.stats.controller');
const paymentsCtrl = require('../payments/payment.controller');
const categoriesCtrl = require('../categories/category.controller');
const categoryValidation = require('../categories/category.validation');

// ── Existing services reused directly ─────────────────────────────────────────
const groupSvc = require('../groups/group.service');
const { Currency } = require('../currency/currency.model');
const { getEntityAuditLogs, getActorAuditLogs } = require('../audit/audit.service');
const depositSvc = require('../deposits/deposit.service');

const router = Router();

// ─── Auth guard — applied to every route in this router ──────────────────────
router.use(authenticate);
router.use(authorizeRoles('ADMIN', 'SUPERVISOR'));

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD STATISTICS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/dashboard/summary', authorizeRoles('ADMIN'), statsCtrl.getDashboardSummary);
router.get('/dashboard/stats', requirePermission('dashboard.view'), statsCtrl.getDashboardStats);
router.get('/stats', requirePermission('dashboard.view'), statsCtrl.getDashboardStats);

// SUPERVISORS
router.get('/supervisors', authorizeRoles('ADMIN'), validateQuery(schemas.listUsersQuery), usersCtrl.listSupervisors);
router.post('/supervisors', authorizeRoles('ADMIN'), validateBody(schemas.createSupervisor), usersCtrl.createSupervisor);
router.get('/supervisors/permissions', authorizeRoles('ADMIN'), usersCtrl.listSupervisorPermissions);
router.get('/supervisors/eligible-users', authorizeRoles('ADMIN'), validateQuery(schemas.listEligibleSupervisorUsersQuery), usersCtrl.listEligibleSupervisorUsers);
router.get('/supervisors/logs', authorizeRoles('ADMIN'), validateQuery(schemas.listSupervisorLogsQuery), usersCtrl.getAllSupervisorLogs);
router.get('/supervisors/:id/logs', authorizeRoles('ADMIN'), validateQuery(schemas.listSupervisorLogsQuery), usersCtrl.getSupervisorLogs);
router.patch(
    '/supervisors/:id/permissions',
    authorizeRoles('ADMIN'),
    validateBody(schemas.updateSupervisorPermissions),
    usersCtrl.updateSupervisorPermissions
);
router.patch('/supervisors/:id/restore', authorizeRoles('ADMIN'), usersCtrl.restoreSupervisor);
router.delete('/supervisors/:id', authorizeRoles('ADMIN'), usersCtrl.deleteSupervisor);

// ═══════════════════════════════════════════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/users', requirePermission('users.view'), validateQuery(schemas.listUsersQuery), usersCtrl.listUsers);
router.get('/users/deleted', authorizeRoles('ADMIN'), usersCtrl.listDeletedUsers); // MUST be before /:id
router.post('/users/adjust-debt', authorizeRoles('ADMIN'), requirePermission('wallet.adjust'), walletLimiter, validateBody(schemas.debtAdjustment), walletCtrl.adjustDebt);
router.get('/users/:id', requirePermission('users.view'), usersCtrl.getUserById);
router.patch('/users/:id', authorizeRoles('ADMIN'), validateBody(schemas.updateUser), usersCtrl.updateUser);
router.delete('/users/:id', requirePermission('users.delete'), usersCtrl.deleteUser);
// approve / reject / restore — specific actions must come BEFORE /:id pattern
router.patch('/users/:id/approve', requirePermission('users.status'), usersCtrl.approveUser);
router.patch('/users/:id/reject', requirePermission('users.status'), usersCtrl.rejectUser);
router.patch('/users/:id/restore', requirePermission('users.status'), usersCtrl.restoreUser);
router.patch('/users/:id/block', authorizeRoles('ADMIN'), validateBody(schemas.userReason), usersCtrl.blockUser);
router.patch('/users/:id/unblock', authorizeRoles('ADMIN'), validateBody(schemas.userReason), usersCtrl.unblockUser);
// Phase 4 gap-bridged routes
router.patch('/users/:id/role', authorizeRoles('ADMIN'), validateBody(schemas.updateUserRole), usersCtrl.updateUserRole);
router.patch('/users/:id/currency', authorizeRoles('ADMIN'), validateBody(schemas.updateUserCurrency), usersCtrl.updateUserCurrency);
router.patch(
    '/users/:id/identity-verification',
    authorizeRoles('ADMIN'),
    validateBody(schemas.updateIdentityVerification),
    usersCtrl.updateIdentityVerificationHold
);
router.patch('/users/:id/credit-limit', authorizeRoles('ADMIN'), validateBody(schemas.updateCreditLimit), usersCtrl.updateUserCreditLimit);
router.patch('/users/:id/group', authorizeRoles('ADMIN'), validateBody(schemas.updateUserGroup), usersCtrl.updateUserGroup);
router.patch('/users/:id/password', authorizeRoles('ADMIN'), validateBody(schemas.resetUserPassword), usersCtrl.resetUserPassword);
router.post('/users/:id/reset-password', authorizeRoles('ADMIN'), validateBody(schemas.resetUserPassword), usersCtrl.resetUserPassword);
router.patch('/users/:id/avatar', authorizeRoles('ADMIN'), avatarUpload.single('avatar'), usersCtrl.updateUserAvatar);

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDERS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/providers', requireAnyPermission('suppliers.manage', 'products.manage', 'manage_providers', 'manage_products'), providersCtrl.listProviders);
router.post('/providers', requirePermission('suppliers.manage'), validateBody(schemas.createProvider), providersCtrl.createProvider);
// sub-resource actions BEFORE /:id to avoid param collision
router.get('/providers/:id/balance', requirePermission('suppliers.manage'), providersCtrl.getProviderBalance);
router.get('/providers/:id/products', requirePermission('suppliers.manage'), providersCtrl.getProviderLiveProducts);
router.post('/providers/:id/test-connection', requirePermission('suppliers.manage'), providersCtrl.testProviderConnection);
router.get('/providers/:id/check-order', requirePermission('suppliers.manage'), providersCtrl.checkProviderOrder);
router.get('/providers/:providerId/products/:externalProductId/price', requirePermission('suppliers.manage'), providersCtrl.getProductPrice);
router.patch('/providers/:id/toggle', requirePermission('suppliers.manage'), providersCtrl.toggleProvider);
router.get('/providers/:id', requirePermission('suppliers.manage'), providersCtrl.getProviderById);
router.patch('/providers/:id', requirePermission('suppliers.manage'), validateBody(schemas.updateProvider), providersCtrl.updateProvider);
router.delete('/providers/:id', requirePermission('suppliers.manage'), providersCtrl.deleteProvider);

// ═══════════════════════════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/orders', requirePermission('orders.view'), validateQuery(schemas.listOrdersQuery), ordersCtrl.listOrders);
router.post('/orders/:id/retry', requirePermission('orders.update'), ordersCtrl.retryOrder);
router.post('/orders/:id/refund', requirePermission('orders.refund'), ordersCtrl.refundOrder);
router.post('/orders/:id/sync-status', requirePermission('orders.update'), ordersCtrl.syncOrderProviderStatus);
router.post('/orders/:id/complete', requirePermission('orders.update'), ordersCtrl.completeOrder);
router.patch('/orders/:id/status', requirePermission('orders.update'), validateBody(schemas.updateOrderStatus), ordersCtrl.updateStatus);
router.get('/orders/:id', requirePermission('orders.view'), ordersCtrl.getOrderById);

// PAYMENTS
router.get('/payments', requirePermission('payments.view'), listPaymentsValidation, validate, paymentsCtrl.adminListPayments);
router.post('/payments/:id/sync-status', requirePermission('payments.view'), paymentIdValidation, validate, paymentsCtrl.adminSyncPaymentStatus);
router.get('/payments/:id', requirePermission('payments.view'), paymentIdValidation, validate, paymentsCtrl.adminGetPayment);

// ═══════════════════════════════════════════════════════════════════════════════
// WALLETS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/wallets', requirePermission('wallet.view'), walletCtrl.listWallets);
router.get('/wallet-adjustments', requirePermission('wallet.view'), validateQuery(schemas.listAdminWalletAdjustmentsQuery), walletCtrl.listAdminAdjustments);
router.get('/wallets/:userId/transactions', requirePermission('wallet.view'), walletCtrl.getTransactionHistory);
router.post('/wallets/:userId/add', requirePermission('wallet.adjust'), walletLimiter, validateBody(schemas.walletAdjustment), walletCtrl.addFunds);
router.post('/wallets/:userId/deduct', authorizeRoles('ADMIN'), requirePermission('wallet.adjust'), walletLimiter, validateBody(schemas.walletAdjustment), walletCtrl.deductFunds);
router.put('/wallets/:userId/set', authorizeRoles('ADMIN'), requirePermission('wallet.adjust'), walletLimiter, validateBody(schemas.walletSetBalance), walletCtrl.setBalance);
router.get('/wallets/:userId', requirePermission('wallet.view'), walletCtrl.getWallet);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORIES  (Phase 4b gap-bridged module)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/categories', requirePermission('products.view'), categoriesCtrl.listCategories);
router.get('/categories/:id', requirePermission('products.view'), categoriesCtrl.getCategoryById);
router.post('/categories', requirePermission('products.manage'), validateBody(categoryValidation.createCategorySchema), categoriesCtrl.createCategory);
router.patch('/categories/:id', requirePermission('products.manage'), validateBody(categoryValidation.updateCategorySchema), categoriesCtrl.updateCategory);
router.patch('/categories/:id/toggle', requirePermission('products.manage'), categoriesCtrl.toggleCategory);
router.delete('/categories/:id', requirePermission('products.manage'), categoriesCtrl.deleteCategory);

// ═══════════════════════════════════════════════════════════════════════════════
// CURRENCIES  (thin proxy — full controller lives in currency module)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/currencies', authorizeRoles('ADMIN'), catchAsync(async (req, res) => {
    const currencies = await Currency.find().sort({ code: 1 });
    sendSuccess(res, { currencies }, 'Currencies retrieved');
}));

router.patch('/currencies/:code', authorizeRoles('ADMIN'), validateBody(schemas.updateCurrency), catchAsync(async (req, res) => {
    const { name, symbol, marketRate, platformRate, markupPercentage, isActive, applyDebtAdjustment } = req.body;
    const code = req.params.code.toUpperCase();

    // Delegate to the canonical currency service (handles debt adjustment internally)
    const currencyService = require('../currency/currency.service');
    const { currency, debtAdjustment } = await currencyService.updateCurrencyRate(code, {
        name,
        symbol,
        marketRate,
        platformRate,
        markupPercentage,
        isActive,
        applyDebtAdjustment,
        adminId: req.user._id,
    });

    const message = debtAdjustment?.usersAdjusted
        ? `Currency '${currency.code}' updated. Debt adjustment applied to ${debtAdjustment.usersAdjusted} users.`
        : `Currency '${currency.code}' updated.`;

    sendSuccess(res, { currency, debtAdjustment }, message);
}));

router.post('/currencies', authorizeRoles('ADMIN'), validateBody(schemas.createCurrency), catchAsync(async (req, res) => {
    const currencyService = require('../currency/currency.service');
    const currency = await currencyService.createCurrency(req.body);
    res.status(201).json({ success: true, message: 'Currency created', data: { currency } });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// GROUPS  (thin proxy — full controller lives in groups module)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/groups', requirePermission('groups.manage'), catchAsync(async (req, res) => {
    const groups = await groupSvc.listGroupsWithSummary({ includeInactive: true });
    sendSuccess(res, groups, 'Groups retrieved');
}));

router.post('/groups', requirePermission('groups.manage'), validateBody(schemas.createGroup), catchAsync(async (req, res) => {
    const group = await groupSvc.createGroup(req.body);
    res.status(201).json({ success: true, message: 'Group created', data: { group } });
}));

router.patch('/groups/:id', requirePermission('groups.manage'), validateBody(schemas.updateGroup), catchAsync(async (req, res) => {
    const group = await groupSvc.updateGroup(req.params.id, req.body);
    sendSuccess(res, { group }, 'Group updated');
}));

router.delete('/groups/:id', requirePermission('groups.manage'), catchAsync(async (req, res) => {
    const group = await groupSvc.deleteGroup(req.params.id);
    sendSuccess(res, { group }, 'Group deleted');
}));

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/settings', authorizeRoles('ADMIN'), settingsCtrl.listSettings);
router.get('/settings/:key', authorizeRoles('ADMIN'), settingsCtrl.getSettingByKey);
router.patch('/settings/:key', authorizeRoles('ADMIN'), validateBody(schemas.updateSetting), settingsCtrl.updateSetting);

// ═══════════════════════════════════════════════════════════════════════════════
// DEPOSITS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/deposits', requirePermission('topups.review'), catchAsync(async (req, res) => {
    const page = parseInt(req.query.page ?? 1, 10);
    const limit = Math.min(parseInt(req.query.limit ?? 20, 10), 100);
    const { status, search } = req.query;
    const result = await depositSvc.listDeposits({ page, limit, status, search });
    res.status(200).json({
        success: true,
        message: 'Deposit requests retrieved',
        data: result.deposits,
        pagination: result.pagination,
        summary: result.summary,
    });
}));

router.get('/deposits/:id', requirePermission('topups.review'), catchAsync(async (req, res) => {
    const deposit = await depositSvc.getDepositById(req.params.id);
    sendSuccess(res, deposit);
}));

router.patch('/deposits/:id/approve', requirePermission('topups.review'), validateBody(schemas.approveDeposit), catchAsync(async (req, res) => {
    const deposit = await depositSvc.approveDeposit(
        req.params.id,
        req.user._id,
        {
            // Admin overrides (optional — fallback to original deposit values in service)
            amount: req.body.amount,
            currency: req.body.currency,
            adminNotes: req.body.adminNotes,
        },
        { actorId: req.user._id, actorRole: 'ADMIN', ipAddress: req.ip, userAgent: req.get('User-Agent') }
    );
    sendSuccess(res, deposit, 'Deposit approved and wallet credited.');
}));

router.patch('/deposits/:id/reject', requirePermission('topups.review'), validateBody(schemas.approveDeposit), catchAsync(async (req, res) => {
    const deposit = await depositSvc.rejectDeposit(
        req.params.id,
        req.user._id,
        req.body.adminNotes ?? null,
        { actorId: req.user._id, actorRole: 'ADMIN', ipAddress: req.ip, userAgent: req.get('User-Agent') }
    );
    sendSuccess(res, deposit, 'Deposit request rejected.');
}));

/**
 * PATCH /admin/deposits/:id/review
 * Unified review endpoint — approve or reject a deposit in one call.
 * Body: { status: 'APPROVED' | 'REJECTED', adminNotes?: string }
 */
router.patch('/deposits/:id/review', requirePermission('topups.review'), validateBody(schemas.reviewDeposit), catchAsync(async (req, res) => {
    const { id } = req.params;
    const { status, adminNotes } = req.body;
    const auditCtx = { actorId: req.user._id, actorRole: 'ADMIN', ipAddress: req.ip, userAgent: req.get('User-Agent') };

    let deposit;
    if (status === 'APPROVED') {
        deposit = await depositSvc.approveDeposit(id, req.user._id, auditCtx);
        sendSuccess(res, deposit, 'Deposit approved and wallet credited.');
    } else {
        deposit = await depositSvc.rejectDeposit(id, req.user._id, adminNotes || null, auditCtx);
        sendSuccess(res, deposit, 'Deposit request rejected.');
    }
}));

router.patch('/deposits/:id', requirePermission('topups.review'), validateBody(schemas.updateDeposit), catchAsync(async (req, res) => {
    const deposit = await depositSvc.updatePendingDeposit(req.params.id, req.body, req.user._id);
    sendSuccess(res, { deposit }, 'Deposit request updated');
}));

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT LOGS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/audit', authorizeRoles('ADMIN'), catchAsync(async (req, res) => {
    const { entityType, entityId, page, limit } = req.query;
    const result = await getEntityAuditLogs(entityId, entityType, {
        page: parseInt(page ?? 1, 10),
        limit: parseInt(limit ?? 50, 10),
    });
    sendPaginated(res, result.logs, result.pagination, 'Audit logs retrieved');
}));

router.get('/audit/actor/:actorId', authorizeRoles('ADMIN'), catchAsync(async (req, res) => {
    const { page, limit } = req.query;
    const result = await getActorAuditLogs(req.params.actorId, {
        page: parseInt(page ?? 1, 10),
        limit: parseInt(limit ?? 50, 10),
    });
    sendPaginated(res, result.logs, result.pagination, 'Actor audit logs retrieved');
}));

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════════

const categoryRoutes = require('../categories/category.routes');
router.use('/categories', authorizeRoles('ADMIN'), categoryRoutes);

module.exports = router;
