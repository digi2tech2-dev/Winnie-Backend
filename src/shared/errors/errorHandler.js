'use strict';

const { AppError } = require('./AppError');
const config = require('../../config/config');

/**
 * Handle Mongoose CastError (invalid ObjectId etc.)
 */
const handleCastError = (err) =>
    new AppError(`Invalid ${err.path}: ${err.value}`, 400, 'INVALID_ID');

/**
 * Handle Mongoose duplicate key error
 */
const handleDuplicateKeyError = (err) => {
    const field = Object.keys(err.keyValue)[0];
    const value = err.keyValue[field];
    return new AppError(
        `Duplicate value for field '${field}': '${value}'. Please use a different value.`,
        409,
        'DUPLICATE_KEY'
    );
};

/**
 * Handle Mongoose validation errors
 */
const getRuntimeEnv = () => process.env.NODE_ENV || config.env || 'development';

const isDevelopment = () => getRuntimeEnv() === 'development';

const isAdminProductRequest = (req) => (
    req?.method === 'PATCH' &&
    /\/admin\/products\/[^/]+$/.test(String(req.originalUrl || req.url || ''))
);

const handleValidationError = (err, req) => {
    const errors = Object.values(err.errors).map((el) => ({
        field: el.path,
        message: el.message,
        value: el.value,
    }));

    if (isDevelopment() && isAdminProductRequest(req)) {
        console.warn('[admin.products.validation.failed]', {
            method: req.method,
            originalUrl: req.originalUrl,
            body: req.body,
            errors,
        });
    }

    const appError = new AppError('Validation failed', 400, 'VALIDATION_ERROR');
    if (isDevelopment()) {
        appError.details = errors;
        appError.errors = errors;
    }
    return appError;
};

/**
 * Handle JWT errors
 */
const handleJWTError = () =>
    new AppError('Invalid token. Please log in again.', 401, 'INVALID_TOKEN');

const handleJWTExpiredError = () =>
    new AppError('Your token has expired. Please log in again.', 401, 'TOKEN_EXPIRED');

/**
 * Send error response in development (full stack trace)
 */
const sendErrorDev = (err, res) => {
    res.status(err.statusCode).json({
        success: false,
        code: err.code,
        message: err.message,
        details: err.details || undefined,
        errors: err.errors || undefined,
        stack: err.stack,
    });
};

/**
 * Send error response in production (safe, no leak)
 */
const sendErrorProd = (err, res) => {
    if (err.isOperational) {
        // Known, safe-to-expose error
        return res.status(err.statusCode).json({
            success: false,
            code: err.code,
            message: err.message,
            details: err.details || undefined,
            errors: err.errors || undefined,
        });
    }

    // Unknown programming error → don't leak details
    console.error('💥 UNHANDLED ERROR:', err);
    return res.status(500).json({
        success: false,
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Something went wrong. Please try again later.',
    });
};

/**
 * Global error handling middleware
 */
const globalErrorHandler = (err, req, res, next) => {
    err.statusCode = err.statusCode || 500;

    let error = { ...err, message: err.message, stack: err.stack };

    // Transform known Mongoose / JWT errors into AppErrors
    if (err.name === 'CastError') error = handleCastError(err);
    if (err.code === 11000) error = handleDuplicateKeyError(err);
    if (err.name === 'ValidationError' && !err.isOperational) error = handleValidationError(err, req);
    if (err.name === 'JsonWebTokenError') error = handleJWTError();
    if (err.name === 'TokenExpiredError') error = handleJWTExpiredError();

    if (getRuntimeEnv() === 'development') {
        sendErrorDev(error, res);
    } else {
        sendErrorProd(error, res);
    }
};

module.exports = globalErrorHandler;
