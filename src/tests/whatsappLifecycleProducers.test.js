'use strict';

jest.mock('../modules/notifications/whatsapp/whatsappNotification.service', () => ({
    queueAdminEvent: jest.fn().mockResolvedValue({ success: true }),
}));
jest.mock('../modules/admin/admin.financialReport.service', () => ({
    DEFAULT_TIMEZONE: 'Africa/Cairo',
    closeDay: jest.fn(),
}));
jest.mock('../modules/audit/audit.service', () => ({
    createAuditLog: jest.fn().mockResolvedValue(null),
}));
jest.mock('../modules/notifications/notification.service', () => ({
    safeCreateNotification: jest.fn().mockResolvedValue(null),
    safeCreateAdminActorNotifications: jest.fn().mockResolvedValue(null),
}));

const whatsapp = require('../modules/notifications/whatsapp/whatsappNotification.service');
const financialReportService = require('../modules/admin/admin.financialReport.service');
const financialController = require('../modules/admin/admin.financialReport.controller');
const groupRequestService = require('../modules/groupRequests/groupRequest.service');
const { GROUP_REQUEST_TYPES, GROUP_REQUEST_STATUS } = require('../modules/groupRequests/groupRequest.constants');
const { connectTestDB, disconnectTestDB, clearCollections, createGroup, createCustomer } = require('./testHelpers');

const proofImage = {
    proofImagePath: 'uploads/sub-agent-requests/test.jpg',
    proofImageUrl: '/uploads/sub-agent-requests/test.jpg',
    proofImageOriginalName: 'test.jpg',
    proofImageMimeType: 'image/jpeg',
    proofImageSize: 1,
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const invoke = (handler, req, res) => new Promise((resolve, reject) => {
    handler(req, res, (error) => (error ? reject(error) : resolve()));
    setImmediate(resolve);
});

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => { await clearCollections(); jest.clearAllMocks(); });

describe('real day-close and sub-agent WhatsApp producers', () => {
    it('emits one day-close event only after the close succeeds, and a delivery failure does not change the response', async () => {
        const close = { _id: '507f1f77bcf86cd799439011', date: '2026-09-22', timezone: 'Africa/Cairo', warnings: [], summary: { transactionCount: 7 }, closedAt: new Date(), closedBy: 'admin', reportVersion: 1 };
        financialReportService.closeDay.mockResolvedValue(close);
        whatsapp.queueAdminEvent.mockRejectedValueOnce(new Error('transport unavailable'));
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        await invoke(financialController.closeDailyReport, {
            body: { date: close.date, timezone: close.timezone },
            user: { _id: '507f1f77bcf86cd799439012', name: 'Admin' }, ip: '127.0.0.1', get: () => null,
        }, res);
        await flush();
        expect(financialReportService.closeDay).toHaveBeenCalledTimes(1);
        expect(whatsapp.queueAdminEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'financial_day_closed' }));
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('emits one sub-agent request event after commit, while WhatsApp rejection leaves the request successful', async () => {
        const group = await createGroup();
        const customer = await createCustomer({ groupId: group._id });
        whatsapp.queueAdminEvent.mockRejectedValueOnce(new Error('transport unavailable'));
        const request = await groupRequestService.createGroupRequest({
            userId: customer._id, requestType: GROUP_REQUEST_TYPES.SUB_AGENT, proofImage,
        });
        await flush();
        expect(request.status).toBe(GROUP_REQUEST_STATUS.PENDING);
        expect(whatsapp.queueAdminEvent).toHaveBeenCalledTimes(1);
        expect(whatsapp.queueAdminEvent).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'sub_agent_request_submitted',
            payload: expect.objectContaining({ customerName: customer.name, email: customer.email }),
        }));
    });
});
