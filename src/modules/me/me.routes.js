'use strict';

/**
 * me.routes.js — User Panel API
 *
 * All routes require:
 *  1. authenticate  — valid JWT
 *  2. requireActiveUser — account status === ACTIVE (admin-approved)
 *
 * Route map:
 *
 *  GET  /api/me                        Profile + wallet balance
 *  PATCH /api/me/password              Secure current-user password change
 *  GET  /api/me/wallet                 Wallet summary + 5 recent txns
 *  GET  /api/me/wallet/transactions    Paginated transaction history
 *
 *  GET  /api/me/products               Active product catalogue (search, page, limit)
 *  GET  /api/me/products/:id           Single product detail
 *
 *  POST /api/me/orders                 Place a new order
 *  GET  /api/me/orders                 My orders (status, date, page, limit)
 *  GET  /api/me/orders/:id             My order detail (ownership enforced)
 *
 *  POST /api/me/deposits               Submit deposit request (multipart: screenshotProof)
 *  GET  /api/me/deposits               My deposit history
 *  GET  /api/me/deposits/:id           My deposit detail (ownership enforced)
 */

const { Router } = require('express');
const me = require('./me.controller');
const authenticate = require('../../shared/middlewares/authenticate');
const requireActiveUser = require('../../shared/middlewares/requireActiveUser');
const { createUpload } = require('../../shared/middlewares/upload');
const { body, param, query } = require('express-validator');
const validate = require('../../shared/middlewares/validate');

const depositUpload = createUpload('deposits');

const router = Router();

// ── Global guards ─────────────────────────────────────────────────────────────
router.use(authenticate, requireActiveUser);

// ─── Profile ──────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/me
 * @desc   Authenticated user's own profile
 * @access Active user
 */
router.get('/', me.getProfile);

const updateCurrencyValidation = [
    body('currency')
        .exists({ checkFalsy: true }).withMessage('currency is required')
        .bail()
        .isString().withMessage('currency must be a string')
        .trim()
        .matches(/^[A-Za-z]{3}$/).withMessage('currency must be a 3-letter ISO 4217 code')
        .toUpperCase(),
];

router.patch('/currency', updateCurrencyValidation, validate, me.updateCurrency);

const updatePasswordValidation = [
    body('currentPassword')
        .exists({ checkFalsy: true }).withMessage('currentPassword is required')
        .bail()
        .isString().withMessage('currentPassword must be a string'),
    body('newPassword')
        .exists({ checkFalsy: true }).withMessage('newPassword is required')
        .bail()
        .isString().withMessage('newPassword must be a string')
        .isLength({ min: 8 }).withMessage('newPassword must be at least 8 characters')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .withMessage('newPassword must contain at least one uppercase letter, one lowercase letter, and one number')
        .custom((value, { req }) => value !== req.body.currentPassword)
        .withMessage('newPassword must be different from currentPassword'),
];

router.patch('/password', updatePasswordValidation, validate, me.updatePassword);

// ─── Wallet ───────────────────────────────────────────────────────────────────

router.get('/wallet', me.getWallet);
router.get('/wallet/transactions', me.getTransactions);

// ─── Products (read-only catalogue) ──────────────────────────────────────────

router.get(
    '/products',
    [
        query('search').optional().isString().trim(),
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 100 }),
    ],
    validate,
    me.getProducts
);

router.get(
    '/products/:id',
    [param('id').isMongoId().withMessage('Invalid product ID')],
    validate,
    me.getProduct
);

// ─── Orders ───────────────────────────────────────────────────────────────────

const createOrderValidation = [
    body('productId')
        .notEmpty().withMessage('productId is required')
        .isMongoId().withMessage('productId must be a valid Mongo ID'),
    body('quantity')
        .optional()
        .isInt({ min: 1 }).withMessage('quantity must be a positive integer'),
];

router.post('/orders', createOrderValidation, validate, me.placeOrder);
router.get('/orders', me.getOrders);
router.get(
    '/orders/:id',
    [param('id').isMongoId().withMessage('Invalid order ID')],
    validate,
    me.getOrder
);

// ─── Deposits ─────────────────────────────────────────────────────────────────

const createDepositValidation = [
    body('requestedAmount')
        .notEmpty().withMessage('requestedAmount is required')
        .isFloat({ gt: 0 }).withMessage('requestedAmount must be a positive number'),
    body('currency')
        .notEmpty().withMessage('currency is required')
        .isString().trim()
        .isLength({ min: 3, max: 3 }).withMessage('currency must be a 3-letter ISO 4217 code')
        .toUpperCase(),
    body('paymentMethodId')
        .notEmpty().withMessage('paymentMethodId is required')
        .isString().trim(),
    body('notes')
        .optional()
        .isString().trim()
        .isLength({ max: 500 }).withMessage('notes cannot exceed 500 characters'),
];

/**
 * @route  POST /api/me/deposits
 * @desc   Submit a deposit request with receipt upload (multi-currency)
 * @access Active user
 * @body   multipart/form-data: requestedAmount, currency, paymentMethodId, receipt (file), notes?
 */
router.post(
    '/deposits',
    depositUpload.single('receipt'),
    createDepositValidation,
    validate,
    me.createDeposit
);

router.get('/deposits', me.getDeposits);
router.get(
    '/deposits/:id',
    [param('id').isMongoId().withMessage('Invalid deposit ID')],
    validate,
    me.getDeposit
);

module.exports = router;
