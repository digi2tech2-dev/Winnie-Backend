'use strict';

const Decimal = require('decimal.js');
const { Provider } = require('../provider.model');
const { ProviderProduct } = require('../providerProduct.model');
const {
    XenaConnection,
    DEFAULT_XENA_SYNTHETIC_PRODUCT,
} = require('./xenaConnection.model');
const { isXenaProvider, XENA_PROVIDER_CODE } = require('./xena.service');
const { NotFoundError, BusinessRuleError } = require('../../../shared/errors/AppError');

const XENA_PRODUCT_ERROR_CODES = Object.freeze({
    PROVIDER_REQUIRED: 'XENA_PROVIDER_REQUIRED',
    INVALID_PRODUCT_CONFIG: 'XENA_INVALID_PRODUCT_CONFIG',
    SYNTHETIC_PRODUCT_SYNC_FAILED: 'XENA_SYNTHETIC_PRODUCT_SYNC_FAILED',
});

const XENA_SYNTHETIC_EXTERNAL_PRODUCT_ID = DEFAULT_XENA_SYNTHETIC_PRODUCT.externalProductId;
const XENA_SYNTHETIC_PRODUCT_NAME = DEFAULT_XENA_SYNTHETIC_PRODUCT.name;

const TARGET_UID_ORDER_FIELD = Object.freeze({
    key: 'target_uid',
    label: 'Xena ID',
    type: 'text',
    required: true,
    isActive: true,
    verifiable: true,
    validation: {
        digitsOnly: true,
        pattern: 'digits',
        minLength: 1,
        maxLength: 50,
    },
});

const cloneTargetUidOrderField = () => JSON.parse(JSON.stringify(TARGET_UID_ORDER_FIELD));

const invalidConfig = (message) => (
    new BusinessRuleError(message, XENA_PRODUCT_ERROR_CODES.INVALID_PRODUCT_CONFIG)
);

const loadXenaProvider = async (providerOrId) => {
    const looksLikeProviderDocument = providerOrId
        && typeof providerOrId === 'object'
        && providerOrId.constructor?.modelName === 'Provider';
    const provider = looksLikeProviderDocument
        ? providerOrId
        : await Provider.findById(providerOrId);

    if (!provider) throw new NotFoundError('Provider');
    if (!isXenaProvider(provider)) {
        throw new BusinessRuleError('A Xena Recharge provider is required.', XENA_PRODUCT_ERROR_CODES.PROVIDER_REQUIRED);
    }

    return provider;
};

const getOrCreateState = async (provider) => {
    let state = await XenaConnection.findOne({ provider: provider._id });
    if (!state) {
        state = new XenaConnection({ provider: provider._id });
    }
    return state;
};

const normalizeName = (name) => {
    const value = String(name || '').trim();
    if (!value) throw invalidConfig('Xena synthetic product name is required.');
    if (value.length > 180) throw invalidConfig('Xena synthetic product name cannot exceed 180 characters.');
    return value;
};

const normalizePositiveSafeInteger = (value, field) => {
    const number = Number(value);
    if (
        !Number.isSafeInteger(number)
        || number < 1
        || String(value).trim?.() === ''
    ) {
        throw invalidConfig(`${field} must be a positive safe integer.`);
    }
    return number;
};

const normalizeProviderUnitPrice = (value) => {
    if (value === null || value === undefined || String(value).trim() === '') {
        throw invalidConfig('providerUnitPrice is required.');
    }

    const raw = String(value).trim();
    if (!/^\d+(\.\d+)?$/.test(raw)) {
        throw invalidConfig('providerUnitPrice must be a positive decimal string.');
    }

    const decimal = new Decimal(raw);
    if (!decimal.isFinite() || decimal.lte(0)) {
        throw invalidConfig('providerUnitPrice must be positive.');
    }

    return decimal.toFixed();
};

const normalizeBoolean = (value) => {
    if (typeof value !== 'boolean') {
        throw invalidConfig('isActive must be a boolean.');
    }
    return value;
};

const defaultConfig = () => ({
    externalProductId: XENA_SYNTHETIC_EXTERNAL_PRODUCT_ID,
    name: XENA_SYNTHETIC_PRODUCT_NAME,
    minAmount: DEFAULT_XENA_SYNTHETIC_PRODUCT.minAmount,
    maxAmount: DEFAULT_XENA_SYNTHETIC_PRODUCT.maxAmount,
    providerUnitPrice: DEFAULT_XENA_SYNTHETIC_PRODUCT.providerUnitPrice,
    isActive: DEFAULT_XENA_SYNTHETIC_PRODUCT.isActive,
});

const mergeConfig = (state) => ({
    ...defaultConfig(),
    ...(state?.productConfig?.toObject ? state.productConfig.toObject() : state?.productConfig || {}),
    externalProductId: XENA_SYNTHETIC_EXTERNAL_PRODUCT_ID,
});

const validateProductConfig = (config, { requirePrice = true } = {}) => {
    const normalized = {
        externalProductId: XENA_SYNTHETIC_EXTERNAL_PRODUCT_ID,
        name: normalizeName(config.name),
        minAmount: normalizePositiveSafeInteger(config.minAmount, 'minAmount'),
        maxAmount: normalizePositiveSafeInteger(config.maxAmount, 'maxAmount'),
        providerUnitPrice: config.providerUnitPrice,
        isActive: normalizeBoolean(config.isActive),
    };

    if (normalized.maxAmount < normalized.minAmount) {
        throw invalidConfig('maxAmount must be greater than or equal to minAmount.');
    }

    normalized.providerUnitPrice = requirePrice
        ? normalizeProviderUnitPrice(config.providerUnitPrice)
        : (config.providerUnitPrice ? normalizeProviderUnitPrice(config.providerUnitPrice) : null);

    return normalized;
};

const safeConfigResponse = (config) => ({
    externalProductId: XENA_SYNTHETIC_EXTERNAL_PRODUCT_ID,
    name: config.name,
    minAmount: config.minAmount,
    maxAmount: config.maxAmount,
    providerUnitPrice: config.providerUnitPrice,
    isActive: config.isActive,
    orderField: cloneTargetUidOrderField(),
});

const getProductConfig = async ({ provider: providerOrId }) => {
    const provider = await loadXenaProvider(providerOrId);
    const state = await XenaConnection.findOne({ provider: provider._id });
    return safeConfigResponse(mergeConfig(state));
};

const updateProductConfig = async ({ provider: providerOrId, data, updatedBy }) => {
    const provider = await loadXenaProvider(providerOrId);
    const state = await getOrCreateState(provider);
    const merged = {
        ...mergeConfig(state),
        ...data,
        externalProductId: XENA_SYNTHETIC_EXTERNAL_PRODUCT_ID,
    };
    const normalized = validateProductConfig(merged, { requirePrice: true });

    state.productConfig = {
        ...normalized,
        updatedBy: updatedBy || null,
        updatedAt: new Date(),
    };
    await state.save();

    return safeConfigResponse(normalized);
};

const buildSyntheticProductDTO = async ({ provider: providerOrId }) => {
    const provider = await loadXenaProvider(providerOrId);
    const state = await XenaConnection.findOne({ provider: provider._id });
    const config = validateProductConfig(mergeConfig(state), { requirePrice: true });
    const orderField = cloneTargetUidOrderField();

    return {
        externalProductId: XENA_SYNTHETIC_EXTERNAL_PRODUCT_ID,
        rawName: config.name,
        rawPrice: config.providerUnitPrice,
        minQty: config.minAmount,
        maxQty: config.maxAmount,
        isActive: config.isActive,
        currency: null,
        rawPayload: {
            synthetic: true,
            providerCode: XENA_PROVIDER_CODE,
            externalProductId: XENA_SYNTHETIC_EXTERNAL_PRODUCT_ID,
            name: config.name,
            providerUnitPrice: config.providerUnitPrice,
            minAmount: config.minAmount,
            maxAmount: config.maxAmount,
            isActive: config.isActive,
            orderField,
            orderFields: [orderField],
            fields: [orderField],
        },
    };
};

const syncSyntheticProduct = async ({ provider: providerOrId }) => {
    const provider = await loadXenaProvider(providerOrId);

    try {
        const dto = await buildSyntheticProductDTO({ provider });
        const now = new Date();
        const providerProduct = await ProviderProduct.findOneAndUpdate(
            {
                provider: provider._id,
                externalProductId: XENA_SYNTHETIC_EXTERNAL_PRODUCT_ID,
            },
            {
                $set: {
                    rawName: dto.rawName,
                    rawPrice: dto.rawPrice,
                    minQty: dto.minQty,
                    maxQty: dto.maxQty,
                    isActive: dto.isActive,
                    rawPayload: dto.rawPayload,
                    lastSyncedAt: now,
                },
            },
            {
                upsert: true,
                new: true,
                setDefaultsOnInsert: true,
            }
        );

        return {
            providerId: provider._id.toString(),
            externalProductId: XENA_SYNTHETIC_EXTERNAL_PRODUCT_ID,
            providerProduct,
            syncedAt: now.toISOString(),
        };
    } catch (err) {
        if (err instanceof BusinessRuleError && err.code?.startsWith('XENA_')) {
            throw err;
        }
        throw new BusinessRuleError(
            'Failed to sync Xena synthetic product.',
            XENA_PRODUCT_ERROR_CODES.SYNTHETIC_PRODUCT_SYNC_FAILED
        );
    }
};

module.exports = {
    XENA_PRODUCT_ERROR_CODES,
    XENA_SYNTHETIC_EXTERNAL_PRODUCT_ID,
    XENA_SYNTHETIC_PRODUCT_NAME,
    TARGET_UID_ORDER_FIELD,
    getProductConfig,
    updateProductConfig,
    buildSyntheticProductDTO,
    syncSyntheticProduct,
    validateProductConfig,
};
