'use strict';

/**
 * Idempotent/resumable ProviderProduct search-field backfill.
 *
 * Usage (staging/disposable database only):
 *   MONGO_URI=... node scripts/backfill-provider-product-search.js \
 *     --batch-size=500 --after-id=<last processed _id>
 *
 * The command never deletes or rewrites catalog payloads. Resume by passing
 * the last reported checkpoint as --after-id after an interrupted run.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { ProviderProduct } = require('../src/modules/providers/providerProduct.model');
const { buildProviderProductSearchFields } = require('../src/modules/providers/providerProductSearch');

const parseArg = (name, fallback = null) => {
    const prefix = `--${name}=`;
    const value = process.argv.find((argument) => argument.startsWith(prefix));
    return value ? value.slice(prefix.length) : fallback;
};

const batchSize = Math.min(Math.max(Number.parseInt(parseArg('batch-size', '500'), 10) || 500, 1), 2000);
const afterId = parseArg('after-id');

const main = async () => {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
    if (afterId && !mongoose.Types.ObjectId.isValid(afterId)) throw new Error('--after-id must be a valid ObjectId');

    await mongoose.connect(process.env.MONGO_URI);
    let cursor = afterId ? new mongoose.Types.ObjectId(afterId) : null;
    let processed = 0;

    try {
        while (true) {
            const filter = cursor ? { _id: { $gt: cursor } } : {};
            const products = await ProviderProduct.find(filter)
                .select('_id rawName translatedName externalProductId offerId offerName rawPayload')
                .sort({ _id: 1 })
                .limit(batchSize)
                .lean();
            if (!products.length) break;

            await ProviderProduct.bulkWrite(products.map((product) => ({
                updateOne: {
                    filter: { _id: product._id },
                    update: {
                        $set: buildProviderProductSearchFields(product),
                    },
                },
            })), { ordered: false });

            processed += products.length;
            cursor = products[products.length - 1]._id;
            console.log(JSON.stringify({ processed, checkpoint: String(cursor) }));
        }
    } finally {
        await mongoose.disconnect();
    }
};

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
