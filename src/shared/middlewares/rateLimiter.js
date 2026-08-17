'use strict';

/**
 * Rate Limiting Middleware
 *
 * Provides two pre-configured limiters:
 *
 * 1. apiLimiter     — general protection for all /api routes
 *                      500 requests per 15-minute window per IP
 *
 * 2. authLimiter    — strict limiter for sensitive endpoints
 *                      (login, register, password reset, resend-verification)
 *                      10 requests per 15-minute window per IP
 *
 * Both return standard JSON responses that match the project's error format.
 */

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;

// ── General API Rate Limiter ──────────────────────────────────────────────────

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,    // 15 minutes
    max: 500,                     // 500 requests per window per IP
    standardHeaders: true,        // Return rate limit info in RateLimit-* headers
    legacyHeaders: false,         // Disable X-RateLimit-* headers
    message: {
        success: false,
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests from this IP. Please try again after 15 minutes.',
    },
});

// ── Strict Auth Rate Limiter ──────────────────────────────────────────────────

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,    // 15 minutes
    max: 10,                      // 10 requests per window per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        code: 'AUTH_RATE_LIMIT_EXCEEDED',
        message: 'Too many authentication attempts. Please try again after 15 minutes.',
    },
});

// ── Wallet Mutation Rate Limiter ──────────────────────────────────────────────

const walletLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,    // 15 minutes
    max: 20,                      // 20 wallet mutations per window per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        code: 'WALLET_RATE_LIMIT_EXCEEDED',
        message: 'Too many wallet operations. Please try again after 15 minutes.',
    },
});

const clientApiLimiter = rateLimit({
    windowMs: parseInt(process.env.CLIENT_API_RATE_LIMIT_WINDOW_MS || `${15 * 60 * 1000}`, 10),
    max: parseInt(process.env.CLIENT_API_RATE_LIMIT_MAX || '120', 10),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        if (req.user?._id) return `client-api:user:${req.user._id.toString()}`;
        return ipKeyGenerator(req.ip);
    },
    message: {
        success: false,
        error_code: 129,
        code: 'CLIENT_API_RATE_LIMIT_EXCEEDED',
        message: 'Too many client API requests. Please slow down and try again later.',
    },
});

module.exports = { apiLimiter, authLimiter, walletLimiter, clientApiLimiter };
