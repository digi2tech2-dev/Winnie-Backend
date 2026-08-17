'use strict';

const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

const isBackgroundJobsEnabled = (env = process.env) => (
    !FALSE_VALUES.has(String(env.BACKGROUND_JOBS_ENABLED ?? 'true').trim().toLowerCase())
);

const getPm2InstanceIds = (env = process.env) => ({
    nodeAppInstance: env.NODE_APP_INSTANCE ?? null,
    pmId: env.pm_id ?? null,
});

const isPm2Process = (env = process.env) => {
    const ids = getPm2InstanceIds(env);
    return ids.nodeAppInstance !== null || ids.pmId !== null;
};

const isPm2Owner = (env = process.env) => {
    const ids = getPm2InstanceIds(env);
    return ids.nodeAppInstance === '0' || ids.pmId === '0';
};

const shouldStartBackgroundJobs = (env = process.env) => {
    if (!isBackgroundJobsEnabled(env)) {
        return {
            owner: false,
            reason: 'BACKGROUND_JOBS_ENABLED=false',
            shouldStart: false,
        };
    }

    if (!isPm2Process(env)) {
        return {
            owner: true,
            reason: 'normal-node-process',
            shouldStart: true,
        };
    }

    if (isPm2Owner(env)) {
        return {
            owner: true,
            reason: 'pm2-owner-instance',
            shouldStart: true,
        };
    }

    return {
        owner: false,
        reason: 'not-pm2-owner-instance',
        shouldStart: false,
    };
};

const startBackgroundJobs = (jobs = [], { env = process.env, logger = console } = {}) => {
    const decision = shouldStartBackgroundJobs(env);
    const ids = getPm2InstanceIds(env);
    const instanceLabel = isPm2Process(env)
        ? `NODE_APP_INSTANCE=${ids.nodeAppInstance ?? '-'} pm_id=${ids.pmId ?? '-'}`
        : 'non-PM2';

    if (!decision.shouldStart) {
        logger.log(`[BackgroundJobs] Skipped (${decision.reason}; ${instanceLabel}).`);
        return decision;
    }

    logger.log(`[BackgroundJobs] Enabled; starting on owner (${decision.reason}; ${instanceLabel}).`);
    jobs.forEach((job) => job.start());
    return decision;
};

const stopBackgroundJobs = (jobs = []) => {
    jobs.forEach((job) => job.stop());
};

const sendReadySignal = ({ processRef = process, logger = console } = {}) => {
    if (typeof processRef.send !== 'function') return false;
    processRef.send('ready');
    logger.log('[Server] Ready signal sent to process manager.');
    return true;
};

module.exports = {
    isBackgroundJobsEnabled,
    sendReadySignal,
    shouldStartBackgroundJobs,
    startBackgroundJobs,
    stopBackgroundJobs,
};
