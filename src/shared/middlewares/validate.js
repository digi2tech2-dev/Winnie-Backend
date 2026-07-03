'use strict';

const { validationResult } = require('express-validator');
const { ValidationError } = require('../errors/AppError');

const SENSITIVE_FIELD_PATTERN = /(password|token|secret|api[-_]?key|credential|authorization)/i;

const maskValidationValue = (field, value) => (
    SENSITIVE_FIELD_PATTERN.test(String(field || ''))
        ? '[REDACTED]'
        : value
);

/**
 * Runs after express-validator chains.
 * Collects all field errors and throws a ValidationError with details.
 */
const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const formatted = errors.array().map((err) => ({
            field: err.path || err.param,
            message: err.msg,
            value: maskValidationValue(err.path || err.param, err.value),
        }));
        console.log('[VALIDATION_FAILED]', req.method, req.originalUrl, JSON.stringify(formatted, null, 2));
        throw new ValidationError('Request validation failed', formatted);
    }
    next();
};

module.exports = validate;
