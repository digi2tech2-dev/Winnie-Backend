'use strict';

const mongoose = require('mongoose');
const {
    GROUP_REQUEST_TYPES,
    GROUP_REQUEST_STATUS,
} = require('./groupRequest.constants');

const snapshotSchema = {
    type: mongoose.Schema.Types.Mixed,
    default: undefined,
};

const groupChangeRequestSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'userId is required'],
            index: true,
        },

        requestType: {
            type: String,
            enum: Object.values(GROUP_REQUEST_TYPES),
            required: [true, 'requestType is required'],
            index: true,
        },

        status: {
            type: String,
            enum: Object.values(GROUP_REQUEST_STATUS),
            default: GROUP_REQUEST_STATUS.PENDING,
            index: true,
        },

        currentGroupId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Group',
            default: null,
        },

        requestedGroupId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Group',
            default: null,
            index: true,
        },

        approvedGroupId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Group',
            default: null,
        },

        approvedCommissionPercent: {
            type: Number,
            default: null,
            min: [0, 'approvedCommissionPercent cannot be negative'],
            max: [100, 'approvedCommissionPercent cannot exceed 100'],
        },

        reason: {
            type: String,
            trim: true,
            maxlength: [1000, 'reason cannot exceed 1000 characters'],
            default: null,
        },

        adminNote: {
            type: String,
            trim: true,
            maxlength: [1000, 'adminNote cannot exceed 1000 characters'],
            default: null,
        },

        reviewedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
            index: true,
        },

        reviewedAt: {
            type: Date,
            default: null,
        },

        canceledAt: {
            type: Date,
            default: null,
        },

        userSnapshot: snapshotSchema,
        currentGroupSnapshot: snapshotSchema,
        requestedGroupSnapshot: snapshotSchema,
        approvedGroupSnapshot: snapshotSchema,

        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: undefined,
        },
    },
    { timestamps: true }
);

groupChangeRequestSchema.index({ userId: 1, createdAt: -1 });
groupChangeRequestSchema.index({ status: 1, createdAt: -1 });
groupChangeRequestSchema.index({ requestType: 1, status: 1, createdAt: -1 });
groupChangeRequestSchema.index({ requestedGroupId: 1, status: 1 });
groupChangeRequestSchema.index({ reviewedBy: 1, reviewedAt: -1 });
groupChangeRequestSchema.index(
    { userId: 1, requestType: 1 },
    {
        unique: true,
        partialFilterExpression: { status: GROUP_REQUEST_STATUS.PENDING },
    }
);

const GroupChangeRequest = mongoose.model('GroupChangeRequest', groupChangeRequestSchema);

module.exports = {
    GroupChangeRequest,
};
