'use strict';

const { Provider } = require('../provider.model');
const { XenaConnection, XENA_CONNECTION_STATUSES } = require('./xenaConnection.model');
const { XenaClient, XENA_ERROR_CODES, safeMessageForCode } = require('./xena.client');
const { NotFoundError, BusinessRuleError } = require('../../../shared/errors/AppError');
const { getProviderCredential, redactSecretText } = require('../../../shared/utils/secretEncryption');

const XENA_PROVIDER_CODE = 'xena-recharge';

const isXenaProvider = (provider) => {
    const slug = String(provider?.slug || '').toLowerCase().trim();
    const name = String(provider?.name || '').toLowerCase().trim();
    return slug === XENA_PROVIDER_CODE || name === 'xena recharge';
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
    const status = provider?.isActive === false
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
        status,
        displayName: state?.displayName || null,
        maskedUsername: state?.maskedUsername || null,
        tokenExpiresAt: toIso(state?.tokenExpiresAt),
        lastErrorCode: state?.lastErrorCode || null,
        lastErrorMessage: state?.lastErrorMessage || null,
        lastCheckedAt: toIso(state?.lastCheckedAt),
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
    XenaConnection.findOne({ provider: providerId }).select('+encryptedConnectionId')
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

const buildClient = (provider) => {
    const apiToken = getProviderCredential(provider.apiToken || provider.apiKey || provider.effectiveToken || null);
    return new XenaClient({
        baseUrl: provider.baseUrl,
        apiToken,
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

const challengeConnection = async ({ provider: providerOrId, displayName, username, password }) => {
    const provider = await loadProvider(providerOrId);
    const state = await getOrCreateState(provider);
    const oldConnectionId = state.encryptedConnectionId ? state.getConnectionId() : null;

    try {
        const client = buildClient(provider);
        const result = await client.challengeConnection({
            connectionId: oldConnectionId,
            displayName,
            username,
            password,
        });

        const connectionId = extractConnectionId(result.data) || oldConnectionId;
        if (!connectionId) {
            throw new BusinessRuleError(
                safeMessageForCode(XENA_ERROR_CODES.MALFORMED_RESPONSE),
                XENA_ERROR_CODES.MALFORMED_RESPONSE
            );
        }

        state.setConnectionId(connectionId);
        state.displayName = displayName || state.displayName || null;
        state.maskedUsername = maskUsername(username);
        state.status = extractStatus(result.data, XENA_CONNECTION_STATUSES.VERIFICATION_REQUIRED);
        state.tokenExpiresAt = toDateOrNull(extractExpiry(result.data));
        state.lastErrorCode = null;
        state.lastErrorMessage = null;
        state.lastCheckedAt = new Date();
        await state.save();

        return {
            status: state.status,
            displayName: state.displayName,
            maskedUsername: state.maskedUsername,
            expiresAt: toIso(state.tokenExpiresAt),
            lastCheckedAt: toIso(state.lastCheckedAt),
        };
    } catch (err) {
        await recordError(state, err);
        throw err;
    }
};

const reconnectConnection = (args) => challengeConnection(args);

const verifyConnection = async ({ provider: providerOrId, code }) => {
    const provider = await loadProvider(providerOrId);
    const state = await getOrCreateState(provider);
    const connectionId = getConnectionIdOrThrow(state);

    try {
        const client = buildClient(provider);
        const result = await client.verifyConnection({ connectionId, code });

        state.status = extractStatus(result.data, XENA_CONNECTION_STATUSES.CONNECTED);
        state.tokenExpiresAt = toDateOrNull(extractExpiry(result.data)) || state.tokenExpiresAt;
        state.lastErrorCode = null;
        state.lastErrorMessage = null;
        state.lastCheckedAt = new Date();
        await state.save();

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
        throw err;
    }
};

const getConnectionStatus = async ({ provider: providerOrId }) => {
    const provider = await loadProvider(providerOrId);
    const state = await getOrCreateState(provider);

    if (!provider.isActive) {
        state.status = XENA_CONNECTION_STATUSES.DISABLED;
        state.lastCheckedAt = new Date();
        await state.save();
        return safeStatusResponse({ provider, state });
    }

    if (!state.encryptedConnectionId) {
        return safeStatusResponse({ provider, state, statusOverride: XENA_CONNECTION_STATUSES.CONNECTION_REQUIRED });
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
    const provider = await loadProvider(providerOrId);
    const state = await getOrCreateState(provider);
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

module.exports = {
    XENA_PROVIDER_CODE,
    XENA_ERROR_CODES,
    isXenaProvider,
    maskUsername,
    normalizeBalance,
    challengeConnection,
    reconnectConnection,
    verifyConnection,
    getConnectionStatus,
    refreshBalance,
};
