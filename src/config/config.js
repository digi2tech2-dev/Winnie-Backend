'use strict';

/**
 * Centralized application configuration.
 * All environment variable access should go through this file.
 */
const config = {
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT, 10) || 5000,

    db: {
        uri: process.env.MONGO_URI,
    },

    jwt: {
        secret: process.env.JWT_SECRET,
        expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    },

    bcrypt: {
        rounds: parseInt(process.env.BCRYPT_ROUNDS, 10) || 12,
    },

    // ── Google OAuth ────────────────────────────────────────────────────────────
    google: {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackUrl: process.env.GOOGLE_CALLBACK_URL ||
            `http://localhost:${process.env.PORT || 5000}/api/auth/google/callback`,
    },

    // ── Email / SMTP ────────────────────────────────────────────────────────────
    email: {
        host: process.env.SMTP_HOST || 'smtp.mailtrap.io',
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        from: process.env.EMAIL_FROM || 'noreply@example.com',
        // Base URL for verification links (server-side)
        appUrl: process.env.APP_URL || `http://localhost:${process.env.PORT || 5000}`,
    },

    // ── Frontend ────────────────────────────────────────────────────────────────
    frontend: {
        url: process.env.FRONTEND_URL || 'http://localhost:5173',
        verifyRedirectUrl: process.env.FRONTEND_VERIFY_REDIRECT_URL ||
            `${process.env.FRONTEND_URL || 'http://localhost:5173'}/email-verified`,
    },

    // ── CORS ────────────────────────────────────────────────────────────────────
    cors: {
        allowedOrigins: process.env.ALLOWED_ORIGINS || 'http://localhost:5173',
    },

    payments: {
        enabled: process.env.PAYMENTS_ENABLED !== 'false',
        defaultGateway: (process.env.PAYMENT_DEFAULT_GATEWAY || 'MOCK').toUpperCase(),
        allowedGateways: (process.env.PAYMENT_ALLOWED_GATEWAYS || 'MOCK')
            .split(',')
            .map((gateway) => gateway.trim().toUpperCase())
            .filter(Boolean),
        minAmount: parseFloat(process.env.PAYMENT_MIN_AMOUNT || '1'),
        maxAmount: parseFloat(process.env.PAYMENT_MAX_AMOUNT || '10000'),
        mockCheckoutBaseUrl: process.env.MOCK_PAYMENT_CHECKOUT_BASE_URL ||
            `${process.env.FRONTEND_URL || 'http://localhost:5173'}/mock-payment`,
    },

    providerCredentials: {
        key: process.env.PROVIDER_CREDENTIALS_KEY,
    },
};

// Guard: fail fast if critical configs are missing
const required = ['MONGO_URI', 'JWT_SECRET'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

module.exports = config;
