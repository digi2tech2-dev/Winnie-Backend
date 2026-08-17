'use strict';

const { body, query, validationResult } = require('express-validator');

const createClientOrderValidation = [
    body('productId')
        .notEmpty().withMessage('productId is required')
        .isMongoId().withMessage('Invalid productId'),

    body('qty')
        .notEmpty().withMessage('qty is required')
        .isInt({ min: 1 }).withMessage('qty must be a positive integer'),

    body('order_uuid')
        .optional({ nullable: true, checkFalsy: true })
        .trim()
        .isLength({ max: 191 }).withMessage('order_uuid cannot exceed 191 characters'),

    body('order_uuid').custom((value, { req }) => {
        const headerValue = req.get('Idempotency-Key');
        const idempotencyKey = String(headerValue || value || '').trim();
        if (!idempotencyKey) {
            throw new Error('order_uuid or Idempotency-Key is required');
        }
        if (idempotencyKey.length > 191) {
            throw new Error('Idempotency-Key cannot exceed 191 characters');
        }
        return true;
    }),
];

const checkOrdersValidation = [
    query('orders')
        .trim()
        .notEmpty().withMessage('orders query is required'),
];

const validateClientRequest = (req, res, next) => {
    const errors = validationResult(req);
    if (errors.isEmpty()) return next();

    const formatted = errors.array().map((err) => ({
        field: err.path || err.param,
        message: err.msg,
        value: err.value,
    }));

    return res.status(400).json({
        success: false,
        error_code: 123,
        message: formatted[0]?.message || 'Request validation failed',
        errors: formatted,
    });
};

module.exports = {
    createClientOrderValidation,
    checkOrdersValidation,
    validateClientRequest,
};
