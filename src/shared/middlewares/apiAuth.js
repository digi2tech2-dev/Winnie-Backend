'use strict';

const { User } = require('../../modules/users/user.model');

const sendApiAuthError = (res, statusCode, errorCode, message) => (
    res.status(statusCode).json({
        success: false,
        error_code: errorCode,
        message,
    })
);

const apiAuth = async (req, res, next) => {
    try {
        const rawToken = req.headers['api-token'];
        const apiToken = Array.isArray(rawToken) ? rawToken[0] : rawToken;
        const token = typeof apiToken === 'string' ? apiToken.trim() : apiToken;

        if (!token) {
            return sendApiAuthError(res, 401, 120, 'Api Token is required!');
        }

        const user = await User.findOne({ apiToken: token });
        if (!user) {
            return sendApiAuthError(res, 401, 121, 'Token error');
        }

        if (user.isApiEnabled !== true) {
            return sendApiAuthError(res, 403, 122, 'Not allowed to use API');
        }

        req.user = user;
        return next();
    } catch (err) {
        return next(err);
    }
};

module.exports = apiAuth;
