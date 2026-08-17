'use strict';

const {
    sendReadySignal,
    shouldStartBackgroundJobs,
    startBackgroundJobs,
} = require('../shared/utils/backgroundJobs');

const createJob = () => {
    let starts = 0;
    return {
        get starts() {
            return starts;
        },
        start: () => {
            starts += 1;
        },
        stop: () => {},
    };
};

const logger = {
    log: jest.fn(),
};

beforeEach(() => {
    logger.log.mockClear();
});

describe('background job startup gating', () => {
    it('BACKGROUND_JOBS_ENABLED=false prevents job startup', () => {
        const job = createJob();
        const decision = startBackgroundJobs([job], {
            env: { BACKGROUND_JOBS_ENABLED: 'false' },
            logger,
        });

        expect(decision.shouldStart).toBe(false);
        expect(decision.reason).toBe('BACKGROUND_JOBS_ENABLED=false');
        expect(job.starts).toBe(0);
    });

    it('starts jobs in a normal non-PM2 node process', () => {
        const job = createJob();
        const decision = startBackgroundJobs([job], {
            env: {},
            logger,
        });

        expect(decision).toMatchObject({
            owner: true,
            reason: 'normal-node-process',
            shouldStart: true,
        });
        expect(job.starts).toBe(1);
    });

    it('starts jobs on PM2 owner instance 0', () => {
        const job = createJob();
        const decision = startBackgroundJobs([job], {
            env: { NODE_APP_INSTANCE: '0', pm_id: '0' },
            logger,
        });

        expect(decision).toMatchObject({
            owner: true,
            reason: 'pm2-owner-instance',
            shouldStart: true,
        });
        expect(job.starts).toBe(1);
    });

    it('skips jobs on non-owner PM2 cluster instances', () => {
        const job = createJob();
        const decision = startBackgroundJobs([job], {
            env: { NODE_APP_INSTANCE: '1', pm_id: '1' },
            logger,
        });

        expect(decision).toMatchObject({
            owner: false,
            reason: 'not-pm2-owner-instance',
            shouldStart: false,
        });
        expect(job.starts).toBe(0);
    });

    it('treats pm_id 0 as owner when NODE_APP_INSTANCE is absent', () => {
        expect(shouldStartBackgroundJobs({ pm_id: '0' })).toMatchObject({
            owner: true,
            shouldStart: true,
        });
    });
});

describe('ready signal', () => {
    it('does not crash outside PM2', () => {
        expect(sendReadySignal({ processRef: {}, logger })).toBe(false);
    });

    it('sends ready when process manager IPC exists', () => {
        const processRef = { send: jest.fn() };

        expect(sendReadySignal({ processRef, logger })).toBe(true);
        expect(processRef.send).toHaveBeenCalledWith('ready');
    });
});
