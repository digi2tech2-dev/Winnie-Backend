'use strict';

const { body, param, query } = require('express-validator');
const {
    NOTIFICATION_TYPES,
    NOTIFICATION_PRIORITIES,
} = require('./notification.model');

const listNotificationsValidation = [
    query('page')
        .optional()
        .isInt({ min: 1 }).withMessage('page must be a positive integer'),

    query('limit')
        .optional()
        .isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100'),

    query('isRead')
        .optional()
        .isBoolean().withMessage('isRead must be true or false'),

    query('type')
        .optional()
        .isIn(Object.values(NOTIFICATION_TYPES)).withMessage(`type must be one of: ${Object.values(NOTIFICATION_TYPES).join(', ')}`),
];

const notificationIdParamValidation = [
    param('id')
        .isMongoId().withMessage('Invalid notification ID format'),
];

const createNotificationValidation = [
    body('userId')
        .if(body('broadcast').not().equals('true'))
        .notEmpty().withMessage('userId is required')
        .bail()
        .isMongoId().withMessage('Invalid userId format'),

    body('userId')
        .if(body('broadcast').equals('true'))
        .optional({ nullable: true })
        .isMongoId().withMessage('Invalid userId format'),

    body('broadcast')
        .optional()
        .isBoolean().withMessage('broadcast must be true or false'),

    body('title')
        .trim()
        .notEmpty().withMessage('title is required')
        .isLength({ max: 160 }).withMessage('title cannot exceed 160 characters'),

    body('message')
        .trim()
        .notEmpty().withMessage('message is required')
        .isLength({ max: 1000 }).withMessage('message cannot exceed 1000 characters'),

    body('type')
        .optional()
        .isIn(Object.values(NOTIFICATION_TYPES)).withMessage(`type must be one of: ${Object.values(NOTIFICATION_TYPES).join(', ')}`),

    body('priority')
        .optional()
        .isIn(Object.values(NOTIFICATION_PRIORITIES)).withMessage(`priority must be one of: ${Object.values(NOTIFICATION_PRIORITIES).join(', ')}`),

    body('route')
        .optional({ nullable: true })
        .isString().withMessage('route must be a string'),

    body('entityType')
        .optional({ nullable: true })
        .isString().withMessage('entityType must be a string'),

    body('entityId')
        .optional({ nullable: true })
        .isMongoId().withMessage('Invalid entityId format'),

    body('metadata')
        .optional()
        .isObject().withMessage('metadata must be an object'),
];

module.exports = {
    listNotificationsValidation,
    notificationIdParamValidation,
    createNotificationValidation,
};
