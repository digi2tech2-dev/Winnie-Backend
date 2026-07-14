'use strict';

const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess } = require('../../shared/utils/apiResponse');
const { createWorkbookBuffer } = require('./admin.financialReport.excel');
const financialReportService = require('./admin.financialReport.service');
const { createAuditLog } = require('../audit/audit.service');
const { ADMIN_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');

const getActorRole = (user) => ACTOR_ROLES[user?.role] || user?.role || ACTOR_ROLES.SYSTEM;

const setExcelHeaders = (res, date, closed = false) => {
    const suffix = closed ? 'closed-' : '';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="financial-report-${suffix}${date}.xlsx"`);
};

const writeDownloadAudit = (req, metadata) => createAuditLog({
    actorId: req.user._id,
    actorRole: getActorRole(req.user),
    action: ADMIN_ACTIONS.FINANCIAL_REPORT_DOWNLOADED,
    entityType: ENTITY_TYPES.FINANCIAL_DAILY_CLOSE,
    entityId: metadata.closeId || null,
    metadata,
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
});

const sendDailyReportWorkbook = async (req, res, { closedDownload = false } = {}) => {
    const date = req.query.date;
    const timezone = req.query.timezone || financialReportService.DEFAULT_TIMEZONE;
    const report = await financialReportService.buildReportData({
        date,
        timezone,
        admin: req.user,
        closedDownload,
    });
    const buffer = createWorkbookBuffer(financialReportService.buildWorkbookSheets(report));

    setExcelHeaders(res, date, report.closed);
    await writeDownloadAudit(req, {
        date,
        timezone,
        closed: report.closed,
        closeId: report.close?._id,
        generatedAt: report.generatedAt,
    });
    res.status(200).send(buffer);
};

const downloadDailyReport = catchAsync(async (req, res) => {
    await sendDailyReportWorkbook(req, res, { closedDownload: req.query.closed === 'true' });
});

const downloadClosedDailyReport = catchAsync(async (req, res) => {
    await sendDailyReportWorkbook(req, res, { closedDownload: true });
});

const closeDailyReport = catchAsync(async (req, res) => {
    const close = await financialReportService.closeDay({
        date: req.body.date,
        timezone: req.body.timezone || financialReportService.DEFAULT_TIMEZONE,
        admin: req.user,
        providerManualBalances: req.body.providerManualBalances || [],
    });

    await createAuditLog({
        actorId: req.user._id,
        actorRole: getActorRole(req.user),
        action: ADMIN_ACTIONS.FINANCIAL_DAY_CLOSED,
        entityType: ENTITY_TYPES.FINANCIAL_DAILY_CLOSE,
        entityId: close._id,
        metadata: {
            date: close.date,
            timezone: close.timezone,
            dayStartUtc: close.dayStartUtc,
            dayEndUtc: close.dayEndUtc,
            reportVersion: close.reportVersion,
            warningsCount: close.warnings?.length || 0,
        },
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
    });

    sendSuccess(res, {
        close: {
            id: close._id,
            date: close.date,
            timezone: close.timezone,
            closedAt: close.closedAt,
            closedBy: close.closedBy,
            reportVersion: close.reportVersion,
            warnings: close.warnings || [],
        },
    }, 'Financial day closed.');
});

const getDailyCloseStatus = catchAsync(async (req, res) => {
    const result = await financialReportService.getCloseStatus({
        date: req.query.date,
        timezone: req.query.timezone || financialReportService.DEFAULT_TIMEZONE,
    });
    sendSuccess(res, result, result.closed ? 'Financial day is closed.' : 'Financial day is not closed.');
});

module.exports = {
    closeDailyReport,
    downloadClosedDailyReport,
    downloadDailyReport,
    getDailyCloseStatus,
};
