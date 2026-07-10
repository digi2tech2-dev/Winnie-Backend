'use strict';

const { body, query, param } = require('express-validator');
const {
    PAYMENT_GATEWAYS,
    PAYMENT_PURPOSES,
    PAYMENT_STATUSES,
} = require('./payment.constants');

const urlValidation = (fieldName) =>
    body(fieldName)
        .optional({ nullable: true, checkFalsy: true })
        .isURL({ require_protocol: true, protocols: ['http', 'https'] })
        .withMessage(`${fieldName} must be a valid http(s) URL`)
        .trim();

const createPaymentIntentValidation = [
    body('amount')
        .notEmpty().withMessage('amount is required')
        .isFloat({ gt: 0 }).withMessage('amount must be greater than zero')
        .toFloat(),

    body('currency')
        .notEmpty().withMessage('currency is required')
        .isString().withMessage('currency must be a string')
        .trim()
        .isLength({ min: 3, max: 3 }).withMessage('currency must be a 3-letter ISO 4217 code')
        .toUpperCase(),

    body('gateway')
        .optional()
        .isString().withMessage('gateway must be a string')
        .trim()
        .toUpperCase()
        .isIn(Object.values(PAYMENT_GATEWAYS))
        .withMessage(`gateway must be one of: ${Object.values(PAYMENT_GATEWAYS).join(', ')}`),

    body('paymentMethodId')
        .optional({ nullable: true, checkFalsy: true })
        .isString().withMessage('paymentMethodId must be a string')
        .trim()
        .isLength({ max: 160 }).withMessage('paymentMethodId cannot exceed 160 characters'),

    urlValidation('returnUrl'),
    urlValidation('cancelUrl'),
];

const paymentIdValidation = [
    param('id')
        .isMongoId()
        .withMessage('Invalid payment ID'),
];

const listPaymentsValidation = [
    query('userId')
        .optional()
        .isMongoId()
        .withMessage('userId must be a valid user ID'),

    query('purpose')
        .optional()
        .isString().withMessage('purpose must be a string')
        .trim()
        .toUpperCase()
        .isIn(Object.values(PAYMENT_PURPOSES))
        .withMessage(`purpose must be one of: ${Object.values(PAYMENT_PURPOSES).join(', ')}`),

    query('status')
        .optional()
        .isString().withMessage('status must be a string')
        .trim()
        .toUpperCase()
        .isIn(Object.values(PAYMENT_STATUSES))
        .withMessage(`status must be one of: ${Object.values(PAYMENT_STATUSES).join(', ')}`),

    query('gateway')
        .optional()
        .isString().withMessage('gateway must be a string')
        .trim()
        .toUpperCase()
        .isIn(Object.values(PAYMENT_GATEWAYS))
        .withMessage(`gateway must be one of: ${Object.values(PAYMENT_GATEWAYS).join(', ')}`),

    query('credited')
        .optional()
        .isBoolean()
        .withMessage('credited must be true or false')
        .toBoolean(),

    query('from')
        .optional()
        .isISO8601()
        .withMessage('from must be an ISO date'),

    query('to')
        .optional()
        .isISO8601()
        .withMessage('to must be an ISO date'),

    query('page')
        .optional()
        .isInt({ min: 1 }).withMessage('page must be a positive integer')
        .toInt(),

    query('limit')
        .optional()
        .isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100')
        .toInt(),
];

module.exports = {
    createPaymentIntentValidation,
    paymentIdValidation,
    listPaymentsValidation,
};
