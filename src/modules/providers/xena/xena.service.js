'use strict';

const { Provider } = require('../provider.model');
const { XenaConnection, XENA_CONNECTION_STATUSES } = require('./xenaConnection.model');
const { XenaClient, XENA_ERROR_CODES, safeMessageForCode } = require('./xena.client');
const { NotFoundError, BusinessRuleError } = require('../../../shared/errors/AppError');
const config = require('../../../config/config');
const { getProviderCredential, hasSecretValue, redactSecretText } = require('../../../shared/utils/secretEncryption');

const XENA_PROVIDER_CODE = 'xena-recharge';

const XENA_DISABLED_ERROR_CODE = 'XENA_RECHARGE_DISABLED';

const isXenaProvider = (provider) => {
    const slug = String(provider?.slug || '').toLowerCase().trim();
    const name = String(provider?.name || '').toLowerCase().trim();
    return slug === XENA_PROVIDER_CODE || name === 'xena recharge';
};

const isXenaRechargeEnabled = () => (
    process.env.XENA_RECHARGE_ENABLED !== undefined
        ? process.env.XENA_RECHARGE_ENABLED === 'true'
        : config.providers?.xenaRecharge?.enabled === true
);

const getGlobalSafetyStatus = () => ({
    enabled: isXenaRechargeEnabled(),
    disabledByEnv: !isXenaRechargeEnabled(),
    gate: 'XENA_RECHARGE_ENABLED',
});

const assertXenaRechargeEnabled = () => {
    if (isXenaRechargeEnabled()) return;
    throw new BusinessRuleError(
        'Xena Recharge is disabled by environment configuration.',
        XENA_DISABLED_ERROR_CODE
    );
};

const getProviderReadinessBlockers = ({ provider, state } = {}) => {
    const blockers = [];
    if (!isXenaRechargeEnabled()) blockers.push(XENA_DISABLED_ERROR_CODE);
    if (!provider?.isActive) blockers.push('XENA_PROVIDER_INACTIVE');
    if (!hasSecretValue(provider?.apiToken) && !hasSecretValue(provider?.apiKey) && !getProviderCredential(provider?.effectiveToken || null)) {
        blockers.push('XENA_PROVIDER_CREDENTIALS_MISSING');
    }
    if (!state?.encryptedConnectionId) blockers.push(XENA_ERROR_CODES.CONNECTION_REQUIRED);
    if (state?.status && state.status !== XENA_CONNECTION_STATUSES.CONNECTED) {
        blockers.push(state.status === XENA_CONNECTION_STATUSES.REAUTHENTICATION_REQUIRED
            ? XENA_ERROR_CODES.REAUTHENTICATION_REQUIRED
            : XENA_ERROR_CODES.CONNECTION_REQUIRED);
    }
    return [...new Set(blockers)];
};

const maskUsername = (username) => {
    const value = String(username || '').trim();
    if (!value) return null;

    const [local, domain] = value.split('@');
    if (domain) {
        const prefix = local.slice(0, Math.min(2, local.length));
        return `${prefix}${local.length > 2 ? '***' : '*'}@${domain}`;
    }

    if (value.length <= 2) return `${value[0] || '*'}*`;
    return `${value.slice(0, 2)}***${value.slice(-1)}`;
};

const toDateOrNull = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

const toIso = (value) => {
    const date = toDateOrNull(value);
    return date ? date.toISOString() : null;
};

const normalizeXenaStatus = (raw, fallback = XENA_CONNECTION_STATUSES.UNKNOWN) => {
    const value = String(raw || '').toLowerCase().trim();

    switch (value) {
        case 'connected':
        case 'verified':
        case 'ready':
        case 'active':
            return XENA_CONNECTION_STATUSES.CONNECTED;
        case 'pending':
            return XENA_CONNECTION_STATUSES.PENDING;
        case 'verification_required':
        case 'otp_required':
        case 'challenge_sent':
        case 'awaiting_verification':
            return XENA_CONNECTION_STATUSES.VERIFICATION_REQUIRED;
        case 'reauthentication_required':
        case 'reauth_required':
        case 'expired':
        case 'disconnected':
            return XENA_CONNECTION_STATUSES.REAUTHENTICATION_REQUIRED;
        case 'disabled':
            return XENA_CONNECTION_STATUSES.DISABLED;
        case 'connection_required':
            return XENA_CONNECTION_STATUSES.CONNECTION_REQUIRED;
        case 'unknown':
            return XENA_CONNECTION_STATUSES.UNKNOWN;
        default:
            return fallback;
    }
};

const extractConnectionId = (data = {}) => (
    data.connectionId
    || data.id
    || data.data?.connectionId
    || data.data?.id
    || null
);

const extractChallengeReference = (data = {}) => (
    data.challengeReference
    || data.challengeRef
    || data.challengeId
    || data.sessionReference
    || data.sessionRef
    || data.sessionId
    || data.temporaryReference
    || data.tempReference
    || data.verificationId
    || data.otpSessionId
    || data.data?.challengeReference
    || data.data?.challengeRef
    || data.data?.challengeId
    || data.data?.sessionReference
    || data.data?.sessionRef
    || data.data?.sessionId
    || data.data?.temporaryReference
    || data.data?.tempReference
    || data.data?.verificationId
    || data.data?.otpSessionId
    || null
);

const extractStatus = (data = {}, fallback) => normalizeXenaStatus(
    data.status
    || data.state
    || data.connectionStatus
    || data.data?.status
    || data.data?.state
    || data.data?.connectionStatus,
    fallback
);

const extractExpiry = (data = {}) => (
    data.expiresAt
    || data.tokenExpiresAt
    || data.data?.expiresAt
    || data.data?.tokenExpiresAt
    || null
);

const normalizeBalance = (payload) => {
    const data = payload?.data !== undefined && payload?.data !== null
        ? payload.data
        : payload;

    let value;
    if (typeof data === 'number' || typeof data === 'string') {
        value = data;
    } else if (data && typeof data === 'object') {
        if (data.balance !== undefined && data.balance !== null) {
            value = data.balance;
        } else if (data.data && typeof data.data === 'object' && data.data.balance !== undefined && data.data.balance !== null) {
            value = data.data.balance;
        }
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        return String(value);
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed || !/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
        return trimmed;
    }

    return null;
};

const extractCurrency = (payload) => (
    payload?.currency
    || payload?.data?.currency
    || payload?.data?.data?.currency
    || null
);

const safeStatusResponse = ({ provider, state, statusOverride, needsReconnectOverride } = {}) => {
    const safety = getGlobalSafetyStatus();
    const readinessBlockers = getProviderReadinessBlockers({ provider, state });
    const status = provider?.isActive === false
        ? XENA_CONNECTION_STATUSES.DISABLED
        : !safety.enabled
            ? XENA_CONNECTION_STATUSES.DISABLED
            : statusOverride || state?.status || XENA_CONNECTION_STATUSES.CONNECTION_REQUIRED;

    const hasConnection = Boolean(state?.encryptedConnectionId);
    const needsReconnect = needsReconnectOverride !== undefined
        ? needsReconnectOverride
        : !hasConnection || [
            XENA_CONNECTION_STATUSES.CONNECTION_REQUIRED,
            XENA_CONNECTION_STATUSES.REAUTHENTICATION_REQUIRED,
            XENA_CONNECTION_STATUSES.UNKNOWN,
        ].includes(status);

    return {
        ...safety,
        status,
        displayName: state?.displayName || null,
        maskedUsername: state?.maskedUsername || null,
        tokenExpiresAt: toIso(state?.tokenExpiresAt),
        lastErrorCode: state?.lastErrorCode || null,
        lastErrorMessage: state?.lastErrorMessage || null,
        lastCheckedAt: toIso(state?.lastCheckedAt),
        readinessBlockers,
        needsReconnect,
    };
};

const sanitizeErrorMessage = (err) => (
    err?.code?.startsWith('XENA_')
        ? safeMessageForCode(err.code)
        : redactSecretText(err?.message || 'Xena integration is currently unavailable.')
);

const loadProvider = async (providerOrId) => {
    const looksLikeProviderDocument = providerOrId
        && typeof providerOrId === 'object'
        && providerOrId.constructor?.modelName === 'Provider';
    const provider = looksLikeProviderDocument
        ? providerOrId
        : await Provider.findById(providerOrId);

    if (!provider) throw new NotFoundError('Provider');
    if (!isXenaProvider(provider)) {
        throw new BusinessRuleError('Provider is not configured for Xena Recharge.', 'INVALID_XENA_PROVIDER');
    }

    return provider;
};

const loadState = (providerId) => (
    XenaConnection.findOne({ provider: providerId }).select('+encryptedConnectionId +encryptedChallengeReference')
);

const getOrCreateState = async (provider) => {
    let state = await loadState(provider._id);
    if (!state) {
        state = new XenaConnection({
            provider: provider._id,
            status: XENA_CONNECTION_STATUSES.CONNECTION_REQUIRED,
        });
    }
    return state;
};

const getConnectionIdOrThrow = (state) => {
    const connectionId = state?.getConnectionId();
    if (!connectionId) {
        throw new BusinessRuleError(
            safeMessageForCode(XENA_ERROR_CODES.CONNECTION_REQUIRED),
            XENA_ERROR_CODES.CONNECTION_REQUIRED
        );
    }
    return connectionId;
};

const getChallengeReferenceOrThrow = (state) => {
    const challengeReference = state?.getChallengeReference();
    if (!challengeReference) {
        throw new BusinessRuleError(
            safeMessageForCode(XENA_ERROR_CODES.CONNECTION_REQUIRED),
            XENA_ERROR_CODES.CONNECTION_REQUIRED
        );
    }
    return challengeReference;
};

const assertVerificationConnectionUsable = (state) => {
    if (state?.status === XENA_CONNECTION_STATUSES.REAUTHENTICATION_REQUIRED) {
        throw new BusinessRuleError(
            safeMessageForCode(XENA_ERROR_CODES.REAUTHENTICATION_REQUIRED),
            XENA_ERROR_CODES.REAUTHENTICATION_REQUIRED
        );
    }

    if (state?.status && state.status !== XENA_CONNECTION_STATUSES.CONNECTED) {
        throw new BusinessRuleError(
            safeMessageForCode(XENA_ERROR_CODES.CONNECTION_REQUIRED),
            XENA_ERROR_CODES.CONNECTION_REQUIRED
        );
    }
};

const buildClient = (provider) => {
    assertXenaRechargeEnabled();
    const apiToken = getProviderCredential(provider.apiToken || provider.apiKey || provider.effectiveToken || null);
    return new XenaClient({
        baseUrl: provider.baseUrl || config.providers?.xenaRecharge?.apiBaseUrl,
        apiToken,
        timeoutMs: config.providers?.xenaRecharge?.timeoutMs,
    });
};

const recordError = async (state, err, { status } = {}) => {
    state.lastErrorCode = err.code || XENA_ERROR_CODES.INTEGRATION_UNAVAILABLE;
    state.lastErrorMessage = sanitizeErrorMessage(err);
    state.lastCheckedAt = new Date();
    if (status) {
        state.status = status;
    }
    await state.save();
};

const safeProviderId = (provider) => (
    provider?._id ? provider._id.toString() : String(provider || '')
);

const logXenaAttempt = (event, { provider, status, errorCode, httpStatus } = {}) => {
    const payload = {
        providerId: safeProviderId(provider),
        status: status || undefined,
        errorCode: errorCode || undefined,
        httpStatus: httpStatus || undefined,
    };

    if (errorCode) {
        console.warn(event, payload);
    } else {
        console.info(event, payload);
    }
};

const pickTargetUserPayload = (payload) => (
    payload?.data && typeof payload.data === 'object'
        ? payload.data
        : payload
);

const normalizeTargetUserResponse = (payload, targetUid) => {
    const userPayload = pickTargetUserPayload(payload);
    if (!userPayload || typeof userPayload !== 'object' || Array.isArray(userPayload)) {
        throw new BusinessRuleError(
            safeMessageForCode(XENA_ERROR_CODES.MALFORMED_RESPONSE),
            XENA_ERROR_CODES.MALFORMED_RESPONSE
        );
    }

    const keys = Object.keys(userPayload);
    if (keys.length === 0) {
        throw new BusinessRuleError(
            safeMessageForCode(XENA_ERROR_CODES.TARGET_INVALID),
            XENA_ERROR_CODES.TARGET_INVALID
        );
    }

    if (userPayload.valid === false) {
        throw new BusinessRuleError(
            safeMessageForCode(XENA_ERROR_CODES.TARGET_INVALID),
            XENA_ERROR_CODES.TARGET_INVALID
        );
    }

    const rawUid = userPayload.uid ?? userPayload.user?.uid ?? null;
    const hasMatchingUid = rawUid !== null && rawUid !== undefined && String(rawUid) === targetUid;
    const isValid = userPayload.valid === true || hasMatchingUid;

    if (!isValid) {
        throw new BusinessRuleError(
            safeMessageForCode(XENA_ERROR_CODES.TARGET_INVALID),
            XENA_ERROR_CODES.TARGET_INVALID
        );
    }

    const profile = userPayload.user && typeof userPayload.user === 'object'
        ? userPayload.user
        : userPayload;

    return {
        valid: true,
        targetUid,
        user: {
            uid: targetUid,
            nickname: profile.nickname ?? profile.name ?? null,
            avatar: profile.avatar ?? null,
            country: profile.country ?? null,
        },
    };
};

const normalizeRechargeStatus = (status) => {
    const value = String(status || '').toLowerCase().trim();

    switch (value) {
        case 'succeeded':
        case 'success':
        case 'completed':
        case 'complete':
            return { xenaStatus: 'succeeded', providerStatus: 'Completed' };
        case 'processing':
        case 'pending':
        case 'queued':
        case 'created':
            return { xenaStatus: 'processing', providerStatus: 'Pending' };
        case 'failed':
        case 'fail':
        case 'rejected':
        case 'cancelled':
        case 'canceled':
            return { xenaStatus: 'failed', providerStatus: 'Cancelled' };
        default:
            return { xenaStatus: 'unknown', providerStatus: 'Unknown' };
    }
};

const pickRechargePayload = (payload) => (
    payload?.data && typeof payload.data === 'object'
        ? payload.data
        : payload
);

const extractRechargeId = (payload = {}) => {
    const candidates = [
        payload?.id,
        payload?.rechargeId,
        payload?.data?.id,
        payload?.data?.rechargeId,
    ];

    for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue;
        const trimmed = candidate.trim();
        if (trimmed) return trimmed;
    }

    return null;
};

const sanitizeXenaPayload = (value) => {
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
        return redactSecretText(value);
    }

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeXenaPayload(item));
    }

    if (typeof value === 'object') {
        const output = {};
        for (const [key, entry] of Object.entries(value)) {
            const normalizedKey = String(key || '').toLowerCase();
            if (
                normalizedKey.includes('authorization')
                || normalizedKey.includes('apikey')
                || normalizedKey.includes('api_key')
                || normalizedKey.includes('api-token')
                || normalizedKey.includes('apitoken')
                || normalizedKey.includes('password')
                || normalizedKey.includes('otp')
                || normalizedKey.includes('secret')
                || normalizedKey.includes('token')
                || normalizedKey.includes('challenge')
                || normalizedKey.includes('session')
                || normalizedKey.includes('verificationid')
                || normalizedKey.includes('otpsession')
                || normalizedKey === 'headers'
                || normalizedKey === 'connectionid'
                || normalizedKey === 'encryptedconnectionid'
                || normalizedKey === 'encryptedchallengereference'
            ) {
                output[key] = '[REDACTED]';
                continue;
            }
            output[key] = sanitizeXenaPayload(entry);
        }
        return output;
    }

    return value;
};

const normalizeRechargeResponse = ({ data, requestId }) => {
    const payload = pickRechargePayload(data);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new BusinessRuleError(
            safeMessageForCode(XENA_ERROR_CODES.MALFORMED_RESPONSE),
            XENA_ERROR_CODES.MALFORMED_RESPONSE
        );
    }

    const providerOrderId = extractRechargeId(data);
    const statusSource = payload.status ?? data?.status ?? data?.data?.status;
    const { xenaStatus, providerStatus } = normalizeRechargeStatus(statusSource);

    return {
        providerOrderId,
        providerRequestId: requestId || data?.requestId || data?.data?.requestId || null,
        providerStatus,
        xenaStatus,
        providerMessage: payload.providerMessage ?? payload.message ?? null,
        providerErrorCode: payload.errorCode ?? payload.code ?? null,
        providerErrorMessage: payload.errorMessage ?? payload.error ?? null,
        rawResponse: sanitizeXenaPayload(data),
    };
};

const assertPositiveSafeInteger = (value, code, message) => {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new BusinessRuleError(message, code);
    }
    return value;
};

const assertNonEmptyString = (value, code, message) => {
    if (typeof value !== 'string' || !value.trim()) {
        throw new BusinessRuleError(message, code);
    }
    return value.trim();
};

const assertRechargeId = (rechargeId) => {
    if (typeof rechargeId !== 'string' || !rechargeId.trim()) {
        throw new BusinessRuleError(
            safeMessageForCode(XENA_ERROR_CODES.RECHARGE_ID_MISSING),
            XENA_ERROR_CODES.RECHARGE_ID_MISSING
        );
    }
    return rechargeId.trim();
};

const challengeConnection = async ({ provider: providerOrId, displayName, username, password }) => {
    assertXenaRechargeEnabled();
    const provider = await loadProvider(providerOrId);
    const state = await getOrCreateState(provider);

    try {
        logXenaAttempt('[xena.connection.challenge.start]', { provider });
        const client = buildClient(provider);
        const result = await client.challengeConnection({
            displayName,
            username,
            password,
        });

        const challengeReference = extractChallengeReference(result.data) || extractConnectionId(result.data);
        if (!challengeReference) {
            throw new BusinessRuleError(
                safeMessageForCode(XENA_ERROR_CODES.MALFORMED_RESPONSE),
                XENA_ERROR_CODES.MALFORMED_RESPONSE
            );
        }

        state.setChallengeReference(challengeReference);
        state.displayName = displayName || state.displayName || null;
        state.maskedUsername = maskUsername(username);
        const upstreamStatus = extractStatus(result.data, XENA_CONNECTION_STATUSES.VERIFICATION_REQUIRED);
        state.status = upstreamStatus === XENA_CONNECTION_STATUSES.CONNECTED
            ? XENA_CONNECTION_STATUSES.VERIFICATION_REQUIRED
            : upstreamStatus;
        state.tokenExpiresAt = toDateOrNull(extractExpiry(result.data));
        state.lastErrorCode = null;
        state.lastErrorMessage = null;
        state.lastCheckedAt = new Date();
        await state.save();
        logXenaAttempt('[xena.connection.challenge.success]', { provider, status: state.status });

        return {
            status: state.status,
            displayName: state.displayName,
            maskedUsername: state.maskedUsername,
            expiresAt: toIso(state.tokenExpiresAt),
            lastCheckedAt: toIso(state.lastCheckedAt),
        };
    } catch (err) {
        await recordError(state, err);
        logXenaAttempt('[xena.connection.challenge.failed]', {
            provider,
            errorCode: err.code || XENA_ERROR_CODES.INTEGRATION_UNAVAILABLE,
            httpStatus: err.httpStatus || null,
        });
        throw err;
    }
};

const reconnectConnection = async ({ provider: providerOrId, displayName, username, password }) => {
    assertXenaRechargeEnabled();
    const provider = await loadProvider(providerOrId);
    const state = await getOrCreateState(provider);
    const oldConnectionId = state.encryptedConnectionId ? state.getConnectionId() : null;

    try {
        logXenaAttempt('[xena.connection.reconnect.start]', { provider });
        const client = buildClient(provider);
        const result = await client.challengeConnection({
            connectionId: oldConnectionId,
            displayName,
            username,
            password,
        });

        const challengeReference = extractChallengeReference(result.data) || extractConnectionId(result.data) || oldConnectionId;
        if (!challengeReference) {
            throw new BusinessRuleError(
                safeMessageForCode(XENA_ERROR_CODES.MALFORMED_RESPONSE),
                XENA_ERROR_CODES.MALFORMED_RESPONSE
            );
        }

        state.setChallengeReference(challengeReference);
        state.displayName = displayName || state.displayName || null;
        state.maskedUsername = maskUsername(username);
        const upstreamStatus = extractStatus(result.data, XENA_CONNECTION_STATUSES.VERIFICATION_REQUIRED);
        state.status = upstreamStatus === XENA_CONNECTION_STATUSES.CONNECTED
            ? XENA_CONNECTION_STATUSES.VERIFICATION_REQUIRED
            : upstreamStatus;
        state.tokenExpiresAt = toDateOrNull(extractExpiry(result.data));
        state.lastErrorCode = null;
        state.lastErrorMessage = null;
        state.lastCheckedAt = new Date();
        await state.save();
        logXenaAttempt('[xena.connection.reconnect.success]', { provider, status: state.status });

        return {
            status: state.status,
            displayName: state.displayName,
            maskedUsername: state.maskedUsername,
            expiresAt: toIso(state.tokenExpiresAt),
            lastCheckedAt: toIso(state.lastCheckedAt),
        };
    } catch (err) {
        await recordError(state, err);
        logXenaAttempt('[xena.connection.reconnect.failed]', {
            provider,
            errorCode: err.code || XENA_ERROR_CODES.INTEGRATION_UNAVAILABLE,
            httpStatus: err.httpStatus || null,
        });
        throw err;
    }
};

const verifyConnection = async ({ provider: providerOrId, code }) => {
    assertXenaRechargeEnabled();
    const provider = await loadProvider(providerOrId);
    const state = await getOrCreateState(provider);
    const challengeReference = getChallengeReferenceOrThrow(state);

    try {
        logXenaAttempt('[xena.connection.verify.start]', { provider });
        const client = buildClient(provider);
        const result = await client.verifyConnection({ challengeReference, code });
        const connectionId = extractConnectionId(result.data) || challengeReference;
        const verifiedStatus = extractStatus(result.data, XENA_CONNECTION_STATUSES.CONNECTED);

        if (verifiedStatus !== XENA_CONNECTION_STATUSES.CONNECTED) {
            throw new BusinessRuleError(
                safeMessageForCode(XENA_ERROR_CODES.MALFORMED_RESPONSE),
                XENA_ERROR_CODES.MALFORMED_RESPONSE
            );
        }

        state.setConnectionId(connectionId);
        state.clearChallengeReference();
        state.status = verifiedStatus;
        state.tokenExpiresAt = toDateOrNull(extractExpiry(result.data)) || state.tokenExpiresAt;
        state.lastErrorCode = null;
        state.lastErrorMessage = null;
        state.lastCheckedAt = new Date();
        await state.save();
        logXenaAttempt('[xena.connection.verify.success]', { provider, status: state.status });

        return {
            status: state.status,
            displayName: state.displayName || null,
            lastCheckedAt: toIso(state.lastCheckedAt),
        };
    } catch (err) {
        const status = err.code === XENA_ERROR_CODES.REAUTHENTICATION_REQUIRED
            ? XENA_CONNECTION_STATUSES.REAUTHENTICATION_REQUIRED
            : undefined;
        await recordError(state, err, { status });
        logXenaAttempt('[xena.connection.verify.failed]', {
            provider,
            errorCode: err.code || XENA_ERROR_CODES.INTEGRATION_UNAVAILABLE,
            httpStatus: err.httpStatus || null,
        });
        throw err;
    }
};

const getConnectionStatus = async ({ provider: providerOrId }) => {
    const provider = await loadProvider(providerOrId);
    const state = await getOrCreateState(provider);

    if (!isXenaRechargeEnabled()) {
        state.status = XENA_CONNECTION_STATUSES.DISABLED;
        state.lastErrorCode = XENA_DISABLED_ERROR_CODE;
        state.lastErrorMessage = 'Xena Recharge is disabled by environment configuration.';
        state.lastCheckedAt = new Date();
        await state.save();
        return safeStatusResponse({ provider, state, statusOverride: XENA_CONNECTION_STATUSES.DISABLED });
    }

    if (!provider.isActive) {
        state.status = XENA_CONNECTION_STATUSES.DISABLED;
        state.lastCheckedAt = new Date();
        await state.save();
        return safeStatusResponse({ provider, state });
    }

    if (!state.encryptedConnectionId) {
        const pendingStatus = [
            XENA_CONNECTION_STATUSES.VERIFICATION_REQUIRED,
            XENA_CONNECTION_STATUSES.PENDING,
        ].includes(state.status)
            ? state.status
            : XENA_CONNECTION_STATUSES.CONNECTION_REQUIRED;
        return safeStatusResponse({ provider, state, statusOverride: pendingStatus });
    }

    try {
        const client = buildClient(provider);
        const result = await client.getConnectionStatus({ connectionId: state.getConnectionId() });

        state.status = extractStatus(result.data, state.status || XENA_CONNECTION_STATUSES.UNKNOWN);
        state.tokenExpiresAt = toDateOrNull(extractExpiry(result.data)) || state.tokenExpiresAt;
        state.lastErrorCode = null;
        state.lastErrorMessage = null;
        state.lastCheckedAt = new Date();
        await state.save();

        return safeStatusResponse({ provider, state });
    } catch (err) {
        const status = err.code === XENA_ERROR_CODES.REAUTHENTICATION_REQUIRED
            ? XENA_CONNECTION_STATUSES.REAUTHENTICATION_REQUIRED
            : XENA_CONNECTION_STATUSES.UNKNOWN;
        await recordError(state, err, { status });
        return safeStatusResponse({ provider, state });
    }
};

const refreshBalance = async ({ provider: providerOrId }) => {
    assertXenaRechargeEnabled();
    const provider = await loadProvider(providerOrId);
    const state = await getOrCreateState(provider);
    assertVerificationConnectionUsable(state);
    const connectionId = getConnectionIdOrThrow(state);

    try {
        const client = buildClient(provider);
        const result = await client.getBalance({ connectionId });
        const balance = normalizeBalance(result.data);

        if (balance === null) {
            throw new BusinessRuleError(
                safeMessageForCode(XENA_ERROR_CODES.MALFORMED_RESPONSE),
                XENA_ERROR_CODES.MALFORMED_RESPONSE
            );
        }

        const checkedAt = new Date();
        state.lastBalance = balance;
        state.lastBalanceCurrency = extractCurrency(result.data);
        state.lastBalanceCheckedAt = checkedAt;
        state.lastBalanceRequestId = result.requestId || null;
        state.lastCheckedAt = checkedAt;
        state.lastErrorCode = null;
        state.lastErrorMessage = null;
        await state.save();

        return {
            balance,
            currency: state.lastBalanceCurrency || null,
            checkedAt: checkedAt.toISOString(),
            source: 'xena_live',
            requestId: result.requestId || null,
        };
    } catch (err) {
        const status = err.code === XENA_ERROR_CODES.REAUTHENTICATION_REQUIRED
            ? XENA_CONNECTION_STATUSES.REAUTHENTICATION_REQUIRED
            : undefined;
        await recordError(state, err, { status });
        throw err;
    }
};

const verifyTargetUser = async ({ provider: providerOrId, targetUid }) => {
    assertXenaRechargeEnabled();
    const provider = await loadProvider(providerOrId);
    const state = await getOrCreateState(provider);
    assertVerificationConnectionUsable(state);
    const connectionId = getConnectionIdOrThrow(state);

    try {
        const client = buildClient(provider);
        const result = await client.verifyTargetUser({ connectionId, targetUid });
        const safeResult = normalizeTargetUserResponse(result.data, targetUid);

        state.lastErrorCode = null;
        state.lastErrorMessage = null;
        state.lastCheckedAt = new Date();
        await state.save();

        return safeResult;
    } catch (err) {
        const status = err.code === XENA_ERROR_CODES.REAUTHENTICATION_REQUIRED
            ? XENA_CONNECTION_STATUSES.REAUTHENTICATION_REQUIRED
            : undefined;
        await recordError(state, err, { status });
        throw err;
    }
};

const createRecharge = async ({
    provider: providerOrId,
    targetUid,
    amount,
    clientReference,
    idempotencyKey,
}) => {
    assertXenaRechargeEnabled();
    const provider = await loadProvider(providerOrId);
    const state = await getOrCreateState(provider);
    assertVerificationConnectionUsable(state);
    const connectionId = getConnectionIdOrThrow(state);
    const normalizedAmount = assertPositiveSafeInteger(
        amount,
        XENA_ERROR_CODES.MALFORMED_RESPONSE,
        'Xena recharge amount must be a positive safe integer.'
    );
    const normalizedReference = assertNonEmptyString(
        clientReference,
        XENA_ERROR_CODES.MALFORMED_RESPONSE,
        'Xena recharge client reference is required.'
    );
    const normalizedIdempotencyKey = assertNonEmptyString(
        idempotencyKey,
        XENA_ERROR_CODES.MALFORMED_RESPONSE,
        'Xena recharge idempotency key is required.'
    );

    try {
        const client = buildClient(provider);
        const result = await client.createRecharge({
            connectionId,
            targetUid,
            amount: normalizedAmount,
            clientReference: normalizedReference,
            idempotencyKey: normalizedIdempotencyKey,
        });
        const safeResult = normalizeRechargeResponse(result);

        state.lastErrorCode = null;
        state.lastErrorMessage = null;
        state.lastCheckedAt = new Date();
        await state.save();

        return safeResult;
    } catch (err) {
        const status = err.code === XENA_ERROR_CODES.REAUTHENTICATION_REQUIRED
            ? XENA_CONNECTION_STATUSES.REAUTHENTICATION_REQUIRED
            : undefined;
        await recordError(state, err, { status });
        throw err;
    }
};

const getRecharge = async ({ provider: providerOrId, rechargeId }) => {
    assertXenaRechargeEnabled();
    const provider = await loadProvider(providerOrId);
    const normalizedRechargeId = assertRechargeId(rechargeId);

    try {
        const client = buildClient(provider);
        const result = await client.getRecharge({ rechargeId: normalizedRechargeId });
        const safeResult = normalizeRechargeResponse(result);

        return safeResult;
    } catch (err) {
        throw err;
    }
};

module.exports = {
    XENA_PROVIDER_CODE,
    XENA_DISABLED_ERROR_CODE,
    XENA_ERROR_CODES,
    assertXenaRechargeEnabled,
    getGlobalSafetyStatus,
    getProviderReadinessBlockers,
    isXenaRechargeEnabled,
    isXenaProvider,
    maskUsername,
    normalizeBalance,
    normalizeTargetUserResponse,
    normalizeRechargeResponse,
    normalizeRechargeStatus,
    extractRechargeId,
    sanitizeXenaPayload,
    challengeConnection,
    reconnectConnection,
    verifyConnection,
    getConnectionStatus,
    refreshBalance,
    verifyTargetUser,
    createRecharge,
    getRecharge,
};
