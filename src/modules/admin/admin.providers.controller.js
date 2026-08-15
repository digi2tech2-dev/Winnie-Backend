'use strict';

/**
 * admin.providers.controller.js
 */

const svc = require('./admin.providers.service');
const xenaSvc = require('../providers/xena/xena.service');
const xenaProductSvc = require('../providers/xena/xenaProduct.service');
const xenaTargetSvc = require('../providers/xena/xenaTarget.service');
const fazerCardsCatalogSvc = require('../providers/fazercards/fazercardsCatalog.service');
const fazerCardsWebhookSvc = require('../providers/fazercards/fazercards.webhook.service');
const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess, sendCreated, sendPaginated } = require('../../shared/utils/apiResponse');
const { sanitizePricingForSupervisor } = require('../../shared/utils/priceVisibility');
const { createAuditLog } = require('../audit/audit.service');
const { ORDER_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');

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

const listFazerCardsCatalogFamilies = catchAsync(async (req, res) => {
    const data = fazerCardsCatalogSvc.listFamilies();
    sendSuccess(res, data, 'FazerCards catalog families retrieved');
});

const syncFazerCardsCatalogFamily = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.syncCatalogFamily(req.body);
    sendSuccess(res, data, 'FazerCards catalog family synced');
});

const syncFazerCardsCatalogAll = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.syncAllCatalogFamilies(req.body);
    sendSuccess(res, data, 'FazerCards catalog families synced');
});

const getFazerCardsCatalogSyncStatus = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.getCatalogSyncStatus();
    sendSuccess(res, data, 'FazerCards catalog sync status retrieved');
});

const getFazerCardsCatalogSummary = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.getCatalogSummary();
    sendSuccess(res, data, 'FazerCards catalog summary retrieved');
});

const getFazerCardsLaunchHealth = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.getLaunchHealth();
    sendSuccess(res, data, 'FazerCards launch health retrieved');
});

const listFazerCardsWebhookDeliveries = catchAsync(async (req, res) => {
    const data = await fazerCardsWebhookSvc.listDeliveries(req.query);
    sendPaginated(res, data.deliveries, data.pagination, 'FazerCards webhook deliveries retrieved');
});

const listFazerCardsContracts = catchAsync(async (req, res) => {
    const data = fazerCardsCatalogSvc.listContracts();
    sendSuccess(res, data, 'FazerCards contracts retrieved');
});

const getFazerCardsContractsSummary = catchAsync(async (req, res) => {
    const data = fazerCardsCatalogSvc.getContractsSummary();
    sendSuccess(res, data, 'FazerCards contract summary retrieved');
});

const getFazerCardsContract = catchAsync(async (req, res) => {
    const data = fazerCardsCatalogSvc.getContract(req.params.familyKey);
    sendSuccess(res, data, 'FazerCards contract retrieved');
});

const backfillFazerCardsCatalogFamilies = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.backfillLegacyFamilies();
    sendSuccess(res, data, 'FazerCards legacy catalog families backfilled');
});

const listFazerCardsProviderProducts = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.listProviderProducts(req.query);
    sendPaginated(res, data.products, data.pagination, 'FazerCards provider products retrieved');
});

const getFazerCardsProviderProductDetails = catchAsync(async (req, res) => {
    const product = await fazerCardsCatalogSvc.getProviderProductDetails(req.params.id);
    sendSuccess(res, { product }, 'FazerCards provider product retrieved');
});

const previewFazerCardsProviderProductImport = catchAsync(async (req, res) => {
    const preview = await fazerCardsCatalogSvc.getImportPreview(req.params.id);
    sendSuccess(res, { preview }, 'FazerCards import preview retrieved');
});

const importFazerCardsProviderProduct = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.importProviderProduct(req.params.id, req.body, req.user._id);
    sendCreated(res, data, data.action === 'updated' ? 'FazerCards product import updated' : 'FazerCards product imported as inactive draft');
});

const dryRunFazerCardsTopup = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.buildTopupDryRun(req.body);
    sendSuccess(res, data, 'FazerCards top-up dry run built');
});

const dryRunFazerCardsCodeDelivery = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.buildCodeDeliveryDryRun(req.body);
    sendSuccess(res, data, 'FazerCards code-delivery dry run built');
});

const dryRunFazerCardsProduct = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.buildUnifiedDryRun({
        productId: req.params.productId,
        ...req.body,
    });
    sendSuccess(res, data, 'FazerCards product dry run built');
});

const runFazerCardsCodeDeliveryLivePilot = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.runCodeDeliveryLivePilot(req.body, req.user?._id);
    sendSuccess(res, data, 'FazerCards code-delivery live pilot executed');
});

const getFazerCardsProductReadiness = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.getProductReadiness(req.params.productId);
    sendSuccess(res, data, 'FazerCards product readiness retrieved');
});

const getFazerCardsCodeDeliveryReadiness = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.getCodeDeliveryReadiness(req.params.productId);
    sendSuccess(res, data, 'FazerCards code-delivery readiness retrieved');
});

const getFazerCardsCodeDeliveryLivePilotDebug = catchAsync(async (req, res) => {
    const debug = await fazerCardsCatalogSvc.getCodeDeliveryLivePilotDebug(req.params.orderId);
    sendSuccess(res, { debug }, 'FazerCards code-delivery pilot debug retrieved');
});

const listFazerCardsCodeDeliveryPilotCodes = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.listCodeDeliveryPilotDeliveredCodes(req.params.orderId);
    sendSuccess(res, data, 'FazerCards delivered code metadata retrieved');
});

const getFazerCardsDeliveredCodeDebug = catchAsync(async (req, res) => {
    const debug = await fazerCardsCatalogSvc.getDeliveredCodeDebug(req.params.codeId);
    sendSuccess(res, { debug }, 'FazerCards delivered code debug retrieved');
});

const storeFazerCardsManualDeliveredCode = catchAsync(async (req, res) => {
    const result = await fazerCardsCatalogSvc.storeManualDeliveredCode({
        orderId: req.params.orderId,
        ...req.body,
    });
    createAuditLog({
        actorId: req.user?._id,
        actorRole: ACTOR_ROLES.ADMIN,
        ipAddress: req.ip ?? null,
        userAgent: req.get('User-Agent') ?? null,
        action: ORDER_ACTIONS.MANUAL_REVIEW,
        entityType: ENTITY_TYPES.ORDER,
        entityId: req.params.orderId,
        metadata: {
            action: 'admin_manual_delivered_code_stored',
            deliveredCodeId: result.id,
            hasCode: result.hasCode,
            hasPin: result.hasPin,
            hasSerial: result.hasSerial,
            storedEncrypted: result.storedEncrypted,
        },
    });
    sendSuccess(res, { deliveredCode: result }, 'FazerCards delivered code stored securely');
});

const listFazerCardsManualOrders = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.listManualOrders(req.query);
    sendPaginated(res, data.orders, data.pagination, 'FazerCards manual orders retrieved');
});

const getFazerCardsManualOrder = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.getManualOrderDetail(req.params.orderId);
    sendSuccess(res, data, 'FazerCards manual order retrieved');
});

const completeFazerCardsManualOrder = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.completeManualOrder(req.params.orderId, req.body, req.user?._id, {
        ipAddress: req.ip ?? null,
        userAgent: req.get('User-Agent') ?? null,
    });
    sendSuccess(res, data, 'FazerCards manual order completed');
});

const failFazerCardsManualOrder = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.failManualOrder(req.params.orderId, req.body, req.user?._id, {
        ipAddress: req.ip ?? null,
        userAgent: req.get('User-Agent') ?? null,
    });
    sendSuccess(res, data, 'FazerCards manual order failed');
});

const noteFazerCardsManualOrder = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.addManualOrderNote(req.params.orderId, req.body, req.user?._id, {
        ipAddress: req.ip ?? null,
        userAgent: req.get('User-Agent') ?? null,
    });
    sendSuccess(res, data, 'FazerCards manual order note added');
});

const bulkUpdateFazerCardsLaunch = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.bulkUpdateLaunchControls(req.body, req.user?._id, {
        ipAddress: req.ip ?? null,
        userAgent: req.get('User-Agent') ?? null,
    });
    sendSuccess(res, data, req.body.dryRun === true ? 'FazerCards launch update previewed' : 'FazerCards launch settings updated');
});

const publishEligibleFazerCardsProducts = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.publishEligibleLaunchControls(req.body, req.user?._id, {
        ipAddress: req.ip ?? null,
        userAgent: req.get('User-Agent') ?? null,
    });
    sendSuccess(res, data, req.body.dryRun === true ? 'FazerCards publish previewed' : 'FazerCards products published');
});

const updateFazerCardsProductLaunch = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.updateSingleProductLaunchControls(req.params.productId, req.body, req.user?._id, {
        ipAddress: req.ip ?? null,
        userAgent: req.get('User-Agent') ?? null,
    });
    sendSuccess(res, data, 'FazerCards product launch settings updated');
});

const syncFazerCardsOrderStatus = catchAsync(async (req, res) => {
    const data = await fazerCardsCatalogSvc.syncOrderStatus(req.params.orderId);
    sendSuccess(res, data, 'FazerCards order status synced');
});

const getFazerCardsOrderProviderDebug = catchAsync(async (req, res) => {
    const debug = await fazerCardsCatalogSvc.getOrderProviderDebug(req.params.orderId);
    sendSuccess(res, { debug }, 'FazerCards provider debug retrieved');
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
    listFazerCardsCatalogFamilies,
    syncFazerCardsCatalogFamily,
    syncFazerCardsCatalogAll,
    getFazerCardsCatalogSyncStatus,
    getFazerCardsCatalogSummary,
    getFazerCardsLaunchHealth,
    listFazerCardsWebhookDeliveries,
    listFazerCardsContracts,
    getFazerCardsContractsSummary,
    getFazerCardsContract,
    backfillFazerCardsCatalogFamilies,
    listFazerCardsProviderProducts,
    getFazerCardsProviderProductDetails,
    previewFazerCardsProviderProductImport,
    importFazerCardsProviderProduct,
    dryRunFazerCardsTopup,
    dryRunFazerCardsCodeDelivery,
    dryRunFazerCardsProduct,
    runFazerCardsCodeDeliveryLivePilot,
    getFazerCardsProductReadiness,
    getFazerCardsCodeDeliveryReadiness,
    getFazerCardsCodeDeliveryLivePilotDebug,
    listFazerCardsCodeDeliveryPilotCodes,
    getFazerCardsDeliveredCodeDebug,
    storeFazerCardsManualDeliveredCode,
    listFazerCardsManualOrders,
    getFazerCardsManualOrder,
    completeFazerCardsManualOrder,
    failFazerCardsManualOrder,
    noteFazerCardsManualOrder,
    bulkUpdateFazerCardsLaunch,
    publishEligibleFazerCardsProducts,
    updateFazerCardsProductLaunch,
    syncFazerCardsOrderStatus,
    getFazerCardsOrderProviderDebug,
};
