'use strict';

const { Currency } = require('../currency/currency.model');
const depositService = require('./deposit.service');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');
const { BusinessRuleError } = require('../../shared/errors/AppError');
const { getDepositRate } = require('../../services/currencyConverter.service');
const { localToUsd, usdToLocal } = require('../../shared/utils/currencyMath');

/**
 * POST /api/deposits
 * Customer creates a deposit request with receipt upload.
 *
 * Multer middleware (createUpload('deposits').single('receipt')) runs
 * BEFORE this handler — req.file is populated on success.
 */
const createDeposit = catchAsync(async (req, res) => {
    // ── Validate file upload ─────────────────────────────────────────────
    if (!req.file) {
        throw new BusinessRuleError(
            'Receipt image is required. Please upload a file.',
            'RECEIPT_REQUIRED'
        );
    }

    const { requestedAmount, currency, paymentMethodId, notes, antiScamConfirmed, termsAccepted, antiScamConfirmedAt } = req.body;

    // ── Fetch current exchange rate ──────────────────────────────────────
    const currencyDoc = await Currency.findOne({
        code: currency.toUpperCase(),
        isActive: true,
    });

    if (!currencyDoc) {
        throw new BusinessRuleError(
            `Currency '${currency}' is not supported or is inactive.`,
            'INVALID_CURRENCY'
        );
    }

    const depositRateSnapshot = Number(currencyDoc.depositRate || currencyDoc.platformRate);
    const exchangeRate = depositRateSnapshot;

    // ── Calculate USD equivalent ─────────────────────────────────────────
    const parsedAmount = parseFloat(requestedAmount);
    const usdEquivalent = localToUsd(parsedAmount, depositRateSnapshot);
    const amountUsd = Number(usdEquivalent.toFixed(2));
    const walletCurrency = String(req.user.currency || 'USD').toUpperCase();
    const walletDepositRateSnapshot = await getDepositRate(walletCurrency);
    const expectedWalletCreditAmount = currency.toUpperCase() === walletCurrency
        ? Number(parsedAmount.toFixed(2))
        : usdToLocal(usdEquivalent, walletDepositRateSnapshot);

    // ── Build relative receipt path ──────────────────────────────────────
    // req.file.path is absolute; we store only the relative part.
    const receiptImage = `uploads/deposits/${req.file.filename}`;

    // ── Persist ──────────────────────────────────────────────────────────
    const deposit = await depositService.createDepositRequest({
        userId: req.user._id,
        paymentMethodId,
        requestedAmount: parsedAmount,
        currency: currency.toUpperCase(),
        exchangeRate,
        amountUsd,
        depositRateSnapshot,
        walletCurrency,
        walletDepositRateSnapshot,
        expectedWalletCreditAmount,
        usdEquivalent,
        rateType: 'deposit',
        legacyFallback: false,
        receiptImage,
        notes: notes || null,
        antiScamConfirmed,
        termsAccepted,
        antiScamConfirmedAt,
        auditContext: req.auditContext,
    });

    sendCreated(res, deposit, 'Deposit request submitted successfully. Pending admin review.');
});

/**
 * GET /api/deposits
 * Admin: list all deposit requests (optional ?status= filter + pagination).
 * Customer: list only their own deposit requests.
 */
const listDeposits = catchAsync(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const { status } = req.query;

    let result;
    if (req.user.role === 'ADMIN') {
        result = await depositService.listDeposits({ page, limit, status });
    } else {
        result = await depositService.listMyDeposits(req.user._id, { page, limit, status });
    }

    sendPaginated(res, result.deposits, result.pagination, 'Deposit requests retrieved.');
});

/**
 * PATCH /api/deposits/:id/approve
 * Admin: approve a deposit and credit the customer's wallet.
 */
const approveDeposit = catchAsync(async (req, res) => {
    const { id } = req.params;

    const deposit = await depositService.approveDeposit(
        id,
        req.user._id,
        {},
        req.auditContext
    );

    sendSuccess(res, deposit, 'Deposit approved and wallet credited successfully.');
});

/**
 * PATCH /api/deposits/:id/reject
 * Admin: reject a deposit request.
 */
const rejectDeposit = catchAsync(async (req, res) => {
    const { adminNotes } = req.body;

    const deposit = await depositService.rejectDeposit(
        req.params.id,
        req.user._id,
        adminNotes || null,
        req.auditContext
    );

    sendSuccess(res, deposit, 'Deposit request rejected.');
});

/**
 * PATCH /api/admin/deposits/:id/review
 * Admin: unified review endpoint — approve or reject a deposit.
 * Body: { status: 'APPROVED' | 'REJECTED', adminNotes?: string }
 */
const reviewDeposit = catchAsync(async (req, res) => {
    const { id } = req.params;
    const { status, adminNotes } = req.body;

    let deposit;

    if (status === 'APPROVED') {
        deposit = await depositService.approveDeposit(
            id,
            req.user._id,
            {},
            req.auditContext
        );
        sendSuccess(res, deposit, 'Deposit approved and wallet credited successfully.');
    } else if (status === 'REJECTED') {
        deposit = await depositService.rejectDeposit(
            id,
            req.user._id,
            adminNotes || null,
            req.auditContext
        );
        sendSuccess(res, deposit, 'Deposit request rejected.');
    } else {
        throw new BusinessRuleError(
            'status must be APPROVED or REJECTED.',
            'INVALID_REVIEW_STATUS'
        );
    }
});

const getReceiptSignedUrl = catchAsync(async (req, res) => {
    const signedUrl = await depositService.getReceiptSignedUrl(req.params.id, req.user);
    sendSuccess(res, signedUrl, 'Deposit receipt URL created.');
});

module.exports = {
    createDeposit,
    listDeposits,
    approveDeposit,
    rejectDeposit,
    reviewDeposit,
    getReceiptSignedUrl,
};
