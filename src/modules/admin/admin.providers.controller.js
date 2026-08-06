'use strict';

/**
 * admin.providers.controller.js
 */

const svc = require('./admin.providers.service');
const xenaSvc = require('../providers/xena/xena.service');
const xenaProductSvc = require('../providers/xena/xenaProduct.service');
const xenaTargetSvc = require('../providers/xena/xenaTarget.service');
const fazerCardsCatalogSvc = require('../providers/fazercards/fazercardsCatalog.service');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const { sanitizePricingForSupervisor } = require('../../shared/utils/priceVisibility');

// GET /admin/providers
const listProviders = catchAsync(async (req, res) => {
    const providers = await svc.listProviders({
        includeInactive: req.query.includeInactive !== 'false',
    });
    sendSuccess(res, { providers }, 'Providers retrieved');
});

// GET /admin/providers/:id
const getProviderById = catchAsync(async (req, res) => {
    const provider = await svc.getProviderById(req.params.id);
    sendSuccess(res, { provider }, 'Provider retrieved');
});

// POST /admin/providers
const createProvider = catchAsync(async (req, res) => {
    const provider = await svc.createProvider(req.body, req.user._id);
    sendCreated(res, { provider }, 'Provider created');
});

// PATCH /admin/providers/:id
const updateProvider = catchAsync(async (req, res) => {
    const provider = await svc.updateProvider(req.params.id, req.body, req.user._id);
    sendSuccess(res, { provider }, 'Provider updated');
});

// DELETE /admin/providers/:id
const deleteProvider = catchAsync(async (req, res) => {
    const provider = await svc.deleteProvider(req.params.id, req.user._id);
    sendSuccess(res, { provider }, 'Provider deleted');
});

// PATCH /admin/providers/:id/toggle
const toggleProvider = catchAsync(async (req, res) => {
    const provider = await svc.toggleProvider(req.params.id, req.user._id);
    sendSuccess(res, { provider, isActive: provider.isActive }, 'Provider toggled');
});

// GET /admin/providers/:id/balance
const getProviderBalance = catchAsync(async (req, res) => {
    const data = await svc.getProviderBalance(req.params.id);
    sendSuccess(res, data, 'Provider balance retrieved');
});

// GET /admin/providers/:id/products
const getProviderLiveProducts = catchAsync(async (req, res) => {
    const data = await svc.getProviderLiveProducts(req.params.id);
    sendSuccess(res, sanitizePricingForSupervisor(data, req.user), 'Provider products retrieved');
});

// POST /admin/providers/:id/test-connection
const testProviderConnection = catchAsync(async (req, res) => {
    const data = await svc.testProviderConnection(req.params.id);
    sendSuccess(res, data, data.success ? 'Connection successful' : 'Connection failed');
});

// GET /admin/providers/:providerId/products/:externalProductId/price
const getProductPrice = catchAsync(async (req, res) => {
    const data = await svc.getProductPrice(req.params.providerId, req.params.externalProductId);
    sendSuccess(res, sanitizePricingForSupervisor(data, req.user), data.found ? 'Price retrieved' : 'Product not found in provider catalog');
});

// GET /admin/providers/:id/check-order?orderId=123
const checkProviderOrder = catchAsync(async (req, res) => {
    const data = await svc.checkProviderOrder(req.params.id, req.query.orderId);
    sendSuccess(res, sanitizePricingForSupervisor(data, req.user), 'Order status retrieved');
});

const challengeXenaConnection = catchAsync(async (req, res) => {
    const data = await xenaSvc.challengeConnection({
        provider: req.params.id,
        displayName: req.body.displayName,
        username: req.body.username,
        password: req.body.password,
    });
    sendSuccess(res, data, 'Xena challenge started');
});

const reconnectXenaConnection = catchAsync(async (req, res) => {
    const data = await xenaSvc.reconnectConnection({
        provider: req.params.id,
        displayName: req.body.displayName,
        username: req.body.username,
        password: req.body.password,
    });
    sendSuccess(res, data, 'Xena reconnect challenge started');
});

const verifyXenaConnection = catchAsync(async (req, res) => {
    const data = await xenaSvc.verifyConnection({
        provider: req.params.id,
        code: req.body.code,
    });
    sendSuccess(res, data, 'Xena connection verified');
});

const getXenaConnectionStatus = catchAsync(async (req, res) => {
    const data = await xenaSvc.getConnectionStatus({ provider: req.params.id });
    sendSuccess(res, data, 'Xena connection status retrieved');
});

const refreshXenaBalance = catchAsync(async (req, res) => {
    const data = await xenaSvc.refreshBalance({ provider: req.params.id });
    sendSuccess(res, data, 'Xena balance refreshed');
});

const getXenaProductConfig = catchAsync(async (req, res) => {
    const data = await xenaProductSvc.getProductConfig({ provider: req.params.id });
    sendSuccess(res, data, 'Xena product config retrieved');
});

const updateXenaProductConfig = catchAsync(async (req, res) => {
    const data = await xenaProductSvc.updateProductConfig({
        provider: req.params.id,
        data: req.body,
        updatedBy: req.user._id,
    });
    sendSuccess(res, data, 'Xena product config updated');
});

const syncXenaSyntheticProduct = catchAsync(async (req, res) => {
    const data = await xenaProductSvc.syncSyntheticProduct({ provider: req.params.id });
    sendSuccess(res, data, 'Xena synthetic product synced');
});

const verifyXenaTarget = catchAsync(async (req, res) => {
    const data = await xenaTargetSvc.verifyProviderTargetUid({
        provider: req.params.id,
        targetUid: req.body.targetUid,
    });
    sendSuccess(res, data, 'Xena target verified');
});

const testFazerCardsConnection = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.testConnection();
    sendSuccess(res, data, 'FazerCards connection successful');
});

const getFazerCardsBalance = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.getBalance();
    sendSuccess(res, data, 'FazerCards balance retrieved');
});

const syncFazerCardsCatalogPage = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.syncCatalogPage(req.body);
    sendSuccess(res, data, 'FazerCards top-up catalog page synced');
});

const listFazerCardsProviderProducts = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.listProviderProducts(req.query);
    sendPaginated(res, data.products, data.pagination, 'FazerCards provider products retrieved');
});

const getFazerCardsProviderProductDetails = catchAsync(async (req, res) => {
    const product = await fazerCardsCatalogSvc.getProviderProductDetails(req.params.id);
    sendSuccess(res, { product }, 'FazerCards provider product retrieved');
});

module.exports = {
    listProviders,
    getProviderById,
    createProvider,
    updateProvider,
    deleteProvider,
    toggleProvider,
    getProviderBalance,
    getProviderLiveProducts,
    testProviderConnection,
    getProductPrice,
    checkProviderOrder,
    challengeXenaConnection,
    reconnectXenaConnection,
    verifyXenaConnection,
    getXenaConnectionStatus,
    refreshXenaBalance,
    getXenaProductConfig,
    updateXenaProductConfig,
    syncXenaSyntheticProduct,
    verifyXenaTarget,
    testFazerCardsConnection,
    getFazerCardsBalance,
    syncFazerCardsCatalogPage,
    listFazerCardsProviderProducts,
    getFazerCardsProviderProductDetails,
};
