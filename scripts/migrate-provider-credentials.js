'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const { Provider } = require('../src/modules/providers/provider.model');
const {
    encryptSecret,
    hasSecretValue,
    isEncryptedSecret,
} = require('../src/shared/utils/secretEncryption');

const CREDENTIAL_FIELDS = ['apiToken', 'apiKey'];

const migrateProviderCredentials = async () => {
    const providers = await Provider.find({});
    const stats = {
        scannedProviders: providers.length,
        updatedProviders: 0,
        encryptedFields: 0,
        skippedEncryptedFields: 0,
        emptyFields: 0,
    };

    for (const provider of providers) {
        let changed = false;

        for (const field of CREDENTIAL_FIELDS) {
            const value = provider[field];

            if (!hasSecretValue(value)) {
                stats.emptyFields += 1;
                continue;
            }

            const trimmed = String(value).trim();
            if (isEncryptedSecret(trimmed)) {
                stats.skippedEncryptedFields += 1;
                continue;
            }

            provider[field] = encryptSecret(trimmed);
            stats.encryptedFields += 1;
            changed = true;
        }

        if (changed) {
            await provider.save();
            stats.updatedProviders += 1;
        }
    }

    return stats;
};

const run = async () => {
    const uri = process.env.MONGO_URI;
    if (!uri) {
        throw new Error('MONGO_URI is required to migrate provider credentials.');
    }

    await mongoose.connect(uri);
    const stats = await migrateProviderCredentials();
    await mongoose.disconnect();

    console.log(
        [
            '[provider-credentials] migration complete',
            `scannedProviders=${stats.scannedProviders}`,
            `updatedProviders=${stats.updatedProviders}`,
            `encryptedFields=${stats.encryptedFields}`,
            `skippedEncryptedFields=${stats.skippedEncryptedFields}`,
            `emptyFields=${stats.emptyFields}`,
        ].join(' ')
    );
};

if (require.main === module) {
    run().catch(async (err) => {
        try {
            await mongoose.disconnect();
        } catch (_) {
            // Ignore disconnect failures during CLI shutdown.
        }

        console.error(`[provider-credentials] migration failed: ${err.message}`);
        process.exit(1);
    });
}

module.exports = {
    migrateProviderCredentials,
};
