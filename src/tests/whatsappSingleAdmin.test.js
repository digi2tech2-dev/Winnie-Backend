'use strict';

const { EventEmitter } = require('events');
const fs = require('fs/promises');
const path = require('path');

const loadTransport = ({ initialize = jest.fn().mockResolvedValue(), sendMessage = jest.fn().mockResolvedValue({ id: { _serialized: 'message-id' } }), clientFactory = null, qrcodeToDataURL = jest.fn().mockResolvedValue('data:image/png;base64,qr') } = {}) => {
    jest.resetModules();
    const makeClient = () => {
        const next = clientFactory ? clientFactory() : new EventEmitter();
        next.initialize = next.initialize || initialize;
        next.sendMessage = next.sendMessage || sendMessage;
        next.destroy = next.destroy || jest.fn().mockResolvedValue();
        return next;
    };
    const client = makeClient();
    const clients = [client];
    let clientCount = 0;
    jest.doMock('whatsapp-web.js', () => ({ Client: jest.fn(() => {
        if (clientCount++ === 0 || !clientFactory) return client;
        const next = makeClient();
        clients.push(next);
        return next;
    }), LocalAuth: jest.fn() }));
    jest.doMock('qrcode', () => ({ toDataURL: qrcodeToDataURL }));
    const transport = require('../modules/whatsapp/whatsapp.service');
    return { transport, client, clients, sendMessage };
};

describe('single-admin WhatsApp transport', () => {
    const originalEnv = process.env;
    beforeEach(() => {
        process.env = { ...originalEnv, ADMIN_NOTIFICATION_NUMBER: '+20 (10) 123-4567', WHATSAPP_AUTH_DATA_PATH: '.test-wa-auth', WHATSAPP_CACHE_DATA_PATH: '.test-wa-cache' };
    });
    afterEach(async () => {
        process.env = originalEnv;
        jest.dontMock('whatsapp-web.js');
        jest.dontMock('qrcode');
        await Promise.all([
            fs.rm(path.join(__dirname, '..', '..', '.test-wa-auth'), { recursive: true, force: true }),
            fs.rm(path.join(__dirname, '..', '..', '.test-wa-cache'), { recursive: true, force: true }),
        ]);
    });

    it('normalizes the configured admin number and uses exactly one destination', async () => {
        const { transport, client, sendMessage } = loadTransport();
        await transport.initializeWhatsApp();
        client.emit('ready');
        await expect(transport.sendAdminNotification('safe alert')).resolves.toMatchObject({ success: true });
        expect(sendMessage).toHaveBeenCalledWith('20101234567@c.us', 'safe alert');
        expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it('contains missing-recipient and send failures without throwing', async () => {
        let loaded = loadTransport();
        delete process.env.ADMIN_NOTIFICATION_NUMBER;
        await expect(loaded.transport.sendAdminNotification('safe alert')).resolves.toMatchObject({ success: false });

        process.env.ADMIN_NOTIFICATION_NUMBER = '+20101234567';
        loaded = loadTransport({ sendMessage: jest.fn().mockRejectedValue(new Error('transport unavailable')) });
        await loaded.transport.initializeWhatsApp();
        loaded.client.emit('ready');
        await expect(loaded.transport.sendAdminNotification('safe alert')).resolves.toMatchObject({ success: false });
    });

    it('captures initialization failure as status and never crashes startup callers', async () => {
        const { transport } = loadTransport({ initialize: jest.fn().mockRejectedValue(new Error('chromium unavailable')) });
        await expect(transport.initializeWhatsApp()).resolves.toMatchObject({ status: 'ERROR' });
    });

    it('fences reset while an older initialization is still in progress', async () => {
        let resolveFirst;
        let markStarted;
        const firstStarted = new Promise((resolve) => { markStarted = resolve; });
        let count = 0;
        const clientFactory = () => {
            const client = new EventEmitter();
            client.initialize = jest.fn(() => {
                count += 1;
                if (count !== 1) return Promise.resolve();
                markStarted();
                return new Promise((resolve) => { resolveFirst = resolve; });
            });
            client.sendMessage = jest.fn();
            client.destroy = jest.fn().mockResolvedValue();
            return client;
        };
        const { transport, client: oldClient, clients } = loadTransport({ clientFactory });
        void transport.initializeWhatsApp();
        await firstStarted;
        await transport.resetWhatsAppSession();
        const currentClient = clients[1];
        currentClient.emit('ready');
        resolveFirst();
        oldClient.emit('ready');
        oldClient.emit('disconnected', 'stale');
        await new Promise((resolve) => setImmediate(resolve));
        expect(transport.getWhatsAppStatus()).toMatchObject({ status: 'CONNECTED', isConnected: true });
    });

    it('fences reconnect during initialization and stale old-client disconnect events', async () => {
        const clientFactory = () => {
            const client = new EventEmitter();
            client.initialize = jest.fn().mockResolvedValue();
            client.sendMessage = jest.fn();
            client.destroy = jest.fn().mockResolvedValue();
            return client;
        };
        const { transport, client: oldClient, clients } = loadTransport({ clientFactory });
        await transport.initializeWhatsApp();
        oldClient.emit('ready');
        await transport.reconnectWhatsApp();
        const currentClient = clients[1];
        currentClient.emit('ready');
        oldClient.emit('disconnected', 'stale old client');
        expect(transport.getWhatsAppStatus()).toMatchObject({ status: 'CONNECTED', isConnected: true });
    });

    it('ignores a stale QR encoding rejection after a newer client is ready', async () => {
        let rejectOldQr;
        const qrcodeToDataURL = jest.fn(() => new Promise((_resolve, reject) => { rejectOldQr = reject; }));
        const clientFactory = () => {
            const next = new EventEmitter();
            next.initialize = jest.fn().mockResolvedValue();
            next.sendMessage = jest.fn();
            next.destroy = jest.fn().mockResolvedValue();
            return next;
        };
        const { transport, client: oldClient, clients } = loadTransport({ clientFactory, qrcodeToDataURL });
        await transport.initializeWhatsApp();
        oldClient.emit('qr', 'old-client-qr');
        await new Promise((resolve) => setImmediate(resolve));

        await transport.reconnectWhatsApp();
        const currentClient = clients[1];
        currentClient.emit('ready');
        rejectOldQr(new Error('stale QR encoding failed'));
        await new Promise((resolve) => setImmediate(resolve));

        expect(transport.getWhatsAppStatus()).toMatchObject({
            status: 'CONNECTED',
            isConnected: true,
            qrDataUrl: null,
            lastError: null,
        });
    });
});

describe('admin message templates', () => {
    it('contains operational fields without leaking known secret fields', () => {
        const { renderAdminMessage } = require('../modules/whatsapp/adminNotificationTemplates');
        const message = renderAdminMessage('NEW_ORDER', { orderNumber: 'ORD-10', productName: 'Game', quantity: 2, target: 'uid-1', amount: 20, currency: 'USD', provider: 'Xena', apiKey: 'secret-value' });
        expect(message).toContain('ORD-10');
        expect(message).toContain('uid-1');
        expect(message).not.toContain('secret-value');
    });
});
