'use strict';

const { Product } = require('../../products/product.model');
const { Provider } = require('../provider.model');
const { isXenaProvider, verifyTargetUser, XENA_ERROR_CODES } = require('./xena.service');
const { XENA_SYNTHETIC_EXTERNAL_PRODUCT_ID, XENA_PRODUCT_ERROR_CODES } = require('./xenaProduct.service');
const { NotFoundError, BusinessRuleError } = require('../../../shared/errors/AppError');

const validateTargetUid = (targetUid) => {
    if (typeof targetUid !== 'string') {
        throw new BusinessRuleError('Xena target UID must be a string.', XENA_ERROR_CODES.TARGET_INVALID);
    }

    const value = targetUid.trim();
    if (!/^\d{1,50}$/.test(value)) {
        throw new BusinessRuleError('Xena target UID must contain 1 to 50 digits only.', XENA_ERROR_CODES.TARGET_INVALID);
    }

    return value;
};

const ensureXenaProviderAndProduct = ({ provider, providerProduct }) => {
    if (!provider || !isXenaProvider(provider)) {
        throw new BusinessRuleError('Product is not linked to Xena Recharge.', XENA_PRODUCT_ERROR_CODES.PROVIDER_REQUIRED);
    }

    if (String(providerProduct?.externalProductId || '') !== XENA_SYNTHETIC_EXTERNAL_PRODUCT_ID) {
        throw new BusinessRuleError('Product is not linked to the Xena synthetic recharge product.', XENA_PRODUCT_ERROR_CODES.PROVIDER_REQUIRED);
    }
};

const resolveXenaProductContext = async (productId) => {
    const product = await Product.findById(productId)
        .populate('provider', 'name slug baseUrl apiToken apiKey isActive')
        .populate({
            path: 'providerProduct',
            select: 'externalProductId provider isActive rawPayload',
            populate: { path: 'provider', select: 'name slug baseUrl apiToken apiKey isActive' },
        });

    if (!product) throw new NotFoundError('Product');
    if (!product.providerProduct) {
        throw new BusinessRuleError('Product is not linked to a provider product.', XENA_PRODUCT_ERROR_CODES.PROVIDER_REQUIRED);
    }

    const provider = product.provider || product.providerProduct.provider;
    ensureXenaProviderAndProduct({ provider, providerProduct: product.providerProduct });

    return { product, provider };
};

const verifyProductTargetUid = async ({ productId, targetUid }) => {
    const normalizedTargetUid = validateTargetUid(targetUid);
    const { provider } = await resolveXenaProductContext(productId);
    return verifyTargetUser({ provider, targetUid: normalizedTargetUid });
};

const verifyProviderTargetUid = async ({ provider: providerOrId, targetUid }) => {
    const normalizedTargetUid = validateTargetUid(targetUid);
    const provider = typeof providerOrId === 'object' && providerOrId?.constructor?.modelName === 'Provider'
        ? providerOrId
        : await Provider.findById(providerOrId);

    if (!provider) throw new NotFoundError('Provider');
    if (!isXenaProvider(provider)) {
        throw new BusinessRuleError('A Xena Recharge provider is required.', XENA_PRODUCT_ERROR_CODES.PROVIDER_REQUIRED);
    }

    return verifyTargetUser({ provider, targetUid: normalizedTargetUid });
};

module.exports = {
    validateTargetUid,
    resolveXenaProductContext,
    verifyProductTargetUid,
    verifyProviderTargetUid,
};
