'use strict';

const jwt = require('jsonwebtoken');
const app = require('../app');
const config = require('../config/config');
const { User, ROLES, USER_STATUS } = require('../modules/users/user.model');
const { AuditLog } = require('../modules/audit/audit.model');
const { ADMIN_ACTIONS, ORDER_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../modules/audit/audit.constants');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createAdmin,
    createCustomer,
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

const createSupervisor = (overrides = {}) => User.create({
    name: 'Test Supervisor',
    email: `supervisor-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`,
    password: 'SupervisorPass1',
    role: ROLES.SUPERVISOR,
    status: USER_STATUS.ACTIVE,
    verified: true,
    permissions: ['orders.view'],
    ...overrides,
});

describe('Admin supervisors API', () => {
    it('returns normal active users as eligible supervisor users', async () => {
        const admin = await createAdmin();
        const customer = await createCustomer({ name: 'Eligible User' });

        const { payload, response } = await requestJson('/admin/supervisors/eligible-users', {
            token: tokenFor(admin),
        });

        expect(response.status).toBe(200);
        expect(payload.data.items).toHaveLength(1);
        expect(payload.data.items[0]).toMatchObject({
            id: customer._id.toString(),
            name: 'Eligible User',
            role: ROLES.CUSTOMER,
            status: USER_STATUS.ACTIVE,
        });
    });

    it('excludes supervisors, admins, deleted users, and blocked users from eligible users', async () => {
        const admin = await createAdmin();
        const eligible = await createCustomer({ name: 'Only Eligible' });
        await createSupervisor({ name: 'Already Supervisor' });
        await createAdmin({ name: 'Other Admin' });
        await createCustomer({ name: 'Deleted User', deletedAt: new Date() });
        await createCustomer({ name: 'Blocked User', blockedAt: new Date() });

        const { payload } = await requestJson('/admin/supervisors/eligible-users', {
            token: tokenFor(admin),
        });

        expect(payload.data.items.map((item) => item.id)).toEqual([eligible._id.toString()]);
    });

    it('searches eligible users by name', async () => {
        const admin = await createAdmin();
        const target = await createCustomer({ name: 'Needle Name', email: 'needle-name@test.com' });
        await createCustomer({ name: 'Other Person', email: 'other-person@test.com' });

        const { payload } = await requestJson('/admin/supervisors/eligible-users?search=Needle', {
            token: tokenFor(admin),
        });

        expect(payload.data.items).toHaveLength(1);
        expect(payload.data.items[0].id).toBe(target._id.toString());
    });

    it('searches eligible users by email', async () => {
        const admin = await createAdmin();
        const target = await createCustomer({ name: 'Email Match', email: 'mail-match@test.com' });
        await createCustomer({ name: 'Other Person', email: 'other-person@test.com' });

        const { payload } = await requestJson('/admin/supervisors/eligible-users?search=mail-match', {
            token: tokenFor(admin),
        });

        expect(payload.data.items).toHaveLength(1);
        expect(payload.data.items[0].id).toBe(target._id.toString());
    });

    it('assigns an existing user as supervisor', async () => {
        const admin = await createAdmin();
        const customer = await createCustomer({ name: 'Promote Me' });

        const { payload, response } = await requestJson('/admin/supervisors', {
            token: tokenFor(admin),
            body: {
                userId: customer._id,
                permissions: ['orders.view', 'orders.update'],
            },
        });

        expect(response.status).toBe(201);
        expect(payload.data.supervisor).toMatchObject({
            id: customer._id.toString(),
            name: 'Promote Me',
            role: ROLES.SUPERVISOR,
            permissionsCount: 2,
        });
        const fresh = await User.findById(customer._id);
        expect(fresh.role).toBe(ROLES.SUPERVISOR);
        expect(fresh.permissions).toEqual(['orders.view', 'orders.update']);
    });

    it('does not create a duplicate user when assigning supervisor access', async () => {
        const admin = await createAdmin();
        const customer = await createCustomer({ email: 'same-user@test.com' });
        const beforeCount = await User.countDocuments();

        await requestJson('/admin/supervisors', {
            token: tokenFor(admin),
            body: {
                userId: customer._id,
                permissions: ['orders.view'],
            },
        });

        expect(await User.countDocuments()).toBe(beforeCount);
        expect(await User.countDocuments({ email: 'same-user@test.com' })).toBe(1);
    });

    it('does not require a password when assigning supervisor access', async () => {
        const admin = await createAdmin();
        const customer = await createCustomer();

        const { response } = await requestJson('/admin/supervisors', {
            token: tokenFor(admin),
            body: {
                userId: customer._id,
                permissions: ['orders.view'],
            },
        });

        expect(response.status).toBe(201);
    });

    it('keeps existing user profile and wallet data unchanged during assignment', async () => {
        const admin = await createAdmin();
        const customer = await createCustomer({
            name: 'Wallet Holder',
            email: 'wallet-holder@test.com',
            walletBalance: 321.5,
            currency: 'USD',
            creditLimit: 25,
        });

        await requestJson('/admin/supervisors', {
            token: tokenFor(admin),
            body: {
                userId: customer._id,
                permissions: ['orders.view'],
            },
        });

        const fresh = await User.findById(customer._id);
        expect(fresh.name).toBe('Wallet Holder');
        expect(fresh.email).toBe('wallet-holder@test.com');
        expect(fresh.walletBalance).toBe(321.5);
        expect(fresh.currency).toBe('USD');
        expect(fresh.creditLimit).toBe(25);
    });

    it('rejects assigning an already-supervisor user', async () => {
        const admin = await createAdmin();
        const supervisor = await createSupervisor();

        const { response, payload } = await requestJson('/admin/supervisors', {
            token: tokenFor(admin),
            body: {
                userId: supervisor._id,
                permissions: ['orders.view'],
            },
        });

        expect(response.status).toBe(422);
        expect(payload.code).toBe('ALREADY_SUPERVISOR');
    });

    it('allows an admin to list supervisors', async () => {
        const admin = await createAdmin();
        const supervisor = await createSupervisor({ name: 'List Me' });

        const { payload, response } = await requestJson('/admin/supervisors', { token: tokenFor(admin) });

        expect(response.status).toBe(200);
        expect(payload.success).toBe(true);
        expect(payload.data.items).toHaveLength(1);
        expect(payload.data.items[0]).toMatchObject({
            id: supervisor._id.toString(),
            name: 'List Me',
            permissionsCount: 1,
            logsCount: 0,
        });
    });

    it('does not include normal customers in the supervisors list', async () => {
        const admin = await createAdmin();
        await createCustomer({ name: 'Plain Customer' });
        await createSupervisor({ name: 'Actual Supervisor' });

        const { payload } = await requestJson('/admin/supervisors', { token: tokenFor(admin) });

        expect(payload.data.items.map((item) => item.name)).toEqual(['Actual Supervisor']);
    });

    it('removes supervisor access only', async () => {
        const admin = await createAdmin();
        const supervisor = await createSupervisor({ walletBalance: 44.25 });

        const { payload, response } = await requestJson(`/admin/supervisors/${supervisor._id}`, {
            method: 'DELETE',
            token: tokenFor(admin),
        });

        expect(response.status).toBe(200);
        expect(payload.data.supervisor.role).toBe(ROLES.CUSTOMER);
        const fresh = await User.findById(supervisor._id);
        expect(fresh.role).toBe(ROLES.CUSTOMER);
        expect(fresh.permissions).toEqual([]);
        expect(fresh.walletBalance).toBe(44.25);
    });

    it('does not soft-delete the user when supervisor access is removed', async () => {
        const admin = await createAdmin();
        const supervisor = await createSupervisor();

        await requestJson(`/admin/supervisors/${supervisor._id}`, {
            method: 'DELETE',
            token: tokenFor(admin),
        });

        const fresh = await User.findById(supervisor._id);
        expect(fresh.deletedAt).toBeNull();
        expect(fresh.status).toBe(USER_STATUS.ACTIVE);
    });

    it('removes user from supervisors list while keeping user in users list', async () => {
        const admin = await createAdmin();
        const supervisor = await createSupervisor({ name: 'Still A User' });

        await requestJson(`/admin/supervisors/${supervisor._id}`, {
            method: 'DELETE',
            token: tokenFor(admin),
        });

        const supervisorsResult = await requestJson('/admin/supervisors', { token: tokenFor(admin) });
        const usersResult = await requestJson('/admin/users', { token: tokenFor(admin) });

        expect(supervisorsResult.payload.data.items.map((item) => item.id)).not.toContain(supervisor._id.toString());
        expect(usersResult.payload.data.map((item) => item.id)).toContain(supervisor._id.toString());
    });

    it('updates supervisor permissions', async () => {
        const admin = await createAdmin();
        const supervisor = await createSupervisor({ permissions: ['orders.view'] });

        const { payload, response } = await requestJson(`/admin/supervisors/${supervisor._id}/permissions`, {
            method: 'PATCH',
            token: tokenFor(admin),
            body: { permissions: ['orders.view', 'payments.view'] },
        });

        expect(response.status).toBe(200);
        expect(payload.data.supervisor.permissions).toEqual(['orders.view', 'payments.view']);
        const fresh = await User.findById(supervisor._id);
        expect(fresh.permissions).toEqual(['orders.view', 'payments.view']);
    });

    it('rejects invalid supervisor permissions', async () => {
        const admin = await createAdmin();
        const supervisor = await createSupervisor();

        const { response } = await requestJson(`/admin/supervisors/${supervisor._id}/permissions`, {
            method: 'PATCH',
            token: tokenFor(admin),
            body: { permissions: ['not.real'] },
        });

        expect(response.status).toBe(422);
    });

    it('returns only logs for the target supervisor', async () => {
        const admin = await createAdmin();
        const supervisor = await createSupervisor();
        const otherSupervisor = await createSupervisor();
        await AuditLog.create([
            {
                actorId: supervisor._id,
                actorRole: ACTOR_ROLES.SUPERVISOR,
                action: ORDER_ACTIONS.CREATED,
                entityType: ENTITY_TYPES.ORDER,
                entityId: supervisor._id,
            },
            {
                actorId: otherSupervisor._id,
                actorRole: ACTOR_ROLES.SUPERVISOR,
                action: ORDER_ACTIONS.CREATED,
                entityType: ENTITY_TYPES.ORDER,
                entityId: otherSupervisor._id,
            },
        ]);

        const { payload, response } = await requestJson(`/admin/supervisors/${supervisor._id}/logs`, {
            token: tokenFor(admin),
        });

        expect(response.status).toBe(200);
        expect(payload.data.items).toHaveLength(1);
        expect(payload.data.items[0].actorId).toBe(supervisor._id.toString());
    });

    it('returns supervisor actors only in all supervisor logs', async () => {
        const admin = await createAdmin();
        const supervisor = await createSupervisor();
        await AuditLog.create([
            {
                actorId: supervisor._id,
                actorRole: ACTOR_ROLES.SUPERVISOR,
                action: ORDER_ACTIONS.CREATED,
                entityType: ENTITY_TYPES.ORDER,
                entityId: supervisor._id,
            },
            {
                actorId: admin._id,
                actorRole: ACTOR_ROLES.ADMIN,
                action: ADMIN_ACTIONS.USER_UPDATED,
                entityType: ENTITY_TYPES.USER,
                entityId: supervisor._id,
            },
        ]);

        const { payload, response } = await requestJson('/admin/supervisors/logs', {
            token: tokenFor(admin),
        });

        expect(response.status).toBe(200);
        expect(payload.data.items).toHaveLength(1);
        expect(payload.data.items[0].actorRole).toBe(ACTOR_ROLES.SUPERVISOR);
    });

    it('rejects non-admin access to supervisor endpoints', async () => {
        const customer = await createCustomer();

        const { response: listResponse } = await requestJson('/admin/supervisors', {
            token: tokenFor(customer),
        });
        const { response: eligibleResponse } = await requestJson('/admin/supervisors/eligible-users', {
            token: tokenFor(customer),
        });

        expect(listResponse.status).toBe(403);
        expect(eligibleResponse.status).toBe(403);
    });
});
