'use strict';

const { runPendingCatalogSyncJobs } = require('./fazercardsCatalogSyncJob.service');

let timer = null;
let running = false;

const runOnce = async (adapterOptions = {}) => {
    if (running) return [];
    running = true;
    try {
        return await runPendingCatalogSyncJobs(adapterOptions);
    } catch (error) {
        console.error('[FazerCardsCatalogSyncJob] Failed to process pending jobs:', error.message);
        return [];
    } finally {
        running = false;
    }
};

const start = (intervalMs = 5_000) => {
    if (process.env.NODE_ENV === 'test' || timer) return;
    timer = setInterval(() => { void runOnce(); }, intervalMs);
    void runOnce();
};

const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
};

module.exports = { runOnce, start, stop };
