'use strict';

class ClientCompatError extends Error {
    constructor(message, code = 500, statusCode = 400) {
        super(message);
        this.name = 'ClientCompatError';
        this.compatCode = code;
        this.statusCode = statusCode;
        this.isOperational = true;
    }
}

const ERROR_CODES = Object.freeze({
    INSUFFICIENT_BALANCE: 100,
    QUANTITY_NOT_AVAILABLE: 105,
    QUANTITY_NOT_ALLOWED: 106,
    PRODUCT_NOT_FOUND: 109,
    PRODUCT_NOT_AVAILABLE: 110,
    RATE_LIMITED: 111,
    QUANTITY_TOO_SMALL: 112,
    QUANTITY_TOO_LARGE: 113,
    BUSINESS_RULE: 114,
    TOKEN_REQUIRED: 120,
    INVALID_TOKEN: 121,
    API_DISABLED: 122,
    IP_FORBIDDEN: 123,
    VALIDATION: 124,
    MAINTENANCE: 130,
    INTERNAL: 500,
});

const mapErrorToCompat = (err) => {
    if (err instanceof ClientCompatError) {
        return { statusCode: err.statusCode || 400, code: err.compatCode, message: err.message };
    }

    const internalCode = String(err?.code || '').toUpperCase();
    const message = String(err?.message || 'Unknown internal error');

    if (internalCode === 'INSUFFICIENT_FUNDS') {
        return { statusCode: 422, code: ERROR_CODES.INSUFFICIENT_BALANCE, message: 'Insufficient balance' };
    }
    if (internalCode === 'NOT_FOUND' && /product/i.test(message)) {
        return { statusCode: 404, code: ERROR_CODES.PRODUCT_NOT_FOUND, message: 'Product deleted or not found' };
    }
    if ([
        'PRODUCT_INACTIVE',
        'PRODUCT_NOT_AVAILABLE_FOR_API',
        'FAZERCARDS_CUSTOMER_PURCHASE_DISABLED',
        'FAMILY_DISABLED_UNAVAILABLE',
        'CUSTOMER_PURCHASE_NOT_ALLOWED',
    ].includes(internalCode)) {
        return { statusCode: 400, code: ERROR_CODES.PRODUCT_NOT_AVAILABLE, message: 'Product not available now' };
    }
    if (internalCode === 'QUANTITY_NOT_AVAILABLE') {
        return { statusCode: 400, code: ERROR_CODES.QUANTITY_NOT_AVAILABLE, message: 'Quantity not available' };
    }
    if (internalCode === 'QUANTITY_OUT_OF_RANGE' || internalCode === 'INVALID_QUANTITY') {
        return { statusCode: 400, code: ERROR_CODES.QUANTITY_NOT_ALLOWED, message: 'Quantity not allowed' };
    }
    if (internalCode === 'VALIDATION_ERROR' || internalCode === 'INVALID_ORDER_FIELDS') {
        return { statusCode: 400, code: ERROR_CODES.VALIDATION, message };
    }
    if (err?.isOperational || (err?.statusCode && err.statusCode < 500)) {
        return { statusCode: err.statusCode || 400, code: ERROR_CODES.BUSINESS_RULE, message };
    }
    return { statusCode: 500, code: ERROR_CODES.INTERNAL, message: 'Unknown internal error' };
};

const sendCompatError = (res, err) => {
    const mapped = mapErrorToCompat(err);
    return res.status(mapped.statusCode).json({ status: 'ERROR', code: mapped.code, message: mapped.message });
};

const catchCompat = (handler) => async (req, res) => {
    try {
        await handler(req, res);
    } catch (err) {
        sendCompatError(res, err);
    }
};

module.exports = { ClientCompatError, ERROR_CODES, mapErrorToCompat, sendCompatError, catchCompat };
