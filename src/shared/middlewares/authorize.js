'use strict';

const { AuthorizationError } = require('../errors/AppError');

const ADMIN_ROLE = 'ADMIN';

/**
 * Role-based access control middleware factory.
 * Usage: authorizeRoles('ADMIN') or authorizeRoles('ADMIN', 'CUSTOMER')
 *
 * Must be used AFTER authenticate middleware.
 */
const authorizeRoles = (...roles) => (req, res, next) => {
    if (!req.user) {
        throw new AuthorizationError('Authentication required before authorization.');
    }

    const allowedRoles = roles.flat().map((role) => String(role).trim().toUpperCase());

    if (!allowedRoles.includes(req.user.role)) {
        throw new AuthorizationError(
            `Role '${req.user.role}' is not allowed to access this resource.`
        );
    }

    next();
};

/**
 * Fine-grained permission guard for supervisor access.
 * Admins bypass permission checks by design.
 *
 * Usage: requirePermission('orders.view')
 */
const requirePermission = (...permissions) => (req, res, next) => {
    if (!req.user) {
        throw new AuthorizationError('Authentication required before authorization.');
    }

    if (req.user.role === ADMIN_ROLE) {
        return next();
    }

    const requiredPermissions = permissions
        .flat()
        .map((permission) => String(permission || '').trim())
        .filter(Boolean);

    if (requiredPermissions.length === 0) {
        return next();
    }

    const userPermissions = Array.isArray(req.user.permissions)
        ? req.user.permissions
        : [];

    const hasEveryPermission = requiredPermissions.every((permission) =>
        userPermissions.includes(permission)
    );

    if (!hasEveryPermission) {
        throw new AuthorizationError('You do not have permission to perform this action.');
    }

    next();
};

const requireAnyPermission = (...permissions) => (req, res, next) => {
    if (!req.user) {
        throw new AuthorizationError('Authentication required before authorization.');
    }

    if (req.user.role === ADMIN_ROLE) {
        return next();
    }

    const allowedPermissions = permissions
        .flat()
        .map((permission) => String(permission || '').trim())
        .filter(Boolean);

    if (allowedPermissions.length === 0) {
        return next();
    }

    const userPermissions = Array.isArray(req.user.permissions)
        ? req.user.permissions
        : [];

    const hasAnyPermission = allowedPermissions.some((permission) =>
        userPermissions.includes(permission)
    );

    if (!hasAnyPermission) {
        throw new AuthorizationError('You do not have permission to perform this action.');
    }

    next();
};

const authorize = authorizeRoles;

module.exports = authorize;
module.exports.authorizeRoles = authorizeRoles;
module.exports.requirePermission = requirePermission;
module.exports.requireAnyPermission = requireAnyPermission;
