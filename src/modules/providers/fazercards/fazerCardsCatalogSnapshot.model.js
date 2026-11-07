'use strict';

const mongoose = require('mongoose');

const CATALOG_SNAPSHOT_STATUSES = Object.freeze({
    COLLECTING: 'collecting',
    COMPLETED: 'completed',
    INVALID: 'invalid',
});

// A snapshot is the audit boundary for absence detection.  It is deliberately
// separate from the cursor job: one page is never a snapshot.
const schema = new mongoose.Schema({
    snapshotId: { type: String, required: true, unique: true, index: true },
    provider: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', required: true, index: true },
    family: { type: String, required: true, uppercase: true, trim: true, index: true },
    ownerJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'FazerCardsCatalogSyncJob', default: null },
    leaseToken: { type: String, default: null, index: true },
    leaseUntil: { type: Date, default: null, index: true },
    status: { type: String, enum: Object.values(CATALOG_SNAPSHOT_STATUSES), default: CATALOG_SNAPSHOT_STATUSES.COLLECTING, index: true },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date, default: null },
    invalidAt: { type: Date, default: null },
    invalidReason: { type: String, default: null, maxlength: 1000 },
    observedCount: { type: Number, default: 0, min: 0 },
}, { timestamps: true, collection: 'fazercardscatalogsnapshots' });

schema.index({ provider: 1, family: 1, status: 1, completedAt: -1 });

const FazerCardsCatalogSnapshot = mongoose.model('FazerCardsCatalogSnapshot', schema);
module.exports = { FazerCardsCatalogSnapshot, CATALOG_SNAPSHOT_STATUSES };
