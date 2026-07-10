'use strict';

/**
 * admin.stats.controller.js - Admin Dashboard Statistics
 */

const { Order, ORDER_STATUS } = require('../orders/order.model');
const { User, USER_STATUS } = require('../users/user.model');
const { Product } = require('../products/product.model');
const { WalletTransaction, TRANSACTION_DIRECTIONS, TRANSACTION_STATUS } = require('../wallet/walletTransaction.model');
const { DepositRequest, DEPOSIT_STATUS } = require('../deposits/deposit.model');
const { Currency } = require('../currency/currency.model');
const { AuditLog } = require('../audit/audit.model');
const { PRODUCT_ACTIONS, ENTITY_TYPES } = require('../audit/audit.constants');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess } = require('../../shared/utils/apiResponse');
const { sanitizePricingForSupervisor } = require('../../shared/utils/priceVisibility');
const { ValidationError } = require('../../shared/errors/AppError');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SUMMARY_RANGE_DAYS = 366;

const parseDateOnly = (value, fieldName) => {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
        throw new ValidationError(`${fieldName} must use YYYY-MM-DD format.`);
    }

    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        throw new ValidationError(`${fieldName} must be a valid date.`);
    }

    return date;
};

const toDateKey = (date) => date.toISOString().slice(0, 10);

const normalizeSummaryRange = (query = {}) => {
    const today = new Date();
    const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const defaultFrom = new Date(todayUtc.getTime() - 9 * DAY_MS);

    const fromDate = parseDateOnly(query.from || query.startDate, 'from') || defaultFrom;
    const toDate = parseDateOnly(query.to || query.endDate, 'to') || todayUtc;

    if (fromDate > toDate) {
        throw new ValidationError('from must be before or equal to to.');
    }

    const days = Math.round((toDate.getTime() - fromDate.getTime()) / DAY_MS) + 1;
    if (days > MAX_SUMMARY_RANGE_DAYS) {
        throw new ValidationError(`Dashboard summary range cannot exceed ${MAX_SUMMARY_RANGE_DAYS} days.`);
    }

    return {
        days,
        from: toDateKey(fromDate),
        fromDate,
        to: toDateKey(toDate),
        toDate,
        toExclusive: new Date(toDate.getTime() + DAY_MS),
    };
};

const previousRangeFor = (range) => {
    const previousToExclusive = new Date(range.fromDate.getTime());
    const previousFromDate = new Date(range.fromDate.getTime() - range.days * DAY_MS);
    const previousToDate = new Date(previousToExclusive.getTime() - DAY_MS);

    return {
        days: range.days,
        from: toDateKey(previousFromDate),
        fromDate: previousFromDate,
        to: toDateKey(previousToDate),
        toDate: previousToDate,
        toExclusive: previousToExclusive,
    };
};

const roundMoney = (value) => Number((Number(value) || 0).toFixed(2));

const changePercent = (current, previous) => {
    const currentValue = Number(current) || 0;
    const previousValue = Number(previous) || 0;
    if (previousValue === 0) return currentValue === 0 ? 0 : null;
    return Number((((currentValue - previousValue) / Math.abs(previousValue)) * 100).toFixed(1));
};

const numberOrZero = (value) => Number(value) || 0;

const countProductMovement = async (range) => {
    const auditMatch = {
        entityType: ENTITY_TYPES.PRODUCT,
        action: { $in: Object.values(PRODUCT_ACTIONS) },
        createdAt: { $gte: range.fromDate, $lt: range.toExclusive },
    };

    const auditCount = await AuditLog.countDocuments(auditMatch);
    if (auditCount > 0) return auditCount;

    return Product.countDocuments({
        deletedAt: null,
        $or: [
            { createdAt: { $gte: range.fromDate, $lt: range.toExclusive } },
            { updatedAt: { $gte: range.fromDate, $lt: range.toExclusive } },
        ],
    });
};

const getOrderSummary = async (range) => {
    const completedMatch = {
        status: ORDER_STATUS.COMPLETED,
        updatedAt: { $gte: range.fromDate, $lt: range.toExclusive },
    };
    const followUpMatch = {
        status: { $in: [ORDER_STATUS.PENDING, ORDER_STATUS.PROCESSING, ORDER_STATUS.MANUAL_REVIEW] },
        createdAt: { $gte: range.fromDate, $lt: range.toExclusive },
    };

    const toNullableDouble = (field) => ({
        $convert: {
            input: field,
            to: 'double',
            onError: null,
            onNull: null,
        },
    });

    const [completedResult, followUpOrders] = await Promise.all([
        Order.aggregate([
            { $match: completedMatch },
            {
                $project: {
                    basePrice: { $ifNull: [toNullableDouble('$basePriceSnapshot'), 0] },
                    profitSnapshot: toNullableDouble('$profitUsd'),
                    quantity: { $ifNull: [toNullableDouble('$quantity'), 1] },
                    rateSnapshot: { $ifNull: [toNullableDouble('$rateSnapshot'), 1] },
                    revenueLocal: { $ifNull: [toNullableDouble('$totalPrice'), 0] },
                    revenueUsdSnapshot: toNullableDouble('$usdAmount'),
                },
            },
            {
                $project: {
                    profitFallback: {
                        $subtract: [
                            {
                                $ifNull: [
                                    '$revenueUsdSnapshot',
                                    {
                                        $cond: [
                                            { $gt: ['$rateSnapshot', 0] },
                                            { $divide: ['$revenueLocal', '$rateSnapshot'] },
                                            '$revenueLocal',
                                        ],
                                    },
                                ],
                            },
                            { $multiply: ['$basePrice', '$quantity'] },
                        ],
                    },
                    revenueUsd: {
                        $ifNull: [
                            '$revenueUsdSnapshot',
                            {
                                $cond: [
                                    { $gt: ['$rateSnapshot', 0] },
                                    { $divide: ['$revenueLocal', '$rateSnapshot'] },
                                    '$revenueLocal',
                                ],
                            },
                        ],
                    },
                    profitSnapshot: 1,
                },
            },
            {
                $group: {
                    _id: null,
                    completedOrders: { $sum: 1 },
                    netProfitUsd: { $sum: { $ifNull: ['$profitSnapshot', '$profitFallback'] } },
                    totalRevenueUsd: { $sum: '$revenueUsd' },
                },
            },
        ]),
        Order.countDocuments(followUpMatch),
    ]);

    const completed = completedResult[0] || {};
    return {
        completedOrders: numberOrZero(completed.completedOrders),
        followUpOrders,
        netProfitUsd: roundMoney(completed.netProfitUsd),
        totalRevenueUsd: roundMoney(completed.totalRevenueUsd),
    };
};

const getActiveUsers = async (range) => {
    // Activity is defined as a customer account with an order or wallet ledger entry
    // in the selected period because the User schema has no lastLoginAt field.
    const [orderUsers, walletUsers] = await Promise.all([
        Order.distinct('userId', {
            createdAt: { $gte: range.fromDate, $lt: range.toExclusive },
        }),
        WalletTransaction.distinct('userId', {
            createdAt: { $gte: range.fromDate, $lt: range.toExclusive },
        }),
    ]);

    return new Set([...orderUsers, ...walletUsers].map((id) => String(id))).size;
};

const getWalletMovementUsd = async (range) => {
    const result = await WalletTransaction.aggregate([
        {
            $match: {
                direction: { $in: [TRANSACTION_DIRECTIONS.CREDIT, TRANSACTION_DIRECTIONS.DEBIT] },
                status: TRANSACTION_STATUS.COMPLETED,
                createdAt: { $gte: range.fromDate, $lt: range.toExclusive },
            },
        },
        {
            $lookup: {
                from: Currency.collection.name,
                localField: 'currency',
                foreignField: 'code',
                as: 'currencyDoc',
            },
        },
        {
            $project: {
                amount: { $abs: '$amount' },
                currency: { $toUpper: { $ifNull: ['$currency', 'USD'] } },
                rate: { $ifNull: [{ $arrayElemAt: ['$currencyDoc.platformRate', 0] }, null] },
            },
        },
        {
            $project: {
                amountUsd: {
                    $cond: [
                        { $eq: ['$currency', 'USD'] },
                        '$amount',
                        {
                            $cond: [
                                { $gt: ['$rate', 0] },
                                { $divide: ['$amount', '$rate'] },
                                0,
                            ],
                        },
                    ],
                },
            },
        },
        { $group: { _id: null, total: { $sum: '$amountUsd' } } },
    ]);

    return roundMoney(result[0]?.total);
};

const getDashboardSummaryForRange = async (range) => {
    const [
        orderSummary,
        activeUsers,
        walletMovementUsd,
        pendingManualOperations,
        productMovement,
    ] = await Promise.all([
        getOrderSummary(range),
        getActiveUsers(range),
        getWalletMovementUsd(range),
        DepositRequest.countDocuments({
            status: DEPOSIT_STATUS.PENDING,
            createdAt: { $gte: range.fromDate, $lt: range.toExclusive },
        }),
        countProductMovement(range),
    ]);

    return {
        ...orderSummary,
        activeUsers,
        pendingManualOperations,
        productMovement,
        walletMovementUsd,
    };
};

const card = (current, previous, { money = false, compare = true } = {}) => ({
    value: money ? roundMoney(current) : numberOrZero(current),
    ...(compare ? { changePercent: changePercent(current, previous) } : {}),
});

const getDashboardStats = catchAsync(async (req, res) => {
    const parseDate = (value, { endOfDay = false } = {}) => {
        if (!value) return null;

        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return null;

        if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
            date.setHours(23, 59, 59, 999);
        }

        return date;
    };

    const startDate = parseDate(req.query.startDate || req.query.from);
    const endDate = parseDate(req.query.endDate || req.query.to, { endOfDay: true });
    const orderMatch = {};

    if (startDate || endDate) {
        orderMatch.createdAt = {
            ...(startDate ? { $gte: startDate } : {}),
            ...(endDate ? { $lte: endDate } : {}),
        };
    }

    const toNumber = (field, fallback = 0) => ({
        $convert: {
            input: { $ifNull: [field, fallback] },
            to: 'double',
            onError: fallback,
            onNull: fallback,
        },
    });

    const roundMoney = (value) => Number((Number(value) || 0).toFixed(2));

    const [orderStatsResult, userStatsResult, productStatsResult] = await Promise.all([
        Order.aggregate([
            { $match: orderMatch },
            {
                $facet: {
                    totals: [
                        {
                            $group: {
                                _id: null,
                                totalOrders: { $sum: 1 },
                                completedOrders: {
                                    $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.COMPLETED] }, 1, 0] },
                                },
                                pendingOrders: {
                                    $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.PENDING] }, 1, 0] },
                                },
                                processingOrders: {
                                    $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.PROCESSING] }, 1, 0] },
                                },
                                pendingProcessingOrders: {
                                    $sum: {
                                        $cond: [
                                            {
                                                $in: [
                                                    '$status',
                                                    [
                                                        ORDER_STATUS.PENDING,
                                                        ORDER_STATUS.PROCESSING,
                                                        ORDER_STATUS.MANUAL_REVIEW,
                                                    ],
                                                ],
                                            },
                                            1,
                                            0,
                                        ],
                                    },
                                },
                                failedOrders: {
                                    $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.FAILED] }, 1, 0] },
                                },
                                canceledOrders: {
                                    $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.CANCELED] }, 1, 0] },
                                },
                                partialOrders: {
                                    $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.PARTIAL] }, 1, 0] },
                                },
                                manualReviewOrders: {
                                    $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.MANUAL_REVIEW] }, 1, 0] },
                                },
                            },
                        },
                    ],
                    financials: [
                        { $match: { status: ORDER_STATUS.COMPLETED } },
                        {
                            $project: {
                                revenue: toNumber('$totalPrice'),
                                revenueUsdSnapshot: toNumber('$usdAmount', null),
                                profitUsdSnapshot: toNumber('$profitUsd', null),
                                quantity: toNumber('$quantity', 1),
                                rateSnapshot: toNumber('$rateSnapshot', 1),
                                basePrice: toNumber('$basePriceSnapshot'),
                            },
                        },
                        {
                            $project: {
                                revenue: 1,
                                rateSnapshot: 1,
                                revenueUsd: {
                                    $ifNull: [
                                        '$revenueUsdSnapshot',
                                        {
                                            $cond: [
                                                { $gt: ['$rateSnapshot', 0] },
                                                { $divide: ['$revenue', '$rateSnapshot'] },
                                                '$revenue',
                                            ],
                                        },
                                    ],
                                },
                                profitUsdSnapshot: 1,
                                netProfit: {
                                    $subtract: [
                                        '$revenue',
                                        { $multiply: ['$basePrice', '$quantity', '$rateSnapshot'] },
                                    ],
                                },
                            },
                        },
                        {
                            $project: {
                                revenue: 1,
                                revenueUsd: 1,
                                netProfit: 1,
                                profitUsd: {
                                    $ifNull: [
                                        '$profitUsdSnapshot',
                                        {
                                            $cond: [
                                                { $gt: ['$rateSnapshot', 0] },
                                                { $divide: ['$netProfit', '$rateSnapshot'] },
                                                '$netProfit',
                                            ],
                                        },
                                    ],
                                },
                            },
                        },
                        {
                            $group: {
                                _id: null,
                                totalRevenue: { $sum: '$revenue' },
                                netProfit: { $sum: '$netProfit' },
                                totalRevenueUsd: { $sum: '$revenueUsd' },
                                totalProfitUsd: { $sum: '$profitUsd' },
                            },
                        },
                    ],
                },
            },
        ]),
        User.aggregate([
            { $match: { deletedAt: null } },
            {
                $group: {
                    _id: null,
                    totalUsers: { $sum: 1 },
                    activeUsers: {
                        $sum: { $cond: [{ $eq: ['$status', USER_STATUS.ACTIVE] }, 1, 0] },
                    },
                    totalWalletBalance: { $sum: { $ifNull: ['$walletBalance', 0] } },
                },
            },
        ]),
        Product.aggregate([
            { $match: { deletedAt: null } },
            {
                $group: {
                    _id: null,
                    totalProducts: { $sum: 1 },
                    activeProducts: {
                        $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] },
                    },
                },
            },
        ]),
    ]);

    const orderStats = orderStatsResult?.[0] || {};
    const totals = orderStats?.totals?.[0] || {};
    const financials = orderStats?.financials?.[0] || {};
    const userStats = userStatsResult?.[0] || {};
    const productStats = productStatsResult?.[0] || {};

    const response = {
        orders: {
            total: totals.totalOrders || 0,
            completed: totals.completedOrders || 0,
            pending: totals.pendingOrders || 0,
            processing: totals.processingOrders || 0,
            pendingProcessing: totals.pendingProcessingOrders || 0,
            failed: totals.failedOrders || 0,
            canceled: totals.canceledOrders || 0,
            partial: totals.partialOrders || 0,
            manualReview: totals.manualReviewOrders || 0,
        },
        financials: {
            totalRevenue: roundMoney(financials.totalRevenue),
            netProfit: roundMoney(financials.netProfit),
            totalRevenueUsd: roundMoney(financials.totalRevenueUsd),
            totalProfitUsd: roundMoney(financials.totalProfitUsd),
        },
        users: {
            total: userStats.totalUsers || 0,
            active: userStats.activeUsers || 0,
            totalWalletBalance: roundMoney(userStats.totalWalletBalance),
        },
        products: {
            total: productStats.totalProducts || 0,
            active: productStats.activeProducts || 0,
        },
    };

    sendSuccess(res, sanitizePricingForSupervisor(response, req.user), 'Dashboard statistics retrieved.');
});

const getDashboardSummary = catchAsync(async (req, res) => {
    const range = normalizeSummaryRange(req.query);
    const previousRange = previousRangeFor(range);

    const [current, previous] = await Promise.all([
        getDashboardSummaryForRange(range),
        getDashboardSummaryForRange(previousRange),
    ]);

    const response = {
        range: {
            from: range.from,
            to: range.to,
        },
        cards: {
            totalRevenueUsd: card(current.totalRevenueUsd, previous.totalRevenueUsd, { money: true }),
            netProfitUsd: card(current.netProfitUsd, previous.netProfitUsd, { money: true }),
            completedOrders: card(current.completedOrders, previous.completedOrders),
            followUpOrders: card(current.followUpOrders, previous.followUpOrders),
            activeUsers: card(current.activeUsers, previous.activeUsers),
            walletMovementUsd: card(current.walletMovementUsd, previous.walletMovementUsd, { money: true, compare: false }),
            pendingManualOperations: card(current.pendingManualOperations, previous.pendingManualOperations, { compare: false }),
            productMovement: card(current.productMovement, previous.productMovement, { compare: false }),
        },
        updatedAt: new Date().toISOString(),
    };

    res.set('Cache-Control', 'no-store');
    sendSuccess(res, response, 'Dashboard summary retrieved.');
});

module.exports = { getDashboardStats, getDashboardSummary };
