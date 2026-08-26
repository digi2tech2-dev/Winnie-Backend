'use strict';

const axios = require('axios');
const { BusinessRuleError } = require('../../../shared/errors/AppError');
const { redactSecretText } = require('../../../shared/utils/secretEncryption');

const DEFAULT_BASE_URL = 'https://api.digiteech.me';
const DEFAULT_TIMEOUT_MS = 20_000;

const XENA_ERROR_CODES = Object.freeze({
    CONNECTION_REQUIRED: 'XENA_CONNECTION_REQUIRED',
    REAUTHENTICATION_REQUIRED: 'XENA_REAUTHENTICATION_REQUIRED',
    PROVIDER_AUTH_FAILED: 'XENA_PROVIDER_AUTH_FAILED',
    INVALID_CREDENTIALS: 'XENA_INVALID_CREDENTIALS',
    OTP_INVALID: 'XENA_OTP_INVALID',
    OTP_EXPIRED: 'XENA_OTP_EXPIRED',
    TARGET_INVALID: 'XENA_TARGET_INVALID',
    BALANCE_UNAVAILABLE: 'XENA_BALANCE_UNAVAILABLE',
    INSUFFICIENT_PROVIDER_BALANCE: 'XENA_INSUFFICIENT_PROVIDER_BALANCE',
    RATE_LIMITED: 'XENA_RATE_LIMITED',
    VERIFICATION_UNAVAILABLE: 'XENA_VERIFICATION_UNAVAILABLE',
    RECHARGE_ID_MISSING: 'XENA_RECHARGE_ID_MISSING',
    RECHARGE_FAILED: 'XENA_RECHARGE_FAILED',
    RECHARGE_UNKNOWN: 'XENA_RECHARGE_UNKNOWN',
    RECHARGE_NOT_FOUND: 'XENA_RECHARGE_NOT_FOUND',
    STATUS_UNAVAILABLE: 'XENA_STATUS_UNAVAILABLE',
    INTEGRATION_UNAVAILABLE: 'XENA_INTEGRATION_UNAVAILABLE',
    MALFORMED_RESPONSE: 'XENA_MALFORMED_RESPONSE',
});

const contextUnavailableCode = (context) => (
    context === 'balance'
        ? XENA_ERROR_CODES.BALANCE_UNAVAILABLE
        : context === 'targetVerification'
            ? XENA_ERROR_CODES.VERIFICATION_UNAVAILABLE
        : context === 'recharge'
            ? XENA_ERROR_CODES.RECHARGE_UNKNOWN
        : context === 'rechargeStatus'
            ? XENA_ERROR_CODES.STATUS_UNAVAILABLE
        : XENA_ERROR_CODES.INTEGRATION_UNAVAILABLE
);

const safeMessageForCode = (code) => {
    switch (code) {
        case XENA_ERROR_CODES.CONNECTION_REQUIRED:
            return 'Xena connection is required.';
        case XENA_ERROR_CODES.REAUTHENTICATION_REQUIRED:
            return 'Xena connection requires reauthentication.';
        case XENA_ERROR_CODES.PROVIDER_AUTH_FAILED:
            return 'Xena provider authentication failed.';
        case XENA_ERROR_CODES.INVALID_CREDENTIALS:
            return 'Xena username or password is invalid.';
        case XENA_ERROR_CODES.OTP_INVALID:
            return 'Xena verification code is invalid.';
        case XENA_ERROR_CODES.OTP_EXPIRED:
            return 'Xena verification code has expired. Please start a new login challenge.';
        case XENA_ERROR_CODES.TARGET_INVALID:
            return 'Xena target UID is invalid.';
        case XENA_ERROR_CODES.BALANCE_UNAVAILABLE:
            return 'Xena balance is currently unavailable.';
        case XENA_ERROR_CODES.INSUFFICIENT_PROVIDER_BALANCE:
            return 'Xena provider balance is insufficient for this recharge.';
        case XENA_ERROR_CODES.RATE_LIMITED:
            return 'Xena rate limit reached. Please retry later.';
        case XENA_ERROR_CODES.VERIFICATION_UNAVAILABLE:
            return 'Xena target verification is currently unavailable.';
        case XENA_ERROR_CODES.RECHARGE_ID_MISSING:
            return 'Xena recharge response is missing a recharge id.';
        case XENA_ERROR_CODES.RECHARGE_FAILED:
            return 'Xena recharge failed.';
        case XENA_ERROR_CODES.RECHARGE_UNKNOWN:
            return 'Xena recharge outcome is uncertain and requires review.';
        case XENA_ERROR_CODES.RECHARGE_NOT_FOUND:
            return 'Xena recharge was not found and requires review.';
        case XENA_ERROR_CODES.STATUS_UNAVAILABLE:
            return 'Xena recharge status is currently unavailable.';
        case XENA_ERROR_CODES.MALFORMED_RESPONSE:
            return 'Xena returned a malformed response.';
        case XENA_ERROR_CODES.INTEGRATION_UNAVAILABLE:
        default:
            return 'Xena integration is currently unavailable.';
    }
};

const extractRequestId = (data, headers = {}) => (
    headers['x-request-id']
    || headers['request-id']
    || data?.requestId
    || data?.data?.requestId
    || null
);

const mapXenaErrorCode = (err, context) => {
    const status = err.response?.status ?? err.statusCode ?? null;
    const providerCode = String(err.response?.data?.code || err.providerCode || '').toUpperCase();
    const providerMessage = String(err.response?.data?.message || err.response?.data?.error || err.message || '').toUpperCase();
    const providerSignal = `${providerCode} ${providerMessage}`;
    const isTimeout = err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '');

    if (
        (context === 'recharge' || context === 'rechargeStatus')
        && /(?:INSUFFICIENT|NOT[ _-]?ENOUGH|OUT[ _-]?OF|NO)[ _-]*(?:PROVIDER[ _-]*)?(?:BALANCE|STOCK|FUNDS|CREDIT)|(?:BALANCE|STOCK|FUNDS|CREDIT)[ _-]*(?:INSUFFICIENT|EXHAUSTED)/.test(providerSignal)
    ) {
        return XENA_ERROR_CODES.INSUFFICIENT_PROVIDER_BALANCE;
    }

    if (status === 429 || providerCode.includes('RATE')) {
        return XENA_ERROR_CODES.RATE_LIMITED;
    }

    if (context === 'targetVerification' && status === 404) {
        return XENA_ERROR_CODES.TARGET_INVALID;
    }

    if (context === 'challenge' && (status === 400 || status === 422)) {
        return XENA_ERROR_CODES.INVALID_CREDENTIALS;
    }

    if (context === 'verify' && (status === 400 || status === 401 || status === 403 || status === 404 || status === 410 || status === 422)) {
        if (status === 410 || providerSignal.includes('EXPIRED')) {
            return XENA_ERROR_CODES.OTP_EXPIRED;
        }

        if (
            providerSignal.includes('OTP')
            || providerSignal.includes('CODE')
            || providerSignal.includes('PIN')
            || providerSignal.includes('VERIFY')
            || providerSignal.includes('VERIFICATION')
        ) {
            return XENA_ERROR_CODES.OTP_INVALID;
        }

        return status === 404
            ? XENA_ERROR_CODES.OTP_EXPIRED
            : XENA_ERROR_CODES.OTP_INVALID;
    }

    if (context === 'rechargeStatus' && status === 404) {
        return XENA_ERROR_CODES.RECHARGE_NOT_FOUND;
    }

    if (context === 'targetVerification' && status === 409) {
        return XENA_ERROR_CODES.REAUTHENTICATION_REQUIRED;
    }

    if (context === 'rechargeStatus' && status === 409) {
        return XENA_ERROR_CODES.REAUTHENTICATION_REQUIRED;
    }

    if (status === 401 || status === 403) {
        return context === 'challenge' || context === 'targetVerification'
            ? XENA_ERROR_CODES.PROVIDER_AUTH_FAILED
            : XENA_ERROR_CODES.REAUTHENTICATION_REQUIRED;
    }

    if (isTimeout || status >= 500 || !status) {
        return contextUnavailableCode(context);
    }

    return contextUnavailableCode(context);
};

const wrapXenaError = (err, context) => {
    if (err instanceof BusinessRuleError && err.code?.startsWith('XENA_')) {
        return err;
    }

    const code = mapXenaErrorCode(err, context);
    const wrapped = new BusinessRuleError(safeMessageForCode(code), code);
    wrapped.statusCode = code === XENA_ERROR_CODES.RATE_LIMITED ? 429 : 422;
    wrapped.httpStatus = err.response?.status ?? err.statusCode ?? null;
    wrapped.requestId = extractRequestId(err.response?.data, err.response?.headers);
    wrapped.safeUpstreamMessage = redactSecretText(err.response?.data?.message || err.response?.data?.error || err.message || '');
    return wrapped;
};

class XenaClient {
    constructor({ baseUrl, apiToken, timeoutMs } = {}) {
        if (!apiToken) {
            throw new BusinessRuleError(safeMessageForCode(XENA_ERROR_CODES.PROVIDER_AUTH_FAILED), XENA_ERROR_CODES.PROVIDER_AUTH_FAILED);
        }

        const resolvedBaseUrl = String(baseUrl || process.env.XENA_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
        const resolvedTimeout = Number(timeoutMs || process.env.XENA_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

        this.http = axios.create({
            baseURL: resolvedBaseUrl,
            timeout: Number.isFinite(resolvedTimeout) && resolvedTimeout > 0 ? resolvedTimeout : DEFAULT_TIMEOUT_MS,
            headers: {
                Authorization: `Bearer ${apiToken}`,
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
        });
    }

    async request(method, path, { data, context, headers } = {}) {
        try {
            const response = await this.http.request({ method, url: path, data, headers });
            return {
                data: response.data,
                status: response.status,
                requestId: extractRequestId(response.data, response.headers),
            };
        } catch (err) {
            throw wrapXenaError(err, context);
        }
    }

    async challengeConnection({ connectionId, displayName, username, password }) {
        const data = {
            displayName,
            username,
            password,
        };

        if (connectionId) {
            data.connectionId = connectionId;
        }

        return this.request('post', '/v1/connections/challenge', {
            data,
            context: 'challenge',
        });
    }

    async verifyConnection({ challengeReference, code }) {
        return this.request('post', '/v1/connections/verify', {
            data: { connectionId: challengeReference, code },
            context: 'verify',
        });
    }

    async getConnectionStatus({ connectionId }) {
        return this.request('get', `/v1/connections/${encodeURIComponent(connectionId)}`, {
            context: 'status',
        });
    }

    async getBalance({ connectionId }) {
        return this.request('get', `/v1/connections/${encodeURIComponent(connectionId)}/balance`, {
            context: 'balance',
        });
    }

    async verifyTargetUser({ connectionId, targetUid }) {
        return this.request('get', `/v1/connections/${encodeURIComponent(connectionId)}/users/${encodeURIComponent(targetUid)}`, {
            context: 'targetVerification',
        });
    }

    async createRecharge({ connectionId, targetUid, amount, clientReference, idempotencyKey }) {
        return this.request('post', '/v1/recharges', {
            data: {
                connectionId,
                targetUid,
                amount,
                clientReference,
            },
            headers: {
                'Idempotency-Key': idempotencyKey,
            },
            context: 'recharge',
        });
    }

    async getRecharge({ rechargeId }) {
        return this.request('get', `/v1/recharges/${encodeURIComponent(rechargeId)}`, {
            context: 'rechargeStatus',
        });
    }
}

module.exports = {
    XenaClient,
    XENA_ERROR_CODES,
    DEFAULT_BASE_URL,
    DEFAULT_TIMEOUT_MS,
    extractRequestId,
    safeMessageForCode,
    wrapXenaError,
};
