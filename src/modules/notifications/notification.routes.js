'use strict';

const { Router } = require('express');
const notificationController = require('./notification.controller');
const {
    listNotificationsValidation,
    notificationIdParamValidation,
    createNotificationValidation,
} = require('./notification.validation');
const validate = require('../../shared/middlewares/validate');
const authenticate = require('../../shared/middlewares/authenticate');
const authorize = require('../../shared/middlewares/authorize');
const requireActiveUser = require('../../shared/middlewares/requireActiveUser');

const router = Router();

router.use(authenticate);
router.use(requireActiveUser);

router.get(
    '/',
    listNotificationsValidation,
    validate,
    notificationController.listMyNotifications
);

router.get('/unread-count', notificationController.getUnreadCount);

router.patch('/read-all', notificationController.markAllAsRead);

router.delete('/read', notificationController.clearReadNotifications);

router.patch(
    '/:id/read',
    notificationIdParamValidation,
    validate,
    notificationController.markAsRead
);

router.delete(
    '/:id',
    notificationIdParamValidation,
    validate,
    notificationController.deleteNotification
);

router.post(
    '/',
    authorize('ADMIN'),
    createNotificationValidation,
    validate,
    notificationController.createNotification
);

module.exports = router;
