'use strict';

/**
 * me.controller.js — User Panel: profile, wallet, orders, products, deposits
 *
 * All handlers operate on the authenticated user (req.user).
 * Ownership isolation: users can ONLY see their own data.
 */

const { User } = require('../users/user.model');
const { WalletTransaction } = require('../wallet/walletTransaction.model');
const userService = require('../users/user.service');
const orderService = require('../orders/order.service');
const depositService = require('../deposits/deposit.service');
const productService = require('../products/product.service');
const { buildCustomerPricingFields } = require('../products/customerPricingPresenter');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');
const { NotFoundError, BusinessRuleError } = require('../../shared/errors/AppError');
const { sanitizePricingForSupervisor } = require('../../shared/utils/priceVisibility');
const { needsGoogleProfileCompletion } = require('../users/googleOnboarding');
const {
    escapeRegex,
    findConfiguredPaymentMethodById,
    mergeSubmittedCustomFieldValues,
    normalizeSubmittedCustomFields,
} = require('../payments/paymentCustomFields');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const parsePage = (v) => Math.max(1, parseInt(v, 10) || 1);
const parseLimit = (v) => Math.min(100, Math.max(1, parseInt(v, 10) || 20));

// =============================================================================
// PROFILE  —  GET /api/me
// =============================================================================

/**
 * Return the authenticated user's full profile including wallet and group info.
 */
const getProfile = catchAsync(async (req, res) => {
    const user = await User.findById(req.user._id)
        .select('-password -__v')
        .populate('groupId', 'name percentage isActive');

    if (!user) throw new NotFoundError('User');

    sendSuccess(res, {
        _id: user._id,
        name: user.name,
        email: user.email,
        username: user.username,
        phone: user.phone,
        country: user.country,
        avatar: user.avatar,
        role: user.role,
        status: user.status,
        verified: user.verified,
        currency: user.currency,
        profileCompletedAt: user.profileCompletedAt,
        needsProfileCompletion: needsGoogleProfileCompletion(user),
        needsOnboarding: needsGoogleProfileCompletion(user),
        identityVerificationRequired: user.identityVerificationRequired === true,
        identityVerificationReason: user.identityVerificationReason || null,
        walletBalance: user.walletBalance,
        group: user.groupId,
        createdAt: user.createdAt,
    }, 'Profile retrieved.');
});

// =============================================================================
// WALLET  —  GET /api/me/wallet
// =============================================================================

/**
 * Wallet summary: balance + last 5 transactions.
 */
/**
 * Update the authenticated user's preferred currency.
 */
const updateCurrency = catchAsync(async (req, res) => {
    const result = await userService.updateMyCurrency(req.user._id, req.body.currency);
    sendSuccess(res, result, 'Currency updated.');
});

/**
 * Securely update the authenticated user's password.
 */
const updatePassword = catchAsync(async (req, res) => {
    await userService.updateMyPassword(req.user._id, {
        currentPassword: req.body.currentPassword,
        newPassword: req.body.newPassword,
    });

    sendSuccess(res, null, 'Password updated successfully.');
});

const getWallet = catchAsync(async (req, res) => {
    const user = await User.findById(req.user._id).select('walletBalance currency creditLimit');
    if (!user) throw new NotFoundError('User');

    const completedFilter = { userId: req.user._id, status: 'COMPLETED' };
    const [recent, aggregates, lastTransaction] = await Promise.all([
        WalletTransaction.find({ userId: req.user._id })
            .sort({ createdAt: -1 })
            .limit(5)
            .populate('reference', 'orderNumber customerInput status totalPrice')
            .lean(),
        WalletTransaction.aggregate([
            { $match: completedFilter },
            {
                $group: {
                    _id: '$type',
                    total: { $sum: '$amount' },
                    count: { $sum: 1 },
                },
            },
        ]),
        WalletTransaction.findOne({ userId: req.user._id }).sort({ createdAt: -1 }).select('createdAt').lean(),
    ]);

    const totalsByType = aggregates.reduce((acc, row) => {
        acc[row._id] = Number(row.total || 0);
        acc.transactionCount += Number(row.count || 0);
        return acc;
    }, { transactionCount: 0 });

    sendSuccess(res, {
        walletBalance: user.walletBalance,
        currency: user.currency,
        recentTransactions: recent,
        lastTransactionAt: lastTransaction?.createdAt || null,
        totalDeposits: totalsByType.CREDIT || 0,
        totalSpent: totalsByType.DEBIT || 0,
        totalRefunds: totalsByType.REFUND || 0,
        transactionCount: totalsByType.transactionCount || 0,
        totalTransactions: totalsByType.transactionCount || 0,
    }, 'Wallet summary retrieved.');
});

// =============================================================================
// WALLET TRANSACTIONS  —  GET /api/me/wallet/transactions
// =============================================================================

/**
 * Paginated transaction history for the authenticated user.
 * Query: page, limit, from/fromDate, to/toDate, search, direction, status, semanticType/type
 */
const getTransactions = catchAsync(async (req, res) => {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const filter = { userId: req.user._id };
    const from = req.query.from || req.query.fromDate;
    const to = req.query.to || req.query.toDate;

    if (from || to) {
        filter.createdAt = {};
        if (from) filter.createdAt.$gte = new Date(from);
        if (to) filter.createdAt.$lte = new Date(to);
    }
    if (req.query.direction) filter.direction = String(req.query.direction).trim().toUpperCase();
    if (req.query.status) filter.status = String(req.query.status).trim().toUpperCase();
    if (req.query.semanticType || req.query.type) {
        const type = String(req.query.semanticType || req.query.type).trim().toUpperCase();
        filter.$and = [
            ...(filter.$and || []),
            { $or: [{ semanticType: type }, { type }] },
        ];
    }
    if (req.query.search && String(req.query.search).trim()) {
        const search = String(req.query.search).trim();
        const regex = new RegExp(escapeRegex(search), 'i');
        filter.$and = [
            ...(filter.$and || []),
            {
                $or: [
                    { description: regex },
                    { reason: regex },
                    { note: regex },
                    { currency: regex },
                    { semanticType: regex },
                    { sourceType: regex },
                ],
            },
        ];
    }

    const skip = (page - 1) * limit;
    const [transactions, total] = await Promise.all([
        WalletTransaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
            .populate('reference', 'orderNumber customerInput status totalPrice').lean(),
        WalletTransaction.countDocuments(filter),
    ]);

    sendPaginated(res, transactions, { page, limit, total, pages: Math.ceil(total / limit) }, 'Transactions retrieved.');
});

// =============================================================================
// ORDERS  —  GET /api/me/orders  |  GET /api/me/orders/:id
// =============================================================================

/**
 * Paginated order list for the authenticated user.
 * Query: status, page, limit, from, to, search, sort
 */
const getOrders = catchAsync(async (req, res) => {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const filter = {
        userId: req.user._id,
        ...(req.query.status && { status: req.query.status }),
    };

    const from = req.query.from || req.query.fromDate;
    const to = req.query.to || req.query.toDate;
    if (from || to) {
        filter.createdAt = {};
        if (from) filter.createdAt.$gte = new Date(from);
        if (to) filter.createdAt.$lte = new Date(to);
    }

    const { Order } = require('../orders/order.model');
    const { Product } = require('../products/product.model');
    if (req.query.search && String(req.query.search).trim()) {
        const search = String(req.query.search).trim();
        const regex = new RegExp(escapeRegex(search), 'i');
        const orConditions = [
            { providerOrderId: regex },
            { providerCode: regex },
            { 'customerInput.values.playerId': regex },
            { 'customerInput.values.player_id': regex },
            { 'customerInput.values.uid': regex },
            { 'customerInput.values.username': regex },
            {
                $expr: {
                    $regexMatch: {
                        input: { $toString: '$orderNumber' },
                        regex: search,
                        options: 'i',
                    },
                },
            },
        ];
        if (/^[a-f\d]{24}$/i.test(search)) orConditions.push({ _id: search });
        const products = await Product.find({
            deletedAt: null,
            $or: [{ name: regex }, { description: regex }, { category: regex }],
        }).select('_id').lean();
        if (products.length) orConditions.push({ productId: { $in: products.map((product) => product._id) } });
        filter.$or = orConditions;
    }
    if (req.query.executionType || req.query.type) {
        filter.executionType = String(req.query.executionType || req.query.type).trim().toLowerCase();
    }

    const orderSort = (() => {
        const sort = String(req.query.sort || '').trim().toLowerCase();
        if (sort === 'oldest' || sort === 'created_asc') return { createdAt: 1 };
        if (sort === 'amount_asc' || sort === 'price_asc') return { chargedAmount: 1, createdAt: -1 };
        if (sort === 'amount_desc' || sort === 'price_desc') return { chargedAmount: -1, createdAt: -1 };
        return { createdAt: -1 };
    })();
    const skip = (page - 1) * limit;
    const [orders, total] = await Promise.all([
        Order.find(filter)
            .sort(orderSort)
            .skip(skip)
            .limit(limit)
            .populate('productId', 'name image')
            .lean(),
        Order.countDocuments(filter),
    ]);

    sendPaginated(res, sanitizePricingForSupervisor(orders, req.user), { page, limit, total, pages: Math.ceil(total / limit) }, 'Orders retrieved.');
});

/**
 * Single order by ID — enforces ownership.
 */
const getOrder = catchAsync(async (req, res) => {
    const order = await orderService.getOrderById(req.params.id, req.user._id);
    sendSuccess(res, sanitizePricingForSupervisor(order, req.user));
});

// =============================================================================
// PLACE ORDER  —  POST /api/me/orders
// =============================================================================

/**
 * Place a new order. Only ACTIVE + verified users can place orders.
 * Balance must be >= order cost (credit system removed).
 */
const placeOrder = catchAsync(async (req, res) => {
    const { productId, quantity, orderFieldsValues, link, target } = req.body;

    // Merge top-level link/target into orderFieldsValues so they always
    // reach customerInput (SMM providers need these as provider params).
    const mergedFields = { ...orderFieldsValues };
    if (link && !mergedFields.link) mergedFields.link = link;
    if (target && !mergedFields.target) mergedFields.target = target;
    const finalFields = Object.keys(mergedFields).length > 0 ? mergedFields : null;

    const auditContext = {
        actorId: req.user._id,
        actorRole: req.user.role,
        ipAddress: req.ip ?? null,
        userAgent: req.get('User-Agent') ?? null,
    };

    const { order, idempotent } = await orderService.createOrder({
        userId: req.user._id,
        productId,
        quantity: parseInt(quantity, 10) || 1,
        idempotencyKey: req.headers['idempotency-key'] || null,
        orderFieldsValues: finalFields,
        auditContext,
    });

    if (idempotent) {
        return sendSuccess(res, sanitizePricingForSupervisor(order, req.user), 'Order already exists (idempotent response).');
    }
    sendCreated(res, sanitizePricingForSupervisor(order, req.user), 'Order placed successfully.');
});

const quoteOrder = catchAsync(async (req, res) => {
    const quote = await orderService.quoteOrder({
        userId: req.user._id,
        productId: req.body.productId,
        quantity: parseInt(req.body.quantity, 10) || 1,
    });

    sendSuccess(res, sanitizePricingForSupervisor(quote, req.user), 'Order quote calculated successfully.');
});

// =============================================================================
// PRODUCTS  —  GET /api/me/products  |  GET /api/me/products/:id
// =============================================================================

/**
 * Public product catalogue for authenticated customers.
 * Prices follow the full pipeline:
 *   1. Base Price (USD from provider)
 *   2. Group Markup: markedUpUSD = productFinalUnitPrice × (1 + group.percentage / 100)
 *   3. Currency Conversion: displayPrice = markedUpUSD × userCurrencyRate
 */
const getProducts = catchAsync(async (req, res) => {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const { Product } = require('../products/product.model');
    const { getConversionRate } = require('../../services/currencyConverter.service');
    const { resolveUserPricingGroup } = require('../groups/group.service');
    const { calculateFinalPrice, getProductFinalUnitPrice } = require('../orders/pricing.service');

    const filter = { isActive: true, visibleInStore: { $ne: false }, deletedAt: null };
    if (req.query.search) {
        filter.$or = [
            { name: { $regex: req.query.search, $options: 'i' } },
            { description: { $regex: req.query.search, $options: 'i' } },
        ];
    }

    const skip = (page - 1) * limit;
    const [products, total] = await Promise.all([
        Product.find(filter)
            .sort({ name: 1 })
            .skip(skip)
            .limit(limit)
            .select('-providerProduct')
            .lean(),
        Product.countDocuments(filter),
    ]);

    // ── 1. Resolve user's group markup ────────────────────────────────────────
    const groupPricing = await resolveUserPricingGroup(req.user);
    const markupPercentage = groupPricing.percentage;

    // ── 2. Resolve user's currency rate ───────────────────────────────────────
    const userCurrency = req.user.currency || 'USD';
    const rate = await getConversionRate(userCurrency);

    // ── 3. Apply pipeline: Base → Markup → Currency ───────────────────────────
    const converted = products.map((p) => {
        const productFinalUnitPriceUsd = getProductFinalUnitPrice(p);
        const markedUpUSD = calculateFinalPrice(productFinalUnitPriceUsd, markupPercentage);
        const pricingFields = buildCustomerPricingFields({
            product: p,
            productFinalUnitPriceUsd,
            groupPercentage: markupPercentage,
            customerUnitPriceUsd: markedUpUSD,
            currency: userCurrency,
            rate,
        });
        return {
            ...p,
            ...pricingFields,
            finalPrice: markedUpUSD,
            sellingPrice: markedUpUSD,
            markedUpPriceUSD: markedUpUSD,
            groupId: groupPricing.groupId,
            groupName: groupPricing.groupName,
            groupPercentage: markupPercentage,
            displayCurrency: userCurrency,
            isPurchasable: p.isPaused !== true
                && p.status !== 'unavailable'
                && p.isAvailableForApi !== false,
        };
    });

    sendPaginated(res, sanitizePricingForSupervisor(converted, req.user), { page, limit, total, pages: Math.ceil(total / limit) }, 'Products retrieved.');
});

/**
 * Single product detail — full pricing pipeline applied.
 */
const getProduct = catchAsync(async (req, res) => {
    const { Product } = require('../products/product.model');
    const { getConversionRate } = require('../../services/currencyConverter.service');
    const { resolveUserPricingGroup } = require('../groups/group.service');
    const { calculateFinalPrice, getProductFinalUnitPrice } = require('../orders/pricing.service');

    const product = await Product.findOne({
        _id: req.params.id,
        isActive: true,
        visibleInStore: { $ne: false },
        deletedAt: null,
    })
        .select('-providerProduct')
        .lean();

    if (!product) throw new NotFoundError('Product');

    // ── 1. Group markup ───────────────────────────────────────────────────────
    const groupPricing = await resolveUserPricingGroup(req.user);
    const markupPercentage = groupPricing.percentage;

    // ── 2. Currency rate ──────────────────────────────────────────────────────
    const userCurrency = req.user.currency || 'USD';
    const rate = await getConversionRate(userCurrency);

    // ── 3. Pipeline: Base → Markup → Currency ─────────────────────────────────
    const productFinalUnitPriceUsd = getProductFinalUnitPrice(product);
    const markedUpUSD = calculateFinalPrice(productFinalUnitPriceUsd, markupPercentage);
    const pricingFields = buildCustomerPricingFields({
        product,
        productFinalUnitPriceUsd,
        groupPercentage: markupPercentage,
        customerUnitPriceUsd: markedUpUSD,
        currency: userCurrency,
        rate,
    });

    sendSuccess(res, sanitizePricingForSupervisor({
        ...product,
        ...pricingFields,
        finalPrice: markedUpUSD,
        sellingPrice: markedUpUSD,
        markedUpPriceUSD: markedUpUSD,
        groupId: groupPricing.groupId,
        groupName: groupPricing.groupName,
        groupPercentage: markupPercentage,
        displayCurrency: userCurrency,
        isPurchasable: product.isPaused !== true
            && product.status !== 'unavailable'
            && product.isAvailableForApi !== false,
    }, req.user));
});

// =============================================================================
// DEPOSITS  —  POST /api/me/deposits  |  GET /api/me/deposits  |  GET /api/me/deposits/:id
// =============================================================================

/**
 * Create a new deposit request.
 * Accepts multipart/form-data with a `receipt` file (via upload middleware).
 * The uploaded file path is stored as `receiptImage`.
 */
const createDeposit = catchAsync(async (req, res) => {
    // ── Validate file upload ─────────────────────────────────────────────
    const uploadedFiles = Array.isArray(req.files) ? req.files : [];
    const receiptFile = req.file || uploadedFiles.find((file) => file.fieldname === 'receipt');
    if (!receiptFile) {
        throw new BusinessRuleError(
            'Receipt image is required. Please upload a file.',
            'RECEIPT_REQUIRED'
        );
    }

    const { requestedAmount, currency, paymentMethodId, notes, antiScamConfirmed, termsAccepted, antiScamConfirmedAt } = req.body;

    // ── Fetch current exchange rate ──────────────────────────────────────
    const { Currency } = require('../currency/currency.model');
    const currencyDoc = await Currency.findOne({
        code: currency.toUpperCase(),
        isActive: true,
    });

    if (!currencyDoc) {
        const { BusinessRuleError } = require('../../shared/errors/AppError');
        throw new BusinessRuleError(
            `Currency '${currency}' is not supported or is inactive.`,
            'INVALID_CURRENCY'
        );
    }

    const exchangeRate = currencyDoc.platformRate;

    // ── Calculate USD equivalent ─────────────────────────────────────────
    const parsedAmount = parseFloat(requestedAmount);
    const amountUsd = Number((parsedAmount / exchangeRate).toFixed(2));

    // ── Build relative receipt path ──────────────────────────────────────
    const receiptImage = `uploads/deposits/${receiptFile.filename}`;
    const { method: paymentMethod } = await findConfiguredPaymentMethodById(paymentMethodId);
    const customFieldFiles = uploadedFiles.reduce((acc, file) => {
        const bracketMatch = String(file.fieldname || '').match(/^customFieldFiles\[([A-Za-z0-9_-]+)\]$/);
        const dottedMatch = String(file.fieldname || '').match(/^customFieldFiles\.([A-Za-z0-9_-]+)$/);
        const key = bracketMatch?.[1] || dottedMatch?.[1] || null;
        if (key) acc[key] = file;
        return acc;
    }, {});
    const validatedCustomFields = normalizeSubmittedCustomFields({
        fieldsConfig: paymentMethod.customFields || [],
        values: mergeSubmittedCustomFieldValues(req.body),
        files: customFieldFiles,
    });

    // ── Persist ──────────────────────────────────────────────────────────
    const deposit = await depositService.createDepositRequest({
        userId: req.user._id,
        paymentMethodId,
        requestedAmount: parsedAmount,
        currency: currency.toUpperCase(),
        exchangeRate,
        amountUsd,
        receiptImage,
        notes: notes || null,
        customFieldSnapshot: validatedCustomFields.customFieldSnapshot,
        customFieldValues: validatedCustomFields.customFieldValues,
        customFieldFiles: validatedCustomFields.customFieldFiles,
        antiScamConfirmed,
        termsAccepted,
        antiScamConfirmedAt,
        auditContext: {
            actorId: req.user._id,
            actorRole: req.user.role,
            ipAddress: req.ip ?? null,
            userAgent: req.get('User-Agent') ?? null,
        },
    });

    sendCreated(res, deposit, 'Deposit request submitted successfully. Pending admin review.');
});

/**
 * List authenticated user's own deposit requests.
 * Query: status, page, limit
 */
const getDeposits = catchAsync(async (req, res) => {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const { status } = req.query;

    const result = await depositService.listMyDeposits(req.user._id, { page, limit, status });
    sendPaginated(res, result.deposits, result.pagination, 'Deposit requests retrieved.');
});

/**
 * Single deposit by ID — user may only see their own.
 */
const getDeposit = catchAsync(async (req, res) => {
    const deposit = await depositService.getDepositById(req.params.id, req.user._id);
    sendSuccess(res, deposit);
});

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    getProfile,
    updateCurrency,
    updatePassword,
    getWallet,
    getTransactions,
    getOrders,
    getOrder,
    placeOrder,
    quoteOrder,
    getProducts,
    getProduct,
    createDeposit,
    getDeposits,
    getDeposit,
};
