'use strict';

const { User } = require('../../modules/users/user.model');
const { USER_STATUS } = require('../../modules/users/user.model');
const { hashApiKey } = require('../../modules/users/apiAccess.service');

const legacyTokenLookupEnabled = () => process.env.CLIENT_API_LEGACY_TOKEN_ENABLED === 'true';

const getSingleHeader = (value) => (Array.isArray(value) ? value[0] : value);

const extractApiKey = (req) => {
    const xApiKey = getSingleHeader(req.headers['x-api-key']);
    if (typeof xApiKey === 'string' && xApiKey.trim()) {
        return { key: xApiKey.trim(), source: 'x-api-key' };
    }

    const authHeader = getSingleHeader(req.headers.authorization);
    if (typeof authHeader === 'string' && /^Bearer\s+/i.test(authHeader)) {
        return { key: authHeader.replace(/^Bearer\s+/i, '').trim(), source: 'authorization' };
    }

    const legacyToken = getSingleHeader(req.headers['api-token']);
    if (typeof legacyToken === 'string' && legacyToken.trim()) {
        return { key: legacyToken.trim(), source: 'api-token' };
    }

    return { key: null, source: null };
};

const sendApiAuthError = (res, statusCode, errorCode, message) => (
    res.status(statusCode).json({
        success: false,
        error_code: errorCode,
        message,
    })
);

const apiAuth = async (req, res, next) => {
    try {
        const { key, source } = extractApiKey(req);

        if (!key) {
            return sendApiAuthError(res, 401, 120, 'API key is required.');
        }

        const apiKeyHash = hashApiKey(key);
        let usedLegacyPlaintextToken = false;
        let user = await User.findOne({ apiKeyHash })
            .select('+apiKeyHash +apiToken +apiKeyLastUsedIp');

        if (!user && source === 'api-token' && legacyTokenLookupEnabled()) {
            user = await User.findOne({ apiToken: key })
                .select('+apiKeyHash +apiToken +apiKeyLastUsedIp');
            usedLegacyPlaintextToken = Boolean(user);
        }

        if (!user) {
            return sendApiAuthError(res, 401, 121, 'Invalid API key.');
        }

        if (
            user.isApiEnabled !== true
            || (!user.apiKeyHash && !usedLegacyPlaintextToken)
            || user.apiKeyRevokedAt
        ) {
            return sendApiAuthError(res, 403, 122, 'API access is disabled.');
        }

        if (user.status !== USER_STATUS.ACTIVE || user.blockedAt || user.deletedAt) {
            return sendApiAuthError(res, 403, 122, 'Account is not allowed to use API.');
        }

        req.user = user;
        req.clientApi = {
            keyPrefix: user.apiKeyPrefix || null,
            keyLast4: user.apiKeyLast4 || null,
            header: source,
            legacyPlaintext: usedLegacyPlaintextToken,
        };

        User.updateOne(
            { _id: user._id },
            {
                $set: {
                    apiKeyLastUsedAt: new Date(),
                    apiKeyLastUsedIp: req.ip || null,
                },
            }
        ).catch(() => {});

        return next();
    } catch (err) {
        return next(err);
    }
};

module.exports = apiAuth;
