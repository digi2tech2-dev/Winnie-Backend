'use strict';

const { Review, REVIEW_STATUS } = require('./review.model');
const { Order, ORDER_STATUS } = require('../orders/order.model');
const { AppError, BusinessRuleError, ConflictError, NotFoundError } = require('../../shared/errors/AppError');

const MAX_PUBLIC_LIMIT = 20;
const DEFAULT_PUBLIC_LIMIT = 10;

const sameId = (a, b) => String(a || '') === String(b || '');

const clampLimit = (value, fallback = DEFAULT_PUBLIC_LIMIT, max = MAX_PUBLIC_LIMIT) => {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return Math.min(parsed, max);
};

const clampPage = (value) => {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const normalizeRating = (value) => Math.min(5, Math.max(1, Math.round(Number(value) || 0)));

const maskDisplayName = (name) => {
    const clean = String(name || '').trim().replace(/\s+/g, ' ');
    if (!clean) return 'Winnie Customer';

    const parts = clean.split(' ').filter(Boolean);
    if (parts.length >= 2) {
        return `${parts[0]} ${parts[1][0] || ''}.`.trim();
    }

    if (clean.length <= 2) return `${clean[0] || 'W'}.`;
    return `${clean.slice(0, 2)}***`;
};

const isSafePublicAvatar = (avatar) => {
    const value = String(avatar || '').trim();
    if (!value) return false;
    return value.startsWith('/uploads/avatars/') || value.startsWith('uploads/avatars/');
};

const toPublicReview = (review) => {
    const plain = typeof review.toObject === 'function' ? review.toObject() : review;
    const user = plain.userId && typeof plain.userId === 'object' ? plain.userId : {};
    const avatar = isSafePublicAvatar(user.avatar) ? user.avatar : '';

    return {
        id: String(plain._id || plain.id),
        rating: normalizeRating(plain.rating),
        comment: plain.comment || '',
        createdAt: plain.createdAt,
        verifiedPurchase: plain.verifiedPurchase === true,
        verifiedCustomer: plain.verifiedPurchase === true,
        isFeatured: plain.isFeatured === true,
        reviewer: {
            displayName: maskDisplayName(user.name || user.username),
            avatar,
        },
    };
};

const getPublicReviews = async ({ limit, page, featured } = {}) => {
    const safeLimit = clampLimit(limit);
    const safePage = clampPage(page);
    const query = { status: REVIEW_STATUS.APPROVED };

    if (featured === true || featured === 'true') {
        query.isFeatured = true;
    }

    const [reviews, totalReviews, stats] = await Promise.all([
        Review.find(query)
            .populate('userId', 'name username avatar')
            .sort({ isFeatured: -1, createdAt: -1 })
            .skip((safePage - 1) * safeLimit)
            .limit(safeLimit),
        Review.countDocuments(query),
        Review.aggregate([
            { $match: query },
            { $group: { _id: null, averageRating: { $avg: '$rating' }, totalReviews: { $sum: 1 } } },
        ]),
    ]);

    const aggregate = stats[0] || {};

    return {
        reviews: reviews.map(toPublicReview),
        stats: {
            averageRating: Number((aggregate.averageRating || 0).toFixed(1)),
            totalReviews: aggregate.totalReviews || 0,
        },
        pagination: {
            page: safePage,
            limit: safeLimit,
            total: totalReviews,
            pages: Math.ceil(totalReviews / safeLimit) || 0,
        },
    };
};

const submitReview = async ({ user, orderId, rating, comment }) => {
    const order = await Order.findById(orderId);
    if (!order) {
        throw new NotFoundError('Order');
    }

    if (!sameId(order.userId, user._id || user.id) && user.role !== 'ADMIN') {
        throw new AppError('You can only review your own orders.', 403, 'ORDER_NOT_OWNED');
    }

    if (order.status !== ORDER_STATUS.COMPLETED) {
        throw new BusinessRuleError('Reviews can only be submitted after a completed order.', 'ORDER_NOT_COMPLETED');
    }

    const exists = await Review.findOne({ orderId: order._id, userId: order.userId }).lean();
    if (exists) {
        throw new ConflictError('A review has already been submitted for this order.');
    }

    const review = await Review.create({
        userId: order.userId,
        orderId: order._id,
        productId: order.productId,
        rating: normalizeRating(rating),
        comment: String(comment || '').trim(),
        status: REVIEW_STATUS.PENDING,
        verifiedPurchase: true,
    });

    return review;
};

const listAdminReviews = async ({ status, page, limit } = {}) => {
    const safeLimit = clampLimit(limit, 50, 50);
    const safePage = clampPage(page);
    const query = {};
    if (status && Object.values(REVIEW_STATUS).includes(String(status).toUpperCase())) {
        query.status = String(status).toUpperCase();
    }

    const [reviews, total] = await Promise.all([
        Review.find(query)
            .populate('userId', 'name email username')
            .populate('productId', 'name')
            .sort({ createdAt: -1 })
            .skip((safePage - 1) * safeLimit)
            .limit(safeLimit)
            .lean(),
        Review.countDocuments(query),
    ]);

    return {
        reviews,
        pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            pages: Math.ceil(total / safeLimit) || 0,
        },
    };
};

const moderateReview = async ({ reviewId, status, isFeatured, moderatorId }) => {
    const nextStatus = String(status || '').toUpperCase();
    if (!Object.values(REVIEW_STATUS).includes(nextStatus)) {
        throw new BusinessRuleError('Invalid review status.', 'INVALID_REVIEW_STATUS');
    }

    const review = await Review.findById(reviewId);
    if (!review) {
        throw new NotFoundError('Review');
    }

    review.status = nextStatus;
    if (isFeatured !== undefined) {
        review.isFeatured = isFeatured === true;
    }
    review.moderatedBy = moderatorId || null;
    review.moderatedAt = new Date();

    await review.save();
    return review;
};

module.exports = {
    getPublicReviews,
    submitReview,
    listAdminReviews,
    moderateReview,
    toPublicReview,
};
