'use strict';

const crypto = require('crypto');
const config = require('../../config/config');

const API_KEY_PUBLIC_PREFIX = 'winnie';

const getHashSecret = () => (
    process.env.API_KEY_HASH_SECRET
    || process.env.CLIENT_API_KEY_HASH_SECRET
    || config.jwt.secret
);

const hashApiKey = (apiKey) => (
    crypto
        .createHmac('sha256', getHashSecret())
        .update(String(apiKey || '').trim())
        .digest('hex')
);

const generateApiKey = () => `${API_KEY_PUBLIC_PREFIX}_${crypto.randomBytes(32).toString('base64url')}`;

const getPrefix = (apiKey) => {
    const value = String(apiKey || '').trim();
    const marker = value.indexOf('_');
    if (marker > 0) return value.slice(0, marker);
    return value.slice(0, 10);
};

const getLast4 = (apiKey) => String(apiKey || '').trim().slice(-4);

const hasActiveApiKey = (user = {}) => Boolean(user.apiKeyHash && !user.apiKeyRevokedAt);

const hasLegacyApiToken = (user = {}) => {
    if (!Object.prototype.hasOwnProperty.call(user, 'apiToken')) return false;
    return Boolean(String(user.apiToken || '').trim());
};

const buildApiAccessMetadata = (user = {}) => ({
    enabled: user.isApiEnabled === true,
    apiAccessEnabled: user.isApiEnabled === true,
    isApiEnabled: user.isApiEnabled === true,
    hasApiKey: hasActiveApiKey(user),
    apiKeyPrefix: user.apiKeyPrefix || null,
    apiKeyLast4: user.apiKeyLast4 || null,
    apiKeyCreatedAt: user.apiKeyCreatedAt || null,
    apiKeyLastRotatedAt: user.apiKeyLastRotatedAt || null,
    apiKeyRevokedAt: user.apiKeyRevokedAt || null,
    apiKeyLastUsedAt: user.apiKeyLastUsedAt || null,
    apiKeyVersion: Number(user.apiKeyVersion || 0),
    legacyKeyPresent: hasLegacyApiToken(user),
});

const applyGeneratedApiKey = (user, now = new Date()) => {
    const apiKey = generateApiKey();

    user.isApiEnabled = true;
    user.apiKeyHash = hashApiKey(apiKey);
    user.apiKeyPrefix = getPrefix(apiKey);
    user.apiKeyLast4 = getLast4(apiKey);
    user.apiKeyCreatedAt = user.apiKeyCreatedAt || now;
    user.apiKeyLastRotatedAt = now;
    user.apiKeyRevokedAt = null;
    user.apiKeyVersion = Number(user.apiKeyVersion || 0) + 1;
    user.apiToken = null;

    return apiKey;
};

const revokeApiKey = (user, now = new Date()) => {
    user.isApiEnabled = false;
    user.apiKeyHash = null;
    user.apiKeyRevokedAt = now;
    user.apiToken = null;
};

module.exports = {
    API_KEY_PUBLIC_PREFIX,
    applyGeneratedApiKey,
    buildApiAccessMetadata,
    generateApiKey,
    getLast4,
    getPrefix,
    hasActiveApiKey,
    hashApiKey,
    revokeApiKey,
};
