'use strict';

const mongoose = require('mongoose');

const SYNC_JOB_STATUSES = Object.freeze({
    IDLE: 'idle',
    RUNNING: 'running',
    PAUSED: 'paused',
    RATE_LIMITED: 'rate_limited',
    COMPLETED: 'completed',
    FAILED: 'failed',
});

const fazerCardsCatalogSyncJobSchema = new mongoose.Schema({
    family: { type: String, required: true, uppercase: true, trim: true, unique: true, index: true },
    status: { type: String, enum: Object.values(SYNC_JOB_STATUSES), default: SYNC_JOB_STATUSES.IDLE, index: true },
    currentCursor: { type: String, default: null },
    currentPage: { type: Number, default: 0, min: 0 },
    processedCatalogCount: { type: Number, default: 0, min: 0 },
    processedOfferCount: { type: Number, default: 0, min: 0 },
    importedCount: { type: Number, default: 0, min: 0 },
    pageSize: { type: Number, default: 100, min: 1, max: 100 },
    nextRunAt: { type: Date, default: Date.now, index: true },
    leaseUntil: { type: Date, default: null, index: true },
    safeLastError: { type: String, default: null, maxlength: 1000 },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'fazercardscatalogsyncjobs' });

fazerCardsCatalogSyncJobSchema.index({ status: 1, nextRunAt: 1, leaseUntil: 1 });

const FazerCardsCatalogSyncJob = mongoose.model('FazerCardsCatalogSyncJob', fazerCardsCatalogSyncJobSchema);

module.exports = { FazerCardsCatalogSyncJob, SYNC_JOB_STATUSES };
