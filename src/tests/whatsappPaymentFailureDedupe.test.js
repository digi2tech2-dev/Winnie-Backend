'use strict';

jest.mock('../modules/whatsapp/whatsapp.service', () => ({
    sendAdminNotification: jest.fn(),
}));

const { Setting } = require('../modules/admin/setting.model');
const { connectTestDB, disconnectTestDB, clearCollections } = require('./testHelpers');
const { sendAdminNotification } = require('../modules/whatsapp/whatsapp.service');
const { queueAdminEvent } = require('../modules/notifications/whatsapp/whatsappNotification.service');
const { resolvePaymentFailureNotification } = require('../modules/whatsapp/paymentFailureNotificationDedupe.service');

const payload = (overrides = {}) => ({
    paymentId: '507f1f77bcf86cd799439011', status: 'PENDING', stage: 'payment_reconciliation', errorCode: 'GATEWAY_TIMEOUT', providerStatus: 'UNKNOWN',
    amount: '10', currency: 'USD', ...overrides,
});

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => { await clearCollections(); jest.clearAllMocks(); sendAdminNotification.mockResolvedValue({ success: true }); });

describe('automatic payment-error durable WhatsApp dedupe', () => {
    it('sends one notification for a repeated reconciliation failure episode', async () => {
        await queueAdminEvent({ eventType: 'payment_webhook_error', payload: payload() });
        await queueAdminEvent({ eventType: 'payment_webhook_error', payload: payload() });
        expect(sendAdminNotification).toHaveBeenCalledTimes(1);
    });

    it('allows only one concurrent attempt for the same failure episode', async () => {
        await Promise.all([
            queueAdminEvent({ eventType: 'payment_webhook_error', payload: payload() }),
            queueAdminEvent({ eventType: 'payment_webhook_error', payload: payload() }),
        ]);
        expect(sendAdminNotification).toHaveBeenCalledTimes(1);
    });

    it('leaves a failed send retry-eligible without changing business data', async () => {
        sendAdminNotification.mockResolvedValueOnce({ success: false, error: 'DISCONNECTED' }).mockResolvedValueOnce({ success: true });
        const first = await queueAdminEvent({ eventType: 'payment_webhook_error', payload: payload() });
        const second = await queueAdminEvent({ eventType: 'payment_webhook_error', payload: payload() });
        expect(first.success).toBe(false);
        expect(second.success).toBe(true);
        expect(sendAdminNotification).toHaveBeenCalledTimes(2);
        expect(await Setting.exists({ key: 'whatsappPaymentFailureNotificationState' })).toBeTruthy();
    });

    it('permits one alert for a distinct later failure episode', async () => {
        await queueAdminEvent({ eventType: 'payment_webhook_error', payload: payload() });
        await queueAdminEvent({ eventType: 'payment_webhook_error', payload: payload({ errorCode: 'GATEWAY_AUTH_FAILED' }) });
        expect(sendAdminNotification).toHaveBeenCalledTimes(2);
    });

    it('permits the same fingerprint again only after a durable recovery closes its episode', async () => {
        await queueAdminEvent({ eventType: 'payment_webhook_error', payload: payload() });
        await queueAdminEvent({ eventType: 'payment_webhook_error', payload: payload() });
        await resolvePaymentFailureNotification(payload().paymentId);
        await Promise.all([
            queueAdminEvent({ eventType: 'payment_webhook_error', payload: payload() }),
            queueAdminEvent({ eventType: 'payment_webhook_error', payload: payload() }),
        ]);
        expect(sendAdminNotification).toHaveBeenCalledTimes(2);
    });
});
