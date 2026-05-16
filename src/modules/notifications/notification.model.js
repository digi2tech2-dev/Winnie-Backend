'use strict';

const mongoose = require('mongoose');

const NOTIFICATION_TYPES = Object.freeze({
    SYSTEM: 'system',
    DEPOSIT: 'deposit',
    ORDER: 'order',
    WALLET: 'wallet',
    ACCOUNT: 'account',
    ADMIN: 'admin',
});

const NOTIFICATION_PRIORITIES = Object.freeze({
    LOW: 'low',
    NORMAL: 'normal',
    HIGH: 'high',
});

const notificationSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'Notification userId is required'],
            index: true,
        },

        title: {
            type: String,
            required: [true, 'Notification title is required'],
            trim: true,
            maxlength: [160, 'Notification title cannot exceed 160 characters'],
        },

        message: {
            type: String,
            required: [true, 'Notification message is required'],
            trim: true,
            maxlength: [1000, 'Notification message cannot exceed 1000 characters'],
        },

        type: {
            type: String,
            enum: Object.values(NOTIFICATION_TYPES),
            default: NOTIFICATION_TYPES.SYSTEM,
            index: true,
        },

        priority: {
            type: String,
            enum: Object.values(NOTIFICATION_PRIORITIES),
            default: NOTIFICATION_PRIORITIES.NORMAL,
        },

        isRead: {
            type: Boolean,
            default: false,
            index: true,
        },

        readAt: {
            type: Date,
            default: null,
        },

        route: {
            type: String,
            trim: true,
            default: null,
        },

        entityType: {
            type: String,
            trim: true,
            default: null,
        },

        entityId: {
            type: mongoose.Schema.Types.ObjectId,
            default: null,
        },

        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
    },
    {
        timestamps: true,
    }
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ type: 1, createdAt: -1 });

notificationSchema.pre('save', function (next) {
    if (this.isModified('isRead')) {
        if (this.isRead && !this.readAt) {
            this.readAt = new Date();
        } else if (!this.isRead) {
            this.readAt = null;
        }
    }

    next();
});

const Notification = mongoose.model('Notification', notificationSchema);

module.exports = {
    Notification,
    NOTIFICATION_TYPES,
    NOTIFICATION_PRIORITIES,
};
