'use strict';

const { Router } = require('express');
const reviewController = require('./review.controller');
const {
    listPublicReviewsValidation,
    submitReviewValidation,
    listAdminReviewsValidation,
    moderateReviewValidation,
} = require('./review.validation');
const validate = require('../../shared/middlewares/validate');
const authenticate = require('../../shared/middlewares/authenticate');
const requireActiveUser = require('../../shared/middlewares/requireActiveUser');
const authorize = require('../../shared/middlewares/authorize');
const { authorizeRoles } = authorize;

const publicRouter = Router();
const customerRouter = Router();
const adminRouter = Router();

publicRouter.get('/reviews', listPublicReviewsValidation, validate, reviewController.getPublicReviews);

customerRouter.use(authenticate);
customerRouter.post(
    '/',
    requireActiveUser,
    authorizeRoles('CUSTOMER', 'ADMIN'),
    submitReviewValidation,
    validate,
    reviewController.submitReview
);

adminRouter.use(authenticate, authorize('ADMIN'));
adminRouter.get('/reviews', listAdminReviewsValidation, validate, reviewController.listAdminReviews);
adminRouter.patch('/reviews/:id', moderateReviewValidation, validate, reviewController.moderateReview);

module.exports = { publicRouter, customerRouter, adminRouter };
