'use strict';

process.env.FAZERCARDS_ENABLED = 'true';
process.env.FAZERCARDS_API_KEY = 'test-fazer-key';
process.env.FAZERCARDS_API_BASE_URL = 'https://api.example.test';

const { BusinessRuleError } = require('../shared/errors/AppError');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { FazerCardsCatalogSyncJob } = require('../modules/providers/fazercards/fazerCardsCatalogSyncJob.model');
const {
    processCatalogSyncJobPage,
    startCatalogSyncJobs,
} = require('../modules/providers/fazercards/fazercardsCatalogSyncJob.service');
const { connectTestDB, disconnectTestDB, clearCollections } = require('./testHelpers');

beforeAll(connectTestDB);
afterEach(clearCollections);
afterAll(disconnectTestDB);

describe('FazerCards catalog sync jobs', () => {
    it('keeps Steam Gifts bulk sync disabled', async () => {
        await expect(startCatalogSyncJobs({ family: 'STEAM_GIFTS' }))
            .rejects.toMatchObject({ code: 'FAZERCARDS_STEAM_GIFTS_ON_DEMAND_ONLY' });
    });

    it('persists paginated Gift Cards, pauses on a mid-sync 429, and resumes from its cursor', async () => {
        const client = {
            fetchCatalogPath: jest.fn(async (path, params = {}) => {
                if (path === '/giftcards' && !params.cursor) {
                    return {
                        data: {
                            items: [{ category_id: 'apple-us', name: 'App Store & iTunes' }],
                            meta: { has_more: true, next_cursor: 'giftcards-page-2' },
                        },
                    };
                }
                if (path === '/giftcards/cards' && params.category_id === 'apple-us') {
                    return {
                        data: { offers: [{ card_id: 'apple-10', name: 'US $10', price_usd: '10.00', stock: 10 }] },
                    };
                }
                if (path === '/giftcards' && params.cursor === 'giftcards-page-2') {
                    if (client.failPageTwoOnce) {
                        client.failPageTwoOnce = false;
                        const error = new BusinessRuleError('FazerCards rate limited.', 'FAZERCARDS_RATE_LIMITED');
                        error.statusCode = 429;
                        error.retryAfterSeconds = 11;
                        throw error;
                    }
                    return {
                        data: {
                            items: [{ category_id: 'itunes-ca', name: 'iTunes Canada' }],
                            meta: { has_more: false, next_cursor: null },
                        },
                    };
                }
                if (path === '/giftcards/cards' && params.category_id === 'itunes-ca') {
                    return {
                        data: { offers: [{ card_id: 'itunes-25', name: 'CA $25', price_usd: '25.00', stock: 10 }] },
                    };
                }
                throw new Error(`Unexpected provider call ${path}`);
            }),
            failPageTwoOnce: true,
        };

        await startCatalogSyncJobs({ family: 'GIFTCARDS', limit: 1 });
        let job = await FazerCardsCatalogSyncJob.findOne({ family: 'GIFTCARDS' });

        job = await processCatalogSyncJobPage(job, { client, enabled: true });
        expect(job).toMatchObject({ status: 'running', currentCursor: 'giftcards-page-2', processedCatalogCount: 1, processedOfferCount: 1 });
        expect(await ProviderProduct.countDocuments({ familyKey: 'GIFTCARDS' })).toBe(1);

        job = await processCatalogSyncJobPage(job, { client, enabled: true });
        expect(job.status).toBe('rate_limited');
        expect(job.completedAt).toBeNull();
        expect(job.currentCursor).toBe('giftcards-page-2');

        job.nextRunAt = new Date(Date.now() - 1);
        await job.save();
        job = await processCatalogSyncJobPage(job, { client, enabled: true });

        expect(job).toMatchObject({ status: 'completed', currentPage: 2, processedCatalogCount: 2, processedOfferCount: 2 });
        expect(await ProviderProduct.findOne({ familyKey: 'GIFTCARDS', rawName: /App Store & iTunes/i })).not.toBeNull();
        expect(client.fetchCatalogPath).not.toHaveBeenCalledWith('/steam-gifts/games', expect.anything(), expect.anything());
    });
});
