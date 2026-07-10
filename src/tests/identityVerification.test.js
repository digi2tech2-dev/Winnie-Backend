'use strict';

const authService = require('../modules/auth/auth.service');
const adminUsersService = require('../modules/admin/admin.users.service');
const meController = require('../modules/me/me.controller');
const orderService = require('../modules/orders/order.service');
const paymentService = require('../modules/payments/payment.service');
const depositService = require('../modules/deposits/deposit.service');
const MockPaymentGateway = require('../modules/payments/gateways/mock.gateway');
const { Payment } = require('../modules/payments/payment.model');
const { Order } = require('../modules/orders/order.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { DepositRequest } = require('../modules/deposits/deposit.model');
const { AuditLog } = require('../modules/audit/audit.model');
const { USER_ACTIONS } = require('../modules/audit/audit.constants');
const { User } = require('../modules/users/user.model');

const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createAdmin,
    createCustomerWithGroup,
    createProduct,
} = require('./testHelpers');

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.PAYMENT_ALLOWED_GATEWAYS;
    delete process.env.PAYMENTS_ENABLED;
    await clearCollections();
});
afterEach(() => {
    jest.restoreAllMocks();
});

const flushAudit = () => new Promise((resolve) => setTimeout(resolve, 100));

const getProfilePayload = async (userId) => {
    return new Promise((resolve, reject) => {
        const res = {
            statusCode: null,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                resolve(payload?.data);
                return this;
            },
        };

        meController.getProfile(
            { user: { _id: userId } },
            res,
            reject
        );
    });
};

describe('Identity verification hold', () => {
    it('admin can enable and clear the hold with audit logs', async () => {
        const admin = await createAdmin();
        const { customer } = await createCustomerWithGroup();

        const enabled = await adminUsersService.updateIdentityVerificationHold(
            customer._id,
            { required: true, reason: 'Payment gateway requested identity confirmation' },
            admin._id
        );

        expect(enabled.identityVerificationRequired).toBe(true);
        expect(enabled.identityVerificationReason).toBe('Payment gateway requested identity confirmation');
        expect(enabled.identityVerificationRequestedAt).toBeInstanceOf(Date);
        expect(enabled.identityVerificationRequestedBy.toString()).toBe(admin._id.toString());
        expect((await getProfilePayload(customer._id)).identityVerificationRequired).toBe(true);

        const cleared = await adminUsersService.updateIdentityVerificationHold(
            customer._id,
            { required: false, reason: 'Verified by support' },
            admin._id
        );

        expect(cleared.identityVerificationRequired).toBe(false);
        expect(cleared.identityVerificationReason).toBe('Verified by support');
        expect(cleared.identityVerificationClearedAt).toBeInstanceOf(Date);
        expect(cleared.identityVerificationClearedBy.toString()).toBe(admin._id.toString());

        const fresh = await User.findById(customer._id);
        expect(fresh.identityVerificationRequired).toBe(false);
        expect((await getProfilePayload(customer._id)).identityVerificationRequired).toBe(false);

        await flushAudit();
        expect(await AuditLog.countDocuments({ action: USER_ACTIONS.IDENTITY_VERIFICATION_REQUIRED })).toBe(1);
        expect(await AuditLog.countDocuments({ action: USER_ACTIONS.IDENTITY_VERIFICATION_CLEARED })).toBe(1);
    });

    it('safe user responses expose the hold flag and reason but not admin actor ids', async () => {
        const admin = await createAdmin();
        const { customer } = await createCustomerWithGroup();
        await adminUsersService.updateIdentityVerificationHold(
            customer._id,
            { required: true, reason: 'Support confirmation needed' },
            admin._id
        );

        const safe = (await User.findById(customer._id)).toSafeObject();
        expect(safe.identityVerificationRequired).toBe(true);
        expect(safe.identityVerificationReason).toBe('Support confirmation needed');
        expect(safe.identityVerificationRequestedBy).toBeUndefined();
        expect(safe.identityVerificationClearedBy).toBeUndefined();
    });

    it('user with hold can still log in', async () => {
        const { customer } = await createCustomerWithGroup({
            email: 'held-login@example.com',
            password: 'HeldLogin@1',
            identityVerificationRequired: true,
        });

        const result = await authService.login({
            email: customer.email,
            password: 'HeldLogin@1',
        });

        expect(result.token).toBeTruthy();
        expect(result.user.identityVerificationRequired).toBe(true);
    });

    it('blocks payment intent creation before gateway, payment, or ledger side effects', async () => {
        const { customer } = await createCustomerWithGroup({
            currency: 'USD',
            identityVerificationRequired: true,
        });
        const gatewaySpy = jest.spyOn(MockPaymentGateway.prototype, 'createPaymentIntent');

        await expect(paymentService.createPaymentIntent({
            userId: customer._id,
            amount: 25,
            currency: 'USD',
            gateway: 'MOCK',
            antiScamConfirmed: true,
            termsAccepted: true,
        })).rejects.toMatchObject({
            statusCode: 403,
            code: 'IDENTITY_VERIFICATION_REQUIRED',
            support: expect.objectContaining({ url: 'https://wa.me/971527715868' }),
        });

        expect(gatewaySpy).not.toHaveBeenCalled();
        expect(await Payment.countDocuments({ userId: customer._id })).toBe(0);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('blocks order creation before wallet debit, order creation, or provider execution', async () => {
        const { customer } = await createCustomerWithGroup({
            walletBalance: 100,
            currency: 'USD',
            identityVerificationRequired: true,
        });
        const product = await createProduct({ basePrice: 10, finalPrice: 10 });

        await expect(orderService.createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
        })).rejects.toMatchObject({
            statusCode: 403,
            code: 'IDENTITY_VERIFICATION_REQUIRED',
        });

        const fresh = await User.findById(customer._id);
        expect(fresh.walletBalance).toBe(100);
        expect(await Order.countDocuments({ userId: customer._id })).toBe(0);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('blocks manual deposit requests before creating a pending request', async () => {
        const { customer } = await createCustomerWithGroup({
            identityVerificationRequired: true,
        });

        await expect(depositService.createDepositRequest({
            userId: customer._id,
            paymentMethodId: 'bank-transfer',
            requestedAmount: 50,
            currency: 'USD',
            exchangeRate: 1,
            amountUsd: 50,
            receiptImage: 'uploads/deposits/test.png',
            antiScamConfirmed: true,
            termsAccepted: true,
        })).rejects.toMatchObject({
            statusCode: 403,
            code: 'IDENTITY_VERIFICATION_REQUIRED',
        });

        expect(await DepositRequest.countDocuments({ userId: customer._id })).toBe(0);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
    });

    it('clearing the hold restores normal payment and order flow', async () => {
        const admin = await createAdmin();
        const { customer } = await createCustomerWithGroup({
            walletBalance: 100,
            currency: 'USD',
            identityVerificationRequired: true,
        });
        const product = await createProduct({ basePrice: 10, finalPrice: 10 });

        await adminUsersService.updateIdentityVerificationHold(
            customer._id,
            { required: false, reason: 'Verified by support' },
            admin._id
        );

        const payment = await paymentService.createPaymentIntent({
            userId: customer._id,
            amount: 25,
            currency: 'USD',
            gateway: 'MOCK',
            antiScamConfirmed: true,
            termsAccepted: true,
        });
        expect(payment.payment._id).toBeTruthy();

        const orderResult = await orderService.createOrder({
            userId: customer._id,
            productId: product._id,
            quantity: 1,
        });
        expect(orderResult.order._id).toBeTruthy();
        expect(await Order.countDocuments({ userId: customer._id })).toBe(1);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(1);
    });
});
