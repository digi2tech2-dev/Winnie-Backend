'use strict';

// Single-recipient WhatsApp transport.  This module deliberately has no
// knowledge of business events or Mongo delivery queues.
const fs = require('fs/promises');
const path = require('path');

let Client = null;
let LocalAuth = null;
let qrcode = null;
let dependencyLoadError = null;

try {
    ({ Client, LocalAuth } = require('whatsapp-web.js'));
    qrcode = require('qrcode');
} catch (error) {
    dependencyLoadError = error;
}

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_AUTH_PATH = path.join(BACKEND_ROOT, '.wwebjs_auth');
const DEFAULT_CACHE_PATH = path.join(BACKEND_ROOT, '.wwebjs_cache');
const DEFAULT_RECONNECT_DELAY_MS = 10000;

let client = null;
let initializing = false;
let clientGeneration = 0;
let reconnectTimer = null;
let allowReconnect = true;
const state = {
    status: 'DISCONNECTED',
    qrDataUrl: null,
    lastError: null,
    connectedAt: null,
};

const safeError = (error) => String(error?.message || error || 'Unknown WhatsApp error').slice(0, 300);
const dependenciesAvailable = () => Boolean(Client && LocalAuth && qrcode);
const digitsOnly = (value) => String(value || '').replace(/\D/g, '');
const getAdminChatId = () => {
    const digits = digitsOnly(process.env.ADMIN_NOTIFICATION_NUMBER);
    return digits ? `${digits}@c.us` : null;
};
const maskAdminNumber = () => {
    const digits = digitsOnly(process.env.ADMIN_NOTIFICATION_NUMBER);
    if (!digits) return null;
    return `+${digits.slice(0, Math.min(2, digits.length))} ******${digits.slice(-4)}`;
};
const resolveRuntimePath = (configured, fallback) => {
    const candidate = String(configured || '').trim() || fallback;
    const resolved = path.resolve(BACKEND_ROOT, candidate);
    const relative = path.relative(BACKEND_ROOT, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('WhatsApp runtime path must be a child of the backend directory.');
    }
    return resolved;
};
const getPaths = () => ({
    auth: resolveRuntimePath(process.env.WHATSAPP_AUTH_DATA_PATH, DEFAULT_AUTH_PATH),
    cache: resolveRuntimePath(process.env.WHATSAPP_CACHE_DATA_PATH, DEFAULT_CACHE_PATH),
});
const reconnectDelay = () => {
    const value = Number(process.env.WHATSAPP_RECONNECT_DELAY_MS);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_RECONNECT_DELAY_MS;
};
const getWhatsAppStatus = () => ({
    status: initializing ? 'INITIALIZING' : state.status,
    isConnected: state.status === 'CONNECTED',
    isInitializing: initializing,
    qrDataUrl: state.status === 'QR_REQUIRED' ? state.qrDataUrl : null,
    hasQrCode: Boolean(state.status === 'QR_REQUIRED' && state.qrDataUrl),
    adminRecipientMasked: maskAdminNumber(),
    adminNumberConfigured: Boolean(getAdminChatId()),
    dependencyAvailable: dependenciesAvailable(),
    lastError: state.lastError,
    connectedAt: state.connectedAt,
});
const clearReconnect = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
};
const scheduleReconnect = () => {
    if (!allowReconnect || reconnectTimer || initializing) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void initializeWhatsApp().catch(() => {});
    }, reconnectDelay());
    reconnectTimer.unref?.();
};
const bindEvents = (nextClient, generation) => {
    const isCurrent = () => client === nextClient && clientGeneration === generation;
    nextClient.on('qr', async (qr) => {
        try {
            const qrDataUrl = await qrcode.toDataURL(qr);
            if (!isCurrent()) return;
            state.qrDataUrl = qrDataUrl;
            state.status = 'QR_REQUIRED';
            state.lastError = null;
        } catch (error) {
            if (!isCurrent()) return;
            state.status = 'ERROR';
            state.lastError = safeError(error);
        }
    });
    nextClient.on('authenticated', () => { if (isCurrent()) { state.status = 'AUTHENTICATED'; state.qrDataUrl = null; state.lastError = null; } });
    nextClient.on('ready', () => { if (isCurrent()) { state.status = 'CONNECTED'; state.qrDataUrl = null; state.lastError = null; state.connectedAt = new Date().toISOString(); } });
    nextClient.on('auth_failure', (message) => { if (isCurrent()) { state.status = 'ERROR'; state.qrDataUrl = null; state.lastError = safeError(message || 'Authentication failed'); } });
    nextClient.on('disconnected', (reason) => {
        if (!isCurrent()) return;
        client = null;
        state.status = 'DISCONNECTED';
        state.qrDataUrl = null;
        state.lastError = reason ? safeError(reason) : null;
        scheduleReconnect();
    });
};
const destroyClient = async () => {
    // Fence any in-flight initialization and handlers before destroying.
    clientGeneration += 1;
    initializing = false;
    const existing = client;
    client = null;
    if (existing) {
        try { await existing.destroy(); } catch (error) { console.warn('[WhatsApp] Client cleanup failed:', safeError(error)); }
    }
    state.qrDataUrl = null;
    state.status = 'DISCONNECTED';
};
const initializeWhatsApp = async () => {
    if (initializing || client) return getWhatsAppStatus();
    if (!dependenciesAvailable()) {
        state.status = 'ERROR';
        state.lastError = 'WhatsApp dependency unavailable.';
        return getWhatsAppStatus();
    }
    initializing = true;
    const generation = ++clientGeneration;
    state.status = 'INITIALIZING';
    state.lastError = null;
    try {
        const paths = getPaths();
        await Promise.all([fs.mkdir(paths.auth, { recursive: true }), fs.mkdir(paths.cache, { recursive: true })]);
        if (generation !== clientGeneration) return getWhatsAppStatus();
        const nextClient = new Client({
            authStrategy: new LocalAuth({ clientId: String(process.env.WHATSAPP_CLIENT_ID || 'winnie-admin').trim() || 'winnie-admin', dataPath: paths.auth }),
            puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] },
            webVersionCache: { type: 'local', path: paths.cache },
        });
        if (generation !== clientGeneration) {
            await nextClient.destroy?.().catch(() => {});
            return getWhatsAppStatus();
        }
        client = nextClient;
        bindEvents(nextClient, generation);
        await nextClient.initialize();
    } catch (error) {
        if (generation === clientGeneration) {
            client = null;
            state.status = 'ERROR';
            state.lastError = safeError(error);
            console.warn('[WhatsApp] Initialization failed:', state.lastError);
        }
    } finally {
        if (generation === clientGeneration) initializing = false;
    }
    return getWhatsAppStatus();
};
const reconnectWhatsApp = async () => {
    clearReconnect();
    await destroyClient();
    allowReconnect = true;
    return initializeWhatsApp();
};
const resetWhatsAppSession = async () => {
    const paths = getPaths(); // validate before stopping an active client
    clearReconnect();
    allowReconnect = false;
    await destroyClient();
    for (const target of [paths.auth, paths.cache]) {
        const relative = path.relative(BACKEND_ROOT, target);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe WhatsApp session path.');
        await fs.rm(target, { recursive: true, force: true });
    }
    allowReconnect = true;
    return initializeWhatsApp();
};
const sendAdminNotification = async (message, metadata = {}) => {
    try {
        const chatId = getAdminChatId();
        const text = String(message || '').trim();
        if (!chatId) throw new Error('ADMIN_NOTIFICATION_NUMBER is not configured.');
        if (!text) throw new Error('WhatsApp notification is empty.');
        if (!client || state.status !== 'CONNECTED') throw new Error('WhatsApp client is not connected.');
        const result = await client.sendMessage(chatId, text);
        return { success: true, messageId: result?.id?._serialized || null };
    } catch (error) {
        // Metadata must stay compact and non-sensitive; business callers never await this result.
        console.warn('[WhatsApp] Admin notification failed:', safeError(error), metadata?.eventType ? `event=${metadata.eventType}` : '');
        return { success: false, error: safeError(error) };
    }
};

module.exports = { initializeWhatsApp, sendAdminNotification, getWhatsAppStatus, reconnectWhatsApp, resetWhatsAppSession, destroyClient, getAdminChatId };
