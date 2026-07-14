'use strict';

const config = require('../../../config/config');
const service = require('./whatsappNotification.service');

let interval = null;
let running = false;

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
    const delayMs = Math.max(10, Number(config.openwa.retryDelaySeconds || 60)) * 1000;
    interval = setInterval(tick, delayMs);
    void tick();
};

const stop = () => {
    if (interval) clearInterval(interval);
    interval = null;
    running = false;
};

module.exports = { start, stop, tick };
