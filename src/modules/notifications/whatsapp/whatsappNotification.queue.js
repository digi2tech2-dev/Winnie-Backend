'use strict';

const config = require('../../../config/config');
const service = require('./whatsappNotification.service');

let interval = null;
let running = false;

const getPollIntervalMs = () => {
    const configuredSeconds = Number(
        process.env.WHATSAPP_QUEUE_POLL_INTERVAL_SECONDS || config.openwa.queuePollIntervalSeconds || 10
    );
    return Math.max(1, Number.isFinite(configuredSeconds) ? configuredSeconds : 10) * 1000;
};

const tick = async () => {
    if (running) return;
    running = true;
    try {
        await service.processPendingMessages({ limit: 25 });
    } catch (error) {
        const msg = error.message || '';
        if (!msg.includes('client was closed') && !msg.includes('connection was destroyed')) {
            console.error('[WhatsAppQueue] Failed to process queue:', msg);
        }
    } finally {
        running = false;
    }
};

const start = () => {
    if (config.env === 'test' || interval) return;
    interval = setInterval(tick, getPollIntervalMs());
    void tick();
};

const stop = () => {
    if (interval) clearInterval(interval);
    interval = null;
    running = false;
    void service.releaseQueueLock().catch(() => {
        // Best-effort cleanup; an expired lock can be claimed by another worker.
    });
};

module.exports = { getPollIntervalMs, start, stop, tick };
