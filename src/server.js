'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const app = require('./app');
const config = require('./config/config');
const connectDB = require('./config/database');
const fulfillmentJob = require('./modules/orders/fulfillmentJob');
const syncProvidersJob = require('./modules/providers/syncProvidersJob');
const fazerCardsCatalogSyncJob = require('./modules/providers/fazercards/fazercardsCatalogSync.job');
const whatsappNotificationQueue = require('./modules/notifications/whatsapp/whatsappNotification.queue');
const {
    sendReadySignal,
    startBackgroundJobs,
    stopBackgroundJobs,
} = require('./shared/utils/backgroundJobs');

const backgroundJobs = [
    fulfillmentJob,
    syncProvidersJob,
    fazerCardsCatalogSyncJob,
    whatsappNotificationQueue,
];

const startServer = async () => {
    try {
        await connectDB();

        const server = app.listen(config.port, () => {
            console.log('');
            console.log('======================================================');
            console.log('  Digital Products Platform Backend');
            console.log(`  Environment : ${config.env}`);
            console.log(`  Port        : ${config.port}`);
            console.log(`  Base URL    : http://localhost:${config.port}/api`);
            console.log('======================================================');
            console.log('');
            sendReadySignal();
            startBackgroundJobs(backgroundJobs);
        });

        const gracefulShutdown = (signal) => {
            console.log(`\nReceived ${signal}. Shutting down gracefully...`);

            stopBackgroundJobs(backgroundJobs);

            server.close(async () => {
                console.log('HTTP server closed.');
                await mongoose.connection.close();
                console.log('MongoDB connection closed.');
                process.exit(0);
            });

            setTimeout(() => {
                console.error('Graceful shutdown timed out. Forcing exit.');
                process.exit(1);
            }, 10_000);
        };

        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));

        process.on('unhandledRejection', (reason) => {
            console.error('Unhandled Promise Rejection:', reason);
            gracefulShutdown('unhandledRejection');
        });

        process.on('uncaughtException', (error) => {
            console.error('Uncaught Exception:', error);
            process.exit(1);
        });

        return server;
    } catch (error) {
        console.error('Failed to start server:', error.message);
        process.exit(1);
    }
};

startServer();
