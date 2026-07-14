'use strict';

const axios = require('axios');
const config = require('../../../config/config');

const trimSlash = (value) => String(value || '').replace(/\/+$/, '');

const getRuntimeConfig = () => ({
    enabled: process.env.OPENWA_ENABLED !== undefined
        ? process.env.OPENWA_ENABLED === 'true'
        : config.openwa.enabled,
    baseUrl: process.env.OPENWA_BASE_URL || config.openwa.baseUrl,
    apiKey: process.env.OPENWA_API_KEY || config.openwa.apiKey,
    sessionId: process.env.OPENWA_SESSION_ID || config.openwa.sessionId,
    sendTimeoutMs: parseInt(process.env.OPENWA_SEND_TIMEOUT_MS || config.openwa.sendTimeoutMs || '15000', 10),
});

const assertConfigured = () => {
    const runtime = getRuntimeConfig();
    if (!runtime.enabled) {
        throw new Error('OpenWA is disabled.');
    }
    if (!runtime.baseUrl) {
        throw new Error('OPENWA_BASE_URL is not configured.');
    }
    if (!runtime.sessionId) {
        throw new Error('OPENWA_SESSION_ID is not configured.');
    }
    return runtime;
};

const buildHeaders = (runtime) => {
    const headers = { 'Content-Type': 'application/json' };
    if (runtime.apiKey) headers['X-API-Key'] = runtime.apiKey;
    return headers;
};

const sendText = async ({ chatId, text }) => {
    const runtime = assertConfigured();
    const response = await axios.post(
        `${trimSlash(runtime.baseUrl)}/sessions/${encodeURIComponent(runtime.sessionId)}/messages/send-text`,
        { chatId, text },
        {
            headers: buildHeaders(runtime),
            timeout: runtime.sendTimeoutMs,
        }
    );

    return {
        providerMessageId: response.data?.id || response.data?.messageId || response.data?.data?.id || null,
        raw: response.data,
    };
};

const getStatus = async () => {
    const runtime = getRuntimeConfig();
    const base = trimSlash(runtime.baseUrl);
    const status = {
        enabled: runtime.enabled,
        provider: 'OPENWA',
        baseUrlConfigured: Boolean(runtime.baseUrl),
        sessionIdConfigured: Boolean(runtime.sessionId),
        sessionId: runtime.sessionId || null,
        canReachOpenWA: false,
        status: 'unknown',
        lastError: null,
    };

    if (!runtime.enabled || !runtime.baseUrl || !runtime.sessionId) {
        status.lastError = !runtime.enabled
            ? 'OpenWA integration is disabled.'
            : 'OpenWA base URL or session id is not configured.';
        return status;
    }

    const candidatePaths = [
        `/sessions/${encodeURIComponent(runtime.sessionId)}/status`,
        `/sessions/${encodeURIComponent(runtime.sessionId)}`,
        '/health',
    ];

    for (const path of candidatePaths) {
        try {
            const response = await axios.get(`${base}${path}`, {
                headers: buildHeaders(runtime),
                timeout: Math.min(runtime.sendTimeoutMs || 15000, 5000),
            });
            status.canReachOpenWA = true;
            status.status = response.data?.status || response.data?.state || response.data?.session?.status || 'reachable';
            status.lastError = null;
            return status;
        } catch (error) {
            status.lastError = error.response?.data?.message || error.message || 'OpenWA status check failed.';
        }
    }

    return status;
};

module.exports = {
    getRuntimeConfig,
    sendText,
    getStatus,
};
