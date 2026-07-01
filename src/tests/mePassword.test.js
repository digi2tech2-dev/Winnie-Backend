'use strict';

const meController = require('../modules/me/me.controller');
const userService = require('../modules/users/user.service');
const { login } = require('../modules/auth/auth.service');
const { User } = require('../modules/users/user.model');
const authenticate = require('../shared/middlewares/authenticate');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
} = require('./testHelpers');

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => { await clearCollections(); });

const runMiddleware = (middleware, req) => new Promise((resolve, reject) => {
    try {
        middleware(req, {}, (err) => (err ? reject(err) : resolve()));
    } catch (err) {
        reject(err);
    }
});

const runHandler = (handler, req) => new Promise((resolve, reject) => {
    const res = {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            resolve({ statusCode: this.statusCode, body: payload });
            return this;
        },
    };

    handler(req, res, reject);
});

describe('PATCH /api/me/password', () => {
    it('active authenticated customer can change password securely', async () => {
        const { customer, group } = await createCustomerWithGroup({
            email: 'password-change@test.com',
            password: 'OldPass@1',
            walletBalance: 77,
        });

        const result = await runHandler(meController.updatePassword, {
            user: customer,
            body: {
                currentPassword: 'OldPass@1',
                newPassword: 'NewPass@2',
            },
        });

        const fresh = await User.findById(customer._id).select('+password');
        expect(result.statusCode).toBe(200);
        expect(result.body.success).toBe(true);
        expect(result.body.message).toBe('Password updated successfully.');
        expect(Object.keys(result.body)).toEqual(['success', 'message']);
        expect(result.body.data).toBeUndefined();
        expect(fresh.password).not.toBe('NewPass@2');
        await expect(fresh.comparePassword('OldPass@1')).resolves.toBe(false);
        await expect(fresh.comparePassword('NewPass@2')).resolves.toBe(true);

        await expect(login({ email: customer.email, password: 'OldPass@1' }))
            .rejects.toMatchObject({ statusCode: 401 });
        await expect(login({ email: customer.email, password: 'NewPass@2' }))
            .resolves.toMatchObject({ user: expect.objectContaining({ email: customer.email }) });

        expect(fresh.role).toBe(customer.role);
        expect(fresh.status).toBe(customer.status);
        expect(fresh.walletBalance).toBe(77);
        expect(fresh.groupId.toString()).toBe(group._id.toString());
    });

    it('rejects wrong currentPassword with a safe error', async () => {
        const { customer } = await createCustomerWithGroup({ password: 'OldPass@1' });

        await expect(userService.updateMyPassword(customer._id, {
            currentPassword: 'WrongPass@1',
            newPassword: 'NewPass@2',
        })).rejects.toMatchObject({
            statusCode: 401,
            message: 'Current password is incorrect.',
        });
    });

    it('rejects weak newPassword', async () => {
        const { customer } = await createCustomerWithGroup({ password: 'OldPass@1' });

        await expect(userService.updateMyPassword(customer._id, {
            currentPassword: 'OldPass@1',
            newPassword: 'weakpass',
        })).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    });

    it('rejects missing currentPassword', async () => {
        const { customer } = await createCustomerWithGroup({ password: 'OldPass@1' });

        await expect(userService.updateMyPassword(customer._id, {
            newPassword: 'NewPass@2',
        })).rejects.toMatchObject({ code: 'CURRENT_PASSWORD_REQUIRED' });
    });

    it('rejects unauthenticated requests before the handler', async () => {
        await expect(runMiddleware(authenticate, { headers: {} }))
            .rejects.toMatchObject({ statusCode: 401 });
    });

    it('does not let profile update change password without currentPassword', async () => {
        const { customer } = await createCustomerWithGroup({ password: 'OldPass@1' });

        await userService.updateMyProfile(customer._id, {
            name: 'Updated Name',
            password: 'NewPass@2',
        });

        const fresh = await User.findById(customer._id).select('+password');
        expect(fresh.name).toBe('Updated Name');
        await expect(fresh.comparePassword('OldPass@1')).resolves.toBe(true);
        await expect(fresh.comparePassword('NewPass@2')).resolves.toBe(false);
    });
});
