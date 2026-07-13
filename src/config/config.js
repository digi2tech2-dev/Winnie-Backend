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
        networkInternational: {
            enabled: process.env.NETWORK_INTERNATIONAL_ENABLED === 'true',
            env: (process.env.NETWORK_INTERNATIONAL_ENV || 'sandbox').toLowerCase(),
            baseUrl: process.env.NETWORK_INTERNATIONAL_BASE_URL,
            apiKey: process.env.NETWORK_INTERNATIONAL_API_KEY,
            outletRef: process.env.NETWORK_INTERNATIONAL_OUTLET_REF,
            currency: (process.env.NETWORK_INTERNATIONAL_CURRENCY || 'AED').toUpperCase(),
            returnUrl: process.env.NETWORK_INTERNATIONAL_RETURN_URL ||
                `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment/success`,
            cancelUrl: process.env.NETWORK_INTERNATIONAL_CANCEL_URL ||
                `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment/cancel`,
            webhookSecret: process.env.NETWORK_INTERNATIONAL_WEBHOOK_SECRET,
            webhookSecretHeader: process.env.NETWORK_INTERNATIONAL_WEBHOOK_SECRET_HEADER ||
                'x-network-webhook-secret',
        },
        paymento: {
            enabled: process.env.PAYMENTO_ENABLED === 'true',
            apiBaseUrl: process.env.PAYMENTO_API_BASE_URL || 'https://api.paymento.io',
            apiKey: process.env.PAYMENTO_API_KEY,
            ipnSecret: process.env.PAYMENTO_IPN_SECRET,
            returnUrl: process.env.PAYMENTO_RETURN_URL ||
                `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment/success`,
            cancelUrl: process.env.PAYMENTO_CANCEL_URL ||
                `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment/cancel`,
            pendingUrl: process.env.PAYMENTO_PENDING_URL ||
                `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment/pending`,
            ipnUrl: process.env.PAYMENTO_IPN_URL ||
                `${process.env.APP_URL || `http://localhost:${process.env.PORT || 5000}`}/api/webhooks/payments/paymento`,
            fiatCurrency: (process.env.PAYMENTO_FIAT_CURRENCY || 'USD').toUpperCase(),
            allowedCrypto: (process.env.PAYMENTO_ALLOWED_CRYPTO || 'USDT').toUpperCase(),
            riskSpeed: parseFloat(process.env.PAYMENTO_RISK_SPEED || '1'),
            createPath: process.env.PAYMENTO_CREATE_PATH || '/v1/payment/request',
            verifyPath: process.env.PAYMENTO_VERIFY_PATH || '/v1/payment/verify',
        },
        ziina: {
            enabled: process.env.ZIINA_ENABLED === 'true',
            apiBaseUrl: process.env.ZIINA_API_BASE_URL || 'https://api-v2.ziina.com/api',
            accessToken: process.env.ZIINA_ACCESS_TOKEN,
            currency: (process.env.ZIINA_CURRENCY || 'AED').toUpperCase(),
            testMode: process.env.ZIINA_TEST_MODE === 'true',
            successUrl: process.env.ZIINA_SUCCESS_URL ||
                `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment/success?provider=ziina&payment_intent_id={PAYMENT_INTENT_ID}`,
            cancelUrl: process.env.ZIINA_CANCEL_URL ||
                `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment/cancel?provider=ziina&payment_intent_id={PAYMENT_INTENT_ID}`,
            failureUrl: process.env.ZIINA_FAILURE_URL ||
                `${process.env.FRONTEND_URL || 'http://localhost:5173'}/payment/cancel?provider=ziina&payment_intent_id={PAYMENT_INTENT_ID}`,
            webhookUrl: process.env.ZIINA_WEBHOOK_URL ||
                `${process.env.APP_URL || `http://localhost:${process.env.PORT || 5000}`}/api/webhooks/payments/ziina`,
            webhookSecret: process.env.ZIINA_WEBHOOK_SECRET,
        },
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
