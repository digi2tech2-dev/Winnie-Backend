'use strict';

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const app = require('../app');
const config = require('../config/config');
const Group = require('../modules/groups/group.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createAdmin,
    createCustomer,
    createCustomerWithGroup,
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

const tokenFor = (user) => jwt.sign(
    { id: user._id, role: user.role },
    config.jwt.secret,
    { expiresIn: '1h' }
);

const fakeGroupId = () => new mongoose.Types.ObjectId();

const requestJson = async (path, {
    body,
    method = body ? 'POST' : 'GET',
    token,
} = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json();
    return { payload, response };
};

const createAdminWithoutGroupDocument = () => createAdmin({ groupId: fakeGroupId() });

describe('Admin groups API', () => {
    it('allows an admin to list groups', async () => {
        const group = await createGroup({ name: 'Default', percentage: 0 });
        const admin = await createAdmin({ groupId: group._id });

        const { payload, response } = await requestJson('/admin/groups', { token: tokenFor(admin) });

        expect(response.status).toBe(200);
        expect(payload.success).toBe(true);
        expect(payload.data.items).toHaveLength(1);
        expect(payload.data.items[0].name).toBe('Default');
    });

    it('rejects non-admin users from listing groups', async () => {
        const { customer } = await createCustomerWithGroup();

        const { payload, response } = await requestJson('/admin/groups', { token: tokenFor(customer) });

        expect(response.status).toBe(403);
        expect(payload.code).toBe('AUTHORIZATION_ERROR');
    });

    it('returns real DB groups only and no mock groups', async () => {
        const group = await createGroup({ name: 'Default', percentage: 0 });
        const admin = await createAdmin({ groupId: group._id });

        const { payload } = await requestJson('/admin/groups', { token: tokenFor(admin) });
        const names = payload.data.items.map((item) => item.name);

        expect(names).toEqual(['Default']);
        expect(names).not.toContain('VIP عملاء');
        expect(names).not.toContain('الوكلاء');
        expect(names).not.toContain('العملاء الأفراد');
        expect(names).not.toContain('مجموعة جديدة');
    });

    it('includes data.items and data.summary', async () => {
        const group = await createGroup({ name: 'Default', percentage: 0 });
        const admin = await createAdmin({ groupId: group._id });

        const { payload } = await requestJson('/admin/groups', { token: tokenFor(admin) });

        expect(Array.isArray(payload.data.items)).toBe(true);
        expect(payload.data.summary).toMatchObject({
            totalGroups: 1,
            activeGroups: 1,
            groupsWithMembers: 0,
            groupsWithoutMembers: 1,
            totalMembers: 0,
        });
    });

    it('calculates membersCount from real customer users only', async () => {
        const group = await createGroup({ name: 'Default', percentage: 0 });
        const admin = await createAdmin({ groupId: group._id });
        await createCustomer({ groupId: group._id });
        await createCustomer({ groupId: group._id });

        const { payload } = await requestJson('/admin/groups', { token: tokenFor(admin) });

        expect(payload.data.items[0]).toMatchObject({
            name: 'Default',
            membersCount: 2,
        });
    });

    it('returns correct summary totals', async () => {
        const withMembers = await createGroup({ name: 'Default', percentage: 0 });
        const withoutMembers = await createGroup({ name: 'Merchants', percentage: 1, isActive: true });
        const inactiveWithMembers = await createGroup({ name: 'Dormant', percentage: 2, isActive: false });
        const admin = await createAdmin({ groupId: withMembers._id });
        await createCustomer({ groupId: withMembers._id });
        await createCustomer({ groupId: withMembers._id });
        await createCustomer({ groupId: inactiveWithMembers._id });

        const { payload } = await requestJson('/admin/groups', { token: tokenFor(admin) });

        expect(payload.data.items.map((item) => item.name).sort()).toEqual(['Default', 'Dormant', 'Merchants']);
        expect(payload.data.items.find((item) => item.name === withoutMembers.name).membersCount).toBe(0);
        expect(payload.data.summary).toMatchObject({
            totalGroups: 3,
            activeGroups: 2,
            groupsWithMembers: 2,
            groupsWithoutMembers: 1,
            totalMembers: 3,
        });
    });

    it('creates a group with name, percentage, and isActive', async () => {
        const admin = await createAdminWithoutGroupDocument();

        const { payload, response } = await requestJson('/admin/groups', {
            body: { name: 'Merchants', percentage: 1.5, isActive: false },
            token: tokenFor(admin),
        });

        expect(response.status).toBe(201);
        expect(payload.data.group).toMatchObject({
            name: 'Merchants',
            percentage: 1.5,
            isActive: false,
        });

        const saved = await Group.findById(payload.data.group._id);
        expect(saved).not.toBeNull();
        expect(saved.deletedAt).toBeNull();
    });

    it('edits group percentage and isActive', async () => {
        const group = await createGroup({ name: 'Merchants', percentage: 1, isActive: true });
        const admin = await createAdmin({ groupId: group._id });

        const { payload, response } = await requestJson(`/admin/groups/${group._id}`, {
            body: { percentage: 2, isActive: false },
            method: 'PATCH',
            token: tokenFor(admin),
        });

        expect(response.status).toBe(200);
        expect(payload.data.group).toMatchObject({
            name: 'Merchants',
            percentage: 2,
            isActive: false,
        });

        const saved = await Group.findById(group._id);
        expect(saved.percentage).toBe(2);
        expect(saved.isActive).toBe(false);
    });

    it('soft-deletes a group with no members', async () => {
        const group = await createGroup({ name: 'Empty', percentage: 0 });
        const admin = await createAdminWithoutGroupDocument();

        const { payload, response } = await requestJson(`/admin/groups/${group._id}`, {
            method: 'DELETE',
            token: tokenFor(admin),
        });

        expect(response.status).toBe(200);
        expect(payload.data.group.deletedAt).toBeTruthy();

        const deleted = await Group.findById(group._id);
        expect(deleted.deletedAt).not.toBeNull();
        expect(deleted.isActive).toBe(false);
    });

    it('does not delete a group with assigned users', async () => {
        const { customer, group } = await createCustomerWithGroup({}, { name: 'Default', percentage: 0 });
        const admin = await createAdmin({ groupId: group._id });

        const { payload, response } = await requestJson(`/admin/groups/${group._id}`, {
            method: 'DELETE',
            token: tokenFor(admin),
        });

        expect(customer.groupId.toString()).toBe(group._id.toString());
        expect(response.status).toBe(400);
        expect(payload.code).toBe('GROUP_HAS_MEMBERS');
        expect(payload.message).toContain('Cannot delete a group that has members');

        const saved = await Group.findById(group._id);
        expect(saved.deletedAt).toBeNull();
        expect(saved.isActive).toBe(true);
    });

    it('returns empty items from an empty groups collection', async () => {
        const admin = await createAdminWithoutGroupDocument();

        const { payload, response } = await requestJson('/admin/groups', { token: tokenFor(admin) });

        expect(response.status).toBe(200);
        expect(payload.data.items).toEqual([]);
        expect(payload.data.summary).toMatchObject({
            totalGroups: 0,
            activeGroups: 0,
            groupsWithMembers: 0,
            groupsWithoutMembers: 0,
            totalMembers: 0,
        });
    });
});
