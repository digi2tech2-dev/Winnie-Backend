'use strict';

const reviewService = require('./review.service');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess, sendCreated } = require('../../shared/utils/apiResponse');

const getPublicReviews = catchAsync(async (req, res) => {
    const result = await reviewService.getPublicReviews({
        limit: req.query.limit,
        page: req.query.page,
        featured: req.query.featured,
    });

    sendSuccess(res, result, 'Public reviews retrieved.');
});

const submitReview = catchAsync(async (req, res) => {
    const review = await reviewService.submitReview({
        user: req.user,
        orderId: req.body.orderId,
        rating: req.body.rating,
        comment: req.body.comment,
    });

    sendCreated(res, {
        review: {
            id: review._id,
            rating: review.rating,
            comment: review.comment,
            status: review.status,
            verifiedPurchase: review.verifiedPurchase,
            createdAt: review.createdAt,
        },
    }, 'Review submitted and is pending moderation.');
});

const listAdminReviews = catchAsync(async (req, res) => {
    const result = await reviewService.listAdminReviews(req.query);
    sendSuccess(res, result, 'Reviews retrieved.');
});

const moderateReview = catchAsync(async (req, res) => {
    const review = await reviewService.moderateReview({
        reviewId: req.params.id,
        status: req.body.status,
        isFeatured: req.body.isFeatured,
        moderatorId: req.user?._id,
    });

    sendSuccess(res, { review }, 'Review moderation updated.');
});

module.exports = {
    getPublicReviews,
    submitReview,
    listAdminReviews,
    moderateReview,
};
