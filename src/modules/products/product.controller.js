'use strict';

const productService = require('./product.service');
const xenaTargetService = require('../providers/xena/xenaTarget.service');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');
const { sanitizePricingForSupervisor } = require('../../shared/utils/priceVisibility');
const { getConversionRate } = require('../../services/currencyConverter.service');
const { resolveUserPricingGroup } = require('../groups/group.service');
const { calculateFinalPrice, getProductFinalUnitPrice } = require('../orders/pricing.service');
const { buildCustomerPricingFields } = require('./customerPricingPresenter');
const { NotFoundError } = require('../../shared/errors/AppError');
const fazerCardsContracts = require('../providers/fazercards/fazercardsContracts');

// ─── Sensitive fields that must NEVER reach non-admin clients ─────────────────

const SENSITIVE_FIELDS = [
    'providerPrice',
    'markupType',
    'markupValue',
    'pricingMode',
    'provider',
    'providerProduct',
    'providerMapping',
    'syncPriceWithProvider',
    'enableManualPrice',
    'manualPriceAdjustment',
    'executionType',
    'providerExecutionEnabled',
    'providerExecutionMode',
    'providerExecutionBlocked',
    'providerBlockReason',
    'customerPurchaseEnabled',
    'providerCode',
    'familyKey',
    'fulfillmentMode',
    'providerCategory',
    'providerCategoryName',
    'providerOfferId',
    'providerOfferName',
    'providerRegion',
    'providerPlatform',
    'providerStock',
    'createdBy',
    'deletedAt',
    'internalNotes',
    'syncedProviderBasePrice',
    'supplierId',
    'providerId',
    'externalProductId',
    'externalProductName',
    '__v',
];

const buildFazerCardsCustomerHints = (product = {}) => {
    if (String(product.providerCode || '').trim().toUpperCase() !== 'FAZER_CARDS') return {};

    const fulfillmentMode = String(product.fulfillmentMode || '').trim().toUpperCase();
    const executionMode = String(product.providerExecutionMode || '').trim().toUpperCase();
    const hints = {};

    if (fulfillmentMode === 'CODE_DELIVERY') {
        hints.deliveryType = 'CODE_DELIVERY';
    } else if (executionMode === 'MANUAL_FULFILLMENT') {
        hints.deliveryType = 'MANUAL_FULFILLMENT';
    } else {
        hints.deliveryType = 'DIGITAL_SERVICE';
    }
    if (executionMode === 'AUTO_PROVIDER') {
        hints.fulfillmentNotice = 'سيتم تنفيذ الطلب تلقائياً من المورد.';
    } else if (executionMode === 'MANUAL_FULFILLMENT') {
        hints.fulfillmentNotice = 'سيتم تنفيذ طلبك بواسطة فريقنا في أسرع وقت.';
    }

    const manualFieldValidation = fazerCardsContracts.validateManualCustomerFieldsForProduct({ product });
    if (!manualFieldValidation.ok) {
        hints.purchaseDisabled = true;
        hints.purchaseUnavailableReason = 'هذا المنتج غير متاح مؤقتاً حتى اكتمال الإعداد.';
    }

    if (product.providerRegion && !product.region) hints.region = product.providerRegion;
    if (product.providerPlatform && !product.platform) hints.platform = product.providerPlatform;
    return hints;
};

/**
 * Strip sensitive business fields from a product before sending to customers.
 * Works on both Mongoose documents and plain objects.
 */
const sanitizeProductForCustomer = (product) => {
    if (!product) return product;
    const obj = typeof product.toObject === 'function' ? product.toObject() : { ...product };
    const customerHints = buildFazerCardsCustomerHints(obj);
    for (const field of SENSITIVE_FIELDS) {
        delete obj[field];
    }
    return { ...obj, ...customerHints };
};

const sanitizeProductsForCustomer = (products) =>
    (Array.isArray(products) ? products : []).map(sanitizeProductForCustomer);

const assertProductVisibleToCustomer = (product) => {
    const obj = product && typeof product.toObject === 'function' ? product.toObject() : product;
    if (
        !obj
        || obj.isActive !== true
        || obj.visibleInStore === false
        || obj.deletedAt
    ) {
        throw new NotFoundError('Product');
    }
    if (
        String(obj.providerCode || '').trim().toUpperCase() === 'FAZER_CARDS'
        && (obj.customerPurchaseEnabled !== true || obj.status !== 'available')
    ) {
        throw new NotFoundError('Product');
    }
};

const applyCustomerGroupPricing = async (products, user) => {
    const list = Array.isArray(products) ? products : [products];
    const groupPricing = await resolveUserPricingGroup(user);
    const userCurrency = user?.currency || 'USD';
    const rate = await getConversionRate(userCurrency);

    const priced = list.map((product) => {
        const obj = typeof product.toObject === 'function' ? product.toObject() : { ...product };
        const productFinalUnitPriceUsd = getProductFinalUnitPrice(obj);
        const customerUnitPriceUsd = calculateFinalPrice(productFinalUnitPriceUsd, groupPricing.percentage);
        const pricingFields = buildCustomerPricingFields({
            product: obj,
            productFinalUnitPriceUsd,
            groupPercentage: groupPricing.percentage,
            customerUnitPriceUsd,
            currency: userCurrency,
            rate,
        });

        return {
            ...obj,
            ...pricingFields,
            finalPrice: customerUnitPriceUsd,
            sellingPrice: customerUnitPriceUsd,
            markedUpPriceUSD: customerUnitPriceUsd,
            groupId: groupPricing.groupId,
            groupName: groupPricing.groupName,
            groupPercentage: groupPricing.percentage,
            displayCurrency: userCurrency,
        };
    });

    return Array.isArray(products) ? priced : priced[0];
};

// ─── User-facing ──────────────────────────────────────────────────────────────

/**
 * GET /api/products
 * Customers see only active products; admins see everything.
 */
const listProducts = catchAsync(async (req, res) => {
    const isAdmin = req.user?.role === 'ADMIN';
    const activeOnly = !isAdmin;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const { products, pagination } = await productService.listProducts({ activeOnly, page, limit });

    const pricedProducts = isAdmin ? products : await applyCustomerGroupPricing(products, req.user);
    const responseProducts = isAdmin
        ? productService.attachCustomerVisibilityStatus(pricedProducts)
        : sanitizeProductsForCustomer(pricedProducts);
    const safeResponseProducts = sanitizePricingForSupervisor(responseProducts, req.user);
    sendPaginated(res, safeResponseProducts, pagination, 'Products retrieved successfully.');
});

/**
 * GET /api/products/:id
 */
const getProduct = catchAsync(async (req, res) => {
    const product = await productService.getProductById(req.params.id);
    const isAdmin = req.user?.role === 'ADMIN';
    if (!isAdmin) assertProductVisibleToCustomer(product);
    const pricedProduct = isAdmin ? product : await applyCustomerGroupPricing(product, req.user);
    const responseProduct = isAdmin
        ? productService.attachCustomerVisibilityStatus(pricedProduct)
        : sanitizeProductForCustomer(pricedProduct);
    sendSuccess(res, sanitizePricingForSupervisor(responseProduct, req.user));
});

const verifyTarget = catchAsync(async (req, res) => {
    const result = await xenaTargetService.verifyProductTargetUid({
        productId: req.params.id,
        targetUid: req.body.targetUid,
    });
    sendSuccess(res, result, 'Target verified successfully.');
});

// ─── Admin only ───────────────────────────────────────────────────────────────

/**
 * POST /api/products
 * Create a standalone product (no provider link).
 */
const createProduct = catchAsync(async (req, res) => {
    const product = await productService.createProduct(req.body, req.user._id);
    sendCreated(res, productService.attachCustomerVisibilityStatus(product), 'Product created successfully.');
});

/**
 * POST /api/products/publish
 * Admin selects a ProviderProduct and publishes it as a platform product.
 * Supports markup configuration, qty override, image override.
 */
const publishProduct = catchAsync(async (req, res) => {
    const product = await productService.publishFromProviderProduct(req.body, req.user._id);
    sendCreated(res, productService.attachCustomerVisibilityStatus(product), 'Product published successfully.');
});

/**
 * PATCH /api/products/:id
 * Update any admin-writable field. Markup-aware price recalculation is
 * applied automatically when needed.
 */
const updateProduct = catchAsync(async (req, res) => {
    const product = await productService.updateProduct(req.params.id, req.body);
    sendSuccess(res, productService.attachCustomerVisibilityStatus(product), 'Product updated successfully.');
});

/**
 * PATCH /api/products/:id/toggle-status
 */
const toggleStatus = catchAsync(async (req, res) => {
    const product = await productService.toggleProductStatus(req.params.id);
    sendSuccess(res, productService.attachCustomerVisibilityStatus(product), `Product ${product.isActive ? 'activated' : 'deactivated'}.`);
});

module.exports = {
    listProducts,
    getProduct,
    verifyTarget,
    createProduct,
    publishProduct,
    updateProduct,
    toggleStatus,
};
