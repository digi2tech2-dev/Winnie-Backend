'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config/config');
const userService = require('../modules/users/user.service');
const { User, USER_STATUS } = require('../modules/users/user.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
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

const signToken = (user) => jwt.sign(
    { id: user._id, role: user.role },
    config.jwt.secret,
    { expiresIn: '1h' }
);

describe('PATCH /api/me/currency', () => {
    it('rejects a customer currency update with a stable business error', async () => {
        const { customer } = await createCustomerWithGroup({ currency: 'USD' });

        await expect(userService.updateMyCurrency(customer._id, 'EGP'))
            .rejects.toMatchObject({
                statusCode: 422,
                code: 'CUSTOMER_CURRENCY_CHANGE_DISABLED',
                message: 'Currency can only be changed by an administrator.',
            });
    });

    it('rejects unauthenticated and inactive token holders before route handlers', async () => {
        await expect(runMiddleware(authenticate, { headers: {} }))
            .rejects.toMatchObject({ statusCode: 401 });

        const { customer } = await createCustomerWithGroup({
            currency: 'USD',
            status: USER_STATUS.REJECTED,
        });
        const token = signToken(customer);

        await expect(runMiddleware(authenticate, {
            headers: { authorization: `Bearer ${token}` },
        })).rejects.toMatchObject({ statusCode: 401 });
    });

    it('does not mutate wallet state or create ledger side effects', async () => {
        const { customer, group } = await createCustomerWithGroup({
            currency: 'USD',
            walletBalance: 123.45,
            creditLimit: 50,
            creditUsed: 10,
        });

        await expect(userService.updateMyCurrency(customer._id, 'EGP'))
            .rejects.toMatchObject({ code: 'CUSTOMER_CURRENCY_CHANGE_DISABLED' });
        const fresh = await User.findById(customer._id);

        expect(fresh.currency).toBe('USD');
        expect(fresh.walletBalance).toBe(123.45);
        expect(fresh.creditLimit).toBe(50);
        expect(fresh.creditUsed).toBe(10);
        expect(fresh.groupId.toString()).toBe(group._id.toString());
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('rejects currency aliases in customer profile updates', async () => {
        const { customer } = await createCustomerWithGroup({ currency: 'USD' });

        await expect(userService.updateMyProfile(customer._id, { currency: 'EGP' }))
            .rejects.toMatchObject({ code: 'CUSTOMER_CURRENCY_CHANGE_DISABLED' });
        await expect(userService.updateMyProfile(customer._id, { walletCurrency: 'EGP' }))
            .rejects.toMatchObject({ code: 'CUSTOMER_CURRENCY_CHANGE_DISABLED' });

        const fresh = await User.findById(customer._id);
        expect(fresh.currency).toBe('USD');
    });
});
