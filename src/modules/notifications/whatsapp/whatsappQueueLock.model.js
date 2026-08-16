'use strict';

const mongoose = require('mongoose');

const whatsappQueueLockSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            unique: true,
            trim: true,
        },
        ownerId: {
            type: String,
            required: true,
            trim: true,
        },
        hostname: {
            type: String,
            trim: true,
            default: null,
        },
        pid: {
            type: Number,
            default: null,
        },
        pm2InstanceId: {
            type: String,
            trim: true,
            default: null,
        },
        heartbeatAt: {
            type: Date,
            required: true,
        },
        expiresAt: {
            type: Date,
            required: true,
            index: true,
        },
    },
    { timestamps: true }
);

const WhatsAppQueueLock = mongoose.model('WhatsAppQueueLock', whatsappQueueLockSchema);

module.exports = { WhatsAppQueueLock };
