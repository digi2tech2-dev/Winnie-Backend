'use strict';

/**
 * admin.users.service.js
 *
 * Admin-level user management.
 * Operations: list, get, update, soft-delete, approve, reject.
 *
 * Does NOT use MongoDB transactions — all operations are single-document
 * writes that are inherently atomic.
 */

const crypto = require('crypto');
const { User, USER_STATUS, ROLES } = require('../users/user.model');
const Group = require('../groups/group.model');
const { Currency } = require('../currency/currency.model');
const { AuditLog } = require('../audit/audit.model');
const {
    WalletTransaction,
    TRANSACTION_TYPES,
    LEDGER_TRANSACTION_TYPES,
    TRANSACTION_DIRECTIONS,
    TRANSACTION_SOURCE_TYPES,
} = require('../wallet/walletTransaction.model');
const { NotFoundError, ConflictError, BusinessRuleError } = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { convertBalance, localToUsd } = require('../../shared/utils/currencyMath');
const { getConversionRate } = require('../../services/currencyConverter.service');
const {
    USER_ACTIONS,
    ADMIN_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
} = require('../audit/audit.constants');

const SUPERVISOR_PERMISSION_GROUPS = Object.freeze([
    {
        group: 'dashboard',
        titleAr: 'لوحة التحكم',
        titleEn: 'Dashboard',
        items: [
            { key: 'dashboard.view', labelAr: 'عرض لوحة التحكم', labelEn: 'View dashboard' },
        ],
    },
    {
        group: 'users',
        titleAr: 'المستخدمون',
        titleEn: 'Users',
        items: [
            { key: 'users.view', labelAr: 'عرض المستخدمين', labelEn: 'View users' },
            { key: 'users.status', labelAr: 'تغيير حالة المستخدمين', labelEn: 'Change user status' },
            { key: 'users.delete', labelAr: 'حذف المستخدمين', labelEn: 'Delete users' },
        ],
    },
    {
        group: 'orders',
        titleAr: 'الطلبات',
        titleEn: 'Orders',
        items: [
            { key: 'orders.view', labelAr: 'عرض الطلبات', labelEn: 'View orders' },
            { key: 'orders.update', labelAr: 'تحديث الطلبات', labelEn: 'Update orders' },
            { key: 'orders.refund', labelAr: 'استرداد الطلبات', labelEn: 'Refund orders' },
        ],
    },
    {
        group: 'catalog',
        titleAr: 'المنتجات والمجموعات',
        titleEn: 'Products and groups',
        items: [
            { key: 'products.view', labelAr: 'عرض المنتجات', labelEn: 'View products' },
            { key: 'products.manage', labelAr: 'إدارة المنتجات', labelEn: 'Manage products' },
            { key: 'products.provider.sync', labelAr: 'ربط ومزامنة الموردين', labelEn: 'Provider product sync' },
            { key: 'groups.manage', labelAr: 'إدارة المجموعات', labelEn: 'Manage groups' },
        ],
    },
    {
        group: 'finance',
        titleAr: 'المالية',
        titleEn: 'Finance',
        items: [
            { key: 'wallet.view', labelAr: 'عرض المحافظ', labelEn: 'View wallets' },
            { key: 'wallet.adjust', labelAr: 'تعديل الأرصدة', labelEn: 'Adjust wallet balances' },
            { key: 'payments.view', labelAr: 'عرض المدفوعات', labelEn: 'View payments' },
            { key: 'topups.review', labelAr: 'مراجعة طلبات الرصيد', labelEn: 'Review top-ups' },
            { key: 'financial_reports.read', labelAr: 'عرض التقارير المالية', labelEn: 'View financial reports' },
            { key: 'financial_reports.close', labelAr: 'تقفيل اليوم المالي', labelEn: 'Close financial days' },
            { key: 'referral_payouts.read', labelAr: 'عرض طلبات سحب الإحالات', labelEn: 'View referral payout requests' },
            { key: 'referral_payouts.manage', labelAr: 'إدارة طلبات سحب الإحالات', labelEn: 'Manage referral payout requests' },
            { key: 'whatsapp_notifications.read', labelAr: 'عرض إشعارات واتساب', labelEn: 'View WhatsApp notifications' },
            { key: 'whatsapp_notifications.manage', labelAr: 'إدارة إشعارات واتساب', labelEn: 'Manage WhatsApp notifications' },
            { key: 'whatsapp_notifications.send_test', labelAr: 'إرسال رسائل تجربة واتساب', labelEn: 'Send WhatsApp test messages' },
            { key: 'whatsapp_notifications.logs', labelAr: 'عرض سجلات واتساب', labelEn: 'View WhatsApp logs' },
        ],
    },
    {
        group: 'operations',
        titleAr: 'أخرى',
        titleEn: 'Operations',
        items: [
            { key: 'suppliers.manage', labelAr: 'إدارة الموردين', labelEn: 'Manage suppliers' },
            { key: 'groupRequests.view', labelAr: 'عرض طلبات الوكلاء', labelEn: 'View group requests' },
            { key: 'groupRequests.manage', labelAr: 'إدارة طلبات الوكلاء', labelEn: 'Manage group requests' },
            { key: 'referrals.view', labelAr: 'عرض الإحالات', labelEn: 'View referrals' },
        ],
    },
]);

const ALLOWED_SUPERVISOR_PERMISSIONS = Object.freeze(
    SUPERVISOR_PERMISSION_GROUPS.flatMap((group) => group.items.map((item) => item.key))
);

// ─── Private helper ────────────────────────────────────────────────────────────

const _findOrFail = async (id) => {
    const user = await User.findById(id).populate('groupId', 'name percentage');
    if (!user) throw new NotFoundError('User');
    return user;
};

const _normalizePermissions = (permissions) => {
    if (permissions === undefined) return undefined;
    if (!Array.isArray(permissions)) {
        throw new BusinessRuleError('permissions must be an array of strings.', 'INVALID_PERMISSIONS');
    }

    return [...new Set(
        permissions
            .map((permission) => String(permission || '').trim())
            .filter(Boolean)
    )];
};

const _validateSupervisorPermissions = (permissions) => {
    const normalized = _normalizePermissions(permissions) || [];
    const invalid = normalized.filter((permission) => !ALLOWED_SUPERVISOR_PERMISSIONS.includes(permission));

    if (invalid.length) {
        throw new BusinessRuleError(
            `Invalid supervisor permissions: ${invalid.join(', ')}`,
            'INVALID_SUPERVISOR_PERMISSION'
        );
    }

    return normalized;
};

const _toSupervisorDto = (user, logsCount = 0) => {
    const raw = typeof user.toSafeObject === 'function'
        ? user.toSafeObject()
        : (typeof user.toObject === 'function' ? user.toObject({ virtuals: true }) : { ...user });
    const permissions = Array.isArray(raw.permissions) ? raw.permissions : [];
    const id = String(raw._id || raw.id);
    const deletedAt = raw.deletedAt || null;
    const blockedAt = raw.blockedAt || null;
    const isActive = raw.status === USER_STATUS.ACTIVE && !deletedAt && !blockedAt;

    return {
        ...raw,
        id,
        _id: raw._id || id,
        name: raw.name || raw.username || raw.email,
        email: raw.email || '',
        status: deletedAt ? 'deleted' : blockedAt ? 'blocked' : (isActive ? 'active' : String(raw.status || '').toLowerCase()),
        isActive,
        isBlocked: Boolean(blockedAt),
        deletedAt,
        permissions,
        permissionsCount: permissions.length,
        lastSeenAt: raw.lastSeenAt || raw.lastLoginAt || raw.updatedAt || raw.createdAt || null,
        logsCount,
        avatarInitial: String(raw.name || raw.email || 'S').trim().slice(0, 1).toUpperCase(),
        createdAt: raw.createdAt || null,
        updatedAt: raw.updatedAt || null,
    };
};

const _toEligibleSupervisorUserDto = (user) => {
    const raw = typeof user.toSafeObject === 'function'
        ? user.toSafeObject()
        : (typeof user.toObject === 'function' ? user.toObject({ virtuals: true }) : { ...user });
    const id = String(raw._id || raw.id);

    return {
        id,
        _id: raw._id || id,
        name: raw.name || raw.username || raw.email,
        email: raw.email || '',
        role: raw.role,
        status: raw.status,
        isBlocked: Boolean(raw.blockedAt),
        deletedAt: raw.deletedAt || null,
        avatarInitial: String(raw.name || raw.email || 'U').trim().slice(0, 1).toUpperCase(),
        currency: raw.currency || 'USD',
        walletBalance: raw.walletBalance ?? 0,
    };
};

const _toAuditLogDto = (log) => {
    const raw = typeof log.toObject === 'function' ? log.toObject() : { ...log };
    const id = String(raw._id || raw.id);

    return {
        id,
        _id: raw._id || id,
        action: raw.action,
        description: raw.metadata?.description || raw.metadata?.note || raw.action,
        createdAt: raw.createdAt,
        metadata: raw.metadata || {},
        actorId: raw.actorId,
        actorRole: raw.actorRole,
        entityType: raw.entityType,
        entityId: raw.entityId,
        ipAddress: raw.ipAddress || null,
        userAgent: raw.userAgent || null,
    };
};

const _sanitizeUserSnapshot = (snapshot) => {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    const sanitized = { ...snapshot };
    delete sanitized.password;
    delete sanitized.emailVerificationToken;
    delete sanitized.emailVerificationExpires;
    delete sanitized.apiToken;
    return sanitized;
};

const _resolveAssignableGroup = async (groupId) => {
    if (groupId === null) return null;

    const group = await Group.findOne({ _id: groupId, deletedAt: null });
    if (!group) throw new NotFoundError('Group');
    if (!group.isActive) {
        throw new BusinessRuleError(
            `Group '${group.name}' is currently inactive and cannot be assigned to users.`,
            'GROUP_INACTIVE'
        );
    }

    return group;
};

// ─── List ──────────────────────────────────────────────────────────────────────

/**
 * Admin list of all users with filtering and pagination.
 *
 * @param {Object} opts
 * @param {string}  [opts.status]    - 'PENDING' | 'ACTIVE' | 'REJECTED'
 * @param {boolean} [opts.verified]  - filter by email verification flag
 * @param {string}  [opts.email]     - partial email search (case-insensitive)
 * @param {string}  [opts.role]      - 'ADMIN' | 'SUPERVISOR' | 'CUSTOMER'
 * @param {Date}    [opts.from]      - createdAt >= from
 * @param {Date}    [opts.to]        - createdAt <= to
 * @param {number}  [opts.page]
 * @param {number}  [opts.limit]
 * @param {string}  [opts.sortBy]    - field name
 * @param {string}  [opts.sortOrder] - 'asc' | 'desc'
 */
const listUsers = async ({
    status,
    verified,
    email,
    role,
    includeDeleted = false,
    includeBlocked = true,
    from,
    to,
    page = 1,
    limit = 20,
    sortBy = 'walletBalance',
    sortOrder = 'desc',
} = {}) => {
    const normalizedPage = Number.isFinite(Number(page)) && Number(page) > 0
        ? Math.floor(Number(page))
        : 1;
    const requestedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
        ? Math.floor(Number(limit))
        : 20;
    const normalizedLimit = Math.min(requestedLimit, 20); // strict max for admin users page
    const skip = (normalizedPage - 1) * normalizedLimit;
    const normalizedSortBy = typeof sortBy === 'string' && sortBy.trim() ? sortBy.trim() : 'walletBalance';
    const normalizedSortOrder = String(sortOrder || '').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';

    const normalizedDisplayStatus = String(status || '').trim().toLowerCase();
    const lifecycleStatus = String(status || '').trim().toUpperCase();
    const filter = { verified: true };

    if (normalizedDisplayStatus === 'deleted') {
        filter.deletedAt = { $ne: null };
    } else if (normalizedDisplayStatus === 'blocked') {
        filter.blockedAt = { $ne: null };
        if (!includeDeleted) filter.deletedAt = null;
    } else if (normalizedDisplayStatus === 'active') {
        filter.deletedAt = null;
        filter.blockedAt = null;
        filter.status = USER_STATUS.ACTIVE;
    } else if (normalizedDisplayStatus === 'all') {
        // Intentionally include active, blocked, and soft-deleted users.
    } else {
        if (!includeDeleted) filter.deletedAt = null;
        if (!includeBlocked) filter.blockedAt = null;
        if (status) filter.status = lifecycleStatus;
    }

    if (verified != null) filter.verified = verified;
    if (role) filter.role = role;
    if (email) {
        filter.$or = [
            { email: { $regex: email, $options: 'i' } },
            { name: { $regex: email, $options: 'i' } },
        ];
    }
    if (from || to) {
        filter.createdAt = {};
        if (from) filter.createdAt.$gte = new Date(from);
        if (to) filter.createdAt.$lte = new Date(to);
    }

    const sort = normalizedSortBy === 'walletBalance'
        ? { walletBalance: normalizedSortOrder === 'asc' ? 1 : -1 }
        : { [normalizedSortBy]: normalizedSortOrder === 'asc' ? 1 : -1 };

    const [users, total] = await Promise.all([
        User.find(filter)
            .select('-password -emailVerificationToken -emailVerificationExpires')
            .populate('groupId', 'name percentage')
            .sort(sort)
            .skip(skip)
            .limit(normalizedLimit),
        User.countDocuments(filter),
    ]);

    return {
        users,
        pagination: {
            page: normalizedPage,
            limit: normalizedLimit,
            total,
            pages: Math.ceil(total / normalizedLimit),
        },
    };
};

const listSupervisors = async ({
    status,
    verified,
    email,
    search,
    includeDeleted = false,
    includeBlocked = true,
    from,
    to,
    page = 1,
    limit = 20,
    sortBy = 'createdAt',
    sortOrder = 'desc',
} = {}) => {
    const result = await listUsers({
        status,
        verified,
        email: email || search,
        role: ROLES.SUPERVISOR,
        includeDeleted: includeDeleted || String(status || '').toLowerCase() === 'all',
        includeBlocked,
        from,
        to,
        page,
        limit,
        sortBy,
        sortOrder,
    });

    const supervisorIds = result.users.map((user) => user._id);
    const logCounts = supervisorIds.length
        ? await AuditLog.aggregate([
            { $match: { actorId: { $in: supervisorIds }, actorRole: ACTOR_ROLES.SUPERVISOR } },
            { $group: { _id: '$actorId', count: { $sum: 1 } } },
        ])
        : [];
    const countByActor = new Map(logCounts.map((item) => [String(item._id), item.count]));

    const [total, active, blocked, deleted] = await Promise.all([
        User.countDocuments({ role: ROLES.SUPERVISOR }),
        User.countDocuments({ role: ROLES.SUPERVISOR, status: USER_STATUS.ACTIVE, blockedAt: null, deletedAt: null }),
        User.countDocuments({ role: ROLES.SUPERVISOR, blockedAt: { $ne: null }, deletedAt: null }),
        User.countDocuments({ role: ROLES.SUPERVISOR, deletedAt: { $ne: null } }),
    ]);

    return {
        items: result.users.map((user) => _toSupervisorDto(user, countByActor.get(String(user._id)) || 0)),
        pagination: result.pagination,
        summary: { total, active, blocked, deleted },
    };
};

const listEligibleSupervisorUsers = async ({
    search,
    page = 1,
    limit = 10,
    currentAdminId,
} = {}) => {
    const paging = _paginate({ page, limit });
    const filter = {
        role: ROLES.CUSTOMER,
        status: USER_STATUS.ACTIVE,
        deletedAt: null,
        blockedAt: null,
    };

    if (currentAdminId) {
        filter._id = { $ne: currentAdminId };
    }

    const normalizedSearch = String(search || '').trim();
    if (normalizedSearch) {
        filter.$or = [
            { name: { $regex: normalizedSearch, $options: 'i' } },
            { email: { $regex: normalizedSearch, $options: 'i' } },
        ];
    }

    const [users, total] = await Promise.all([
        User.find(filter)
            .select('-password -emailVerificationToken -emailVerificationExpires')
            .sort({ createdAt: -1 })
            .skip(paging.skip)
            .limit(paging.limit),
        User.countDocuments(filter),
    ]);

    return {
        items: users.map(_toEligibleSupervisorUserDto),
        pagination: {
            page: paging.page,
            limit: paging.limit,
            total,
            pages: Math.ceil(total / paging.limit),
        },
    };
};

// ─── Get One ───────────────────────────────────────────────────────────────────

const getUserById = async (id) => {
    const user = await User.findById(id)
        .select('-password -emailVerificationToken -emailVerificationExpires')
        .populate('groupId', 'name percentage isActive');
    if (!user) throw new NotFoundError('User');
    return user;
};

const createSupervisor = async ({ userId, permissions = [] } = {}, adminId) => {
    const normalizedPermissions = _validateSupervisorPermissions(permissions);
    const user = await _findOrFail(userId);

    if (String(user._id) === String(adminId)) {
        throw new BusinessRuleError('You cannot assign yourself as a supervisor.', 'CANNOT_ASSIGN_SELF');
    }
    if (user.role === ROLES.SUPERVISOR) {
        throw new BusinessRuleError('User is already a supervisor.', 'ALREADY_SUPERVISOR');
    }
    if (user.role === ROLES.ADMIN) {
        throw new BusinessRuleError('Admin accounts cannot be assigned as supervisors.', 'INVALID_SUPERVISOR_TARGET');
    }
    if (user.deletedAt) {
        throw new BusinessRuleError('Deleted users cannot be assigned as supervisors.', 'DELETED_USER_SUPERVISOR_ASSIGN');
    }
    if (user.blockedAt) {
        throw new BusinessRuleError('Blocked users cannot be assigned as supervisors.', 'BLOCKED_USER_SUPERVISOR_ASSIGN');
    }
    if (user.status !== USER_STATUS.ACTIVE) {
        throw new BusinessRuleError('Only active users can be assigned as supervisors.', 'INACTIVE_USER_SUPERVISOR_ASSIGN');
    }

    const previousRole = user.role;
    const previousPermissions = [...(user.permissions || [])];
    user.role = ROLES.SUPERVISOR;
    user.permissions = normalizedPermissions;
    await user.save();

    await createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.SUPERVISOR_ASSIGNED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: {
            email: user.email,
            previousRole,
            newRole: user.role,
            previousPermissions,
            newPermissions: user.permissions,
        },
    });

    return _toSupervisorDto(user, 0);
};

const listSupervisorPermissions = async () => {
    const groups = SUPERVISOR_PERMISSION_GROUPS.map((group) => ({
        ...group,
        items: group.items.map((item) => ({ ...item, group: group.group })),
    }));

    return {
        items: groups.flatMap((group) => group.items),
        groups,
    };
};

// ─── Update ────────────────────────────────────────────────────────────────────

/**
 * Admin update of a user (name, email, groupId, status, verified).
 */
const updateUser = async (id, data, adminId) => {
    const user = await _findOrFail(id);
    const before = _sanitizeUserSnapshot(user.toObject());

    const { name, email, groupId, status, verified, permissions, isApiEnabled } = data;

    if (name !== undefined) user.name = name.trim();
    if (status !== undefined) {
        user.status = status;
        // Admin approval (ACTIVE) overrides the need for email verification.
        // Without this, approved users get locked out with "Please verify your email".
        if (status === 'ACTIVE') {
            user.verified = true;
            user.emailVerificationToken = null;
            user.emailVerificationExpires = null;
        }
    }
    if (verified !== undefined) user.verified = verified;
    if (groupId !== undefined) {
        const group = await _resolveAssignableGroup(groupId);
        user.groupId = group?._id || null;
    }
    if (permissions !== undefined) {
        if (user.role !== ROLES.SUPERVISOR) {
            throw new BusinessRuleError('Only supervisors can be assigned permissions.', 'INVALID_PERMISSION_TARGET');
        }
        user.permissions = _normalizePermissions(permissions);
    }
    if (isApiEnabled !== undefined) {
        user.isApiEnabled = isApiEnabled;
        if (isApiEnabled === true) {
            const hasApiToken = await User.exists({ _id: id, apiToken: { $nin: [null, ''] } });
            if (!hasApiToken) {
                user.apiToken = crypto.randomBytes(32).toString('hex');
            }
        }
    }

    if (email !== undefined && email !== user.email) {
        const exists = await User.findOne({ email: email.toLowerCase(), _id: { $ne: id } });
        if (exists) throw new ConflictError('An account with this email already exists.');
        user.email = email.toLowerCase();
    }

    await user.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.USER_UPDATED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { before, after: _sanitizeUserSnapshot(user.toObject()) },
    });

    return user;
};

// ─── Soft Delete ───────────────────────────────────────────────────────────────

const deleteUser = async (id, adminId) => {
    const user = await _findOrFail(id);

    if (user.deletedAt) throw new BusinessRuleError('User is already deleted.', 'ALREADY_DELETED');
    if (user.role === ROLES.ADMIN) throw new BusinessRuleError('Admin accounts cannot be deleted.', 'CANNOT_DELETE_ADMIN');

    user.deletedAt = new Date();
    user.status = USER_STATUS.REJECTED;   // prevents login
    await user.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.USER_DELETED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { email: user.email, deletedAt: user.deletedAt },
    });

    return user;
};

// ─── List Deleted ──────────────────────────────────────────────────────────────

/**
 * Admin list of soft-deleted users.
 */
const listDeletedUsers = async ({
    page = 1,
    limit = 100,
} = {}) => {
    limit = Math.min(limit, 200);
    const skip = (page - 1) * limit;

    const filter = { deletedAt: { $ne: null } };
    const sort = { deletedAt: -1 };

    const [users, total] = await Promise.all([
        User.find(filter)
            .select('-password -emailVerificationToken -emailVerificationExpires')
            .populate('groupId', 'name percentage')
            .sort(sort)
            .skip(skip)
            .limit(limit),
        User.countDocuments(filter),
    ]);

    return {
        users,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

// ─── Restore (un-delete) ───────────────────────────────────────────────────────

/**
 * Restore a soft-deleted user. Clears deletedAt and resets status to PENDING
 * so the admin can re-approve when ready.
 */
const restoreUser = async (id, adminId) => {
    const user = await _findOrFail(id);

    if (!user.deletedAt) {
        throw new BusinessRuleError('User is not deleted.', 'NOT_DELETED');
    }

    user.deletedAt = null;
    user.status = USER_STATUS.ACTIVE;
    await user.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.USER_RESTORED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: {
            action: 'restore',
            email: user.email,
            restoredAt: new Date(),
            remainsBlocked: Boolean(user.blockedAt),
        },
    });

    return user;
};

// ─── Approve / Reject ──────────────────────────────────────────────────────────
// These already exist in user.service.js. We proxy them here so all
// admin user operations come through a single module.

const { approveUser, rejectUser } = require('../users/user.service');

// ─── Update Role ──────────────────────────────────────────────────────────────

/**
 * Admin update of a user's role.
 * Guards: cannot demote yourself, cannot change a deleted user's role.
 */
const updateUserRole = async (id, role, adminId, permissions) => {
    const user = await _findOrFail(id);
    if (user._id.toString() === adminId.toString()) {
        throw new BusinessRuleError('You cannot change your own role.', 'SELF_ROLE_CHANGE');
    }
    if (user.deletedAt) {
        throw new BusinessRuleError('Cannot change the role of a deleted user.', 'DELETED_USER_ROLE_CHANGE');
    }
    if (!Object.values(ROLES).includes(role)) {
        throw new BusinessRuleError(
            `Invalid role: '${role}'. Must be ADMIN, SUPERVISOR, or CUSTOMER.`,
            'INVALID_ROLE'
        );
    }

    const normalizedPermissions = _normalizePermissions(permissions);
    if (role !== ROLES.SUPERVISOR && normalizedPermissions?.length) {
        throw new BusinessRuleError('Only supervisors can be assigned permissions.', 'INVALID_PERMISSION_TARGET');
    }

    const previousRole = user.role;
    const previousPermissions = [...(user.permissions || [])];
    user.role = role;
    if (role === ROLES.SUPERVISOR) {
        user.permissions = normalizedPermissions !== undefined
            ? normalizedPermissions
            : (previousRole === ROLES.SUPERVISOR ? previousPermissions : []);
    } else {
        user.permissions = [];
    }
    await user.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.USER_ROLE_CHANGED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: {
            previousRole,
            newRole: role,
            previousPermissions,
            newPermissions: user.permissions,
        },
    });

    return user;
};

const updateSupervisorPermissions = async (id, permissions, adminId) => {
    const user = await _findOrFail(id);
    if (user.deletedAt) {
        throw new BusinessRuleError('Cannot update permissions for a deleted user.', 'DELETED_USER_PERMISSION_CHANGE');
    }
    if (user.role !== ROLES.SUPERVISOR) {
        throw new BusinessRuleError('Only supervisors can be assigned permissions.', 'INVALID_PERMISSION_TARGET');
    }

    const previousPermissions = [...(user.permissions || [])];
    user.permissions = _validateSupervisorPermissions(permissions);
    await user.save();

    await createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.SUPERVISOR_PERMISSIONS_UPDATED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: {
            field: 'permissions',
            previousPermissions,
            newPermissions: user.permissions,
        },
    });

    return user;
};

// ─── Update Currency ──────────────────────────────────────────────────────────

/**
 * Admin currency changes convert the existing wallet balance using the current
 * platform rates and write a neutral ledger event for auditability.
 */
const updateUserCurrency = async (id, currency, adminId, reason = null) => {
    const user = await _findOrFail(id);
    const code = String(currency || '').trim().toUpperCase();
    const previousCurrency = String(user.currency || 'USD').toUpperCase();
    const previousBalance = Number(user.walletBalance || 0);
    const normalizedReason = reason === undefined || reason === null || String(reason).trim() === ''
        ? null
        : String(reason).trim();

    if (user.deletedAt) {
        throw new BusinessRuleError('Cannot change currency for a deleted user.', 'DELETED_USER_CURRENCY_CHANGE');
    }

    const activeCurrency = code === 'USD' ? true : await Currency.exists({ code, isActive: true });
    if (!activeCurrency) {
        throw new BusinessRuleError(`Currency '${code}' is not active or does not exist.`, 'INVALID_CURRENCY');
    }

    if (previousCurrency === code) {
        return {
            user,
            wallet: {
                previousCurrency,
                currency: code,
                previousBalance,
                balance: previousBalance,
            },
            conversion: {
                fromCurrency: previousCurrency,
                toCurrency: code,
                fromAmount: previousBalance,
                toAmount: previousBalance,
                noOp: true,
            },
        };
    }

    const previousRate = await getConversionRate(previousCurrency);
    const newRate = await getConversionRate(code);
    const newBalance = previousBalance === 0
        ? 0
        : convertBalance(previousBalance, previousRate, newRate);
    const amountInUsd = previousBalance === 0 ? 0 : localToUsd(previousBalance, previousRate);
    const conversionRate = previousRate ? Number((newRate / previousRate).toFixed(10)) : null;
    const now = new Date();

    user.currency = code;
    user.walletBalance = newBalance;
    await user.save();

    let transaction = null;
    if (previousBalance !== 0) {
        transaction = await WalletTransaction.create({
            userId: user._id,
            type: TRANSACTION_TYPES.DEBT_ADJUSTMENT,
            semanticType: LEDGER_TRANSACTION_TYPES.ADMIN_CURRENCY_CONVERSION,
            sourceType: TRANSACTION_SOURCE_TYPES.ADMIN_CURRENCY_CONVERSION,
            direction: TRANSACTION_DIRECTIONS.NEUTRAL,
            amount: Math.abs(previousBalance),
            balanceBefore: previousBalance,
            balanceAfter: newBalance,
            reference: null,
            currency: code,
            status: 'COMPLETED',
            description: `Admin currency conversion ${previousCurrency} to ${code}`,
            reason: normalizedReason || undefined,
            note: normalizedReason || undefined,
            metadata: {
                operation: 'ADMIN_CURRENCY_CONVERSION',
                previousCurrency,
                newCurrency: code,
                previousBalance,
                newBalance,
                previousRate,
                newRate,
                amountInUsd,
                conversionRate,
                adminId,
                userId: user._id,
                reason: normalizedReason || undefined,
                convertedAt: now,
            },
            actorId: adminId,
            actorRole: ACTOR_ROLES.ADMIN,
        });
    }

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.USER_CURRENCY_CONVERTED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: {
            field: 'currency',
            previousCurrency,
            newCurrency: code,
            previousBalance,
            newBalance,
            previousRate,
            newRate,
            amountInUsd,
            conversionRate,
            transactionId: transaction?._id,
            reason: normalizedReason || undefined,
            convertedAt: now,
        },
    });

    await user.populate('groupId', 'name percentage isActive');

    return {
        user,
        wallet: {
            previousCurrency,
            currency: code,
            previousBalance,
            balance: newBalance,
        },
        conversion: {
            fromCurrency: previousCurrency,
            toCurrency: code,
            fromAmount: previousBalance,
            toAmount: newBalance,
            rateSnapshot: {
                [previousCurrency]: previousRate,
                [code]: newRate,
            },
            previousRate,
            newRate,
            amountInUsd,
            conversionRate,
            transactionId: transaction?._id || null,
        },
    };
};

// ─── Reset Password ───────────────────────────────────────────────────────────

/**
 * Admin reset of a user's password.
 * Assigns the plain-text password — the pre-save hook auto-hashes via bcrypt.
 */
const resetUserPassword = async (id, newPassword, adminId) => {
    // Need to select password field explicitly since it has select: false
    const user = await User.findById(id).select('+password');
    if (!user) throw new NotFoundError('User');
    if (user.deletedAt) {
        throw new BusinessRuleError('Cannot reset password for a deleted user.', 'DELETED_USER_PASSWORD_RESET');
    }
    if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,128}$/.test(String(newPassword || ''))) {
        throw new BusinessRuleError(
            'Password must be 8-128 characters and contain at least one uppercase letter, one lowercase letter, and one number.',
            'INVALID_PASSWORD'
        );
    }

    user.password = newPassword; // pre-save hook will bcrypt hash this
    user.twoFactorOtp = null;
    user.twoFactorOtpExpires = null;
    user.twoFactorTempToken = null;
    user.twoFactorTempTokenExpires = null;
    await user.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.USER_PASSWORD_RESET,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { note: 'Password reset by admin' }, // never log the actual password
    });

    // Re-fetch without password field for clean response
    return _findOrFail(id);
};

const blockUser = async (id, adminId, reason = null) => {
    const user = await _findOrFail(id);
    const normalizedReason = reason === undefined || reason === null || String(reason).trim() === ''
        ? null
        : String(reason).trim();

    if (String(user._id) === String(adminId)) {
        throw new BusinessRuleError('You cannot block your own account.', 'CANNOT_BLOCK_SELF');
    }
    if (user.deletedAt) {
        throw new BusinessRuleError('Cannot block a deleted user. Restore the user first.', 'DELETED_USER_BLOCK');
    }
    if (user.blockedAt) {
        throw new BusinessRuleError('User is already blocked.', 'ALREADY_BLOCKED');
    }

    user.blockedAt = new Date();
    user.blockedBy = adminId;
    user.blockReason = normalizedReason;
    await user.save();
    await user.populate('groupId', 'name percentage isActive');

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.USER_BLOCKED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: {
            reason: normalizedReason || undefined,
            blockedAt: user.blockedAt,
            targetUserId: user._id,
        },
    });

    const logsCount = await AuditLog.countDocuments({ actorId: user._id, actorRole: ACTOR_ROLES.SUPERVISOR });
    return _toSupervisorDto(user, logsCount);
};

const _paginate = ({ page = 1, limit = 20 } = {}) => {
    const normalizedPage = Number.isFinite(Number(page)) && Number(page) > 0
        ? Math.floor(Number(page))
        : 1;
    const requestedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
        ? Math.floor(Number(limit))
        : 20;
    const normalizedLimit = Math.min(requestedLimit, 100);

    return {
        limit: normalizedLimit,
        page: normalizedPage,
        skip: (normalizedPage - 1) * normalizedLimit,
    };
};

const getSupervisorLogs = async (id, { page = 1, limit = 20 } = {}) => {
    const user = await _findOrFail(id);
    if (user.role !== ROLES.SUPERVISOR) {
        throw new BusinessRuleError('Only supervisors have supervisor operation logs.', 'INVALID_SUPERVISOR_TARGET');
    }

    const paging = _paginate({ page, limit });
    const filter = { actorId: user._id, actorRole: ACTOR_ROLES.SUPERVISOR };

    const [logs, total] = await Promise.all([
        AuditLog.find(filter).sort({ createdAt: -1 }).skip(paging.skip).limit(paging.limit),
        AuditLog.countDocuments(filter),
    ]);

    return {
        items: logs.map(_toAuditLogDto),
        pagination: {
            page: paging.page,
            limit: paging.limit,
            total,
            pages: Math.ceil(total / paging.limit),
        },
    };
};

const getAllSupervisorLogs = async ({ page = 1, limit = 20 } = {}) => {
    const paging = _paginate({ page, limit });
    const filter = { actorRole: ACTOR_ROLES.SUPERVISOR };

    const [logs, total] = await Promise.all([
        AuditLog.find(filter).sort({ createdAt: -1 }).skip(paging.skip).limit(paging.limit),
        AuditLog.countDocuments(filter),
    ]);

    return {
        items: logs.map(_toAuditLogDto),
        pagination: {
            page: paging.page,
            limit: paging.limit,
            total,
            pages: Math.ceil(total / paging.limit),
        },
    };
};

const restoreSupervisor = async (id, adminId) => {
    const user = await _findOrFail(id);

    if (user.role !== ROLES.SUPERVISOR) {
        throw new BusinessRuleError('Only supervisors can be restored from this endpoint.', 'INVALID_SUPERVISOR_TARGET');
    }
    if (!user.deletedAt) {
        throw new BusinessRuleError('Supervisor is not deleted.', 'NOT_DELETED');
    }

    user.deletedAt = null;
    user.status = USER_STATUS.ACTIVE;
    await user.save();

    await createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.SUPERVISOR_RESTORED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: {
            email: user.email,
            restoredAt: new Date(),
        },
    });

    return _toSupervisorDto(user, 0);
};

const deleteSupervisor = async (id, adminId) => {
    const user = await _findOrFail(id);

    if (String(user._id) === String(adminId)) {
        throw new BusinessRuleError('You cannot remove supervisor access from your own account.', 'CANNOT_REMOVE_SELF_SUPERVISOR');
    }
    if (user.role !== ROLES.SUPERVISOR) {
        throw new BusinessRuleError('Only supervisors can be removed from this endpoint.', 'INVALID_SUPERVISOR_TARGET');
    }

    const previousRole = user.role;
    const previousPermissions = [...(user.permissions || [])];
    user.role = ROLES.CUSTOMER;
    user.permissions = [];
    await user.save();

    await createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.SUPERVISOR_REMOVED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: {
            email: user.email,
            previousRole,
            newRole: user.role,
            previousPermissions,
            newPermissions: user.permissions,
        },
    });

    return _toSupervisorDto(user, 0);
};

const unblockUser = async (id, adminId, reason = null) => {
    const user = await _findOrFail(id);
    const normalizedReason = reason === undefined || reason === null || String(reason).trim() === ''
        ? null
        : String(reason).trim();

    if (!user.blockedAt) {
        throw new BusinessRuleError('User is not blocked.', 'NOT_BLOCKED');
    }

    const previousBlockedAt = user.blockedAt;
    const previousBlockReason = user.blockReason;
    user.blockedAt = null;
    user.blockedBy = null;
    user.blockReason = null;
    await user.save();
    await user.populate('groupId', 'name percentage isActive');

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.USER_UNBLOCKED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: {
            reason: normalizedReason || undefined,
            previousBlockedAt,
            previousBlockReason,
            targetUserId: user._id,
        },
    });

    return user;
};

// ─── Update Avatar ────────────────────────────────────────────────────────────

/**
 * Admin update of a user's avatar URL.
 */
const updateUserAvatar = async (id, avatarUrl, adminId) => {
    const user = await _findOrFail(id);

    const previousAvatar = user.avatar;
    user.avatar = avatarUrl || null;
    await user.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.USER_AVATAR_UPDATED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { previousAvatar, newAvatar: avatarUrl || null },
    });

    return user;
};

// ─── Update Credit Limit ──────────────────────────────────────────────────────

/**
 * Admin update of a user's credit limit (overdraft allowance).
 */
const updateUserCreditLimit = async (id, creditLimit, adminId, reason = null) => {
    const user = await _findOrFail(id);
    const parsedCreditLimit = Number(creditLimit);

    if (!Number.isFinite(parsedCreditLimit) || parsedCreditLimit < 0) {
        throw new BusinessRuleError('Credit limit cannot be negative.', 'INVALID_CREDIT_LIMIT');
    }

    const previousCreditLimit = user.creditLimit || 0;
    user.creditLimit = parsedCreditLimit;
    await user.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.USER_UPDATED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: { field: 'creditLimit', previousCreditLimit, newCreditLimit: user.creditLimit, reason },
    });

    return user;
};

const updateUserGroup = async (id, { groupId, reason } = {}, adminId) => {
    const user = await _findOrFail(id);
    const group = await _resolveAssignableGroup(groupId);

    const previousGroupId = user.groupId?._id || user.groupId || null;
    const previousGroupName = user.groupId?.name || null;
    const previousRole = user.role;

    user.groupId = group._id;
    await user.save();
    await user.populate('groupId', 'name percentage isActive');

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: USER_ACTIONS.GROUP_CHANGED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: {
            previousGroupId,
            previousGroupName,
            newGroupId: group._id,
            newGroupName: group.name,
            reason,
            roleUnchanged: user.role === previousRole,
        },
    });

    return user;
};

const updateIdentityVerificationHold = async (id, { required, reason } = {}, adminId) => {
    if (typeof required !== 'boolean') {
        throw new BusinessRuleError('required must be a boolean.', 'INVALID_IDENTITY_VERIFICATION_REQUIRED');
    }

    const user = await _findOrFail(id);
    if (user.deletedAt) {
        throw new BusinessRuleError('Cannot update identity verification for a deleted user.', 'DELETED_USER_IDENTITY_VERIFICATION_CHANGE');
    }

    const now = new Date();
    const normalizedReason = reason === undefined || reason === null || String(reason).trim() === ''
        ? null
        : String(reason).trim();

    user.identityVerificationRequired = required;
    user.identityVerificationReason = normalizedReason;

    if (required === true) {
        user.identityVerificationRequestedAt = now;
        user.identityVerificationRequestedBy = adminId;
        user.identityVerificationClearedAt = null;
        user.identityVerificationClearedBy = null;
    } else {
        user.identityVerificationClearedAt = now;
        user.identityVerificationClearedBy = adminId;
    }

    await user.save();
    await user.populate('groupId', 'name percentage isActive');

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: required === true
            ? USER_ACTIONS.IDENTITY_VERIFICATION_REQUIRED
            : USER_ACTIONS.IDENTITY_VERIFICATION_CLEARED,
        entityType: ENTITY_TYPES.USER,
        entityId: user._id,
        metadata: {
            required: user.identityVerificationRequired,
            reason: normalizedReason || undefined,
        },
    });

    return user;
};

module.exports = {
    listUsers,
    listSupervisors,
    listEligibleSupervisorUsers,
    listSupervisorPermissions,
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
