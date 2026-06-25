'use strict';

/**
 * PM2 ecosystem configuration.
 *
 * Start: pm2 start ecosystem.config.js --env production
 * Logs:  pm2 logs digital-products-platform-backend
 */
module.exports = {
    apps: [
        {
            name: 'digital-products-platform-backend',
            script: 'src/server.js',
            instances: 'max',
            exec_mode: 'cluster',
            watch: false,
            max_memory_restart: '512M',
            kill_timeout: 5000,
            wait_ready: true,
            listen_timeout: 10000,
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            error_file: './logs/pm2-error.log',
            out_file: './logs/pm2-out.log',
            merge_logs: true,
            env: {
                NODE_ENV: 'development',
                PORT: 5000,
                APP_URL: 'http://localhost:5000',
                FRONTEND_URL: 'http://localhost:5173',
                ALLOWED_ORIGINS: 'http://localhost:5173',
            },
            env_production: {
                NODE_ENV: 'production',
            },
        },
    ],
};
