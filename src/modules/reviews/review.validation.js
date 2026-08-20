'use strict';

const { body, param, query } = require('express-validator');
const { REVIEW_STATUS } = require('./review.model');

const listPublicReviewsValidation = [
    query('page').optional().isInt({ min: 1 }).withMessage('page must be >= 1'),
    query('limit').optional().isInt({ min: 1, max: 20 }).withMessage('limit must be 1-20'),
    query('featured').optional().isBoolean().withMessage('featured must be a boolean'),
];

const submitReviewValidation = [
    body('orderId').notEmpty().withMessage('orderId is required').isMongoId().withMessage('Invalid orderId'),
    body('rating').notEmpty().withMessage('rating is required').isInt({ min: 1, max: 5 }).withMessage('rating must be 1-5'),
    body('comment').optional({ nullable: true }).isString().trim().isLength({ max: 600 }).withMessage('comment must be up to 600 characters'),
];

const listAdminReviewsValidation = [
    query('page').optional().isInt({ min: 1 }).withMessage('page must be >= 1'),
    query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('limit must be 1-50'),
    query('status').optional().isIn(Object.values(REVIEW_STATUS)).withMessage('Invalid review status'),
];

const moderateReviewValidation = [
    param('id').isMongoId().withMessage('Invalid review ID'),
    body('status').notEmpty().withMessage('status is required').isIn(Object.values(REVIEW_STATUS)).withMessage('Invalid review status'),
    body('isFeatured').optional().isBoolean().withMessage('isFeatured must be a boolean'),
];

module.exports = {
    listPublicReviewsValidation,
    submitReviewValidation,
    listAdminReviewsValidation,
    moderateReviewValidation,
};
