'use strict';

const jwt = require('jsonwebtoken');
const app = require('../app');
const config = require('../config/config');
const notificationService = require('../modules/notifications/notification.service');
const {
    Notification,
    NOTIFICATION_TYPES,
    NOTIFICATION_PRIORITIES,
} = require('../modules/notifications/notification.model');
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
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}/api`;
});

afterAll(async () => {
    await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

const tokenFor = (user) => jwt.sign({ id: user._id, role: user.role }, config.jwt.secret, { expiresIn: '1h' });

const setup = async () => {
    const group = await createGroup({ name: `Notifications-${Date.now()}` });
    const admin = await createAdmin({ groupId: group._id });
    const customer = await createCustomer({ groupId: group._id });
    return { admin, customer, group };
};

const createNotificationFor = (user, overrides = {}) => notificationService.createNotification({
    userId: user._id,
    title: 'Test notification',
    message: 'A test notification message',
    type: NOTIFICATION_TYPES.ADMIN,
    priority: NOTIFICATION_PRIORITIES.NORMAL,
    ...overrides,
});

describe('notifications API', () => {
    it('admin can fetch their notifications', async () => {
        const { admin } = await setup();
        await createNotificationFor(admin, { title: 'Admin alert' });

        const response = await fetch(`${baseUrl}/me/notifications`, {
            headers: { authorization: `Bearer ${tokenFor(admin)}` },
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.notifications).toHaveLength(1);
        expect(body.data.notifications[0].title).toBe('Admin alert');
    });

    it('admin unread count returns the correct count', async () => {
        const { admin } = await setup();
        await createNotificationFor(admin, { title: 'Unread admin one' });
        const readNotification = await createNotificationFor(admin, { title: 'Read admin one' });
        await Notification.updateOne(
            { _id: readNotification._id },
            { $set: { isRead: true, readAt: new Date() } }
        );

        const response = await fetch(`${baseUrl}/me/notifications/unread-count`, {
            headers: { authorization: `Bearer ${tokenFor(admin)}` },
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.unreadCount).toBe(1);
    });

    it('admin can mark a notification read', async () => {
        const { admin } = await setup();
        const notification = await createNotificationFor(admin, { title: 'Read me' });

        const response = await fetch(`${baseUrl}/me/notifications/${notification._id}/read`, {
            method: 'PATCH',
            headers: { authorization: `Bearer ${tokenFor(admin)}` },
        });
        const body = await response.json();
        const updated = await Notification.findById(notification._id);

        expect(response.status).toBe(200);
        expect(body.data.isRead).toBe(true);
        expect(updated.isRead).toBe(true);
        expect(updated.readAt).toBeInstanceOf(Date);
    });

    it('customer notifications still load and mark read', async () => {
        const { customer } = await setup();
        const notification = await createNotificationFor(customer, {
            title: 'Customer wallet update',
            type: NOTIFICATION_TYPES.WALLET,
        });

        const listResponse = await fetch(`${baseUrl}/me/notifications`, {
            headers: { authorization: `Bearer ${tokenFor(customer)}` },
        });
        const listBody = await listResponse.json();

        const readResponse = await fetch(`${baseUrl}/me/notifications/${notification._id}/read`, {
            method: 'PATCH',
            headers: { authorization: `Bearer ${tokenFor(customer)}` },
        });
        const readBody = await readResponse.json();

        expect(listResponse.status).toBe(200);
        expect(listBody.data.notifications).toHaveLength(1);
        expect(readResponse.status).toBe(200);
        expect(readBody.data.isRead).toBe(true);
    });

    it('users cannot mark another user notification read', async () => {
        const { admin, customer } = await setup();
        const adminNotification = await createNotificationFor(admin, { title: 'Private admin alert' });

        const response = await fetch(`${baseUrl}/me/notifications/${adminNotification._id}/read`, {
            method: 'PATCH',
            headers: { authorization: `Bearer ${tokenFor(customer)}` },
        });

        expect(response.status).toBe(404);
    });
});
