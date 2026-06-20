'use strict';

const { Notification, NOTIFICATION_TYPES, NOTIFICATION_PRIORITIES } = require('./notification.model');
const { User, ROLES, USER_STATUS } = require('../users/user.model');
const { NotFoundError } = require('../../shared/errors/AppError');

const normalizeNotificationPayload = ({
    userId,
    title,
    message,
    type = NOTIFICATION_TYPES.SYSTEM,
    priority = NOTIFICATION_PRIORITIES.NORMAL,
    route = null,
    entityType = null,
    entityId = null,
    metadata = {},
}) => ({
    userId,
    title: String(title || '').trim(),
    message: String(message || '').trim(),
    type,
    priority,
    route: route ? String(route).trim() : null,
    entityType: entityType ? String(entityType).trim() : null,
    entityId: entityId || null,
    metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {},
});

const getEventKey = (params) => {
    const eventKey = params?.metadata?.eventKey;
    return eventKey ? String(eventKey).trim() : '';
};

const notificationExistsForEvent = async (userId, eventKey) => {
    if (!userId || !eventKey) return false;
    return Boolean(await Notification.exists({ userId, 'metadata.eventKey': eventKey }));
};

const createNotification = async (params) => {
    const isBroadcast = params?.broadcast === true || params?.broadcast === 'true';
    const eventKey = getEventKey(params);

    if (isBroadcast) {
        const users = await User.find({ status: USER_STATUS.ACTIVE }).select('_id');

        if (users.length === 0) {
            return {
                broadcast: true,
                createdCount: 0,
            };
        }

        const recipients = eventKey
            ? (await Promise.all(users.map(async (user) => (
                (await notificationExistsForEvent(user._id, eventKey)) ? null : user
            )))).filter(Boolean)
            : users;

        if (recipients.length === 0) {
            return {
                broadcast: true,
                createdCount: 0,
            };
        }

        const notifications = await Notification.insertMany(
            recipients.map((user) => normalizeNotificationPayload({
                ...params,
                userId: user._id,
            })),
            { ordered: false }
        );

        return {
            broadcast: true,
            createdCount: notifications.length,
        };
    }

    const payload = normalizeNotificationPayload(params);
    if (eventKey && await notificationExistsForEvent(payload.userId, eventKey)) {
        return null;
    }

    return Notification.create(payload);
};

const safeCreateNotification = async (params) => {
    try {
        return await createNotification(params);
    } catch (error) {
        console.error('[Notifications] Failed to create notification:', error.message);
        return null;
    }
};

const createAdminActorNotifications = async ({
    roles = [ROLES.ADMIN],
    permissions = [],
    permissionMode = 'all',
    ...notificationPayload
}) => {
    const normalizedRoles = roles
        .map((role) => String(role || '').trim().toUpperCase())
        .filter(Boolean);
    const requiredPermissions = permissions
        .map((permission) => String(permission || '').trim())
        .filter(Boolean);
    const normalizedPermissionMode = String(permissionMode || 'all').trim().toLowerCase();
    const eventKey = getEventKey(notificationPayload);

    const users = await User.find({
        status: USER_STATUS.ACTIVE,
        role: { $in: normalizedRoles.length ? normalizedRoles : [ROLES.ADMIN] },
    }).select('_id role permissions');

    const recipients = users.filter((user) => {
        if (user.role === ROLES.ADMIN || requiredPermissions.length === 0) {
            return true;
        }

        const userPermissions = Array.isArray(user.permissions) ? user.permissions : [];
        if (normalizedPermissionMode === 'any') {
            return requiredPermissions.some((permission) => userPermissions.includes(permission));
        }

        return requiredPermissions.every((permission) => userPermissions.includes(permission));
    });

    const dedupedRecipients = eventKey
        ? (await Promise.all(recipients.map(async (user) => (
            (await notificationExistsForEvent(user._id, eventKey)) ? null : user
        )))).filter(Boolean)
        : recipients;

    if (dedupedRecipients.length === 0) {
        return [];
    }

    return Notification.insertMany(
        dedupedRecipients.map((user) => normalizeNotificationPayload({
            ...notificationPayload,
            userId: user._id,
        })),
        { ordered: false }
    );
};

const safeCreateAdminActorNotifications = async (params) => {
    try {
        return await createAdminActorNotifications(params);
    } catch (error) {
        console.error('[Notifications] Failed to create admin notifications:', error.message);
        return [];
    }
};

const listNotifications = async (userId, {
    page = 1,
    limit = 20,
    isRead,
    type,
} = {}) => {
    const filter = { userId };

    if (isRead !== undefined) {
        filter.isRead = String(isRead) === 'true' || isRead === true;
    }

    if (type) {
        filter.type = type;
    }

    const skip = (page - 1) * limit;

    const [notifications, total, unreadCount] = await Promise.all([
        Notification.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        Notification.countDocuments(filter),
        Notification.countDocuments({ userId, isRead: false }),
    ]);

    return {
        notifications,
        unreadCount,
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit) || 1,
        },
    };
};

const getUnreadCount = async (userId) => {
    return Notification.countDocuments({ userId, isRead: false });
};

const markNotificationAsRead = async (userId, notificationId) => {
    const notification = await Notification.findOneAndUpdate(
        { _id: notificationId, userId },
        { $set: { isRead: true, readAt: new Date() } },
        { new: true }
    );

    if (!notification) {
        throw new NotFoundError('Notification');
    }

    return notification;
};

const markAllNotificationsAsRead = async (userId) => {
    const result = await Notification.updateMany(
        { userId, isRead: false },
        { $set: { isRead: true, readAt: new Date() } }
    );

    return { modifiedCount: result.modifiedCount || 0 };
};

const deleteNotification = async (userId, notificationId) => {
    const notification = await Notification.findOneAndDelete({ _id: notificationId, userId });
    if (!notification) {
        throw new NotFoundError('Notification');
    }

    return notification;
};

const clearReadNotifications = async (userId) => {
    const result = await Notification.deleteMany({ userId, isRead: true });
    return { deletedCount: result.deletedCount || 0 };
};

module.exports = {
    createNotification,
    safeCreateNotification,
    createAdminActorNotifications,
    safeCreateAdminActorNotifications,
    listNotifications,
    getUnreadCount,
    markNotificationAsRead,
    markAllNotificationsAsRead,
    deleteNotification,
    clearReadNotifications,
};
