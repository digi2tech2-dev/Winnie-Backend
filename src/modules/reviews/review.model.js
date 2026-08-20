'use strict';

const mongoose = require('mongoose');

const REVIEW_STATUS = Object.freeze({
    PENDING: 'PENDING',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
});

const reviewSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'User ID is required'],
            index: true,
        },
        orderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Order',
            required: [true, 'Order ID is required'],
            index: true,
        },
        productId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
            required: [true, 'Product ID is required'],
            index: true,
        },
        rating: {
            type: Number,
            required: [true, 'Rating is required'],
            min: [1, 'Rating must be at least 1'],
            max: [5, 'Rating cannot exceed 5'],
        },
        comment: {
            type: String,
            trim: true,
            maxlength: [600, 'Comment cannot exceed 600 characters'],
            default: '',
        },
        status: {
            type: String,
            enum: Object.values(REVIEW_STATUS),
            default: REVIEW_STATUS.PENDING,
            index: true,
        },
        isFeatured: {
            type: Boolean,
            default: false,
            index: true,
        },
        moderatedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
        moderatedAt: {
            type: Date,
            default: null,
        },
        verifiedPurchase: {
            type: Boolean,
            default: true,
        },
    },
    {
        timestamps: true,
    }
);

reviewSchema.index({ orderId: 1, userId: 1 }, { unique: true, name: 'unique_review_per_order_user' });
reviewSchema.index({ status: 1, isFeatured: 1, createdAt: -1 });

const Review = mongoose.model('Review', reviewSchema);

module.exports = { Review, REVIEW_STATUS };
