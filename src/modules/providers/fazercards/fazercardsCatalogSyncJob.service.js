'use strict';

const crypto = require('crypto');

const { BusinessRuleError } = require('../../../shared/errors/AppError');
const { getFazerCardsFamily } = require('./fazercardsFamilies');
const {
    syncCatalogFamily,
    invalidateCatalogSnapshot,
    reconcileCompletedCatalogSnapshot,
    repairSourceAvailabilityBlocks,
} = require('./fazercardsCatalog.service');
const { FazerCardsCatalogSyncJob, SYNC_JOB_STATUSES } = require('./fazerCardsCatalogSyncJob.model');
const { FazerCardsCatalogSnapshot, CATALOG_SNAPSHOT_STATUSES } = require('./fazerCardsCatalogSnapshot.model');

const ACTIVE_STATUSES = [SYNC_JOB_STATUSES.IDLE, SYNC_JOB_STATUSES.RUNNING, SYNC_JOB_STATUSES.PAUSED, SYNC_JOB_STATUSES.RATE_LIMITED];
const RUNNABLE_STATUSES = [SYNC_JOB_STATUSES.IDLE, SYNC_JOB_STATUSES.RUNNING, SYNC_JOB_STATUSES.RATE_LIMITED];
const LEASE_MS = 5 * 60 * 1000;
const AUTHORITATIVE_FAMILIES = new Set(['TOPUPS', 'GIFTCARDS', 'GAME_KEYS']);

const safeErrorMessage = (error) => String(
    error?.safeUpstreamMessage || error?.message || 'FazerCards catalog sync failed.'
).replace(/[\r\n]+/g, ' ').slice(0, 1000);

const retryAfterSeconds = (error) => Math.max(
    1,
    Math.ceil(Number(error?.retryAfterSeconds) || 60)
);

const isRateLimited = (error) => (
    Number(error?.statusCode || error?.httpStatus) === 429
    || String(error?.code || '').toUpperCase() === 'FAZERCARDS_RATE_LIMITED'
);

const normalizeFamilies = (families = []) => {
    const values = Array.isArray(families) ? families : [families];
    const normalized = [...new Set(values.map((family) => String(family || '').trim().toUpperCase()).filter(Boolean))];
    if (!normalized.length) throw new BusinessRuleError('At least one FazerCards family is required.', 'FAZERCARDS_SYNC_FAMILY_REQUIRED');

    normalized.forEach((family) => {
        const entry = getFazerCardsFamily(family);
        if (!entry || entry.familyKey === 'UNKNOWN') {
            throw new BusinessRuleError(`Unknown FazerCards catalog family '${family}'.`, 'FAZERCARDS_UNKNOWN_FAMILY');
        }
        if (family === 'STEAM_GIFTS') {
            throw new BusinessRuleError('Steam Gifts bulk catalog sync is disabled; sync an explicit AppID instead.', 'FAZERCARDS_STEAM_GIFTS_ON_DEMAND_ONLY');
        }
        if (entry.catalogAvailable === false) {
            throw new BusinessRuleError(`FazerCards family '${family}' is not available for catalog sync.`, 'FAZERCARDS_FAMILY_UNAVAILABLE');
        }
    });
    return normalized;
};

const summarizeJob = (job) => {
    if (!job) return null;
    const value = typeof job.toObject === 'function' ? job.toObject() : job;
    return {
        id: String(value._id),
        family: value.family,
        status: value.status,
        currentCursor: value.currentCursor || null,
        currentPage: Number(value.currentPage || 0),
        processedCatalogCount: Number(value.processedCatalogCount || 0),
        processedOfferCount: Number(value.processedOfferCount || 0),
        importedCount: Number(value.importedCount || 0),
        reconciledMissingCount: Number(value.reconciledMissingCount || 0),
        confirmedMissingCount: Number(value.confirmedMissingCount || 0),
        nextRunAt: value.nextRunAt || null,
        safeLastError: value.safeLastError || null,
        snapshotId: value.snapshotId || null,
        startedAt: value.startedAt || null,
        completedAt: value.completedAt || null,
        updatedAt: value.updatedAt || null,
    };
};

const getCatalogSyncJobs = async () => {
    const jobs = await FazerCardsCatalogSyncJob.find({}).sort({ family: 1 }).lean();
    return jobs.map(summarizeJob);
};

const startCatalogSyncJobs = async ({ families, family, limit = 100 } = {}) => {
    const normalizedFamilies = normalizeFamilies(families?.length ? families : family);
    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 100);
    const now = new Date();
    const jobs = [];

    for (const familyKey of normalizedFamilies) {
        const existing = await FazerCardsCatalogSyncJob.findOne({ family: familyKey });
        if (existing && ACTIVE_STATUSES.includes(existing.status)) {
            jobs.push(summarizeJob(existing));
            continue;
        }

        const job = await FazerCardsCatalogSyncJob.findOneAndUpdate(
            { family: familyKey },
            {
                $set: {
                    status: SYNC_JOB_STATUSES.IDLE,
                    currentCursor: null,
                    currentPage: 0,
                    processedCatalogCount: 0,
                    processedOfferCount: 0,
                    importedCount: 0,
                    reconciledMissingCount: 0,
                    confirmedMissingCount: 0,
                    pageSize,
                    nextRunAt: now,
                    leaseUntil: null,
                    safeLastError: null,
                    startedAt: now,
                    completedAt: null,
                    leaseToken: null,
                    snapshotId: AUTHORITATIVE_FAMILIES.has(familyKey) ? crypto.randomUUID() : null,
                },
            },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );
        jobs.push(summarizeJob(job));
    }

    return jobs;
};

const claimNextJob = async () => {
    const now = new Date();
    return FazerCardsCatalogSyncJob.findOneAndUpdate(
        {
            status: { $in: RUNNABLE_STATUSES },
            nextRunAt: { $lte: now },
            $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
        },
        {
            $set: {
                status: SYNC_JOB_STATUSES.RUNNING,
                leaseUntil: new Date(now.getTime() + LEASE_MS),
                safeLastError: null,
                leaseToken: crypto.randomUUID(),
            },
        },
        { new: true, sort: { nextRunAt: 1, updatedAt: 1 } }
    );
};

const processCatalogSyncJobPage = async (job, adapterOptions = {}) => {
    try {
        const snapshotId = AUTHORITATIVE_FAMILIES.has(job.family) ? job.snapshotId : null;
        const effectiveLeaseToken = job.leaseToken || crypto.randomUUID();
        if (snapshotId) {
            const completedSnapshot = await FazerCardsCatalogSnapshot.exists({
                snapshotId,
                ownerJobId: job._id,
                status: CATALOG_SNAPSHOT_STATUSES.COMPLETED,
            });
            if (completedSnapshot) {
                return FazerCardsCatalogSyncJob.findOneAndUpdate({ _id: job._id, leaseToken: job.leaseToken }, {
                    $set: { status: SYNC_JOB_STATUSES.COMPLETED, completedAt: new Date(), nextRunAt: null, leaseUntil: null, safeLastError: null },
                }, { new: true });
            }
        }
        const result = await syncCatalogFamily({
            family: job.family,
            cursor: job.currentCursor || undefined,
            limit: job.pageSize,
            maxPages: 1,
            snapshotId,
            snapshotOwnerJobId: job._id,
            snapshotLeaseToken: effectiveLeaseToken,
        }, adapterOptions);

        if (result.snapshotInvalid === true) {
            const error = result.errors?.[0] || 'FazerCards returned an incomplete catalog page; no source removals were reconciled.';
            await invalidateCatalogSnapshot({ snapshotId, reason: error });
            return FazerCardsCatalogSyncJob.findOneAndUpdate({ _id: job._id, leaseToken: job.leaseToken }, {
                $set: { status: SYNC_JOB_STATUSES.FAILED, safeLastError: error, leaseUntil: null, nextRunAt: null },
            }, { new: true });
        }

        const hasMore = result.hasMore === true;
        const nextCursor = result.nextCursor || null;
        if (hasMore && !nextCursor) {
            const error = 'FazerCards reported more catalog pages without a usable next cursor.';
            await invalidateCatalogSnapshot({ snapshotId, reason: error });
            return FazerCardsCatalogSyncJob.findOneAndUpdate({ _id: job._id, leaseToken: job.leaseToken }, {
                $set: { status: SYNC_JOB_STATUSES.FAILED, safeLastError: error, leaseUntil: null, nextRunAt: null },
            }, { new: true });
        }

        const update = {
            currentCursor: nextCursor,
            currentPage: Number(job.currentPage || 0) + Math.max(1, Number(result.pagesFetched || 1)),
            processedCatalogCount: Number(job.processedCatalogCount || 0) + Number(result.categoriesFetched || 0),
            processedOfferCount: Number(job.processedOfferCount || 0) + Number(result.offersFetched || 0),
            importedCount: Number(job.importedCount || 0)
                + Number(result.providerProductsCreated || 0)
                + Number(result.providerProductsUpdated || 0),
            leaseUntil: null,
            safeLastError: null,
            leaseToken: effectiveLeaseToken,
        };

        if (hasMore) {
            update.status = SYNC_JOB_STATUSES.RUNNING;
            update.nextRunAt = new Date();
        } else {
            if (snapshotId) {
                const reconciliation = await reconcileCompletedCatalogSnapshot({
                    providerId: result.providerId,
                    family: job.family,
                    snapshotId,
                    ownerJobId: job._id,
                    leaseToken: effectiveLeaseToken,
                });
                update.reconciledMissingCount = reconciliation.reconciled;
                update.confirmedMissingCount = reconciliation.confirmed;
            }
            update.status = SYNC_JOB_STATUSES.COMPLETED;
            update.completedAt = new Date();
            update.nextRunAt = null;
        }
        return FazerCardsCatalogSyncJob.findOneAndUpdate({ _id: job._id, leaseToken: job.leaseToken }, { $set: update }, { new: true });
    } catch (error) {
        const snapshotId = AUTHORITATIVE_FAMILIES.has(job.family) ? job.snapshotId : null;
        const leaseLost = ['FAZERCARDS_SNAPSHOT_LEASE_LOST', 'FAZERCARDS_SNAPSHOT_LEASE_CONFLICT'].includes(String(error?.code || ''));
        // A stale worker must be a no-op. In particular it must not invalidate
        // the valid snapshot now owned by the replacement worker.
        if (leaseLost) return FazerCardsCatalogSyncJob.findById(job._id);
        await invalidateCatalogSnapshot({ snapshotId, reason: safeErrorMessage(error) });
        if (isRateLimited(error)) {
            const nextRunAt = new Date(Date.now() + (retryAfterSeconds(error) * 1000));
            // A rate-limited run is intentionally restarted from cursor zero
            // with a new snapshot: it can never prove absence.
            return FazerCardsCatalogSyncJob.findOneAndUpdate({ _id: job._id, leaseToken: job.leaseToken }, {
                $set: {
                    status: SYNC_JOB_STATUSES.RATE_LIMITED,
                    nextRunAt,
                    leaseUntil: null,
                    safeLastError: safeErrorMessage(error),
                    currentCursor: null,
                    currentPage: 0,
                    processedCatalogCount: 0,
                    processedOfferCount: 0,
                    importedCount: 0,
                    reconciledMissingCount: 0,
                    confirmedMissingCount: 0,
                    snapshotId: AUTHORITATIVE_FAMILIES.has(job.family) ? crypto.randomUUID() : null,
                },
            }, { new: true });
        }

        return FazerCardsCatalogSyncJob.findOneAndUpdate({ _id: job._id, leaseToken: job.leaseToken }, {
            $set: {
                status: SYNC_JOB_STATUSES.FAILED,
                nextRunAt: null,
                leaseUntil: null,
                safeLastError: safeErrorMessage(error),
            },
        }, { new: true });
    }
};

const runPendingCatalogSyncJobs = async (adapterOptions = {}) => {
    const processed = [];
    await repairSourceAvailabilityBlocks({ limit: 100 });
    // Jobs are intentionally handled one page at a time and serially.
    while (true) {
        const job = await claimNextJob();
        if (!job) break;
        const updated = await processCatalogSyncJobPage(job, adapterOptions);
        processed.push(summarizeJob(updated));
    }
    return processed;
};

module.exports = {
    getCatalogSyncJobs,
    processCatalogSyncJobPage,
    runPendingCatalogSyncJobs,
    startCatalogSyncJobs,
    summarizeJob,
};
