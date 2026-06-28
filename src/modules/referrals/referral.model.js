'use strict';

const mongoose = require('mongoose');
const {
    REFERRAL_RELATIONSHIP_STATUS,
    REFERRAL_COMMISSION_STATUS,
    REFERRAL_SOURCE_TYPES,
    ELIGIBLE_REFERRAL_SEMANTIC_TYPES,
} = require('./referral.constants');

const referralRelationshipSchema = new mongoose.Schema(
    {
        inviterUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'inviterUserId is required'],
            index: true,
        },

        invitedUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'invitedUserId is required'],
            unique: true,
        },

        referralCode: {
            type: String,
            required: [true, 'referralCode is required'],
            uppercase: true,
            trim: true,
            index: true,
        },

        status: {
            type: String,
            enum: Object.values(REFERRAL_RELATIONSHIP_STATUS),
            default: REFERRAL_RELATIONSHIP_STATUS.ACTIVE,
            index: true,
        },

        registeredAt: {
            type: Date,
            default: Date.now,
        },

        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: undefined,
        },
    },
    { timestamps: true }
);

referralRelationshipSchema.index({ inviterUserId: 1, createdAt: -1 });

const referralCommissionSchema = new mongoose.Schema(
    {
        inviterUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'inviterUserId is required'],
            index: true,
        },

        invitedUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'invitedUserId is required'],
            index: true,
        },

        sourceWalletTransactionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'WalletTransaction',
            required: [true, 'sourceWalletTransactionId is required'],
            unique: true,
        },

        sourceType: {
            type: String,
            enum: Object.values(REFERRAL_SOURCE_TYPES),
            required: [true, 'sourceType is required'],
            index: true,
        },

        sourceId: {
            type: mongoose.Schema.Types.ObjectId,
            default: null,
            index: true,
        },

        sourceSemanticType: {
            type: String,
            enum: Object.keys(ELIGIBLE_REFERRAL_SEMANTIC_TYPES),
            required: [true, 'sourceSemanticType is required'],
            index: true,
        },

        sourceAmount: {
            type: Number,
            required: [true, 'sourceAmount is required'],
            min: [0, 'sourceAmount cannot be negative'],
        },

        sourceCurrency: {
            type: String,
            required: [true, 'sourceCurrency is required'],
            uppercase: true,
            trim: true,
            minlength: 3,
            maxlength: 3,
        },

        commissionPercentage: {
            type: Number,
            required: [true, 'commissionPercentage is required'],
            min: [0, 'commissionPercentage cannot be negative'],
            max: [100, 'commissionPercentage cannot exceed 100'],
        },

        commissionAmount: {
            type: Number,
            required: [true, 'commissionAmount is required'],
            min: [0, 'commissionAmount cannot be negative'],
        },

        commissionCurrency: {
            type: String,
            required: [true, 'commissionCurrency is required'],
            uppercase: true,
            trim: true,
            minlength: 3,
            maxlength: 3,
        },

        walletTransactionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'WalletTransaction',
            default: null,
            index: true,
        },

        status: {
            type: String,
            enum: Object.values(REFERRAL_COMMISSION_STATUS),
            required: [true, 'status is required'],
            index: true,
        },

        idempotencyKey: {
            type: String,
            required: [true, 'idempotencyKey is required'],
            trim: true,
        },

        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: undefined,
        },

        creditedAt: {
            type: Date,
            default: null,
        },

        reversedAt: {
            type: Date,
            default: null,
        },
    },
    { timestamps: true }
);

referralCommissionSchema.index({ idempotencyKey: 1 }, { unique: true });
referralCommissionSchema.index({ inviterUserId: 1, createdAt: -1 });
referralCommissionSchema.index({ invitedUserId: 1, createdAt: -1 });
referralCommissionSchema.index({ status: 1, createdAt: -1 });

const ReferralRelationship = mongoose.model('ReferralRelationship', referralRelationshipSchema);
const ReferralCommission = mongoose.model('ReferralCommission', referralCommissionSchema);

module.exports = {
    ReferralRelationship,
    ReferralCommission,
};
