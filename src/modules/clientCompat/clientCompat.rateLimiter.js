'use strict';

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { ERROR_CODES } = require('./clientCompat.errors');

const createClientCompatLimiter = ({ max = 1000, windowMs = 15 * 60 * 1000 } = {}) => rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    handler: (_req, res) => res.status(429).json({
        status: 'ERROR',
        code: ERROR_CODES.RATE_LIMITED,
        message: 'Try again later',
    }),
});

const clientCompatLimiter = createClientCompatLimiter();

module.exports = { createClientCompatLimiter, clientCompatLimiter };
