'use strict';

const crypto = require('crypto');
const { User, ROLES, USER_STATUS } = require('./user.model');
const Group = require('../groups/group.model');
const { NotFoundError, ConflictError, BusinessRuleError, AuthenticationError } = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { USER_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');

/** Shared populate projection for group fields shown in user responses. */
const GROUP_PROJECTION = 'name percentage isActive';
const PASSWORD_STRENGTH_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/;

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: QUERIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Admin: List all users with optional filters.
 * Supports filtering by role, status, groupId.
 */
const listUsers = async ({ page = 1, limit = 20, role, status, groupId } = {}) => {
    const filter = {};
    if (role) filter.role = role;
    if (status) filter.status = status;
    if (groupId) filter.groupId = groupId;

    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
        User.find(filter)
            .select('-password')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('groupId', GROUP_PROJECTION),
        User.countDocuments(filter),
    ]);

    return {
        users,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

/**
 * Admin: Get a user by ID.
 */
const getUserById = async (id) => {
    const user = await User.findById(id)
        .select('-password')
        .populate('groupId', GROUP_PROJECTION);
    if (!user) throw new NotFoundError('User');
    return user;
};

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: ACTIVATION LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Admin: Approve a user account.
 *
 * @param {string|ObjectId} targetUserId
 * @param {string|ObjectId} adminId
 * @param {Object|null}     [auditContext] - from req.auditContext (optional)
 */
const approveUser = async (targetUserId, adminId, auditContext = null) => {
    const user = await User.findById(targetUserId).select('-password');
    if (!user) throw new NotFoundError('User');

    if (user.status === USER_STATUS.ACTIVE) {
        throw new BusinessRuleError(
            'This account is already active.',
            'ALREADY_ACTIVE'
        );
    }

    const previousStatus = user.status;

    // Use findByIdAndUpdate to guarantee all fields are written to the DB,
    // including select:false fields (emailVerificationToken, emailVerificationExpires)
    // that are NOT loaded on the Mongoose document and would be silently skipped by .save().
    const updatedUser = await User.findByIdAndUpdate(
        targetUserId,
        {
            $set: {
                status: USER_STATUS.ACTIVE,
                verified: true,
                approvedBy: adminId,
                approvedAt: new Date(),
            },
            $unset: {
                emailVerificationToken: '',
                emailVerificationExpires: '',
                rejectedBy: '',
                rejectedAt: '',
            },
        },
        { new: true }
    ).select('-password');

    // ── Audit: fire-and-forget, after successful save ──────────────────────────
    createAuditLog({
        actorId: auditContext?.actorId ?? adminId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.ADMIN,
        action: USER_ACTIONS.APPROVED,
        entityType: ENTITY_TYPES.USER,
        entityId: targetUserId,
        metadata: { previousStatus, approvedBy: adminId },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    return updatedUser.toSafeObject ? updatedUser.toSafeObject() : updatedUser.toObject();
};

/**
 * Admin: Reject a user account.
 *
 * @param {string|ObjectId} targetUserId
 * @param {string|ObjectId} adminId
 * @param {Object|null}     [auditContext] - from req.auditContext (optional)
 */
const rejectUser = async (targetUserId, adminId, auditContext = null) => {
    const user = await User.findById(targetUserId).select('-password');
    if (!user) throw new NotFoundError('User');

    if (user.status === USER_STATUS.REJECTED) {
        throw new BusinessRuleError(
            'This account is already rejected.',
            'ALREADY_REJECTED'
        );
    }

    const previousStatus = user.status;

    user.status = USER_STATUS.REJECTED;
    user.rejectedBy = adminId;
    user.rejectedAt = new Date();
    user.approvedBy = null;
    user.approvedAt = null;

    await user.save();

    // ── Audit: fire-and-forget, after successful save ──────────────────────────
    createAuditLog({
        actorId: auditContext?.actorId ?? adminId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.ADMIN,
        action: USER_ACTIONS.REJECTED,
        entityType: ENTITY_TYPES.USER,
        entityId: targetUserId,
        metadata: { previousStatus, rejectedBy: adminId },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    return user.toSafeObject();
};

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: GENERAL UPDATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Admin: Update user fields (credit limit, name, groupId).
 * Activation lifecycle is intentionally handled via approveUser/rejectUser
 * so that all audit fields (approvedBy/At, rejectedBy/At) are always set correctly.
 */
const updateUser = async (id, { groupId, creditLimit, name, isApiEnabled }) => {
    const user = await User.findById(id);
    if (!user) throw new NotFoundError('User');

    if (groupId !== undefined) {
        if (groupId !== null) {
            const group = await Group.findById(groupId);
            if (!group) throw new NotFoundError('Group');
            if (!group.isActive) {
                throw new BusinessRuleError(
                    `Group '${group.name}' is inactive and cannot be assigned.`,
                    'GROUP_INACTIVE'
                );
            }
        }
        user.groupId = groupId;
    }

    if (creditLimit !== undefined) {
        if (creditLimit < 0) throw new BusinessRuleError('Credit limit cannot be negative.', 'INVALID_CREDIT_LIMIT');
        user.creditLimit = creditLimit;
    }

    if (name !== undefined) user.name = name;
    if (isApiEnabled !== undefined) {
        user.isApiEnabled = isApiEnabled;
        if (isApiEnabled === true) {
            const hasApiToken = await User.exists({ _id: id, apiToken: { $nin: [null, ''] } });
            if (!hasApiToken) {
                user.apiToken = crypto.randomBytes(32).toString('hex');
            }
        }
    }

    await user.save();
    return user.toSafeObject();
};

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER: SELF-SERVICE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Customer: Get own profile.
 */
const getMyProfile = async (userId) => {
    const user = await User.findById(userId)
        .select('-password')
        .populate('groupId', GROUP_PROJECTION);
    if (!user) throw new NotFoundError('User');
    return user;
};

/**
 * Customer: Update own profile (self-service).
 * Only allows safe profile fields. Password changes require
 * updateMyPassword so currentPassword is verified first.
 */
const updateMyProfile = async (userId, updates = {}) => {
    if (
        Object.prototype.hasOwnProperty.call(updates, 'currency')
        || Object.prototype.hasOwnProperty.call(updates, 'walletCurrency')
    ) {
        throw new BusinessRuleError(
            'Currency can only be changed by an administrator.',
            'CUSTOMER_CURRENCY_CHANGE_DISABLED'
        );
    }

    const { name, email, phone, username } = updates;
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User');

    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = email;
    if (phone !== undefined) user.phone = phone;
    if (username !== undefined) user.username = username;

    await user.save();
    return user.toSafeObject ? user.toSafeObject() : user.toObject();
};

/**
 * Customer: securely update own password.
 * Verifies currentPassword before saving the new password through the
 * User model pre-save hashing hook.
 */
const updateMyPassword = async (userId, { currentPassword, newPassword }) => {
    if (typeof currentPassword !== 'string' || !currentPassword) {
        throw new BusinessRuleError('currentPassword is required.', 'CURRENT_PASSWORD_REQUIRED');
    }

    if (typeof newPassword !== 'string' || !newPassword) {
        throw new BusinessRuleError('newPassword is required.', 'NEW_PASSWORD_REQUIRED');
    }

    if (newPassword.length < 8 || !PASSWORD_STRENGTH_PATTERN.test(newPassword)) {
        throw new BusinessRuleError(
            'newPassword must be at least 8 characters and contain uppercase, lowercase, and number characters.',
            'WEAK_PASSWORD'
        );
    }

    if (newPassword === currentPassword) {
        throw new BusinessRuleError(
            'New password must be different from current password.',
            'PASSWORD_UNCHANGED'
        );
    }

    const user = await User.findById(userId).select('+password');
    if (!user) throw new NotFoundError('User');

    if (!user.password) {
        throw new BusinessRuleError(
            'Password change is not available for this account.',
            'PASSWORD_NOT_AVAILABLE'
        );
    }

    const currentMatches = await user.comparePassword(currentPassword);
    if (!currentMatches) {
        throw new AuthenticationError('Current password is incorrect.');
    }

    const unchanged = await user.comparePassword(newPassword);
    if (unchanged) {
        throw new BusinessRuleError(
            'New password must be different from current password.',
            'PASSWORD_UNCHANGED'
        );
    }

    user.password = newPassword;
    await user.save();

    return { updated: true };
};

/**
 * Customer currency changes are disabled. Currency assignment is admin-only.
 */
const updateMyCurrency = async () => {
    throw new BusinessRuleError(
        'Currency can only be changed by an administrator.',
        'CUSTOMER_CURRENCY_CHANGE_DISABLED'
    );
};

/**
 * Customer: Update own avatar (self-service).
 * Accepts a URL string or null/empty to clear.
 */
const updateMyAvatar = async (userId, avatar) => {
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User');

    user.avatar = avatar || null;
    await user.save();
    return user.toSafeObject ? user.toSafeObject() : user.toObject();
};

const regenerateMyApiToken = async (userId) => {
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User');

    const apiToken = crypto.randomBytes(32).toString('hex');
    user.apiToken = apiToken;
    await user.save();

    return {
        apiToken,
        user: user.toSafeObject ? user.toSafeObject() : user.toObject(),
    };
};

module.exports = {
    listUsers,
    getUserById,
    approveUser,
    rejectUser,
    updateUser,
    getMyProfile,
    updateMyProfile,
    updateMyPassword,
    updateMyCurrency,
    updateMyAvatar,
    regenerateMyApiToken,
};
