'use strict';

jest.mock('axios', () => ({
    post: jest.fn(),
    get: jest.fn(),
}));

const crypto = require('crypto');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const app = require('../app');
const config = require('../config/config');
const whatsappService = require('../modules/notifications/whatsapp/whatsappNotification.service');
const { WhatsAppNotificationLog } = require('../modules/notifications/whatsapp/whatsappNotificationLog.model');
const { AdminWhatsAppRecipient } = require('../modules/notifications/whatsapp/adminWhatsAppRecipient.model');
const { normalizePhoneNumber } = require('../modules/notifications/whatsapp/phoneNormalizer');
const { User } = require('../modules/users/user.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createAdmin,
    createCustomer,
    createGroup,
} = require('./testHelpers');

let server;
let baseUrl;

beforeAll(async () => {
    await connectTestDB();
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

afterAll(async () => {
    await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
    await disconnectTestDB();
});

beforeEach(async () => {
    process.env.OPENWA_ENABLED = 'true';
    process.env.OPENWA_BASE_URL = 'http://openwa.test/api';
    process.env.OPENWA_API_KEY = 'test-openwa-key';
    process.env.OPENWA_SESSION_ID = 'session-a';
    process.env.OPENWA_DEFAULT_COUNTRY_CODE = '20';
    process.env.OPENWA_MAX_RETRIES = '3';
    process.env.OPENWA_RETRY_DELAY_SECONDS = '1';
    axios.post.mockReset();
    axios.get.mockReset();
    axios.post.mockResolvedValue({ data: { id: 'provider-message-1' } });
    axios.get.mockResolvedValue({ data: { status: 'CONNECTED' } });
    jest.restoreAllMocks();
    await clearCollections();
});

afterEach(() => {
    delete process.env.OPENWA_ENABLED;
    delete process.env.OPENWA_BASE_URL;
    delete process.env.OPENWA_API_KEY;
    delete process.env.OPENWA_SESSION_ID;
    delete process.env.OPENWA_DEFAULT_COUNTRY_CODE;
    delete process.env.OPENWA_MAX_RETRIES;
    delete process.env.OPENWA_RETRY_DELAY_SECONDS;
});

const tokenFor = (user) => jwt.sign({ id: user._id, role: user.role }, config.jwt.secret, { expiresIn: '1h' });

const setup = async () => {
    const group = await createGroup({ name: `WhatsApp-${Date.now()}-${Math.random()}` });
    const admin = await createAdmin({ groupId: group._id });
    const customer = await createCustomer({ groupId: group._id });
    return { group, admin, customer };
};

const requestJson = async (path, { token, method = 'GET', body } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { response, payload: await response.json() };
};

describe('WhatsApp notifications', () => {
    it('normalizes supported phone formats for OpenWA chat ids', () => {
        expect(normalizePhoneNumber('01012345678').chatId).toBe('201012345678@c.us');
        expect(normalizePhoneNumber('+201012345678').phone).toBe('201012345678');
        expect(normalizePhoneNumber('971501234567').chatId).toBe('971501234567@c.us');
        expect(() => normalizePhoneNumber('abc')).toThrow('invalid characters');
    });

    it('customer can save settings and changing phone resets verification', async () => {
        const { customer } = await setup();
        await User.findByIdAndUpdate(customer._id, {
            $set: {
                'whatsappNotifications.enabled': true,
                'whatsappNotifications.phone': '201011111111',
                'whatsappNotifications.phoneVerified': true,
                'whatsappNotifications.verifiedAt': new Date(),
            },
        });

        const { response, payload } = await requestJson('/me/whatsapp-notifications', {
            method: 'PATCH',
            token: tokenFor(customer),
            body: {
                enabled: true,
                phone: '+201022222222',
                eventPreferences: { orderCompleted: false },
            },
        });

        expect(response.status).toBe(200);
        expect(payload.data.settings.phone).toBe('201022222222');
        expect(payload.data.settings.phoneVerified).toBe(false);
        expect(payload.data.settings.eventPreferences.orderCompleted).toBe(false);
        expect(payload.data.settings.verificationCodeHash).toBeUndefined();
    });

    it('rejects invalid and unauthenticated customer settings requests', async () => {
        const { customer } = await setup();
        const invalid = await requestJson('/me/whatsapp-notifications', {
            method: 'PATCH',
            token: tokenFor(customer),
            body: { phone: 'bad-phone' },
        });
        const unauthenticated = await requestJson('/me/whatsapp-notifications');

        expect(invalid.response.status).toBe(400);
        expect(unauthenticated.response.status).toBe(401);
    });

    it('queues OTP without exposing it and verifies the hashed code', async () => {
        const originalRandomInt = crypto.randomInt;
        jest.spyOn(crypto, 'randomInt').mockImplementation((min, max) => (
            min === 100000 && max === 1000000 ? 123456 : originalRandomInt(min, max)
        ));
        const { customer } = await setup();

        const sent = await requestJson('/me/whatsapp-notifications/send-code', {
            method: 'POST',
            token: tokenFor(customer),
            body: { phone: '+201011111111' },
        });
        const fresh = await User.findById(customer._id).select('whatsappNotifications');

        expect(sent.response.status).toBe(200);
        expect(JSON.stringify(sent.payload)).not.toContain('123456');
        expect(fresh.whatsappNotifications.verificationCodeHash).toBeTruthy();
        expect(fresh.whatsappNotifications.verificationCodeHash).not.toBe('123456');
        expect(fresh.whatsappNotifications.verificationCodeExpiresAt).toBeInstanceOf(Date);

        const wrong = await requestJson('/me/whatsapp-notifications/verify', {
            method: 'POST',
            token: tokenFor(customer),
            body: { code: '111111' },
        });
        expect(wrong.response.status).toBe(422);

        const verified = await requestJson('/me/whatsapp-notifications/verify', {
            method: 'POST',
            token: tokenFor(customer),
            body: { code: '123456' },
        });
        expect(verified.response.status).toBe(200);
        expect(verified.payload.data.settings.enabled).toBe(true);
        expect(verified.payload.data.settings.phoneVerified).toBe(true);
    });

    it('eligibility skips disabled/unverified customers and queues verified customers', async () => {
        const { customer } = await setup();

        await whatsappService.queueCustomerEvent({
            userId: customer._id,
            eventType: 'wallet_topup_completed',
            relatedEntityType: 'payment',
            relatedEntityId: new mongoose.Types.ObjectId(),
            payload: { amount: 100, currency: 'EGP', gateway: 'Ziina' },
        });
        expect(await WhatsAppNotificationLog.countDocuments({ status: 'skipped', reason: 'CUSTOMER_DISABLED' })).toBe(0);

        await User.findByIdAndUpdate(customer._id, {
            $set: {
                'whatsappNotifications.enabled': true,
                'whatsappNotifications.phone': '201011111111',
                'whatsappNotifications.phoneVerified': false,
            },
        });
        await whatsappService.queueCustomerEvent({
            userId: customer._id,
            eventType: 'wallet_topup_completed',
            relatedEntityType: 'payment',
            relatedEntityId: new mongoose.Types.ObjectId(),
            payload: { amount: 100, currency: 'EGP', gateway: 'Ziina' },
        });
        expect(await WhatsAppNotificationLog.countDocuments({ status: 'skipped', reason: 'PHONE_NOT_VERIFIED' })).toBe(1);

        await User.findByIdAndUpdate(customer._id, {
            $set: { 'whatsappNotifications.phoneVerified': true },
        });
        await whatsappService.queueCustomerEvent({
            userId: customer._id,
            eventType: 'wallet_topup_completed',
            relatedEntityType: 'payment',
            relatedEntityId: new mongoose.Types.ObjectId(),
            payload: { amount: 100, currency: 'EGP', gateway: 'Ziina' },
        });
        expect(await WhatsAppNotificationLog.countDocuments({ status: 'pending' })).toBe(1);
    });

    it('sends pending messages through OpenWA with API key and marks failures retryable', async () => {
        const log = await whatsappService.queueWhatsAppNotification({
            recipientType: 'customer',
            phone: '+201011111111',
            eventType: 'test_message',
            payload: { message: 'hello' },
        });

        await whatsappService.processPendingMessages({ limit: 1 });
        const sent = await WhatsAppNotificationLog.findById(log._id);

        expect(axios.post).toHaveBeenCalledWith(
            'http://openwa.test/api/sessions/session-a/messages/send-text',
            { chatId: '201011111111@c.us', text: expect.any(String) },
            expect.objectContaining({
                headers: expect.objectContaining({ 'X-API-Key': 'test-openwa-key' }),
            })
        );
        expect(sent.status).toBe('sent');

        axios.post.mockRejectedValueOnce(new Error('timeout'));
        const failedLog = await whatsappService.queueWhatsAppNotification({
            recipientType: 'admin',
            phone: '+201022222222',
            eventType: 'test_message',
            payload: { message: 'fail me' },
        });
        await whatsappService.processPendingMessages({ limit: 1 });
        const failed = await WhatsAppNotificationLog.findById(failedLog._id);
        expect(failed.status).toBe('failed');
        expect(failed.retryCount).toBe(1);
        expect(failed.nextRetryAt).toBeInstanceOf(Date);
    });

    it('admin can CRUD recipients, send tests, list logs, and retry failed logs', async () => {
        const { admin, customer } = await setup();
        const adminToken = tokenFor(admin);
        const customerToken = tokenFor(customer);

        const blocked = await requestJson('/admin/whatsapp/recipients', { token: customerToken });
        expect(blocked.response.status).toBe(403);

        const created = await requestJson('/admin/whatsapp/recipients', {
            method: 'POST',
            token: adminToken,
            body: { name: 'Ops', phone: '+201011111111', enabled: true },
        });
        expect(created.response.status).toBe(201);
        expect(await AdminWhatsAppRecipient.countDocuments()).toBe(1);

        const id = created.payload.data.recipient.id;
        const updated = await requestJson(`/admin/whatsapp/recipients/${id}`, {
            method: 'PATCH',
            token: adminToken,
            body: { enabled: false },
        });
        expect(updated.response.status).toBe(200);
        expect(updated.payload.data.recipient.enabled).toBe(false);

        await requestJson(`/admin/whatsapp/recipients/${id}`, {
            method: 'PATCH',
            token: adminToken,
            body: { enabled: true },
        });
        const test = await requestJson(`/admin/whatsapp/recipients/${id}/test`, {
            method: 'POST',
            token: adminToken,
        });
        expect(test.response.status).toBe(200);

        const failed = await WhatsAppNotificationLog.create({
            recipientType: 'admin',
            adminRecipientId: id,
            phone: '201011111111',
            chatId: '201011111111@c.us',
            eventType: 'test_message',
            title: 'Failed',
            message: 'Failed',
            status: 'failed',
            retryCount: 3,
            maxRetries: 3,
        });
        const retry = await requestJson(`/admin/whatsapp/retry/${failed._id}`, {
            method: 'POST',
            token: adminToken,
        });
        const logs = await requestJson('/admin/whatsapp/logs', { token: adminToken });

        expect(retry.response.status).toBe(200);
        expect(logs.response.status).toBe(200);
        expect(logs.payload.data.length).toBeGreaterThan(0);
    });
});
