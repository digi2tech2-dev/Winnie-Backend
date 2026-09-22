'use strict';

jest.mock('../modules/whatsapp/whatsapp.service', () => ({
    sendAdminNotification: jest.fn().mockResolvedValue({ success: true, messageId: 'mock-message' }),
}));

const { Setting } = require('../modules/admin/setting.model');
const { connectTestDB, disconnectTestDB, clearCollections } = require('./testHelpers');
const { sendAdminNotification } = require('../modules/whatsapp/whatsapp.service');
const policy = require('../modules/whatsapp/adminNotificationPolicy.service');

const EVENTS = [
    ['NEW_ORDER', 'newOrder', '🛒 طلب جديد'],
    ['PAYMENT_SUCCESS', 'paymentSuccess', '✅ دفع ناجح'],
    ['DEPOSIT_PENDING', 'depositPending', '💰 إيداع قيد المراجعة'],
    ['PROVIDER_FAILURE', 'providerFailure', '🚨 فشل مورد / تنفيذ طلب'],
    ['MANUAL_REVIEW', 'manualReview', '⚠️ طلب يحتاج مراجعة يدوية'],
    ['AUTOMATIC_PAYMENT_ERROR', 'automaticPaymentError', '⚠️ خطأ الدفع/الإشعار التلقائي'],
    ['DAY_CLOSED', 'dayClosed', '📊 تم تقفيل اليوم'],
    ['LARGE_WALLET_ADJUSTMENT', 'largeWalletAdjustment', '💳 تعديل محفظة كبير'],
    ['PROVIDER_BALANCE_WARNING', 'providerBalanceWarning', '⚠️ تحذير رصيد مورد'],
    ['SUB_AGENT_REQUEST', 'subAgentRequest', '👤 طلب وكيل فرعي جديد'],
];

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => { await clearCollections(); jest.clearAllMocks(); });

describe.each(EVENTS)('WhatsApp event policy: %s', (eventType, preferenceKey, title) => {
    const payload = { orderNumber: 'ORD-1', customerName: 'Customer', productName: 'Product', quantity: 1, amount: '10', currency: 'USD', provider: 'Provider', paymentId: 'PAY-1', depositId: 'DEP-1', requestId: 'REQ-1', date: '2026-01-01' };

    it('sends exactly once when enabled', async () => {
        const eventPreferences = { ...policy.DEFAULT_EVENT_PREFERENCES, [preferenceKey]: true };
        await Setting.create({ key: policy.SETTING_KEY, value: { eventPreferences }, description: 'test' });
        await expect(policy.dispatchAdminEvent({ eventType, payload })).resolves.toMatchObject({ success: true });
        expect(sendAdminNotification).toHaveBeenCalledTimes(1);
        expect(sendAdminNotification.mock.calls[0][0]).toContain(title);
    });

    it('sends zero messages when disabled', async () => {
        const eventPreferences = { ...policy.DEFAULT_EVENT_PREFERENCES, [preferenceKey]: false };
        await Setting.create({ key: policy.SETTING_KEY, value: { eventPreferences }, description: 'test' });
        await expect(policy.dispatchAdminEvent({ eventType, payload })).resolves.toMatchObject({ skipped: 'EVENT_DISABLED' });
        expect(sendAdminNotification).not.toHaveBeenCalled();
    });
});
