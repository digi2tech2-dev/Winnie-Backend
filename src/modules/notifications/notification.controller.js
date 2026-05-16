'use strict';

const notificationService = require('./notification.service');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');

const listMyNotifications = catchAsync(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const result = await notificationService.listNotifications(req.user._id, {
        page,
        limit,
        isRead: req.query.isRead,
        type: req.query.type,
    });

    return sendPaginated(
        res,
        {
            notifications: result.notifications,
            unreadCount: result.unreadCount,
        },
        result.pagination,
        'Notifications retrieved successfully.'
    );
});

const getUnreadCount = catchAsync(async (req, res) => {
    const unreadCount = await notificationService.getUnreadCount(req.user._id);
    return sendSuccess(res, { unreadCount }, 'Unread notification count retrieved successfully.');
});

const markAsRead = catchAsync(async (req, res) => {
    const notification = await notificationService.markNotificationAsRead(req.user._id, req.params.id);
    return sendSuccess(res, notification, 'Notification marked as read.');
});

const markAllAsRead = catchAsync(async (req, res) => {
    const result = await notificationService.markAllNotificationsAsRead(req.user._id);
    return sendSuccess(res, result, 'All notifications marked as read.');
});

const deleteNotification = catchAsync(async (req, res) => {
    await notificationService.deleteNotification(req.user._id, req.params.id);
    return sendSuccess(res, null, 'Notification deleted successfully.');
});

const clearReadNotifications = catchAsync(async (req, res) => {
    const result = await notificationService.clearReadNotifications(req.user._id);
    return sendSuccess(res, result, 'Read notifications cleared successfully.');
});

const createNotification = catchAsync(async (req, res) => {
    const notification = await notificationService.createNotification(req.body);
    return sendCreated(res, notification, 'Notification created successfully.');
});

module.exports = {
    listMyNotifications,
    getUnreadCount,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    clearReadNotifications,
    createNotification,
};
