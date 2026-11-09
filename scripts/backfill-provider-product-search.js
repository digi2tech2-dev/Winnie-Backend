'use strict';

/**
 * Idempotent/resumable ProviderProduct search-field backfill for Luban Play.
 *
 * Usage (staging/disposable database only):
 *   MONGO_URI=... node scripts/backfill-provider-product-search.js \
 *     --batch-size=500 --after-id=<last processed _id> [--dry-run]
 *
 * The command only writes the four normalized search fields. Every write uses
 * the source document's updatedAt as a compare-and-set version, so a supplier
 * sync that changes the source data wins and the backfill retries from fresh
 * data instead of overwriting it.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { Provider } = require('../src/modules/providers/provider.model');
const { ProviderProduct } = require('../src/modules/providers/providerProduct.model');
const { buildProviderProductSearchFields } = require('../src/modules/providers/providerProductSearch');

const LUBAN_PROVIDER_CODE = 'LUBAN_PLAY';
const LUBAN_ADAPTER_TYPE = 'luban-play';
const LUBAN_SLUG = 'luban-play';
const SOURCE_PROJECTION = '_id provider updatedAt rawName translatedName externalProductId offerId offerName rawPayload searchNamePrefixes searchNamePhrases searchIdentifiers searchLookup';
const SEARCH_FIELDS = Object.freeze([
    'searchNamePrefixes',
    'searchNamePhrases',
    'searchIdentifiers',
    'searchLookup',
]);

const parseArg = (name, fallback = null) => {
    const prefix = `--${name}=`;
    const value = process.argv.find((argument) => argument.startsWith(prefix));
    return value === undefined ? fallback : value.slice(prefix.length);
};

const parseBooleanArg = (name) => process.argv.includes(`--${name}`) || parseArg(name) === 'true';

const parseBatchSize = (value) => Math.min(Math.max(Number.parseInt(value, 10) || 500, 1), 2000);

const getMatchedCount = (result) => Number(result?.matchedCount ?? result?.nModified ?? result?.n ?? 0);

const valuesEqual = (left, right) => JSON.stringify(left || []) === JSON.stringify(right || []);

const searchFieldsEqual = (product, fields) => SEARCH_FIELDS.every((field) => valuesEqual(product[field], fields[field]));

/** Resolve exactly one non-deleted Luban Play provider and return its ObjectId. */
const resolveLubanProviderId = async ({ Provider: ProviderModel = Provider, mongoose: mongooseInstance = mongoose } = {}) => {
    const providers = await ProviderModel.find({
        deletedAt: null,
        $or: [
            { providerCode: LUBAN_PROVIDER_CODE },
            { adapterType: LUBAN_ADAPTER_TYPE },
            { slug: LUBAN_SLUG },
        ],
    })
        .select('_id providerCode adapterType slug')
        .lean();

    const ids = [...new Set(providers.map((provider) => String(provider._id)))];
    if (ids.length !== 1) {
        throw new Error(`Expected exactly one active Luban Play provider, found ${ids.length}. Refusing to backfill.`);
    }

    const providerId = ids[0];
    if (!mongooseInstance.Types.ObjectId.isValid(providerId)) {
        throw new Error('Resolved Luban Play provider has an invalid MongoDB ObjectId. Refusing to backfill.');
    }
    return new mongooseInstance.Types.ObjectId(providerId);
};

const findSourceProduct = async (ProviderProductModel, providerId, productId) => ProviderProductModel.findOne({
    _id: productId,
    provider: providerId,
})
    .select(SOURCE_PROJECTION)
    .lean();

/**
 * Update one product with CAS protection. A failed CAS rereads the source and
 * retries, never applying search fields derived from stale supplier data.
 */
const backfillProduct = async ({ ProviderProduct: ProviderProductModel = ProviderProduct, providerId, product, maxRetries = 3 }) => {
    let current = product;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (!current) {
            throw new Error('ProviderProduct disappeared during backfill; checkpoint not advanced.');
        }
        if (!current.updatedAt) {
            throw new Error(`ProviderProduct ${String(current._id)} has no source version; checkpoint not advanced.`);
        }

        const searchFields = buildProviderProductSearchFields(current);
        if (searchFieldsEqual(current, searchFields)) return { applied: false, attempts: attempt + 1 };

        const result = await ProviderProductModel.updateOne(
            {
                _id: current._id,
                provider: providerId,
                updatedAt: current.updatedAt,
            },
            { $set: searchFields },
            { timestamps: false },
        );

        if (getMatchedCount(result) === 1) return { applied: true, attempts: attempt + 1 };
        current = await findSourceProduct(ProviderProductModel, providerId, current._id);
    }

    const conflict = new Error(`Concurrent supplier update prevented backfill for ${String(product._id)}.`);
    conflict.code = 'BACKFILL_CONFLICT';
    throw conflict;
};

const buildProviderFilter = (providerId, cursor) => ({
    provider: providerId,
    ...(cursor ? { _id: { $gt: cursor } } : {}),
});

const runBackfill = async ({
    Provider: ProviderModel = Provider,
    ProviderProduct: ProviderProductModel = ProviderProduct,
    mongoose: mongooseInstance = mongoose,
    batchSize = 500,
    afterId = null,
    dryRun = false,
    maxRetries = 3,
    log = () => {},
} = {}) => {
    const providerId = await resolveLubanProviderId({ Provider: ProviderModel, mongoose: mongooseInstance });
    if (afterId && !mongooseInstance.Types.ObjectId.isValid(afterId)) {
        throw new Error('--after-id must be a valid ObjectId');
    }
    let cursor = afterId ? new mongooseInstance.Types.ObjectId(afterId) : null;
    const filter = buildProviderFilter(providerId, cursor);

    if (dryRun) {
        const targetCount = await ProviderProductModel.countDocuments(filter);
        log(JSON.stringify({ dryRun: true, providerId: String(providerId), targetCount, afterId: cursor ? String(cursor) : null }));
        return { dryRun: true, providerId, targetCount, checkpoint: cursor };
    }

    let processed = 0;
    let applied = 0;

    while (true) {
        const products = await ProviderProductModel.find(buildProviderFilter(providerId, cursor))
            .select(SOURCE_PROJECTION)
            .sort({ _id: 1 })
            .limit(batchSize)
            .lean();
        if (!products.length) break;

        for (const product of products) {
            try {
                const result = await backfillProduct({
                    ProviderProduct: ProviderProductModel,
                    providerId,
                    product,
                    maxRetries,
                });
                processed += 1;
                if (result.applied) applied += 1;
                cursor = product._id;
                log(JSON.stringify({ processed, applied, checkpoint: String(cursor), providerId: String(providerId) }));
            } catch (error) {
                error.checkpoint = cursor ? String(cursor) : null;
                throw error;
            }
        }
    }

    return { dryRun: false, providerId, processed, applied, checkpoint: cursor };
};

const main = async () => {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');

    const rawAfterId = parseArg('after-id');
    if (rawAfterId && !mongoose.Types.ObjectId.isValid(rawAfterId)) throw new Error('--after-id must be a valid ObjectId');

    await mongoose.connect(process.env.MONGO_URI);
    try {
        await runBackfill({
            batchSize: parseBatchSize(parseArg('batch-size', '500')),
            afterId: rawAfterId,
            dryRun: parseBooleanArg('dry-run'),
            maxRetries: parseBatchSize(parseArg('retries', '3')),
            log: (line) => console.log(line),
        });
    } finally {
        await mongoose.disconnect();
    }
};

if (require.main === module) {
    main().catch((error) => {
        console.error(JSON.stringify({
            error: error.message,
            code: error.code || 'BACKFILL_FAILED',
            checkpoint: error.checkpoint ?? null,
        }));
        process.exitCode = 1;
    });
}

module.exports = {
    backfillProduct,
    resolveLubanProviderId,
    runBackfill,
};
