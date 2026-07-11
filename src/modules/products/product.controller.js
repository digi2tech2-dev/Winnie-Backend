'use strict';

const productService = require('./product.service');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const catchAsync = require('../../shared/utils/catchAsync');
const { sanitizePricingForSupervisor } = require('../../shared/utils/priceVisibility');
const { getConversionRate } = require('../../services/currencyConverter.service');
const { resolveUserPricingGroup } = require('../groups/group.service');
const { calculateFinalPrice, getProductFinalUnitPrice } = require('../orders/pricing.service');
const { buildCustomerPricingFields } = require('./customerPricingPresenter');

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

/**
 * Strip sensitive business fields from a product before sending to customers.
 * Works on both Mongoose documents and plain objects.
 */
const sanitizeProductForCustomer = (product) => {
    if (!product) return product;
    const obj = typeof product.toObject === 'function' ? product.toObject() : { ...product };
    for (const field of SENSITIVE_FIELDS) {
        delete obj[field];
    }
    return obj;
};

const sanitizeProductsForCustomer = (products) =>
    (Array.isArray(products) ? products : []).map(sanitizeProductForCustomer);

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
    const responseProducts = isAdmin ? pricedProducts : sanitizeProductsForCustomer(pricedProducts);
    const safeResponseProducts = sanitizePricingForSupervisor(responseProducts, req.user);
    sendPaginated(res, safeResponseProducts, pagination, 'Products retrieved successfully.');
});

/**
 * GET /api/products/:id
 */
const getProduct = catchAsync(async (req, res) => {
    const product = await productService.getProductById(req.params.id);
    const isAdmin = req.user?.role === 'ADMIN';
    const pricedProduct = isAdmin ? product : await applyCustomerGroupPricing(product, req.user);
    const responseProduct = isAdmin ? pricedProduct : sanitizeProductForCustomer(pricedProduct);
    sendSuccess(res, sanitizePricingForSupervisor(responseProduct, req.user));
});

// ─── Admin only ───────────────────────────────────────────────────────────────

/**
 * POST /api/products
 * Create a standalone product (no provider link).
 */
const createProduct = catchAsync(async (req, res) => {
    const product = await productService.createProduct(req.body, req.user._id);
    sendCreated(res, product, 'Product created successfully.');
});

/**
 * POST /api/products/publish
 * Admin selects a ProviderProduct and publishes it as a platform product.
 * Supports markup configuration, qty override, image override.
 */
const publishProduct = catchAsync(async (req, res) => {
    const product = await productService.publishFromProviderProduct(req.body, req.user._id);
    sendCreated(res, product, 'Product published successfully.');
});

/**
 * PATCH /api/products/:id
 * Update any admin-writable field. Markup-aware price recalculation is
 * applied automatically when needed.
 */
const updateProduct = catchAsync(async (req, res) => {
    const product = await productService.updateProduct(req.params.id, req.body);
    sendSuccess(res, product, 'Product updated successfully.');
});

/**
 * PATCH /api/products/:id/toggle-status
 */
const toggleStatus = catchAsync(async (req, res) => {
    const product = await productService.toggleProductStatus(req.params.id);
    sendSuccess(res, product, `Product ${product.isActive ? 'activated' : 'deactivated'}.`);
});

module.exports = {
    listProducts,
    getProduct,
    createProduct,
    publishProduct,
    updateProduct,
    toggleStatus,
};
