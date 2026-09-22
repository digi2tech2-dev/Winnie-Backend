'use strict';

jest.mock('../modules/notifications/whatsapp/whatsappNotification.service', () => ({
    queueAdminEvent: jest.fn().mockResolvedValue({ success: true }),
}));
jest.mock('../modules/notifications/notification.service', () => ({
    safeCreateNotification: jest.fn().mockResolvedValue(null),
    safeCreateAdminActorNotifications: jest.fn().mockResolvedValue(null),
}));

const whatsapp = require('../modules/notifications/whatsapp/whatsappNotification.service');
const events = require('../modules/notifications/notification.events');

const order = {
    _id: 'order-1', orderNumber: 'ORD-1', productName: 'Product', quantity: 2,
    orderFieldsValues: { target_uid: 'UID-9' }, customerName: 'Customer', customerEmail: 'customer@example.test',
    chargedAmount: '20', currency: 'USD', providerCode: 'XENA', providerOrderId: 'provider-1', providerStatus: 'FAILED',
    providerErrorCode: 'SAFE_ERROR', status: 'FAILED', userId: 'user-1', executionType: 'AUTOMATIC',
};
const payment = { _id: 'payment-1', userId: 'user-1', amount: '15', currency: 'USD', gateway: 'MOCK', status: 'FAILED' };
const deposit = { _id: 'deposit-1', userId: { _id: 'user-1', name: 'Customer', email: 'customer@example.test' }, requestedAmount: '12', currency: 'USD', paymentMethodId: 'bank', status: 'PENDING' };

beforeEach(() => { jest.clearAllMocks(); process.env.WHATSAPP_LARGE_WALLET_ADJUSTMENT_THRESHOLD = '100'; });
afterEach(() => { delete process.env.WHATSAPP_LARGE_WALLET_ADJUSTMENT_THRESHOLD; });

const expectOne = (eventType) => {
    expect(whatsapp.queueAdminEvent).toHaveBeenCalledTimes(1);
    expect(whatsapp.queueAdminEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType }));
};

describe('real business notification producers', () => {
    it('new order producer emits one NEW_ORDER path', () => { events.notifyOrderCreated(order); expectOne('order_created'); });
    it('payment success producer emits one PAYMENT_SUCCESS path', () => { events.notifyPaymentSucceeded(payment, { transactionId: 'tx-1' }); expectOne('successful_payment'); });
    it('deposit request producer emits one DEPOSIT_PENDING path', () => { events.notifyDepositRequested(deposit); expectOne('manual_deposit_pending'); });
    it('provider failure producer emits one PROVIDER_FAILURE path', () => { events.notifyOrderFailed(order, { reason: 'safe failure' }); expectOne('provider_order_failed'); });
    it('manual review producer emits one MANUAL_REVIEW path', () => { events.notifyOrderManualReview(order, { reason: 'ambiguous provider state' }); expectOne('manual_order_intervention'); });
    it('automatic reconciliation failure emits one AUTOMATIC_PAYMENT_ERROR path', () => { events.notifyPaymentReconciliationFailed(payment, { errorCode: 'RECONCILE', errorMessage: 'safe failure' }); expectOne('payment_webhook_error'); });
    it('large wallet adjustment producer emits one thresholded path', () => { events.notifyManualWalletAdjustment({ userId: 'user-1', operation: 'ADD', amount: '100', currency: 'USD', transactionId: 'tx-1', balanceBefore: '5', balanceAfter: '105', actorRole: 'ADMIN' }); expectOne('large_wallet_adjustment'); });
});
