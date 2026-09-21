'use strict';

const { User, USER_STATUS } = require('../users/user.model');
const { hashApiKey } = require('../users/apiAccess.service');
const { ERROR_CODES } = require('./clientCompat.errors');

const getSingleHeader = (value) => (Array.isArray(value) ? value[0] : value);
const legacyTokenLookupEnabled = () => process.env.CLIENT_API_LEGACY_TOKEN_ENABLED === 'true';

const extractApiKey = (req) => {
    const apiToken = getSingleHeader(req.headers['api-token']);
    if (typeof apiToken === 'string' && apiToken.trim()) return { key: apiToken.trim(), source: 'api-token' };

    const xApiKey = getSingleHeader(req.headers['x-api-key']);
    if (typeof xApiKey === 'string' && xApiKey.trim()) return { key: xApiKey.trim(), source: 'x-api-key' };

    const authorization = getSingleHeader(req.headers.authorization);
    if (typeof authorization === 'string' && /^Bearer\s+/i.test(authorization)) {
        return { key: authorization.replace(/^Bearer\s+/i, '').trim(), source: 'authorization' };
    }
    return { key: null, source: null };
};

const normalizeIp = (value) => String(value || '').trim().split(',')[0].trim().replace(/^::ffff:/i, '');

const sendAuthError = (res, statusCode, code, message) => (
    res.status(statusCode).json({ status: 'ERROR', code, message })
);

const clientCompatAuth = async (req, res, next) => {
    try {
        const { key, source } = extractApiKey(req);
        if (!key) return sendAuthError(res, 401, ERROR_CODES.TOKEN_REQUIRED, 'API token is required');

        const apiKeyHash = hashApiKey(key);
        let usedLegacyPlaintextToken = false;
        let user = await User.findOne({ $or: [{ apiKeyHash }, { apiKeyRevokedHash: apiKeyHash }] })
            .select('+apiKeyHash +apiKeyRevokedHash +apiToken +apiKeyLastUsedIp +whitelistIps');

        if (!user && source === 'api-token' && legacyTokenLookupEnabled()) {
            user = await User.findOne({ apiToken: key })
                .select('+apiKeyHash +apiKeyRevokedHash +apiToken +apiKeyLastUsedIp +whitelistIps');
            usedLegacyPlaintextToken = Boolean(user);
        }
        if (!user) return sendAuthError(res, 401, ERROR_CODES.INVALID_TOKEN, 'Invalid API token');

        if (
            user.isApiEnabled !== true
            || (!user.apiKeyHash && !usedLegacyPlaintextToken)
            || user.apiKeyRevokedAt
            || user.status !== USER_STATUS.ACTIVE
            || user.blockedAt
            || user.deletedAt
        ) {
            return sendAuthError(res, 403, ERROR_CODES.API_DISABLED, 'API access is disabled');
        }

        const allowlist = (Array.isArray(user.whitelistIps) ? user.whitelistIps : [])
            .map(normalizeIp)
            .filter(Boolean);
        if (allowlist.length > 0 && !allowlist.includes(normalizeIp(req.ip))) {
            return sendAuthError(res, 403, ERROR_CODES.IP_FORBIDDEN, 'IP address is not allowed');
        }

        req.user = user;
        req.clientCompat = { keyPrefix: user.apiKeyPrefix || null, header: source };
        User.updateOne(
            { _id: user._id },
            { $set: { apiKeyLastUsedAt: new Date(), apiKeyLastUsedIp: req.ip || null } }
        ).catch(() => {});
        return next();
    } catch (err) {
        return next(err);
    }
};

module.exports = { clientCompatAuth, extractApiKey, normalizeIp };
