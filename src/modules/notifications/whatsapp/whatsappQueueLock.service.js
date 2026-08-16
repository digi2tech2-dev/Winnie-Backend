'use strict';

const os = require('os');
const config = require('../../../config/config');
const { WhatsAppQueueLock } = require('./whatsappQueueLock.model');

const LOCK_NAME = 'whatsapp-notification-queue';

const parsePositiveInt = (value, fallback) => {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getQueueRuntimeConfig = () => ({
    queueEnabled: process.env.WHATSAPP_QUEUE_ENABLED !== undefined
        ? process.env.WHATSAPP_QUEUE_ENABLED !== 'false'
        : config.openwa.queueEnabled !== false,
    workerLockTtlMs: parsePositiveInt(
        process.env.WHATSAPP_WORKER_LOCK_TTL_MS || config.openwa.workerLockTtlMs,
        120000
    ),
    workerHeartbeatMs: parsePositiveInt(
        process.env.WHATSAPP_WORKER_HEARTBEAT_MS || config.openwa.workerHeartbeatMs,
        30000
    ),
    processingStaleAfterMs: parsePositiveInt(
        process.env.WHATSAPP_PROCESSING_STALE_AFTER_MS || config.openwa.processingStaleAfterMs,
        10 * 60 * 1000
    ),
});

const buildOwner = (ownerId = null) => {
    const hostname = os.hostname();
    const pm2InstanceId = process.env.pm_id || process.env.NODE_APP_INSTANCE || null;
    return {
        ownerId: ownerId || [
            hostname,
            `pid:${process.pid}`,
            pm2InstanceId ? `pm2:${pm2InstanceId}` : null,
        ].filter(Boolean).join(':'),
        hostname,
        pid: process.pid,
        pm2InstanceId,
    };
};

const acquireQueueLock = async ({ ownerId = null, ttlMs = null } = {}) => {
    const runtime = getQueueRuntimeConfig();
    if (!runtime.queueEnabled) return null;

    const owner = buildOwner(ownerId);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (ttlMs || runtime.workerLockTtlMs));
    const update = {
        $set: {
            ...owner,
            heartbeatAt: now,
            expiresAt,
        },
    };

    const existing = await WhatsAppQueueLock.findOneAndUpdate(
        {
            name: LOCK_NAME,
            $or: [
                { ownerId: owner.ownerId },
                { expiresAt: { $lte: now } },
            ],
        },
        update,
        { new: true }
    );

    if (existing) return existing;

    try {
        return await WhatsAppQueueLock.create({
            name: LOCK_NAME,
            ...owner,
            heartbeatAt: now,
            expiresAt,
        });
    } catch (error) {
        if (error.code === 11000) return null;
        throw error;
    }
};

const renewQueueLock = async ({ ownerId = null, ttlMs = null } = {}) => {
    const runtime = getQueueRuntimeConfig();
    const owner = buildOwner(ownerId);
    const now = new Date();
    return WhatsAppQueueLock.findOneAndUpdate(
        {
            name: LOCK_NAME,
            ownerId: owner.ownerId,
            expiresAt: { $gt: now },
        },
        {
            $set: {
                heartbeatAt: now,
                expiresAt: new Date(now.getTime() + (ttlMs || runtime.workerLockTtlMs)),
            },
        },
        { new: true }
    );
};

const releaseQueueLock = async ({ ownerId = null } = {}) => {
    const owner = buildOwner(ownerId);
    const result = await WhatsAppQueueLock.deleteOne({
        name: LOCK_NAME,
        ownerId: owner.ownerId,
    });
    return result.deletedCount === 1;
};

module.exports = {
    LOCK_NAME,
    acquireQueueLock,
    buildOwner,
    getQueueRuntimeConfig,
    releaseQueueLock,
    renewQueueLock,
};
