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

        eligibleUntil: {
            type: Date,
            default: null,
            index: true,
        },

        stoppedAt: {
            type: Date,
            default: null,
            index: true,
        },

        stoppedReason: {
            type: String,
            enum: ['promoted_to_sub_agent', 'expired', 'admin_removed', 'other', null],
            default: null,
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

        agentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
            index: true,
        },

        invitedUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'invitedUserId is required'],
            index: true,
        },

        referredUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
            index: true,
        },

        sourceWalletTransactionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'WalletTransaction',
            default: null,
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

        topupAmount: {
            type: Number,
            default: null,
            min: [0, 'topupAmount cannot be negative'],
        },

        sourceCurrency: {
            type: String,
            required: [true, 'sourceCurrency is required'],
            uppercase: true,
            trim: true,
            minlength: 3,
            maxlength: 3,
        },

        topupCurrency: {
            type: String,
            uppercase: true,
            trim: true,
            minlength: 3,
            maxlength: 3,
            default: null,
        },

        sourceTopupAmount: {
            type: Number,
            default: null,
            min: [0, 'sourceTopupAmount cannot be negative'],
        },

        sourceTopupCurrency: {
            type: String,
            uppercase: true,
            trim: true,
            minlength: 3,
            maxlength: 3,
            default: null,
        },

        commissionPercentage: {
            type: Number,
            required: [true, 'commissionPercentage is required'],
            min: [0, 'commissionPercentage cannot be negative'],
            max: [100, 'commissionPercentage cannot exceed 100'],
        },

        commissionPercent: {
            type: Number,
            default: null,
            min: [0, 'commissionPercent cannot be negative'],
            max: [100, 'commissionPercent cannot exceed 100'],
        },

        commissionAmount: {
            type: Number,
            required: [true, 'commissionAmount is required'],
            min: [0, 'commissionAmount cannot be negative'],
        },

        commissionOriginalAmount: {
            type: Number,
            default: null,
            min: [0, 'commissionOriginalAmount cannot be negative'],
        },

        commissionOriginalCurrency: {
            type: String,
            uppercase: true,
            trim: true,
            minlength: 3,
            maxlength: 3,
            default: null,
        },

        commissionCurrency: {
            type: String,
            required: [true, 'commissionCurrency is required'],
            uppercase: true,
            trim: true,
            minlength: 3,
            maxlength: 3,
        },

        referrerCurrency: {
            type: String,
            uppercase: true,
            trim: true,
            minlength: 3,
            maxlength: 3,
            default: null,
        },

        agentCurrency: {
            type: String,
            uppercase: true,
            trim: true,
            minlength: 3,
            maxlength: 3,
            default: null,
        },

        fxRateUsed: {
            type: Number,
            default: null,
            min: [0, 'fxRateUsed cannot be negative'],
        },

        fxSnapshotAt: {
            type: Date,
            default: null,
        },

        fxMetadata: {
            type: mongoose.Schema.Types.Mixed,
            default: undefined,
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

        earnedAt: {
            type: Date,
            default: Date.now,
            index: true,
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

referralCommissionSchema.pre('validate', function syncSubAgentCommissionAliases(next) {
    if (!this.agentId && this.inviterUserId) this.agentId = this.inviterUserId;
    if (!this.referredUserId && this.invitedUserId) this.referredUserId = this.invitedUserId;
    if (this.topupAmount === null || this.topupAmount === undefined) this.topupAmount = this.sourceAmount;
    if (!this.topupCurrency && this.sourceCurrency) this.topupCurrency = this.sourceCurrency;
    if (this.sourceTopupAmount === null || this.sourceTopupAmount === undefined) this.sourceTopupAmount = this.sourceAmount;
    if (!this.sourceTopupCurrency && this.sourceCurrency) this.sourceTopupCurrency = this.sourceCurrency;
    if (this.commissionPercent === null || this.commissionPercent === undefined) {
        this.commissionPercent = this.commissionPercentage;
    }
    if (this.commissionOriginalAmount === null || this.commissionOriginalAmount === undefined) {
        this.commissionOriginalAmount = this.commissionAmount;
    }
    if (!this.commissionOriginalCurrency && this.sourceCurrency) this.commissionOriginalCurrency = this.sourceCurrency;
    if (!this.referrerCurrency && this.commissionCurrency) this.referrerCurrency = this.commissionCurrency;
    if (!this.agentCurrency && this.commissionCurrency) this.agentCurrency = this.commissionCurrency;
    if (this.fxRateUsed === null || this.fxRateUsed === undefined) this.fxRateUsed = 1;
    if (!this.fxSnapshotAt) this.fxSnapshotAt = this.earnedAt || this.createdAt || new Date();
    if (!this.earnedAt) this.earnedAt = this.createdAt || new Date();
    next();
});

referralCommissionSchema.index({ idempotencyKey: 1 }, { unique: true });
referralCommissionSchema.index({ sourceWalletTransactionId: 1 }, {
    unique: true,
    partialFilterExpression: { sourceWalletTransactionId: { $type: 'objectId' } },
});
referralCommissionSchema.index({ sourceType: 1, sourceId: 1 }, {
    unique: true,
    partialFilterExpression: { sourceId: { $type: 'objectId' } },
});
referralCommissionSchema.index({ inviterUserId: 1, createdAt: -1 });
referralCommissionSchema.index({ invitedUserId: 1, createdAt: -1 });
referralCommissionSchema.index({ agentId: 1, earnedAt: -1 });
referralCommissionSchema.index({ referredUserId: 1, earnedAt: -1 });
referralCommissionSchema.index({ status: 1, createdAt: -1 });

const ReferralRelationship = mongoose.model('ReferralRelationship', referralRelationshipSchema);
const ReferralCommission = mongoose.model('ReferralCommission', referralCommissionSchema);

module.exports = {
    ReferralRelationship,
    ReferralCommission,
    SubAgentCommission: ReferralCommission,
};
