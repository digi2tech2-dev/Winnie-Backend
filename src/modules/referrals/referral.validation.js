'use strict';

const { body, query } = require('express-validator');
const {
    REFERRAL_RELATIONSHIP_STATUS,
    REFERRAL_COMMISSION_STATUS,
    REFERRAL_PAYOUT_METHODS,
    REFERRAL_PAYOUT_STATUS,
} = require('./referral.constants');

const paginationValidation = [
    query('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100'),
];

const dateFilterValidation = [
    query('from').optional().isISO8601().withMessage('from must be an ISO date'),
    query('to').optional().isISO8601().withMessage('to must be an ISO date'),
];

const mongoIdQuery = (field) =>
    query(field).optional().isMongoId().withMessage(`${field} must be a valid Mongo ID`);

const validateCodeValidation = [
    body('inviteCode')
        .optional()
        .isString().withMessage('inviteCode must be a string')
        .trim()
        .isLength({ min: 3, max: 32 }).withMessage('inviteCode must be between 3 and 32 characters'),
    body('referralCode')
        .optional()
        .isString().withMessage('referralCode must be a string')
        .trim()
        .isLength({ min: 3, max: 32 }).withMessage('referralCode must be between 3 and 32 characters'),
    body()
        .custom((value) => Boolean(value.inviteCode || value.referralCode))
        .withMessage('inviteCode or referralCode is required'),
];

const referralSettingsValidation = [
    body('enabled')
        .optional()
        .isBoolean().withMessage('enabled must be a boolean')
        .toBoolean(),
    body('depositCommissionPercentage')
        .optional()
        .isFloat({ min: 0, max: 100 }).withMessage('depositCommissionPercentage must be between 0 and 100')
        .toFloat(),
    body('applyTo')
        .optional()
        .equals('EVERY_ELIGIBLE_WALLET_CREDIT')
        .withMessage('applyTo must be EVERY_ELIGIBLE_WALLET_CREDIT'),
    body('minSourceAmount')
        .optional({ nullable: true })
        .custom((value) => value === null || (Number.isFinite(Number(value)) && Number(value) >= 0))
        .withMessage('minSourceAmount must be null or a non-negative number'),
    body('maxCommissionAmount')
        .optional({ nullable: true })
        .custom((value) => value === null || (Number.isFinite(Number(value)) && Number(value) >= 0))
        .withMessage('maxCommissionAmount must be null or a non-negative number'),
];

const relationshipListValidation = [
    ...paginationValidation,
    ...dateFilterValidation,
    mongoIdQuery('inviterUserId'),
    mongoIdQuery('invitedUserId'),
    query('status')
        .optional()
        .isIn(Object.values(REFERRAL_RELATIONSHIP_STATUS))
        .withMessage('status must be ACTIVE, CANCELED, or BLOCKED'),
];

const commissionListValidation = [
    ...paginationValidation,
    ...dateFilterValidation,
    mongoIdQuery('inviterUserId'),
    mongoIdQuery('invitedUserId'),
    query('status')
        .optional()
        .isIn(Object.values(REFERRAL_COMMISSION_STATUS))
        .withMessage('status must be CREDITED, SKIPPED, or REVERSED'),
];

const myCommissionListValidation = [
    ...paginationValidation,
    query('status')
        .optional()
        .isIn(Object.values(REFERRAL_COMMISSION_STATUS))
        .withMessage('status must be CREDITED, SKIPPED, or REVERSED'),
];

const payoutListValidation = [
    ...paginationValidation,
    ...dateFilterValidation,
    mongoIdQuery('userId'),
    mongoIdQuery('user'),
    query('status')
        .optional()
        .isIn(Object.values(REFERRAL_PAYOUT_STATUS))
        .withMessage('status must be a valid referral payout status'),
    query('method')
        .optional()
        .isIn(Object.values(REFERRAL_PAYOUT_METHODS))
        .withMessage('method must be wallet_credit or manual_external'),
    query('currency')
        .optional()
        .isString()
        .trim()
        .isLength({ min: 3, max: 3 })
        .withMessage('currency must be a 3-letter code'),
];

const createPayoutValidation = [
    body('method')
        .isIn(Object.values(REFERRAL_PAYOUT_METHODS))
        .withMessage('method must be wallet_credit or manual_external'),
    body('currency')
        .optional()
        .isString()
        .trim()
        .isLength({ min: 3, max: 3 })
        .withMessage('currency must be a 3-letter code'),
    body('requestedCurrency')
        .optional()
        .isString()
        .trim()
        .isLength({ min: 3, max: 3 })
        .withMessage('requestedCurrency must be a 3-letter code'),
    body()
        .custom((value) => Boolean(value.currency || value.requestedCurrency))
        .withMessage('currency is required'),
    body('amount')
        .optional()
        .isFloat({ gt: 0 })
        .withMessage('amount must be greater than zero'),
    body('requestedAmount')
        .optional()
        .isFloat({ gt: 0 })
        .withMessage('requestedAmount must be greater than zero'),
    body('payoutDetails')
        .optional({ nullable: true })
        .isObject()
        .withMessage('payoutDetails must be an object'),
    body('payoutDetails.methodName').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
    body('payoutDetails.accountName').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
    body('payoutDetails.accountNumber').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
    body('payoutDetails.phone').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
    body('payoutDetails.walletAddress').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
    body('payoutDetails.notes').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
];

const rejectPayoutValidation = [
    body('reason')
        .optional()
        .isString()
        .trim()
        .isLength({ max: 1000 })
        .withMessage('reason cannot exceed 1000 characters'),
    body('rejectionReason')
        .optional()
        .isString()
        .trim()
        .isLength({ max: 1000 })
        .withMessage('rejectionReason cannot exceed 1000 characters'),
    body()
        .custom((value) => Boolean(value.reason || value.rejectionReason))
        .withMessage('reason is required'),
    body('adminNotes').optional({ nullable: true }).isString().trim().isLength({ max: 2000 }),
    body('adminNote').optional({ nullable: true }).isString().trim().isLength({ max: 2000 }),
];

module.exports = {
    validateCodeValidation,
    referralSettingsValidation,
    relationshipListValidation,
    commissionListValidation,
    myCommissionListValidation,
    payoutListValidation,
    createPayoutValidation,
    rejectPayoutValidation,
};
