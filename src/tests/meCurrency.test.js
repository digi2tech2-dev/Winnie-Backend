'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config/config');
const meController = require('../modules/me/me.controller');
const userService = require('../modules/users/user.service');
const { User, USER_STATUS } = require('../modules/users/user.model');
const { Currency } = require('../modules/currency/currency.model');
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

const makeCurrency = (overrides = {}) => Currency.create({
    code: 'EGP',
    name: 'Egyptian Pound',
    symbol: 'EGP',
    marketRate: 50,
    platformRate: 50,
    isActive: true,
    lastUpdatedAt: new Date(),
    ...overrides,
});

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

const signToken = (user) => jwt.sign(
    { id: user._id, role: user.role },
    config.jwt.secret,
    { expiresIn: '1h' }
);

describe('PATCH /api/me/currency', () => {
    it('active authenticated customer can update to an active currency', async () => {
        await makeCurrency({ code: 'EGP' });
        const { customer } = await createCustomerWithGroup({ currency: 'USD' });

        const result = await runHandler(meController.updateCurrency, {
            user: customer,
            body: { currency: 'EGP' },
        });

        const fresh = await User.findById(customer._id);
        expect(result.statusCode).toBe(200);
        expect(result.body.success).toBe(true);
        expect(result.body.data.currency).toBe('EGP');
        expect(result.body.data.user.currency).toBe('EGP');
        expect(fresh.currency).toBe('EGP');
    });

    it('normalizes currency to uppercase', async () => {
        await makeCurrency({ code: 'EGP' });
        const { customer } = await createCustomerWithGroup({ currency: 'USD' });

        const result = await userService.updateMyCurrency(customer._id, 'egp');
        const fresh = await User.findById(customer._id);

        expect(result.currency).toBe('EGP');
        expect(fresh.currency).toBe('EGP');
    });

    it('rejects unsupported currency', async () => {
        const { customer } = await createCustomerWithGroup({ currency: 'USD' });

        await expect(userService.updateMyCurrency(customer._id, 'XYZ'))
            .rejects.toMatchObject({ code: 'INVALID_CURRENCY' });
    });

    it('rejects inactive currency', async () => {
        await makeCurrency({ code: 'EGP', isActive: false });
        const { customer } = await createCustomerWithGroup({ currency: 'USD' });

        await expect(userService.updateMyCurrency(customer._id, 'EGP'))
            .rejects.toMatchObject({ code: 'INVALID_CURRENCY' });
    });

    it('rejects missing currency', async () => {
        const { customer } = await createCustomerWithGroup({ currency: 'USD' });

        await expect(userService.updateMyCurrency(customer._id, ''))
            .rejects.toMatchObject({ code: 'CURRENCY_REQUIRED' });
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

    it('updates only User.currency and does not create wallet ledger side effects', async () => {
        await makeCurrency({ code: 'EGP' });
        const { customer, group } = await createCustomerWithGroup({
            currency: 'USD',
            walletBalance: 123.45,
            creditLimit: 50,
            creditUsed: 10,
        });

        await userService.updateMyCurrency(customer._id, 'EGP');
        const fresh = await User.findById(customer._id);

        expect(fresh.currency).toBe('EGP');
        expect(fresh.walletBalance).toBe(123.45);
        expect(fresh.creditLimit).toBe(50);
        expect(fresh.creditUsed).toBe(10);
        expect(fresh.groupId.toString()).toBe(group._id.toString());
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('response does not expose unsafe user fields', async () => {
        await makeCurrency({ code: 'EGP' });
        const { customer } = await createCustomerWithGroup({
            currency: 'USD',
            apiToken: 'secret-api-token',
            emailVerificationToken: 'secret-email-token',
        });

        const result = await userService.updateMyCurrency(customer._id, 'EGP');

        expect(result.user.password).toBeUndefined();
        expect(result.user.apiToken).toBeUndefined();
        expect(result.user.emailVerificationToken).toBeUndefined();
        expect(result.user.twoFactorOtp).toBeUndefined();
    });

    it('is idempotent when currency already matches', async () => {
        await makeCurrency({ code: 'EGP' });
        const { customer } = await createCustomerWithGroup({ currency: 'EGP' });

        const result = await userService.updateMyCurrency(customer._id, 'EGP');

        expect(result.currency).toBe('EGP');
        expect(result.user.currency).toBe('EGP');
    });
});
