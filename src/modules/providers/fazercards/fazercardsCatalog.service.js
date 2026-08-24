'use strict';

const mongoose = require('mongoose');
const config = require('../../../config/config');
const { Provider } = require('../provider.model');
const { ProviderProduct, FULFILLMENT_MODES, SUPPORT_LEVELS } = require('../providerProduct.model');
const {
    Product,
    PRICING_MODES,
    MARKUP_TYPES,
    EXECUTION_TYPES,
    PRODUCT_STATUSES,
    computeFinalPrice,
} = require('../../products/product.model');
const { Order, ORDER_STATUS } = require('../../orders/order.model');
const { refundFailedOrder } = require('../../orders/orderFulfillment.service');
const { Currency } = require('../../currency/currency.model');
const { PROVIDER_CODES } = require('../provider.constants');
const { BusinessRuleError, ConflictError, NotFoundError, ValidationError } = require('../../../shared/errors/AppError');
const {
    FazerCardsAdapter,
    extractTopupIdentifiers,
    buildTopupFields,
    normalizeTopupOrderStatus,
    normalizeRequiredFields,
} = require('./fazercards.adapter');
const {
    sanitizePayload,
    FAZERCARDS_RATE_LIMIT_SAFETY_BUFFER_SECONDS,
} = require('./fazercards.client');
const {
    NORMALIZED_STATUSES,
    parseFazerCardsOrderPayload,
} = require('./fazercardsStatus.service');
const { getFazerCardsFamily, listFazerCardsFamilies } = require('./fazercardsFamilies');
const fazerCardsContracts = require('./fazercardsContracts');
const {
    buildFazerCardsSearchTermSpecs,
    normalizeSearchTerm,
} = require('./fazercardsSearchAliases');
const { ProviderDeliveredCode, DELIVERY_STATUSES } = require('./providerDeliveredCode.model');
const { ProviderPilotOrder } = require('./providerPilotOrder.model');
const { FazerCardsSteamGiftGameIndex } = require('./fazerCardsSteamGiftGameIndex.model');
const {
    sanitizeProviderCodePayload,
    storeDeliveredCodesForOrder,
    storeManualDeliveredCodeForOrder,
} = require('./fazercardsDelivery.service');
const { createAuditLog } = require('../../audit/audit.service');
const { ORDER_ACTIONS, PRODUCT_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../../audit/audit.constants');
const { notifyOrderCompleted, notifyOrderFailed, notifyOrderManualReview } = require('../../notifications/notification.events');

const FAZERCARDS_SLUG = 'fazer-cards';
const SYNC_ALL_DEFAULT_FAMILIES = Object.freeze([
    'TOPUPS',
    'GIFTCARDS',
    'GAME_KEYS',
    'TELEGRAM',
    'STEAM_TOPUP',
    'MANUAL_SERVICES',
]);
const DRAFT_IMPORT_FAMILIES = new Set([...SYNC_ALL_DEFAULT_FAMILIES, 'STEAM_GIFTS']);
const CODE_DELIVERY_IMPORT_FAMILIES = new Set(['GIFTCARDS', 'GAME_KEYS']);
const AUTO_PROVIDER_FAMILIES = new Set([
    'TOPUPS',
    'GIFTCARDS',
    'GAME_KEYS',
    'TELEGRAM',
    'STEAM_TOPUP',
    'STEAM_GIFTS',
    'MANUAL_SERVICES',
]);
const LAUNCH_PUBLISH_FAMILIES = Object.freeze([
    'TOPUPS',
    'GIFTCARDS',
    'GAME_KEYS',
    'TELEGRAM',
    'STEAM_TOPUP',
    'STEAM_GIFTS',
    'MANUAL_SERVICES',
]);
const ALL_LAUNCH_FAMILIES = Object.freeze([...LAUNCH_PUBLISH_FAMILIES]);
const UNIMPLEMENTED_FAMILY_BLOCK_REASONS = Object.freeze({
    TELEGRAM: 'TELEGRAM_READINESS_REQUIRED',
    STEAM_TOPUP: 'STEAM_TOPUP_READINESS_REQUIRED',
    MANUAL_SERVICES: 'MANUAL_SERVICE_READINESS_REQUIRED',
    STEAM_GIFTS: 'STEAM_GIFTS_ON_DEMAND_READINESS_REQUIRED',
});
const IMPORTED_PRODUCT_LAUNCH_SELECT = '_id name externalProductId providerProduct isActive visibleInStore status customerPurchaseEnabled providerExecutionMode providerExecutionEnabled providerExecutionBlocked providerBlockReason familyKey fulfillmentMode orderFields dynamicFields';
let syncAllInProgress = false;
let lastSyncAllSummary = null;
let steamGiftIndexRefreshInProgress = false;

const STEAM_GIFT_INDEX_RATE_LIMIT_MS = 3 * 60 * 1000;
const FAZERCARDS_CATALOG_SYNC_MAX_PAGES = 1000;

const isFazerCardsRateLimitError = (error) => (
    Number(error?.statusCode || error?.httpStatus) === 429
    || String(error?.code || '').toUpperCase() === 'FAZERCARDS_RATE_LIMITED'
);

const buildCustomerVisibilityStatus = (product = {}) => {
    const status = String(product?.status || '').trim().toLowerCase();
    const reasons = [];

    if (product?.deletedAt) reasons.push('deletedAt=set');
    if (product?.isActive !== true) reasons.push('isActive=false');
    if (product?.visibleInStore === false) reasons.push('visibleInStore=false');
    if (status !== PRODUCT_STATUSES.AVAILABLE) reasons.push(`status=${status || 'missing'}`);
    if (product?.customerPurchaseEnabled !== true) reasons.push('customerPurchaseEnabled=false');
    if (product?.isPaused === true) reasons.push('isPaused=true');
    if (product?.isAvailableForApi === false) reasons.push('isAvailableForApi=false');
    const manualFieldValidation = fazerCardsContracts.validateManualCustomerFieldsForProduct({ product });
    if (!manualFieldValidation.ok) {
        reasons.push(manualFieldValidation.reason || 'manual fulfillment requires customer fields');
    }

    return {
        visibleToCustomer: reasons.length === 0,
        reasons,
    };
};

const summarizeImportedLaunchProduct = (product = null) => {
    if (!product) return null;
    const visibility = buildCustomerVisibilityStatus(product);
    const manualFieldValidation = fazerCardsContracts.validateManualCustomerFieldsForProduct({ product });
    return {
        id: product._id,
        name: product.name,
        isActive: product.isActive === true,
        visibleInStore: product.visibleInStore !== false,
        status: product.status || null,
        customerPurchaseEnabled: product.customerPurchaseEnabled === true,
        providerExecutionMode: product.providerExecutionMode || null,
        providerExecutionEnabled: product.providerExecutionEnabled === true,
        providerExecutionBlocked: product.providerExecutionBlocked === true,
        providerBlockReason: product.providerBlockReason || null,
        familyKey: product.familyKey || null,
        fulfillmentMode: product.fulfillmentMode || null,
        visibleToCustomer: visibility.visibleToCustomer,
        visibilityReasons: visibility.reasons,
        customerVisibilityStatus: visibility,
        manualFieldWarning: manualFieldValidation.ok ? null : manualFieldValidation.message,
        manualFieldSuggestions: manualFieldValidation.suggestions || [],
    };
};

const diffLaunchFields = (product = {}, update = {}) => (
    Object.entries(update)
        .filter(([key, value]) => String(product?.[key] ?? '') !== String(value ?? ''))
        .map(([key]) => key)
);

const findFazerCardsProvider = () => Provider.findOne({
    deletedAt: null,
    $or: [
        { providerCode: PROVIDER_CODES.FAZER_CARDS },
        { slug: FAZERCARDS_SLUG },
        { name: /^FazerCards$/i },
        { name: /^Fazer Cards$/i },
    ],
});

const ensureFazerCardsProvider = async () => {
    const existing = await findFazerCardsProvider();
    if (existing) return existing;

    return Provider.create({
        name: 'FazerCards',
        slug: FAZERCARDS_SLUG,
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        baseUrl: config.providers.fazerCards.apiBaseUrl,
        authType: 'API_KEY',
        syncInterval: 0,
        isActive: config.providers.fazerCards.enabled,
        supportedFeatures: ['getAccount', 'getBalance', 'fetchTopupCategoriesPage', 'fetchTopupOffers'],
    });
};

const getConfiguredAdapter = async (adapterOptions = {}) => {
    const provider = await ensureFazerCardsProvider();
    return {
        provider,
        adapter: new FazerCardsAdapter(provider, adapterOptions),
    };
};

const listContracts = () => ({
    success: true,
    contracts: fazerCardsContracts.listContracts(),
});

const getContract = (familyKey) => {
    const contract = fazerCardsContracts.getContract(String(familyKey || '').trim().toUpperCase());
    if (!contract) throw new NotFoundError('FazerCards contract');
    return {
        success: true,
        contract,
    };
};

const getContractsSummary = () => ({
    success: true,
    ...fazerCardsContracts.getContractSummary(),
});

const getContractMetadata = (familyKey, checks = {}) => {
    const contract = fazerCardsContracts.getContractOrUnknown(familyKey);
    return {
        contract,
        supportStage: contract.supportStage,
        executionStage: contract.executionStage,
        blockers: contract.blockers || [],
        requiredCapabilities: contract.requiredCapabilities || [],
        missingCapabilities: fazerCardsContracts.getMissingCapabilities(contract, checks),
        canCustomerPurchase: contract.canCustomerPurchase === true,
        canLivePilot: contract.canLivePilot === true,
        canDryRun: contract.canDryRun === true,
        canImportDraft: contract.canImportDraft === true,
    };
};

const testConnection = async (adapterOptions = {}) => {
    const { provider, adapter } = await getConfiguredAdapter(adapterOptions);
    const result = await adapter.health();
    return { provider: provider.name, providerId: provider._id, ...result };
};

const getBalance = async (adapterOptions = {}) => {
    const { provider, adapter } = await getConfiguredAdapter(adapterOptions);
    const balance = await adapter.getBalance();
    return { provider: provider.name, providerId: provider._id, balance };
};

const upsertCatalogProduct = async (providerId, dto, now) => {
    const existed = await ProviderProduct.exists({
        provider: providerId,
        externalProductId: dto.externalProductId,
    });
    const doc = await ProviderProduct.findOneAndUpdate(
        {
            provider: providerId,
            externalProductId: dto.externalProductId,
        },
        {
            $set: {
                providerCode: PROVIDER_CODES.FAZER_CARDS,
                name: dto.name,
                rawName: dto.rawName,
                rawPrice: dto.rawPrice,
                minQty: dto.minQty,
                maxQty: dto.maxQty,
                isActive: dto.isActive,
                category: dto.category,
                categoryName: dto.categoryName,
                offerId: dto.offerId,
                offerName: dto.offerName,
                subCategory: dto.subCategory,
                region: dto.region,
                platform: dto.platform,
                currency: dto.currency,
                costPrice: dto.costPrice,
                available: dto.available,
                stock: dto.stock,
                rawPayload: dto.rawPayload,
                lastSyncedAt: now,
                fulfillmentMode: dto.fulfillmentMode,
                familyKey: dto.familyKey || null,
                supportLevel: dto.supportLevel || null,
                executionBlocked: dto.executionBlocked === true,
                isSupported: dto.isSupported,
                isBlocked: dto.isBlocked,
                blockReason: dto.blockReason,
                requiredFields: dto.requiredFields,
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return { doc, isNew: !existed };
};

const mergeCategoryFromOfferResponse = (category, offerPage) => ({
    ...category,
    ...Object.fromEntries(
        Object.entries(offerPage.category || {}).filter(([, value]) => value !== undefined && value !== null && value !== '')
    ),
});

const getCategoryId = (category = {}) => String(category.category_id || category.categoryId || category.id || '').trim();

const syncCatalogPage = async ({ limit = 100, cursor, category, maxPages = FAZERCARDS_CATALOG_SYNC_MAX_PAGES } = {}, adapterOptions = {}) => {
    const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const { provider, adapter } = await getConfiguredAdapter(adapterOptions);

    if (!provider.isActive) {
        throw new BusinessRuleError('FazerCards provider is inactive.', 'PROVIDER_INACTIVE');
    }

    const now = new Date();
    let providerProductsCreated = 0;
    let providerProductsUpdated = 0;
    let offersFetched = 0;
    let blocked = 0;
    let unsupported = 0;
    let productsSkipped = 0;
    let pagesFetched = 0;
    let nextCursor = cursor || null;
    let hasMore = true;
    let paginationIncomplete = false;
    let lastMeta = {};
    const requestIds = [];
    const errors = [];
    const skipReasons = {};
    const categoryFilter = String(category || '').trim();
    const allCategories = [];

    const normalizedMaxPages = Math.min(Math.max(parseInt(maxPages, 10) || FAZERCARDS_CATALOG_SYNC_MAX_PAGES, 1), FAZERCARDS_CATALOG_SYNC_MAX_PAGES);

    while (hasMore && pagesFetched < normalizedMaxPages) {
        const page = await adapter.fetchTopupCategoriesPage({ limit: normalizedLimit, cursor: nextCursor });
        pagesFetched++;
        if (page.requestId) requestIds.push(page.requestId);
        lastMeta = page.meta || {};
        if (page.malformed) {
            blocked++;
            unsupported++;
            productsSkipped++;
            incrementReason(skipReasons, 'MALFORMED_TOPUP_CATEGORY_PAGE');
            errors.push('FazerCards top-up category response has an unknown shape');
        }
        allCategories.push(...page.items);

        const previousCursor = nextCursor;
        nextCursor = page.meta?.next_cursor || null;
        hasMore = Boolean(page.meta?.has_more && nextCursor && nextCursor !== previousCursor);
        if (page.meta?.has_more && !hasMore) {
            paginationIncomplete = true;
            incrementReason(skipReasons, 'PAGINATION_CURSOR_MISSING');
            errors.push('FazerCards top-up sync could not continue because the response did not include a usable next cursor.');
        }
    }

    if (pagesFetched >= normalizedMaxPages && lastMeta?.has_more) {
        hasMore = true;
        paginationIncomplete = true;
        incrementReason(skipReasons, normalizedMaxPages === FAZERCARDS_CATALOG_SYNC_MAX_PAGES ? 'MAX_CATALOG_PAGES_REACHED' : 'PAGE_BATCH_LIMIT_REACHED');
        errors.push(normalizedMaxPages === FAZERCARDS_CATALOG_SYNC_MAX_PAGES
            ? 'FazerCards top-up sync stopped after the maximum page limit.'
            : 'FazerCards top-up sync paused after its page batch limit.');
    }

    const categories = categoryFilter
        ? allCategories.filter((item) => getCategoryId(item) === categoryFilter)
        : allCategories;

    for (const categoryItem of categories) {
        const categoryId = getCategoryId(categoryItem);
        if (!categoryId) {
            blocked++;
            unsupported++;
            productsSkipped++;
            incrementReason(skipReasons, 'MISSING_CATEGORY_ID');
            errors.push('FazerCards top-up category is missing category_id');
            continue;
        }

        let offerPage;
        try {
            offerPage = await adapter.fetchTopupOffers(categoryId);
        } catch (err) {
            if (isFazerCardsRateLimitError(err)) throw err;
            productsSkipped++;
            incrementReason(skipReasons, 'TOPUP_OFFERS_FETCH_FAILED');
            errors.push(err.message || `Failed to fetch FazerCards offers for ${categoryId}`);
            continue;
        }

        if (offerPage.malformed) {
            blocked++;
            unsupported++;
            incrementReason(skipReasons, 'MALFORMED_TOPUP_OFFERS_RESPONSE');
            errors.push(`FazerCards offers response for ${categoryId} has an unknown shape`);
        }

        offersFetched += offerPage.offers.length;
        const mergedCategory = mergeCategoryFromOfferResponse(categoryItem, offerPage);

        for (const offer of offerPage.offers) {
            try {
                const dto = adapter.normalizeTopupOfferProduct({
                    category: mergedCategory,
                    offer,
                    fields: offerPage.fields,
                });
                if (dto.isBlocked) blocked++;
                if (!dto.isSupported) unsupported++;
                const { isNew } = await upsertCatalogProduct(provider._id, dto, now);
                if (isNew) providerProductsCreated++;
                else providerProductsUpdated++;
            } catch (err) {
                blocked++;
                unsupported++;
                productsSkipped++;
                incrementReason(skipReasons, 'TOPUP_OFFER_NORMALIZATION_FAILED');
                errors.push(err.message || 'Failed to normalize FazerCards top-up offer');
            }
        }
    }

    return {
        providerId: provider._id.toString(),
        provider: provider.name,
        endpoints: ['GET /topups', 'GET /topups/offers'],
        categoriesFetched: categories.length,
        pagesFetched,
        offersFetched,
        providerProductsCreated,
        providerProductsUpdated,
        blocked,
        unsupported,
        productsSkipped,
        skipReasons,
        nextCursor: hasMore ? nextCursor : null,
        hasMore: Boolean(hasMore || paginationIncomplete),
        deleted: 0,
        deactivated: 0,
        errors,
        meta: mergePagedMeta({
            meta: lastMeta,
            limit: normalizedLimit,
            pagesFetched,
            itemsFetched: allCategories.length,
            hasMore: hasMore || paginationIncomplete,
            nextCursor,
        }),
        requestId: requestIds[0] || null,
        requestIds,
        syncedAt: now,
    };
};

const firstValue = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

const parseNumber = (value, fallback = null) => {
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeSteamGiftGameName = (value) => String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeMeta = (data = {}, params = {}) => ({
    total: data?.meta?.total ?? data?.total ?? null,
    limit: data?.meta?.limit ?? data?.limit ?? params.limit ?? null,
    next_cursor: data?.meta?.next_cursor ?? data?.meta?.nextCursor ?? data?.next_cursor ?? data?.nextCursor ?? null,
    has_more: Boolean(data?.meta?.has_more ?? data?.meta?.hasMore ?? data?.has_more ?? data?.hasMore ?? false),
});

const incrementReason = (target, reason) => {
    const key = String(reason || 'UNKNOWN_SKIP_REASON');
    target[key] = (target[key] || 0) + 1;
};

const extractCatalogItems = (data = {}, keys = ['items']) => {
    if (Array.isArray(data)) return data;
    for (const key of keys) {
        if (Array.isArray(data?.[key])) return data[key];
        if (Array.isArray(data?.data?.[key])) return data.data[key];
    }
    return [];
};

const mergePagedMeta = ({ meta = {}, limit, pagesFetched, itemsFetched, hasMore, nextCursor }) => ({
    ...meta,
    limit: meta.limit ?? limit ?? null,
    pages_fetched: pagesFetched,
    items_fetched: itemsFetched,
    next_cursor: hasMore ? nextCursor : null,
    has_more: Boolean(hasMore),
});

const fetchCatalogPathPages = async (adapter, path, {
    limit,
    cursor,
    context,
    params = {},
    itemKeys = ['items'],
    maxPages = FAZERCARDS_CATALOG_SYNC_MAX_PAGES,
} = {}) => {
    const items = [];
    const requestIds = [];
    let pagesFetched = 0;
    let nextCursor = cursor || null;
    let hasMore = true;
    let paginationIncomplete = false;
    let lastMeta = {};

    while (hasMore && pagesFetched < maxPages) {
        const pageParams = {
            ...params,
            limit,
            ...(nextCursor ? { cursor: nextCursor } : {}),
        };
        const page = await adapter.fetchCatalogPath(path, pageParams, context);
        pagesFetched++;
        if (page.requestId) requestIds.push(page.requestId);

        const pageItems = extractCatalogItems(page.data, itemKeys);
        items.push(...pageItems);
        lastMeta = normalizeMeta(page.data, pageParams);

        const previousCursor = nextCursor;
        nextCursor = lastMeta.next_cursor || null;
        hasMore = Boolean(lastMeta.has_more && nextCursor && nextCursor !== previousCursor);
        if (lastMeta.has_more && !hasMore) {
            paginationIncomplete = true;
        }
    }

    const maxPagesReached = pagesFetched >= maxPages && Boolean(lastMeta.has_more);
    paginationIncomplete = paginationIncomplete || maxPagesReached;

    return {
        items,
        pagesFetched,
        requestIds,
        requestId: requestIds[0] || null,
        meta: mergePagedMeta({
            meta: lastMeta,
            limit,
            pagesFetched,
            itemsFetched: items.length,
            hasMore: paginationIncomplete,
            nextCursor,
        }),
        maxPagesReached,
        paginationIncomplete,
    };
};

const listFamilies = () => ({
    families: listFazerCardsFamilies().map((family) => ({
        familyKey: family.familyKey,
        displayName: family.displayName,
        status: family.status,
        catalogAvailable: family.catalogAvailable,
        catalogEndpoints: family.catalogEndpoints,
        optionalCatalogEndpoints: family.optionalCatalogEndpoints || [],
        executionAvailable: family.executionAvailable,
        executionEnabled: family.executionEnabled,
        executionGloballyGated: family.executionGloballyGated === true,
        fulfillmentMode: family.suggestedFulfillmentMode,
        supportLevel: family.supportLevel,
        warning: family.warning || null,
    })),
});

const makeBlockedFamilyProduct = (family, overrides = {}) => ({
    providerCode: PROVIDER_CODES.FAZER_CARDS,
    familyKey: family.familyKey,
    supportLevel: family.supportLevel,
    executionBlocked: true,
    fulfillmentMode: family.suggestedFulfillmentMode,
    isSupported: false,
    isBlocked: true,
    blockReason: family.blockReason || 'EXECUTION_NOT_IMPLEMENTED',
    isActive: true,
    available: overrides.available ?? true,
    minQty: overrides.minQty || 1,
    maxQty: overrides.maxQty || 9999,
    stock: overrides.stock ?? null,
    currency: overrides.currency || 'USD',
    requiredFields: overrides.requiredFields || [],
    ...overrides,
    rawPayload: sanitizePayload(overrides.rawPayload || {}),
});

const normalizeGiftCardProduct = (category = {}, offer = {}) => {
    const family = getFazerCardsFamily('GIFTCARDS');
    const categoryId = String(firstValue(category.category_id, category.categoryId, category.id, 'unknown_category'));
    const cardId = String(firstValue(offer.card_id, offer.cardId, offer.id, offer.product_id, offer.productId, 'unknown_card'));
    const categoryName = String(firstValue(category.name, category.title, categoryId));
    const offerName = String(firstValue(offer.name, offer.title, cardId));
    const costPrice = parseNumber(firstValue(offer.price_usd, offer.priceUsd, offer.cost_usd), null);
    return makeBlockedFamilyProduct(family, {
        externalProductId: `FAZER_GIFTCARD:${categoryId}:${cardId}`,
        name: `${categoryName} - ${offerName}`,
        rawName: `${categoryName} - ${offerName}`,
        rawPrice: costPrice === null ? '0' : String(firstValue(offer.price_usd, offer.priceUsd, offer.cost_usd)),
        costPrice,
        executionBlocked: false,
        isSupported: costPrice !== null && costPrice > 0,
        isBlocked: costPrice === null || costPrice <= 0,
        blockReason: costPrice === null || costPrice <= 0 ? 'INVALID_PRICE' : null,
        category: categoryId,
        categoryName,
        offerId: cardId,
        offerName,
        stock: parseNumber(offer.stock, null),
        minQty: parseNumber(firstValue(offer.min_order_quantity, offer.minQty, offer.min), 1) || 1,
        maxQty: parseNumber(firstValue(offer.max_order_quantity, offer.maxQty, offer.max), 9999) || 9999,
        rawPayload: { family: family.familyKey, category, offer },
    });
};

const normalizeGameKeyProduct = (game = {}, key = {}) => {
    const family = getFazerCardsFamily('GAME_KEYS');
    const gameId = String(firstValue(game.game_id, game.gameId, game.id, 'unknown_game'));
    const keyId = String(firstValue(key.key_id, key.keyId, key.id, key.product_id, key.productId, 'unknown_key'));
    const gameName = String(firstValue(game.GameName, game.name, game.title, gameId));
    const keyName = String(firstValue(key.name, key.title, keyId));
    const costPrice = parseNumber(firstValue(key.price_usd, key.priceUsd, key.cost_usd), null);
    return makeBlockedFamilyProduct(family, {
        externalProductId: `FAZER_GAMEKEY:${gameId}:${keyId}`,
        name: `${gameName} - ${keyName}`,
        rawName: `${gameName} - ${keyName}`,
        rawPrice: costPrice === null ? '0' : String(firstValue(key.price_usd, key.priceUsd, key.cost_usd)),
        costPrice,
        executionBlocked: false,
        isSupported: costPrice !== null && costPrice > 0,
        isBlocked: costPrice === null || costPrice <= 0,
        blockReason: costPrice === null || costPrice <= 0 ? 'INVALID_PRICE' : null,
        category: gameId,
        categoryName: gameName,
        offerId: keyId,
        offerName: keyName,
        region: firstValue(game.region, key.region, null),
        platform: firstValue(game.platform, key.platform, null),
        stock: parseNumber(key.stock, null),
        minQty: parseNumber(firstValue(key.min_order_quantity, key.minQty, key.min), 1) || 1,
        maxQty: parseNumber(firstValue(key.max_order_quantity, key.maxQty, key.max), 9999) || 9999,
        rawPayload: { family: family.familyKey, game, key },
    });
};

const normalizeSteamGiftProducts = (game = {}, details = {}) => {
    const family = getFazerCardsFamily('STEAM_GIFTS');
    const appId = String(firstValue(details.appid, game.appid, game.app_id, game.id, 'unknown_app'));
    const gameName = String(firstValue(game.name, details.name, `Steam App ${appId}`));
    const offers = Array.isArray(details.offers) ? details.offers : [];
    const products = [];
    for (const offer of offers) {
        const subId = String(firstValue(offer.sub_id, offer.subId, offer.id, 'unknown_sub'));
        const offerName = String(firstValue(offer.name, gameName));
        const regions = Array.isArray(offer.regions) && offer.regions.length ? offer.regions : [{ region: firstValue(offer.region, null), price: firstValue(offer.price, offer.price_usd, null) }];
        for (const regionOffer of regions) {
            const region = String(firstValue(regionOffer.region, 'GLOBAL'));
            const costPrice = parseNumber(firstValue(regionOffer.price, regionOffer.price_usd, offer.price_usd), null);
            products.push(makeBlockedFamilyProduct(family, {
                externalProductId: `FAZER_STEAM_GIFT:${appId}:${subId}:${region}`,
                name: `${gameName} - ${offerName} - ${region}`,
                rawName: `${gameName} - ${offerName} - ${region}`,
                rawPrice: costPrice === null ? '0' : String(firstValue(regionOffer.price, regionOffer.price_usd, offer.price_usd)),
                costPrice,
                category: appId,
                categoryName: gameName,
                offerId: subId,
                offerName,
                region,
                platform: 'steam',
                minQty: 1,
                maxQty: 1,
                requiredFields: [{ key: 'invite_url', label: 'رابط دعوة Steam', type: 'text', required: true }],
                executionBlocked: false,
                isSupported: costPrice !== null && costPrice > 0 && appId !== 'unknown_app' && subId !== 'unknown_sub' && Boolean(region),
                isBlocked: costPrice === null || costPrice <= 0 || appId === 'unknown_app' || subId === 'unknown_sub' || !region,
                blockReason: costPrice === null || costPrice <= 0
                    ? 'INVALID_PRICE'
                    : appId === 'unknown_app'
                        ? 'STEAM_GIFT_APP_ID_MISSING'
                        : subId === 'unknown_sub'
                            ? 'STEAM_GIFT_SUB_ID_MISSING'
                            : !region
                                ? 'STEAM_GIFT_REGION_MISSING'
                                : null,
                rawPayload: { family: family.familyKey, game: { ...game, appid: appId, name: gameName }, offer, region: regionOffer },
            }));
        }
    }
    return products;
};

const normalizeSteamTopupProducts = (ratesData = {}) => {
    const family = getFazerCardsFamily('STEAM_TOPUP');
    const rates = ratesData.rates && typeof ratesData.rates === 'object' ? ratesData.rates : {};
    return Object.entries(rates).map(([currency, rate]) => makeBlockedFamilyProduct(family, {
        externalProductId: `FAZER_STEAM_TOPUP:${String(currency).toUpperCase()}`,
        name: `Steam Wallet Top-up - ${String(currency).toUpperCase()}`,
        rawName: `Steam Wallet Top-up - ${String(currency).toUpperCase()}`,
        rawPrice: '1',
        costPrice: '1',
        category: 'steam_topup',
        categoryName: 'Steam Wallet Top-up',
        offerId: String(currency).toUpperCase(),
        offerName: String(currency).toUpperCase(),
        currency: 'USD',
        requiredFields: [{ key: 'steamLogin', label: 'Steam Login', type: 'text', required: true }],
        executionBlocked: false,
        isSupported: true,
        isBlocked: false,
        blockReason: null,
        rawPayload: { family: family.familyKey, rateCurrency: currency, rate, response: ratesData },
    }));
};

const normalizeTelegramProducts = (starsData = {}, premiumData = {}) => {
    const family = getFazerCardsFamily('TELEGRAM');
    const products = [];
    if (starsData?.price_per_star || starsData?.pricePerStar) {
        const price = firstValue(starsData.price_per_star, starsData.pricePerStar);
        products.push(makeBlockedFamilyProduct(family, {
            externalProductId: 'FAZER_TELEGRAM:STARS',
            name: 'Telegram Stars',
            rawName: 'Telegram Stars',
            rawPrice: String(price),
            costPrice: parseNumber(price, null),
            category: 'telegram',
            categoryName: 'Telegram',
            offerId: 'stars',
            offerName: 'Stars',
            fulfillmentMode: FULFILLMENT_MODES.TELEGRAM_STARS_TOPUP,
            minQty: parseNumber(firstValue(starsData.min_amount, starsData.minAmount), 50) || 50,
            maxQty: parseNumber(firstValue(starsData.max_amount, starsData.maxAmount), 10000) || 10000,
            requiredFields: [{ key: 'telegram_username', label: 'Telegram Username', type: 'text', required: true }],
            executionBlocked: false,
            isSupported: parseNumber(price, null) !== null && parseNumber(price, null) > 0,
            isBlocked: !(parseNumber(price, null) !== null && parseNumber(price, null) > 0),
            blockReason: parseNumber(price, null) !== null && parseNumber(price, null) > 0 ? null : 'TELEGRAM_PRICE_INVALID',
            rawPayload: { family: family.familyKey, kind: 'telegram_stars', response: starsData },
        }));
    }
    for (const plan of Array.isArray(premiumData?.plans) ? premiumData.plans : []) {
        const months = String(firstValue(plan.months, 'unknown'));
        const price = firstValue(plan.price_usd, plan.priceUsd);
        products.push(makeBlockedFamilyProduct(family, {
            externalProductId: `FAZER_TELEGRAM:PREMIUM:${months}`,
            name: `Telegram Premium - ${months} months`,
            rawName: `Telegram Premium - ${months} months`,
            rawPrice: String(price || '0'),
            costPrice: parseNumber(price, null),
            category: 'telegram',
            categoryName: 'Telegram',
            offerId: `premium_${months}`,
            offerName: `${months} months`,
            fulfillmentMode: FULFILLMENT_MODES.TELEGRAM_PREMIUM,
            requiredFields: [{ key: 'telegram_username', label: 'Telegram Username', type: 'text', required: true }],
            executionBlocked: false,
            isSupported: parseNumber(price, null) !== null && parseNumber(price, null) > 0,
            isBlocked: !(parseNumber(price, null) !== null && parseNumber(price, null) > 0),
            blockReason: parseNumber(price, null) !== null && parseNumber(price, null) > 0 ? null : 'TELEGRAM_PRICE_INVALID',
            rawPayload: { family: family.familyKey, kind: 'telegram_premium', plan, response: premiumData },
        }));
    }
    return products;
};

const mergeRequiredFields = (...fieldGroups) => {
    const seen = new Set();
    const fields = [];
    for (const group of fieldGroups) {
        for (const field of Array.isArray(group) ? group : []) {
            const key = String(field?.key || field?.name || field?.id || '').trim();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            fields.push(field);
        }
    }
    return fields;
};

const normalizeManualServiceFields = (category = {}, offer = {}) => mergeRequiredFields(
    normalizeRequiredFields(offer),
    normalizeRequiredFields(category)
);

const normalizeManualServiceProduct = (category = {}, offer = {}) => {
    const family = getFazerCardsFamily('MANUAL_SERVICES');
    const serviceId = String(firstValue(category.id, category.manual_service_id, category.manualServiceId, 'unknown_service'));
    const offerId = String(firstValue(offer.id, offer.product_id, offer.productId, 'unknown_offer'));
    const categoryName = String(firstValue(category.name, category.title, serviceId));
    const offerName = String(firstValue(offer.name, offer.title, offerId));
    const price = firstValue(offer.price_usd, offer.priceUsd);
    const requiredFields = normalizeManualServiceFields(category, offer);
    const costPrice = parseNumber(price, null);
    const supported = serviceId !== 'unknown_service'
        && offerId !== 'unknown_offer'
        && costPrice !== null
        && costPrice > 0
        && requiredFields.length > 0;
    return makeBlockedFamilyProduct(family, {
        externalProductId: `FAZER_MANUAL_SERVICE:${serviceId}:${offerId}`,
        name: `${categoryName} - ${offerName}`,
        rawName: `${categoryName} - ${offerName}`,
        rawPrice: String(price || '0'),
        costPrice,
        executionBlocked: !supported,
        isSupported: supported,
        isBlocked: !supported,
        blockReason: supported
            ? null
            : requiredFields.length === 0
                ? 'MANUAL_SERVICE_FIELDS_MISSING'
                : costPrice === null || costPrice <= 0
                    ? 'INVALID_PRICE'
                    : 'MANUAL_SERVICE_IDENTIFIERS_MISSING',
        category: serviceId,
        categoryName,
        offerId,
        offerName,
        subCategory: firstValue(category.kind, null),
        requiredFields,
        rawPayload: { family: family.familyKey, category, offer },
    });
};

const syncFamilyDtos = async (family, adapter, { limit, cursor, appid, gameName, maxPages } = {}) => {
    const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    if (family.familyKey === 'GIFTCARDS') {
        const page = await fetchCatalogPathPages(adapter, '/giftcards', {
            limit: normalizedLimit,
            cursor,
            context: 'giftcards',
            itemKeys: ['items', 'categories'],
            maxPages,
        });
        const categories = page.items;
        const products = [];
        let productsSkipped = 0;
        const skipReasons = {};
        const errors = [];
        for (const category of categories) {
            const categoryId = getCategoryId(category);
            if (!categoryId) {
                productsSkipped++;
                incrementReason(skipReasons, 'MISSING_CATEGORY_ID');
                continue;
            }
            const cards = await adapter.fetchCatalogPath('/giftcards/cards', { category_id: categoryId }, 'giftcards_cards');
            const offers = extractCatalogItems(cards.data, ['offers', 'cards', 'items']);
            for (const offer of offers) products.push(normalizeGiftCardProduct({ ...category, ...cards.data }, offer));
        }
        if (page.maxPagesReached) {
            incrementReason(skipReasons, 'MAX_CATALOG_PAGES_REACHED');
            errors.push('FazerCards Gift Cards sync stopped after the maximum page limit.');
        } else if (page.paginationIncomplete) {
            incrementReason(skipReasons, 'PAGINATION_CURSOR_MISSING');
            errors.push('FazerCards Gift Cards sync could not continue because the response did not include a usable next cursor.');
        }
        return {
            products,
            categoriesFetched: categories.length,
            pagesFetched: page.pagesFetched,
            offersFetched: products.length,
            productsSkipped,
            skipReasons,
            errors,
            meta: page.meta,
            requestId: page.requestId,
            requestIds: page.requestIds,
        };
    }

    if (family.familyKey === 'GAME_KEYS') {
        const page = await fetchCatalogPathPages(adapter, '/gamekeys', {
            limit: normalizedLimit,
            cursor,
            context: 'gamekeys',
            itemKeys: ['items', 'games'],
            maxPages,
        });
        const games = page.items;
        const products = [];
        let productsSkipped = 0;
        const skipReasons = {};
        const errors = [];
        for (const game of games) {
            const gameId = String(firstValue(game.game_id, game.gameId, game.id, '')).trim();
            if (!gameId) {
                productsSkipped++;
                incrementReason(skipReasons, 'MISSING_GAME_ID');
                continue;
            }
            const keys = await adapter.fetchCatalogPath('/gamekeys/keys', { game_id: gameId }, 'gamekeys_keys');
            const keyItems = extractCatalogItems(keys.data, ['keys', 'items', 'offers']);
            const mergedGame = { ...game, ...keys.data };
            for (const key of keyItems) products.push(normalizeGameKeyProduct(mergedGame, key));
        }
        if (page.maxPagesReached) {
            incrementReason(skipReasons, 'MAX_CATALOG_PAGES_REACHED');
            errors.push('FazerCards Game Keys sync stopped after the maximum page limit.');
        } else if (page.paginationIncomplete) {
            incrementReason(skipReasons, 'PAGINATION_CURSOR_MISSING');
            errors.push('FazerCards Game Keys sync could not continue because the response did not include a usable next cursor.');
        }
        return {
            products,
            categoriesFetched: games.length,
            pagesFetched: page.pagesFetched,
            offersFetched: products.length,
            productsSkipped,
            skipReasons,
            errors,
            meta: page.meta,
            requestId: page.requestId,
            requestIds: page.requestIds,
        };
    }

    if (family.familyKey === 'STEAM_GIFTS') {
        const appId = String(appid || '').trim();
        if (!appId) {
            const error = new ValidationError(
                'Steam Gifts requires an AppID for on-demand sync.',
                [{ field: 'appid', message: 'اكتب AppID أولاً لمزامنة Steam Gifts' }]
            );
            error.code = 'FAZERCARDS_STEAM_GIFTS_APPID_REQUIRED';
            throw error;
        }
        const details = await adapter.fetchSteamGiftGame(appId);
        const game = { appid: appId, name: String(gameName || '').trim() || details.data?.name || `Steam App ${appId}` };
        const products = normalizeSteamGiftProducts(game, details.data);
        return {
            products,
            categoriesFetched: 1,
            offersFetched: products.length,
            meta: { appid: appId, strategy: 'appid_on_demand', broadSyncDisabled: true },
            requestId: details.requestId,
        };
    }

    if (family.familyKey === 'STEAM_TOPUP') {
        const rates = await adapter.fetchCatalogPath('/steam-topup/rates', {}, 'steam_topup_rates');
        const products = normalizeSteamTopupProducts(rates.data);
        return { products, categoriesFetched: 1, offersFetched: products.length, meta: {}, requestId: rates.requestId };
    }

    if (family.familyKey === 'TELEGRAM') {
        const stars = await adapter.fetchCatalogPath('/telegram/stars', {}, 'telegram_stars');
        const premium = await adapter.fetchCatalogPath('/telegram/premium', {}, 'telegram_premium');
        const products = normalizeTelegramProducts(stars.data, premium.data);
        return { products, categoriesFetched: 2, offersFetched: products.length, meta: {}, requestId: stars.requestId || premium.requestId };
    }

    if (family.familyKey === 'MANUAL_SERVICES') {
        const page = await fetchCatalogPathPages(adapter, '/manual-services', {
            limit: normalizedLimit,
            cursor,
            context: 'manual_services',
            itemKeys: ['items', 'services'],
            maxPages,
        });
        const categories = page.items;
        const products = [];
        let productsSkipped = 0;
        const skipReasons = {};
        const errors = [];
        for (const category of categories) {
            const serviceId = String(firstValue(category.id, category.manual_service_id, '')).trim();
            if (!serviceId) {
                productsSkipped++;
                incrementReason(skipReasons, 'MISSING_MANUAL_SERVICE_ID');
                continue;
            }
            const offers = await adapter.fetchCatalogPath(`/manual-services/${encodeURIComponent(serviceId)}/offers`, {}, 'manual_service_offers');
            const offerItems = extractCatalogItems(offers.data, ['items', 'offers', 'products']);
            const mergedCategory = {
                ...category,
                ...(offers.data?.category || {}),
                fields: firstValue(offers.data?.fields, offers.data?.requiredFields, offers.data?.inputs, category.fields),
            };
            for (const offer of offerItems) products.push(normalizeManualServiceProduct(mergedCategory, offer));
        }
        if (page.maxPagesReached) {
            incrementReason(skipReasons, 'MAX_CATALOG_PAGES_REACHED');
            errors.push('FazerCards Manual Services sync stopped after the maximum page limit.');
        } else if (page.paginationIncomplete) {
            incrementReason(skipReasons, 'PAGINATION_CURSOR_MISSING');
            errors.push('FazerCards Manual Services sync could not continue because the response did not include a usable next cursor.');
        }
        return {
            products,
            categoriesFetched: categories.length,
            pagesFetched: page.pagesFetched,
            offersFetched: products.length,
            productsSkipped,
            skipReasons,
            errors,
            meta: page.meta,
            requestId: page.requestId,
            requestIds: page.requestIds,
        };
    }

    throw new BusinessRuleError(`FazerCards family '${family.familyKey}' is not syncable yet.`, 'FAZERCARDS_FAMILY_DISCOVERY_UNCONFIRMED');
};

const syncCatalogFamily = async ({ family, limit = 20, cursor, appid, gameName, maxPages } = {}, adapterOptions = {}) => {
    const registryEntry = getFazerCardsFamily(family);
    if (!registryEntry || registryEntry.familyKey === 'UNKNOWN') {
        throw new BusinessRuleError('Unknown FazerCards catalog family.', 'FAZERCARDS_UNKNOWN_FAMILY');
    }
    if (registryEntry.familyKey === 'TOPUPS') {
        return syncCatalogPage({ limit, cursor, maxPages }, adapterOptions);
    }

    const { provider, adapter } = await getConfiguredAdapter(adapterOptions);
    if (!provider.isActive) {
        throw new BusinessRuleError('FazerCards provider is inactive.', 'PROVIDER_INACTIVE');
    }

    const now = new Date();
    const {
        products,
        categoriesFetched,
        pagesFetched = 1,
        offersFetched,
        productsSkipped = 0,
        skipReasons = {},
        errors = [],
        meta,
        requestId,
        requestIds = requestId ? [requestId] : [],
    } = await syncFamilyDtos(registryEntry, adapter, { limit, cursor, appid, gameName, maxPages });
    let providerProductsCreated = 0;
    let providerProductsUpdated = 0;
    for (const dto of products) {
        const { isNew } = await upsertCatalogProduct(provider._id, dto, now);
        if (isNew) providerProductsCreated++;
        else providerProductsUpdated++;
    }

    return {
        providerId: provider._id.toString(),
        provider: provider.name,
        familyKey: registryEntry.familyKey,
        displayName: registryEntry.displayName,
        endpoints: registryEntry.catalogEndpoints,
        categoriesFetched,
        pagesFetched,
        offersFetched,
        providerProductsCreated,
        providerProductsUpdated,
        blocked: products.filter((product) => product.isBlocked).length,
        unsupported: products.filter((product) => !product.isSupported).length,
        productsSkipped,
        skipReasons,
        nextCursor: meta?.next_cursor ?? null,
        hasMore: Boolean(meta?.has_more),
        deleted: 0,
        deactivated: 0,
        errors,
        meta,
        requestId,
        requestIds,
        syncedAt: now,
        catalogOnly: registryEntry.executionAvailable !== true,
    };
};

const normalizeSyncAllFamilies = ({ families, includeSteamGifts = false } = {}) => {
    const requested = Array.isArray(families) && families.length
        ? families
        : SYNC_ALL_DEFAULT_FAMILIES;
    const normalized = [...new Set(requested.map((family) => String(family || '').trim().toUpperCase()).filter(Boolean))];

    if (includeSteamGifts === true && !normalized.includes('STEAM_GIFTS')) {
        normalized.push('STEAM_GIFTS');
    }

    for (const familyKey of normalized) {
        const registryEntry = getFazerCardsFamily(familyKey);
        if (!registryEntry || registryEntry.familyKey === 'UNKNOWN') {
            throw new BusinessRuleError(`Unknown FazerCards catalog family: ${familyKey}.`, 'FAZERCARDS_UNKNOWN_FAMILY');
        }
    }

    return normalized;
};

const getSyncAllFamilyValue = (source = {}, familyKey, key) => {
    if (!source || typeof source !== 'object') return undefined;
    return source[familyKey]?.[key]
        ?? source[familyKey.toLowerCase()]?.[key]
        ?? source[familyKey];
};

const getSyncAllFamilyLimit = (options = {}, familyKey) => {
    const value = getSyncAllFamilyValue(options.limits, familyKey, 'limit')
        ?? getSyncAllFamilyValue(options.familyOptions, familyKey, 'limit')
        ?? options.limit;
    return Math.min(Math.max(parseInt(value, 10) || 20, 1), 100);
};

const getSyncAllFamilyCursor = (options = {}, familyKey) => (
    getSyncAllFamilyValue(options.cursors, familyKey, 'cursor')
    ?? getSyncAllFamilyValue(options.familyOptions, familyKey, 'cursor')
    ?? (Array.isArray(options.families) && options.families.length === 1 ? options.cursor : null)
);

const emptySyncFamilyResult = (familyKey, overrides = {}) => {
    const family = getFazerCardsFamily(familyKey);
    return {
        familyKey,
        displayName: family?.displayName || familyKey,
        endpoints: family?.catalogEndpoints || [],
        categoriesFetched: 0,
        pagesFetched: 0,
        offersFetched: 0,
        providerProductsCreated: 0,
        providerProductsUpdated: 0,
        blocked: 0,
        unsupported: 0,
        productsSkipped: 0,
        skipReasons: {},
        nextCursor: null,
        hasMore: false,
        errors: [],
        catalogOnly: family?.executionAvailable !== true,
        ...overrides,
    };
};

const getSteamGiftIndexMaxResults = () => {
    const configured = parseInt(config.providers.fazerCards.steamGiftsIndexMaxResults, 10);
    return Number.isFinite(configured) && configured > 0 ? configured : null;
};

const extractSteamGiftIndexGames = (data = {}) => {
    if (Array.isArray(data?.games)) return data.games;
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.data?.games)) return data.data.games;
    if (Array.isArray(data)) return data;
    return [];
};

const summarizeSteamGiftIndexItem = (item = {}) => ({
    appid: item.appid,
    name: item.name,
    indexedAt: item.indexedAt,
    lastSeenAt: item.lastSeenAt,
});

const refreshSteamGiftGameIndex = async (options = {}, adapterOptions = {}) => {
    if (steamGiftIndexRefreshInProgress) {
        throw new BusinessRuleError('Steam Gifts index refresh is already running.', 'FAZERCARDS_STEAM_GIFTS_INDEX_REFRESH_IN_PROGRESS');
    }

    const latest = await FazerCardsSteamGiftGameIndex.findOne({ provider: PROVIDER_CODES.FAZER_CARDS })
        .sort({ indexedAt: -1 })
        .select('indexedAt')
        .lean();
    const now = new Date();
    if (latest?.indexedAt && now.getTime() - new Date(latest.indexedAt).getTime() < STEAM_GIFT_INDEX_RATE_LIMIT_MS) {
        const retryAfterSeconds = Math.max(
            1,
            Math.ceil((STEAM_GIFT_INDEX_RATE_LIMIT_MS - (now.getTime() - new Date(latest.indexedAt).getTime())) / 1000)
        ) + FAZERCARDS_RATE_LIMIT_SAFETY_BUFFER_SECONDS;
        const error = new BusinessRuleError('Steam Gifts index refresh is rate-limited. Try again later.', 'FAZERCARDS_STEAM_GIFTS_INDEX_RATE_LIMITED');
        error.statusCode = 429;
        error.retryAfterSeconds = retryAfterSeconds;
        throw error;
    }

    steamGiftIndexRefreshInProgress = true;
    try {
        const adapter = new FazerCardsAdapter(adapterOptions);
        const maxResults = getSteamGiftIndexMaxResults();
        const params = maxResults ? { limit: maxResults } : {};
        const response = await adapter.fetchSteamGiftGames(params);
        const games = extractSteamGiftIndexGames(response.data);
        const operations = [];
        let skipped = 0;

        for (const game of games) {
            const appid = parseNumber(firstValue(game.appid, game.app_id, game.id), null);
            const name = String(firstValue(game.name, game.title, '')).trim();
            if (!Number.isInteger(appid) || appid <= 0 || !name) {
                skipped++;
                continue;
            }
            operations.push({
                updateOne: {
                    filter: { appid },
                    update: {
                        $set: {
                            appid,
                            name,
                            normalizedName: normalizeSteamGiftGameName(name),
                            provider: PROVIDER_CODES.FAZER_CARDS,
                            source: 'steam-gifts',
                            lastSeenAt: now,
                            indexedAt: now,
                            rawSanitized: null,
                        },
                    },
                    upsert: true,
                },
            });
        }

        let upsertedCount = 0;
        let modifiedCount = 0;
        const chunkSize = 1000;
        for (let index = 0; index < operations.length; index += chunkSize) {
            const result = await FazerCardsSteamGiftGameIndex.bulkWrite(operations.slice(index, index + chunkSize), { ordered: false });
            upsertedCount += result.upsertedCount || 0;
            modifiedCount += result.modifiedCount || 0;
        }

        const meta = response.data?.meta || {};
        const warning = meta.truncated === true || (maxResults && games.length >= maxResults)
            ? 'Steam Gifts index refresh was partial/truncated.'
            : null;

        return {
            success: true,
            familyKey: 'STEAM_GIFTS',
            total: meta.total ?? null,
            returned: meta.returned ?? games.length,
            upserted: upsertedCount,
            updated: modifiedCount,
            skipped,
            indexedAt: now,
            warning,
            partial: Boolean(warning),
            maxResults,
            requestId: response.requestId || null,
        };
    } finally {
        steamGiftIndexRefreshInProgress = false;
    }
};

const searchSteamGiftGameIndex = async ({ q = '', limit = 20 } = {}) => {
    const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const query = String(q || '').trim();
    const totalIndexed = await FazerCardsSteamGiftGameIndex.countDocuments({ provider: PROVIDER_CODES.FAZER_CARDS });

    if (totalIndexed === 0) {
        return {
            items: [],
            indexEmpty: true,
            message: 'Steam Gifts index is empty. Refresh the index or enter AppID manually.',
            query,
            limit: normalizedLimit,
        };
    }

    const normalizedQuery = normalizeSteamGiftGameName(query);
    const filter = { provider: PROVIDER_CODES.FAZER_CARDS };
    if (query) {
        const numericAppId = /^\d+$/.test(query) ? Number(query) : null;
        if (numericAppId) {
            filter.appid = numericAppId;
        } else if (normalizedQuery) {
            filter.normalizedName = { $regex: escapeRegex(normalizedQuery), $options: 'i' };
        }
    }

    const items = await FazerCardsSteamGiftGameIndex.find(filter)
        .sort(query && /^\d+$/.test(query) ? { appid: 1 } : { normalizedName: 1, appid: 1 })
        .limit(normalizedLimit)
        .lean();

    return {
        items: items.map(summarizeSteamGiftIndexItem),
        indexEmpty: false,
        message: '',
        query,
        limit: normalizedLimit,
    };
};

const syncAllCatalogFamilies = async (options = {}, adapterOptions = {}) => {
    if (syncAllInProgress) {
        throw new BusinessRuleError('A FazerCards catalog sync-all job is already running.', 'FAZERCARDS_SYNC_ALREADY_RUNNING');
    }

    const familyKeys = normalizeSyncAllFamilies(options);
    syncAllInProgress = true;
    const startedAt = new Date();
    const results = {};
    const errors = [];
    const warnings = [];

    try {
        for (const familyKey of familyKeys) {
            const registryEntry = getFazerCardsFamily(familyKey);
            if (familyKey === 'STEAM_GIFTS' || registryEntry?.catalogAvailable === false) {
                const steamGiftSkip = familyKey === 'STEAM_GIFTS';
                results[familyKey] = emptySyncFamilyResult(familyKey, {
                    success: false,
                    skipped: true,
                    unavailable: registryEntry?.catalogAvailable === false,
                    onDemandOnly: steamGiftSkip,
                    errors: [
                        steamGiftSkip
                            ? 'Steam Gifts broad sync is intentionally disabled. Sync one explicit appid instead.'
                            : registryEntry?.warning || 'FazerCards catalog family is unavailable.',
                    ],
                });
                warnings.push({
                    familyKey,
                    code: steamGiftSkip ? 'FAZERCARDS_STEAM_GIFTS_ON_DEMAND_SYNC_ONLY' : registryEntry?.blockReason || 'FAZERCARDS_FAMILY_UNAVAILABLE',
                    message: results[familyKey].errors[0],
                });
                continue;
            }

            try {
                const result = await syncCatalogFamily({
                    family: familyKey,
                    limit: getSyncAllFamilyLimit(options, familyKey),
                    cursor: getSyncAllFamilyCursor(options, familyKey),
                }, adapterOptions);
                results[familyKey] = {
                    success: true,
                    skipped: false,
                    ...result,
                    familyKey,
                };
            } catch (err) {
                if (isFazerCardsRateLimitError(err)) throw err;
                const safeError = {
                    code: err.code || 'FAZERCARDS_SYNC_FAMILY_FAILED',
                    message: err.safeUpstreamMessage || err.message || 'FazerCards family sync failed.',
                    httpStatus: err.httpStatus || err.statusCode || null,
                };
                results[familyKey] = emptySyncFamilyResult(familyKey, {
                    success: false,
                    skipped: false,
                    errors: [safeError.message],
                    error: safeError,
                });
                errors.push({ familyKey, ...safeError });
            }
        }

        const totals = Object.values(results).reduce((sum, item) => ({
            categoriesFetched: sum.categoriesFetched + (Number(item.categoriesFetched) || 0),
            pagesFetched: sum.pagesFetched + (Number(item.pagesFetched) || 0),
            offersFetched: sum.offersFetched + (Number(item.offersFetched) || 0),
            providerProductsCreated: sum.providerProductsCreated + (Number(item.providerProductsCreated) || 0),
            providerProductsUpdated: sum.providerProductsUpdated + (Number(item.providerProductsUpdated) || 0),
            blocked: sum.blocked + (Number(item.blocked) || 0),
            unsupported: sum.unsupported + (Number(item.unsupported) || 0),
            productsSkipped: sum.productsSkipped + (Number(item.productsSkipped) || 0),
        }), {
            categoriesFetched: 0,
            pagesFetched: 0,
            offersFetched: 0,
            providerProductsCreated: 0,
            providerProductsUpdated: 0,
            blocked: 0,
            unsupported: 0,
            productsSkipped: 0,
        });

        const summary = {
            success: errors.length === 0 || Object.values(results).some((result) => result.success === true),
            familiesRequested: familyKeys,
            familiesSynced: Object.values(results).filter((result) => result.success === true).map((result) => result.familyKey),
            familiesSkipped: Object.values(results).filter((result) => result.skipped === true).map((result) => result.familyKey),
            results,
            totals,
            errors,
            warnings,
            startedAt,
            finishedAt: new Date(),
        };
        lastSyncAllSummary = sanitizePayload(summary);
        return summary;
    } finally {
        syncAllInProgress = false;
    }
};

const parseBooleanFilter = (value) => {
    if (value === undefined || value === null || value === '') return undefined;
    return ['true', '1', 'yes'].includes(String(value).trim().toLowerCase());
};

const parseImportedFilter = parseBooleanFilter;

const hasTopupPayloadShape = (product = {}) => Boolean(
    product.rawPayload?.category
    && product.rawPayload?.offer
    && (
        product.rawPayload.category.category_id
        || product.rawPayload.category.categoryId
        || product.rawPayload.category.id
    )
    && (
        product.rawPayload.offer.offer_id
        || product.rawPayload.offer.offerId
        || product.rawPayload.offer.id
    )
);

const isLegacyTopupProviderProduct = (product = {}) => (
    product.providerCode === PROVIDER_CODES.FAZER_CARDS
    && (
        String(product.externalProductId || '').startsWith('FAZER_TOPUP:')
        || product.fulfillmentMode === FULFILLMENT_MODES.TOPUP_WITH_FIELDS
        || hasTopupPayloadShape(product)
    )
);

const inferFazerCardsFamilyKey = (product = {}) => {
    const explicit = String(product.familyKey || '').trim().toUpperCase();
    if (explicit && explicit !== 'UNKNOWN') return explicit;
    if (isLegacyTopupProviderProduct(product)) return 'TOPUPS';
    return explicit || 'UNKNOWN';
};

const addAndCondition = (query, condition) => {
    if (!condition || Object.keys(condition).length === 0) return;
    if (!query.$and) query.$and = [];
    query.$and.push(condition);
};

const buildFamilyFilter = (familyKey) => {
    const normalized = String(familyKey || '').trim().toUpperCase();
    if (!normalized) return null;
    if (normalized === 'TOPUPS') {
        return {
            $or: [
                { familyKey: 'TOPUPS' },
                { externalProductId: /^FAZER_TOPUP:/ },
                { fulfillmentMode: FULFILLMENT_MODES.TOPUP_WITH_FIELDS },
                {
                    $and: [
                        {
                            $or: [
                                { familyKey: { $exists: false } },
                                { familyKey: null },
                                { familyKey: '' },
                                { familyKey: 'UNKNOWN' },
                            ],
                        },
                        { 'rawPayload.category': { $exists: true } },
                        { 'rawPayload.offer': { $exists: true } },
                    ],
                },
            ],
        };
    }
    if (normalized === 'UNKNOWN') {
        return {
            $and: [
                {
                    $or: [
                        { familyKey: { $exists: false } },
                        { familyKey: null },
                        { familyKey: '' },
                        { familyKey: 'UNKNOWN' },
                    ],
                },
                { externalProductId: { $not: /^FAZER_TOPUP:/ } },
                { fulfillmentMode: { $ne: FULFILLMENT_MODES.TOPUP_WITH_FIELDS } },
                {
                    $nor: [{
                        'rawPayload.category': { $exists: true },
                        'rawPayload.offer': { $exists: true },
                    }],
                },
            ],
        };
    }
    return { familyKey: normalized };
};

const PROVIDER_PRODUCT_PRIMARY_SEARCH_FIELDS = Object.freeze([
    'rawName',
    'name',
    'translatedName',
]);

const PROVIDER_PRODUCT_MEDIUM_SEARCH_FIELDS = Object.freeze([
    'category',
    'categoryName',
    'familyKey',
    'subCategory',
    'offerName',
    'region',
    'platform',
    'fulfillmentMode',
    'supportLevel',
    'blockReason',
    'rawPayload.family',
    'rawPayload.kind',
    'rawPayload.category.name',
    'rawPayload.category.title',
    'rawPayload.offer.name',
    'rawPayload.offer.title',
    'rawPayload.game.name',
    'rawPayload.game.GameName',
    'rawPayload.game.title',
    'rawPayload.game.platform',
    'rawPayload.game.region',
    'rawPayload.key.name',
    'rawPayload.key.title',
    'rawPayload.response.name',
    'rawPayload.response.title',
]);

const PROVIDER_PRODUCT_LOW_SEARCH_FIELDS = Object.freeze([
    'externalProductId',
    'offerId',
    'sku',
    'code',
    'reference',
    'rawPayload.sku',
    'rawPayload.code',
    'rawPayload.reference',
    'rawPayload.category.category_id',
    'rawPayload.category.categoryId',
    'rawPayload.category.id',
    'rawPayload.category.name',
    'rawPayload.category.title',
    'rawPayload.category.sku',
    'rawPayload.category.code',
    'rawPayload.category.reference',
    'rawPayload.offer.offer_id',
    'rawPayload.offer.offerId',
    'rawPayload.offer.card_id',
    'rawPayload.offer.cardId',
    'rawPayload.offer.key_id',
    'rawPayload.offer.keyId',
    'rawPayload.offer.product_id',
    'rawPayload.offer.productId',
    'rawPayload.offer.manual_service_id',
    'rawPayload.offer.manualServiceId',
    'rawPayload.offer.id',
    'rawPayload.offer.name',
    'rawPayload.offer.title',
    'rawPayload.offer.sku',
    'rawPayload.offer.code',
    'rawPayload.offer.reference',
    'rawPayload.game.game_id',
    'rawPayload.game.gameId',
    'rawPayload.game.id',
    'rawPayload.game.name',
    'rawPayload.game.GameName',
    'rawPayload.game.title',
    'rawPayload.game.platform',
    'rawPayload.game.region',
    'rawPayload.game.sku',
    'rawPayload.game.code',
    'rawPayload.key.key_id',
    'rawPayload.key.keyId',
    'rawPayload.key.id',
    'rawPayload.key.name',
    'rawPayload.key.title',
    'rawPayload.key.sku',
    'rawPayload.key.code',
    'rawPayload.key.reference',
    'rawPayload.response.product_id',
    'rawPayload.response.productId',
    'rawPayload.response.offer_id',
    'rawPayload.response.offerId',
    'rawPayload.response.card_id',
    'rawPayload.response.cardId',
    'rawPayload.response.key_id',
    'rawPayload.response.keyId',
    'rawPayload.response.manual_service_id',
    'rawPayload.response.manualServiceId',
    'rawPayload.response.name',
    'rawPayload.response.title',
    'rawPayload.response.sku',
    'rawPayload.response.code',
    'rawPayload.response.reference',
]);

const PROVIDER_PRODUCT_SEARCH_FIELDS = Object.freeze([
    ...PROVIDER_PRODUCT_PRIMARY_SEARCH_FIELDS,
    ...PROVIDER_PRODUCT_MEDIUM_SEARCH_FIELDS,
    ...PROVIDER_PRODUCT_LOW_SEARCH_FIELDS,
]);

const buildSearchRegex = (termSpec) => {
    const escaped = escapeRegex(termSpec.pattern || termSpec.term);
    if (termSpec.short) {
        return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, 'i');
    }
    return new RegExp(escaped, 'i');
};

const buildProviderProductSearchFilter = (search) => {
    const searchTerms = buildFazerCardsSearchTermSpecs(search)
        .filter((termSpec) => !termSpec.supportingOnly);
    if (searchTerms.length === 0) return null;

    const clauses = [];
    for (const termSpec of searchTerms) {
        const regex = buildSearchRegex(termSpec);
        for (const field of PROVIDER_PRODUCT_SEARCH_FIELDS) {
            clauses.push({ [field]: regex });
        }
    }

    return { $or: clauses };
};

const getPathValue = (source = {}, path = '') => {
    if (!source || !path) return undefined;
    return path.split('.').reduce((value, key) => (
        value && typeof value === 'object' ? value[key] : undefined
    ), source);
};

const getSearchFieldValues = (product = {}, fields = []) => fields
    .flatMap((field) => {
        const value = getPathValue(product, field);
        if (Array.isArray(value)) return value;
        return [value];
    })
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map((value) => String(value));

const valueMatchesTermSpec = (value, termSpec) => {
    const normalizedValue = normalizeSearchTerm(value);
    if (!normalizedValue) return false;
    if (termSpec.short) {
        const tokenRegex = new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(termSpec.pattern || termSpec.term)}(?=$|[^A-Za-z0-9])`, 'i');
        return tokenRegex.test(String(value || ''));
    }
    return normalizedValue.includes(termSpec.term);
};

const anyFieldMatchesTermSpec = (product, fields, termSpec) => (
    getSearchFieldValues(product, fields).some((value) => valueMatchesTermSpec(value, termSpec))
);

const scoreFazerCardsSearchResult = (product = {}, searchText = '') => {
    const termSpecs = buildFazerCardsSearchTermSpecs(searchText);
    const directTerms = termSpecs.filter((termSpec) => termSpec.direct);
    const strongAliasTerms = termSpecs.filter((termSpec) => !termSpec.direct && !termSpec.supportingOnly);
    const supportingTerms = termSpecs.filter((termSpec) => termSpec.supportingOnly);
    let score = 0;

    for (const termSpec of directTerms) {
        if (anyFieldMatchesTermSpec(product, PROVIDER_PRODUCT_PRIMARY_SEARCH_FIELDS, termSpec)) score = Math.max(score, 1000);
        else if (anyFieldMatchesTermSpec(product, PROVIDER_PRODUCT_MEDIUM_SEARCH_FIELDS, termSpec)) score = Math.max(score, 550);
        else if (anyFieldMatchesTermSpec(product, PROVIDER_PRODUCT_LOW_SEARCH_FIELDS, termSpec)) score = Math.max(score, 250);
    }

    for (const termSpec of strongAliasTerms) {
        if (anyFieldMatchesTermSpec(product, PROVIDER_PRODUCT_PRIMARY_SEARCH_FIELDS, termSpec)) score = Math.max(score, 800);
        else if (anyFieldMatchesTermSpec(product, PROVIDER_PRODUCT_MEDIUM_SEARCH_FIELDS, termSpec)) score = Math.max(score, 450);
        else if (anyFieldMatchesTermSpec(product, PROVIDER_PRODUCT_LOW_SEARCH_FIELDS, termSpec)) score = Math.max(score, 175);
    }

    if (score > 0) {
        for (const termSpec of supportingTerms) {
            if (anyFieldMatchesTermSpec(product, PROVIDER_PRODUCT_SEARCH_FIELDS, termSpec)) score += 25;
        }
    }

    return score;
};

const sortFazerCardsSearchResults = (products = [], searchText = '') => (
    products
        .map((product) => ({
            product,
            score: scoreFazerCardsSearchResult(product, searchText),
        }))
        .sort((left, right) => (
            right.score - left.score
            || String(left.product.rawName || '').localeCompare(String(right.product.rawName || ''))
            || String(left.product.externalProductId || '').localeCompare(String(right.product.externalProductId || ''))
        ))
        .map(({ product }) => product)
);

const buildFazerCardsProviderProductScope = async () => {
    const provider = await findFazerCardsProvider();
    if (!provider?._id) return { providerCode: PROVIDER_CODES.FAZER_CARDS };

    return {
        $or: [
            { providerCode: PROVIDER_CODES.FAZER_CARDS },
            { provider: provider._id },
        ],
    };
};

const listProviderProducts = async ({
    page = 1,
    limit = 50,
    search,
    q,
    query: queryText,
    category,
    region,
    available,
    supported,
    blocked,
    imported,
    fulfillmentMode,
    familyKey,
    familyKeyExplicit,
    explicitFamily,
    supportLevel,
    blockReason,
} = {}) => {
    const query = await buildFazerCardsProviderProductScope();
    const searchText = search || q || queryText;
    const hasSearch = String(searchText || '').trim().length > 0;
    const shouldApplyFamilyFilter = !hasSearch
        || familyKeyExplicit === true
        || familyKeyExplicit === 'true'
        || explicitFamily === true
        || explicitFamily === 'true';
    if (category) query.category = String(category).trim();
    if (region) query.region = String(region).trim();
    if (fulfillmentMode) query.fulfillmentMode = String(fulfillmentMode).trim().toUpperCase();
    if (shouldApplyFamilyFilter) addAndCondition(query, buildFamilyFilter(familyKey));
    if (supportLevel) query.supportLevel = String(supportLevel).trim().toUpperCase();
    if (blockReason) query.blockReason = String(blockReason).trim().toUpperCase();

    const availableFilter = parseBooleanFilter(available);
    if (availableFilter !== undefined) query.available = availableFilter;
    const supportedFilter = parseBooleanFilter(supported);
    if (supportedFilter !== undefined) query.isSupported = supportedFilter;
    const blockedFilter = parseBooleanFilter(blocked);
    if (blockedFilter !== undefined) query.isBlocked = blockedFilter;
    const importedFilter = parseImportedFilter(imported);
    let importedProductMap = new Map();

    if (importedFilter !== undefined) {
        const importedProducts = await Product.find({
            providerProduct: { $ne: null },
            deletedAt: null,
        }).select(IMPORTED_PRODUCT_LAUNCH_SELECT).lean();
        importedProductMap = new Map(importedProducts.map((product) => [
            String(product.providerProduct),
            product,
        ]));
        const importedIds = importedProducts.map((product) => product.providerProduct).filter(Boolean);
        query._id = importedFilter ? { $in: importedIds } : { $nin: importedIds };
    }

    addAndCondition(query, buildProviderProductSearchFilter(searchText));

    const normalizedPage = Math.max(parseInt(page, 10) || 1, 1);
    const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const skip = (normalizedPage - 1) * normalizedLimit;

    let products = [];
    let total = 0;

    if (hasSearch) {
        const matchedProducts = await ProviderProduct.find(query)
            .sort({ rawName: 1, externalProductId: 1 })
            .populate('provider', 'name slug providerCode')
            .lean();
        const rankedProducts = sortFazerCardsSearchResults(matchedProducts, searchText);
        total = rankedProducts.length;
        products = rankedProducts.slice(skip, skip + normalizedLimit);
    } else {
        [products, total] = await Promise.all([
            ProviderProduct.find(query)
                .sort({ rawName: 1, externalProductId: 1 })
                .skip(skip)
                .limit(normalizedLimit)
                .populate('provider', 'name slug providerCode')
                .lean(),
            ProviderProduct.countDocuments(query),
        ]);
    }

    if (importedFilter === undefined && products.length) {
        const importedProducts = await Product.find({
            providerProduct: { $in: products.map((product) => product._id) },
            deletedAt: null,
        }).select(IMPORTED_PRODUCT_LAUNCH_SELECT).lean();
        importedProductMap = new Map(importedProducts.map((product) => [
            String(product.providerProduct),
            product,
        ]));
    }

    return {
        products: products.map((product) => {
            const importedProduct = importedProductMap.get(String(product._id)) || null;
            return {
                ...product,
                imported: Boolean(importedProduct),
                importedProduct: summarizeImportedLaunchProduct(importedProduct),
            };
        }),
        pagination: {
            page: normalizedPage,
            limit: normalizedLimit,
            total,
            pages: Math.ceil(total / normalizedLimit),
        },
    };
};

const getCatalogSummary = async () => {
    const products = await ProviderProduct.find({ providerCode: PROVIDER_CODES.FAZER_CARDS })
        .select('_id providerCode externalProductId familyKey fulfillmentMode rawPayload isSupported isBlocked')
        .lean();
    const importedProducts = await Product.find({
        providerProduct: { $in: products.map((product) => product._id) },
        deletedAt: null,
    }).select('providerProduct').lean();
    const importedIds = new Set(importedProducts.map((product) => String(product.providerProduct)));
    const byFamily = {};

    for (const family of listFazerCardsFamilies()) {
        byFamily[family.familyKey] = { total: 0, supported: 0, blocked: 0, imported: 0 };
    }

    for (const product of products) {
        const familyKey = inferFazerCardsFamilyKey(product);
        if (!byFamily[familyKey]) byFamily[familyKey] = { total: 0, supported: 0, blocked: 0, imported: 0 };
        byFamily[familyKey].total++;
        if (product.isSupported === true) byFamily[familyKey].supported++;
        if (product.isBlocked === true) byFamily[familyKey].blocked++;
        if (importedIds.has(String(product._id))) byFamily[familyKey].imported++;
    }

    const nextRecommendedFamilies = listFazerCardsFamilies()
        .filter((family) => family.familyKey !== 'TOPUPS' && family.familyKey !== 'UNKNOWN' && byFamily[family.familyKey]?.total > 0)
        .map((family) => ({
            familyKey: family.familyKey,
            displayName: family.displayName,
            supportLevel: family.supportLevel,
            blocker: family.blockReason || null,
        }));

    return {
        totalProviderProducts: products.length,
        byFamily,
        nextRecommendedFamilies,
    };
};

const backfillLegacyFamilies = async () => {
    const matcher = {
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        $or: [
            { externalProductId: /^FAZER_TOPUP:/ },
            { fulfillmentMode: FULFILLMENT_MODES.TOPUP_WITH_FIELDS },
            {
                'rawPayload.category': { $exists: true },
                'rawPayload.offer': { $exists: true },
            },
        ],
    };
    const candidates = await ProviderProduct.find(matcher)
        .select('_id providerCode externalProductId familyKey supportLevel executionBlocked fulfillmentMode rawPayload')
        .lean();

    let matched = 0;
    let updated = 0;
    let skipped = 0;
    const byFamily = { TOPUPS: 0 };

    for (const product of candidates) {
        if (!isLegacyTopupProviderProduct(product)) {
            continue;
        }
        matched++;
        byFamily.TOPUPS++;

        const set = {};
        const explicitFamily = String(product.familyKey || '').trim().toUpperCase();
        if (!explicitFamily || explicitFamily === 'UNKNOWN') set.familyKey = 'TOPUPS';
        if (!product.supportLevel) set.supportLevel = SUPPORT_LEVELS.FULL_TOPUP_SUPPORTED;
        if (product.executionBlocked !== false) set.executionBlocked = false;

        if (Object.keys(set).length === 0) {
            skipped++;
            continue;
        }

        const result = await ProviderProduct.updateOne({ _id: product._id }, { $set: set });
        if ((result.modifiedCount || 0) > 0) updated++;
    }

    return {
        success: true,
        matched,
        updated,
        skipped,
        byFamily,
    };
};

const getProviderProductDetails = async (id) => {
    const product = await ProviderProduct.findOne({
        _id: id,
        providerCode: PROVIDER_CODES.FAZER_CARDS,
    }).populate('provider', 'name slug providerCode').lean();
    if (!product) throw new NotFoundError('ProviderProduct');
    const importedProduct = await Product.findOne({
        providerProduct: product._id,
        deletedAt: null,
    }).select(IMPORTED_PRODUCT_LAUNCH_SELECT).lean();
    return {
        ...product,
        imported: Boolean(importedProduct),
        importedProduct: summarizeImportedLaunchProduct(importedProduct),
    };
};

const PRODUCT_FIELD_TYPES = new Set(['text', 'textarea', 'number', 'select', 'url', 'email', 'tel', 'date']);

const normalizeFieldKey = (value, fallback) => {
    const key = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_');
    if (/^[a-z][a-z0-9_]*$/.test(key)) return key;
    return fallback;
};

const normalizeProductFieldType = (value) => {
    const normalized = String(value || 'text').trim().toLowerCase();
    return PRODUCT_FIELD_TYPES.has(normalized) ? normalized : 'text';
};

const buildOrderFieldsFromProviderFields = (fields = []) => {
    const usedKeys = new Set();
    return fields.map((field, index) => {
        const rawKey = typeof field === 'string' ? field : field?.key || field?.name || field?.id;
        const baseKey = normalizeFieldKey(rawKey, `field_${index + 1}`);
        let key = baseKey;
        let suffix = 2;
        while (usedKeys.has(key)) {
            key = `${baseKey}_${suffix}`;
            suffix++;
        }
        usedKeys.add(key);

        return {
            id: key,
            key,
            label: String((typeof field === 'string' ? field : field?.label || field?.title || field?.name) || key).trim(),
            type: normalizeProductFieldType(typeof field === 'string' ? 'text' : field?.type),
            required: typeof field === 'string' ? true : field?.required !== false,
            options: Array.isArray(field?.options) ? field.options.map((option) => String(option || '').trim()).filter(Boolean) : [],
            min: typeof field === 'string' ? null : field?.min ?? null,
            max: typeof field === 'string' ? null : field?.max ?? null,
            sortOrder: index,
            isActive: true,
            providerKey: rawKey || key,
        };
    });
};

const buildDynamicFieldsFromOrderFields = (orderFields = []) => (
    orderFields.map((field) => ({
        name: field.key,
        label: field.label,
        type: field.type,
        required: field.required !== false,
        options: Array.isArray(field.options) ? field.options : [],
        min: field.min ?? null,
        max: field.max ?? null,
        isActive: field.isActive !== false,
    }))
);

const buildProviderMapping = (orderFields = []) => (
    Object.fromEntries(
        orderFields
            .filter((field) => field.providerKey && field.providerKey !== field.key)
            .map((field) => [field.key, String(field.providerKey)])
    )
);

const getProviderProductFamilyKey = (providerProduct = {}) => {
    const explicit = String(providerProduct.familyKey || providerProduct.rawPayload?.family || '').trim().toUpperCase();
    if (explicit) return explicit;
    const external = String(providerProduct.externalProductId || '').trim();
    if (external.startsWith('FAZER_GIFTCARD:')) return 'GIFTCARDS';
    if (external.startsWith('FAZER_GAMEKEY:')) return 'GAME_KEYS';
    if (external.startsWith('FAZER_STEAM_TOPUP:')) return 'STEAM_TOPUP';
    if (external.startsWith('FAZER_STEAM_GIFT:')) return 'STEAM_GIFTS';
    if (external.startsWith('FAZER_TELEGRAM:')) return 'TELEGRAM';
    if (external.startsWith('FAZER_MANUAL_SERVICE:')) return 'MANUAL_SERVICES';
    return inferFazerCardsFamilyKey(providerProduct);
};

const isCodeDeliveryImportCandidate = (providerProduct = {}) => (
    providerProduct.providerCode === PROVIDER_CODES.FAZER_CARDS
    && providerProduct.fulfillmentMode === FULFILLMENT_MODES.CODE_DELIVERY
    && CODE_DELIVERY_IMPORT_FAMILIES.has(getProviderProductFamilyKey(providerProduct))
);

const isTopupImportCandidate = (providerProduct = {}) => (
    providerProduct.fulfillmentMode === FULFILLMENT_MODES.TOPUP_WITH_FIELDS
);

const isDraftImportCandidate = (providerProduct = {}) => (
    providerProduct.providerCode === PROVIDER_CODES.FAZER_CARDS
    && DRAFT_IMPORT_FAMILIES.has(getProviderProductFamilyKey(providerProduct))
    && providerProduct.fulfillmentMode
    && providerProduct.fulfillmentMode !== FULFILLMENT_MODES.UNKNOWN
);

const getFamilyBlockReason = (providerProduct = {}) => {
    const familyKey = getProviderProductFamilyKey(providerProduct);
    return providerProduct.blockReason
        || UNIMPLEMENTED_FAMILY_BLOCK_REASONS[familyKey]
        || getFazerCardsFamily(familyKey)?.blockReason
        || 'EXECUTION_NOT_IMPLEMENTED';
};

const isAutoProviderImportCandidate = (providerProduct = {}) => AUTO_PROVIDER_FAMILIES.has(getProviderProductFamilyKey(providerProduct));

const shouldBlockImportedProductExecution = (providerProduct = {}) => !isAutoProviderImportCandidate(providerProduct);

const assertImportableProviderProduct = (providerProduct) => {
    if (!providerProduct) throw new NotFoundError('ProviderProduct');
    if (providerProduct.providerCode !== PROVIDER_CODES.FAZER_CARDS) {
        throw new BusinessRuleError('Only FazerCards provider products can be imported here.', 'FAZERCARDS_PROVIDER_PRODUCT_REQUIRED');
    }

    const isTopup = isTopupImportCandidate(providerProduct);
    const familyKey = getProviderProductFamilyKey(providerProduct);
    if (!isTopup && !isDraftImportCandidate(providerProduct)) {
        throw new BusinessRuleError('Only recognized FazerCards catalog products can be imported as inactive drafts.', 'FAZERCARDS_IMPORT_UNSUPPORTED_FULFILLMENT_MODE');
    }
    if (isTopup) {
        if (providerProduct.isSupported !== true) {
            throw new BusinessRuleError('Unsupported FazerCards provider products cannot be imported.', 'FAZERCARDS_PROVIDER_PRODUCT_UNSUPPORTED');
        }
        if (providerProduct.isBlocked === true) {
            throw new BusinessRuleError('Blocked FazerCards provider products cannot be imported.', 'FAZERCARDS_PROVIDER_PRODUCT_BLOCKED');
        }
        if (!Array.isArray(providerProduct.requiredFields) || providerProduct.requiredFields.length === 0) {
            throw new BusinessRuleError('FazerCards provider product is missing required fields.', 'FAZERCARDS_PROVIDER_PRODUCT_MISSING_FIELDS');
        }
    }

    if (!isTopup && !DRAFT_IMPORT_FAMILIES.has(familyKey)) {
        throw new BusinessRuleError('FazerCards product family is not enabled for draft import.', 'FAZERCARDS_IMPORT_FAMILY_UNSUPPORTED');
    }

    const rawCostPrice = providerProduct.costPrice ?? providerProduct.rawPrice;
    const costPrice = Number(rawCostPrice);
    if (rawCostPrice === undefined || rawCostPrice === null || rawCostPrice === '' || !Number.isFinite(costPrice) || costPrice <= 0) {
        throw new BusinessRuleError('FazerCards provider product has an invalid cost price.', 'FAZERCARDS_PROVIDER_PRODUCT_INVALID_COST');
    }
};

const normalizeImportCurrency = async (currency) => {
    const normalized = String(currency || 'USD').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalized)) {
        throw new BusinessRuleError('currency must be a 3-letter code.', 'INVALID_PRODUCT_CURRENCY');
    }
    if (normalized === 'USD') return normalized;

    const exists = await Currency.exists({ code: normalized, isActive: true });
    if (!exists) {
        throw new BusinessRuleError('currency must be USD or an active supported currency.', 'UNSUPPORTED_PRODUCT_CURRENCY');
    }
    return normalized;
};

const buildImportPreview = (providerProduct) => {
    const orderFields = buildOrderFieldsFromProviderFields(providerProduct.requiredFields);
    const familyKey = getProviderProductFamilyKey(providerProduct);
    const executionBlocked = shouldBlockImportedProductExecution(providerProduct);
    const blockReason = executionBlocked ? getFamilyBlockReason(providerProduct) : providerProduct.blockReason || null;
    const family = getFazerCardsFamily(familyKey);
    const providerPrice = String(providerProduct.costPrice ?? providerProduct.rawPrice);
    const calculatedLocalPrice = computeFinalPrice(providerPrice, MARKUP_TYPES.PERCENTAGE, 0);
    return {
        providerProductId: providerProduct._id.toString(),
        providerProductName: providerProduct.rawName,
        externalProductId: providerProduct.externalProductId,
        familyKey,
        fulfillmentMode: providerProduct.fulfillmentMode,
        supportLevel: providerProduct.supportLevel || null,
        executionBlocked: providerProduct.executionBlocked === true,
        blockReason,
        costPrice: providerPrice,
        autoPriceSyncAvailable: Boolean(calculatedLocalPrice),
        calculatedLocalPrice,
        calculatedPriceSource: calculatedLocalPrice ? 'provider_cost' : null,
        defaultPricingMode: calculatedLocalPrice ? PRICING_MODES.SYNC : PRICING_MODES.MANUAL,
        defaultMarkupType: MARKUP_TYPES.PERCENTAGE,
        defaultMarkupValue: 0,
        currency: providerProduct.currency || 'USD',
        requiredFields: providerProduct.requiredFields,
        stock: providerProduct.stock ?? null,
        minQty: providerProduct.minQty || 1,
        maxQty: providerProduct.maxQty || 9999,
        region: providerProduct.region || null,
        platform: providerProduct.platform || null,
        suggestedProductName: providerProduct.translatedName || providerProduct.rawName,
        suggestedOrderFields: orderFields.map(({ providerKey, ...field }) => field),
        warning: executionBlocked
            ? `${family?.displayName || familyKey} execution is not implemented yet. Product will be imported as inactive and not visible to customers.`
            : 'Product will be imported as inactive and not visible to customers.',
    };
};

const getImportPreview = async (id) => {
    const providerProduct = await ProviderProduct.findById(id).populate('provider', 'name slug providerCode isActive').lean();
    assertImportableProviderProduct(providerProduct);
    return buildImportPreview(providerProduct);
};

const hasExplicitSellPrice = (payload = {}) => (
    payload.sellPrice !== undefined
    && payload.sellPrice !== null
    && payload.sellPrice !== ''
);

const resolveFazerCardsImportPricing = (providerProduct, payload = {}) => {
    const providerPrice = String(providerProduct.costPrice ?? providerProduct.rawPrice);
    const markupType = Object.values(MARKUP_TYPES).includes(payload.markupType)
        ? payload.markupType
        : MARKUP_TYPES.PERCENTAGE;
    const markupValue = Number(payload.markupValue ?? 0);
    if (!Number.isFinite(markupValue) || markupValue < 0) {
        throw new BusinessRuleError('markupValue must be a non-negative number.', 'INVALID_MARKUP_VALUE');
    }

    if (hasExplicitSellPrice(payload)) {
        const sellPrice = Number(payload.sellPrice);
        if (!Number.isFinite(sellPrice) || sellPrice <= 0) {
            throw new BusinessRuleError('sellPrice must be a positive number.', 'INVALID_SELL_PRICE');
        }
        return {
            basePrice: String(sellPrice),
            finalPrice: String(sellPrice),
            markupType,
            markupValue,
            pricingMode: PRICING_MODES.MANUAL,
            providerPrice,
            syncPriceWithProvider: false,
        };
    }

    const finalPrice = computeFinalPrice(providerPrice, markupType, markupValue);
    if (!finalPrice) {
        throw new BusinessRuleError(
            'FazerCards provider product has no valid price to auto-sync. Enter a manual sell price.',
            'FAZERCARDS_PROVIDER_PRODUCT_PRICE_REQUIRED'
        );
    }

    return {
        basePrice: finalPrice,
        finalPrice,
        markupType,
        markupValue,
        pricingMode: PRICING_MODES.SYNC,
        providerPrice,
        syncPriceWithProvider: true,
    };
};

const importProviderProduct = async (id, payload = {}, adminUserId = null) => {
    const providerProduct = await ProviderProduct.findById(id).populate('provider', 'name slug providerCode isActive');
    assertImportableProviderProduct(providerProduct);
    if (!providerProduct.provider) throw new NotFoundError('Provider');

    const existing = await Product.findOne({ providerProduct: providerProduct._id, deletedAt: null });
    if (existing && payload.updateExisting !== true) {
        throw new ConflictError(`ProviderProduct '${providerProduct.rawName}' has already been imported as '${existing.name}'.`);
    }

    const currency = await normalizeImportCurrency(payload.currency || providerProduct.currency || 'USD');

    const productName = String(payload.name || providerProduct.translatedName || providerProduct.rawName || '').trim();
    if (productName.length < 2 || productName.length > 200) {
        throw new BusinessRuleError('name must be 2-200 characters.', 'INVALID_PRODUCT_NAME');
    }

    const sameNameProduct = await Product.findOne({
        _id: existing?._id ? { $ne: existing._id } : { $exists: true },
        name: new RegExp(`^${productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
        deletedAt: null,
    });
    if (sameNameProduct) {
        throw new ConflictError(`A product named '${productName}' already exists.`);
    }

    const pricing = resolveFazerCardsImportPricing(providerProduct, payload);
    const familyKey = getProviderProductFamilyKey(providerProduct);
    const executionBlocked = shouldBlockImportedProductExecution(providerProduct);
    const blockReason = executionBlocked ? getFamilyBlockReason(providerProduct) : null;
    const providerExecutionMode = fazerCardsContracts.getDefaultExecutionMode(familyKey);
    const orderFieldsWithProviderKeys = buildOrderFieldsFromProviderFields(providerProduct.requiredFields);
    const providerMapping = buildProviderMapping(orderFieldsWithProviderKeys);
    const orderFields = orderFieldsWithProviderKeys.map(({ providerKey, ...field }) => field);
    const dynamicFields = buildDynamicFieldsFromOrderFields(orderFields);
    const nowUpdate = {
        name: productName,
        description: payload.description ?? providerProduct.rawPayload?.category?.note ?? null,
        image: payload.image || null,
        category: payload.categoryId || payload.category || providerProduct.category || null,
        basePrice: pricing.basePrice,
        providerPrice: pricing.providerPrice,
        finalPrice: pricing.finalPrice,
        currency,
        minQty: providerProduct.minQty || 1,
        maxQty: providerProduct.maxQty || 9999,
        isActive: false,
        visibleInStore: false,
        isPaused: false,
        status: PRODUCT_STATUSES.UNAVAILABLE,
        executionType: EXECUTION_TYPES.MANUAL,
        customerPurchaseEnabled: false,
        pricingMode: pricing.pricingMode,
        markupType: pricing.markupType,
        markupValue: pricing.markupValue,
        syncPriceWithProvider: pricing.syncPriceWithProvider,
        syncNameWithProvider: payload.syncNameFromProvider === true,
        syncAvailabilityWithProvider: payload.syncAvailabilityFromProvider !== false,
        providerExecutionEnabled: false,
        providerExecutionBlocked: executionBlocked,
        providerExecutionMode,
        providerBlockReason: blockReason,
        provider: providerProduct.provider._id,
        providerProduct: providerProduct._id,
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        externalProductId: providerProduct.externalProductId,
        familyKey,
        fulfillmentMode: providerProduct.fulfillmentMode,
        providerCategory: providerProduct.category || null,
        providerCategoryName: providerProduct.categoryName || null,
        providerOfferId: providerProduct.offerId || null,
        providerOfferName: providerProduct.offerName || null,
        providerRegion: providerProduct.region || null,
        providerPlatform: providerProduct.platform || null,
        providerStock: Number.isFinite(Number(providerProduct.stock)) ? Number(providerProduct.stock) : null,
        orderFields,
        dynamicFields,
        providerMapping,
    };

    const product = existing
        ? await Product.findByIdAndUpdate(existing._id, { $set: nowUpdate }, { new: true, runValidators: true })
        : await Product.create({ ...nowUpdate, createdBy: adminUserId });

    return {
        action: existing ? 'updated' : 'created',
        preview: buildImportPreview(providerProduct.toObject()),
        product,
    };
};

const normalizeProviderCode = (value) => String(value || '').trim().toUpperCase();

const assertDryRunProduct = (product, providerProduct) => {
    if (!product) throw new NotFoundError('Product');
    if (!providerProduct) throw new NotFoundError('ProviderProduct');

    const providerCode = normalizeProviderCode(
        product.providerCode
        || product.provider?.providerCode
        || product.provider?.code
        || product.provider?.slug
        || providerProduct.providerCode
        || providerProduct.provider?.providerCode
        || providerProduct.provider?.slug
    );
    const slug = String(product.provider?.slug || providerProduct.provider?.slug || '').trim().toLowerCase();
    if (providerCode !== PROVIDER_CODES.FAZER_CARDS && slug !== FAZERCARDS_SLUG) {
        throw new BusinessRuleError('Product is not linked to FazerCards.', 'FAZERCARDS_PRODUCT_REQUIRED');
    }
    if (providerProduct.providerCode !== PROVIDER_CODES.FAZER_CARDS) {
        throw new BusinessRuleError('Linked ProviderProduct is not a FazerCards product.', 'FAZERCARDS_PROVIDER_PRODUCT_REQUIRED');
    }
    if (providerProduct.fulfillmentMode !== FULFILLMENT_MODES.TOPUP_WITH_FIELDS) {
        throw new BusinessRuleError('Only FazerCards TOPUP_WITH_FIELDS products can be dry-run.', 'FAZERCARDS_UNSUPPORTED_FULFILLMENT_MODE');
    }
    if (providerProduct.isSupported !== true) {
        throw new BusinessRuleError('Unsupported FazerCards ProviderProduct cannot be dry-run.', 'FAZERCARDS_PROVIDER_PRODUCT_UNSUPPORTED');
    }
    if (providerProduct.isBlocked === true) {
        throw new BusinessRuleError('Blocked FazerCards ProviderProduct cannot be dry-run.', 'FAZERCARDS_PROVIDER_PRODUCT_BLOCKED');
    }
    if (!Array.isArray(providerProduct.requiredFields) || providerProduct.requiredFields.length === 0) {
        throw new BusinessRuleError('FazerCards ProviderProduct is missing required customer fields.', 'FAZERCARDS_REQUIRED_FIELDS_MISSING');
    }

    const rawCost = providerProduct.costPrice ?? providerProduct.rawPrice;
    const cost = Number(rawCost);
    if (rawCost === undefined || rawCost === null || rawCost === '' || !Number.isFinite(cost) || cost <= 0) {
        throw new BusinessRuleError('FazerCards ProviderProduct has an invalid cost price.', 'FAZERCARDS_PROVIDER_PRODUCT_INVALID_COST');
    }
};

const buildTopupDryRun = async ({ productId, fields = {}, orderId = null } = {}) => {
    const product = await Product.findById(productId)
        .populate('provider', 'name slug code providerCode')
        .populate({
            path: 'providerProduct',
            select: 'provider providerCode externalProductId rawName costPrice rawPrice currency category offerId fulfillmentMode isSupported isBlocked requiredFields rawPayload',
            populate: { path: 'provider', select: 'name slug providerCode' },
        });
    if (!product) throw new NotFoundError('Product');

    const providerProduct = product.providerProduct;
    assertDryRunProduct(product, providerProduct);

    const { categoryId, offerId } = extractTopupIdentifiers(providerProduct);
    if (!categoryId || !offerId) {
        throw new BusinessRuleError(
            'FazerCards top-up category_id and offer_id are required.',
            !categoryId ? 'FAZERCARDS_CATEGORY_ID_MISSING' : 'FAZERCARDS_OFFER_ID_MISSING'
        );
    }

    const { missing } = buildTopupFields(fields, providerProduct.requiredFields);
    if (missing.length > 0) {
        throw new BusinessRuleError(
            `Missing FazerCards customer field(s): ${missing.join(', ')}.`,
            'FAZERCARDS_CUSTOMER_FIELDS_MISSING'
        );
    }

    const suppliedOrderId = String(orderId || '').trim();
    const idempotencyKeyPreview = `fazercards:topup:${suppliedOrderId || 'DRY_RUN_PREVIEW'}`;
    const executionState = product.providerExecutionEnabled === true ? 'enabled' : 'disabled';

    const contract = fazerCardsContracts.getContractOrUnknown('TOPUPS');
    const contractPayload = fazerCardsContracts.buildPayloadFromContract({
        familyKey: 'TOPUPS',
        providerProduct,
        fields,
    });
    if (contractPayload.success !== true) {
        throw new BusinessRuleError(
            contractPayload.message || 'FazerCards top-up payload contract failed.',
            contractPayload.code || 'FAZERCARDS_TOPUP_PAYLOAD_INVALID'
        );
    }

    return {
        success: true,
        dryRun: true,
        wouldCall: contractPayload.wouldCall,
        provider: 'FazerCards',
        contract,
        idempotencyKeyPreview,
        product: {
            id: product._id.toString(),
            name: product.name,
            providerExecutionEnabled: product.providerExecutionEnabled === true,
        },
        providerProduct: {
            id: providerProduct._id.toString(),
            externalProductId: providerProduct.externalProductId,
            costPrice: String(providerProduct.costPrice ?? providerProduct.rawPrice),
            currency: providerProduct.currency || 'USD',
        },
        payload: contractPayload.payload,
        requiredFields: providerProduct.requiredFields,
        warnings: [
            'Dry run only. No FazerCards order was created.',
            `Product execution is currently ${executionState}.`,
            ...contract.warnings,
        ],
    };
};

const asTrimmedString = (value) => String(value || '').trim();

const extractExternalParts = (externalProductId, prefix) => {
    const external = asTrimmedString(externalProductId);
    if (!external.startsWith(prefix)) return [];
    return external.slice(prefix.length).split(':').map((part) => part.trim()).filter(Boolean);
};

const extractCodeDeliveryIdentifiers = (providerProduct = {}) => {
    const familyKey = getProviderProductFamilyKey(providerProduct);
    const raw = providerProduct.rawPayload || {};
    if (familyKey === 'GIFTCARDS') {
        const externalParts = extractExternalParts(providerProduct.externalProductId, 'FAZER_GIFTCARD:');
        return {
            familyKey,
            categoryId: asTrimmedString(firstValue(
                providerProduct.category,
                raw.category?.category_id,
                raw.category?.categoryId,
                raw.category_id,
                externalParts[0]
            )),
            itemId: asTrimmedString(firstValue(
                providerProduct.offerId,
                raw.offer?.card_id,
                raw.offer?.cardId,
                raw.offer?.id,
                raw.card_id,
                externalParts[1]
            )),
        };
    }
    if (familyKey === 'GAME_KEYS') {
        const externalParts = extractExternalParts(providerProduct.externalProductId, 'FAZER_GAMEKEY:');
        return {
            familyKey,
            categoryId: asTrimmedString(firstValue(
                providerProduct.category,
                raw.game?.game_id,
                raw.game?.gameId,
                raw.game_id,
                externalParts[0]
            )),
            itemId: asTrimmedString(firstValue(
                providerProduct.offerId,
                raw.key?.key_id,
                raw.key?.keyId,
                raw.key?.id,
                raw.key_id,
                externalParts[1]
            )),
        };
    }
    return { familyKey, categoryId: null, itemId: null };
};

const loadCodeDeliveryProduct = async (productId) => {
    const product = await Product.findById(productId)
        .populate('provider', 'name slug code providerCode')
        .populate({
            path: 'providerProduct',
            select: 'provider providerCode externalProductId rawName costPrice rawPrice currency category categoryName offerId offerName familyKey fulfillmentMode supportLevel executionBlocked isSupported isBlocked blockReason requiredFields rawPayload stock minQty maxQty region platform',
            populate: { path: 'provider', select: 'name slug providerCode' },
        });
    if (!product) throw new NotFoundError('Product');
    return product;
};

const assertCodeDeliveryProduct = (product, providerProduct) => {
    if (!product) throw new NotFoundError('Product');
    if (!providerProduct) throw new NotFoundError('ProviderProduct');
    assertFazerCardsProductLink(product);

    if (providerProduct.providerCode !== PROVIDER_CODES.FAZER_CARDS) {
        throw new BusinessRuleError('Linked ProviderProduct is not a FazerCards product.', 'FAZERCARDS_PROVIDER_PRODUCT_REQUIRED');
    }
    const familyKey = getProviderProductFamilyKey(providerProduct);
    if (!CODE_DELIVERY_IMPORT_FAMILIES.has(familyKey)) {
        throw new BusinessRuleError('Only FazerCards GiftCards and GameKeys can use code-delivery dry-run.', 'FAZERCARDS_CODE_DELIVERY_FAMILY_UNSUPPORTED');
    }
    if (providerProduct.fulfillmentMode !== FULFILLMENT_MODES.CODE_DELIVERY) {
        throw new BusinessRuleError('Only FazerCards CODE_DELIVERY products can use this dry-run.', 'FAZERCARDS_UNSUPPORTED_FULFILLMENT_MODE');
    }

    const rawCost = providerProduct.costPrice ?? providerProduct.rawPrice;
    const cost = Number(rawCost);
    if (rawCost === undefined || rawCost === null || rawCost === '' || !Number.isFinite(cost) || cost <= 0) {
        throw new BusinessRuleError('FazerCards ProviderProduct has an invalid cost price.', 'FAZERCARDS_PROVIDER_PRODUCT_INVALID_COST');
    }

    return familyKey;
};

const normalizeCodeDeliveryQuantity = (quantity, providerProduct = {}) => {
    const parsed = Number(quantity ?? 1);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new BusinessRuleError('quantity must be a positive integer.', 'FAZERCARDS_CODE_DELIVERY_QUANTITY_INVALID');
    }
    const minQty = Number(providerProduct.minQty || 1);
    const maxQty = Number(providerProduct.maxQty || 9999);
    if (Number.isFinite(minQty) && parsed < minQty) {
        throw new BusinessRuleError('quantity is below the provider minimum.', 'FAZERCARDS_CODE_DELIVERY_QUANTITY_INVALID');
    }
    if (Number.isFinite(maxQty) && parsed > maxQty) {
        throw new BusinessRuleError('quantity exceeds the provider maximum.', 'FAZERCARDS_CODE_DELIVERY_QUANTITY_INVALID');
    }
    const rawStock = providerProduct.stock;
    const stock = Number(rawStock);
    if (rawStock !== undefined && rawStock !== null && rawStock !== '' && Number.isFinite(stock) && stock >= 0 && parsed > stock) {
        throw new BusinessRuleError('quantity exceeds available provider stock.', 'FAZERCARDS_CODE_DELIVERY_STOCK_INSUFFICIENT');
    }
    return parsed;
};

const buildCodeDeliveryDryRun = async ({ productId, quantity = 1 } = {}) => {
    const product = await loadCodeDeliveryProduct(productId);
    const providerProduct = product.providerProduct;
    const familyKey = assertCodeDeliveryProduct(product, providerProduct);
    const normalizedQuantity = normalizeCodeDeliveryQuantity(quantity, providerProduct);
    const contract = fazerCardsContracts.getContractOrUnknown(familyKey);
    const contractPayload = fazerCardsContracts.buildPayloadFromContract({
        familyKey,
        providerProduct,
        quantity: normalizedQuantity,
    });
    if (contractPayload.success !== true) {
        throw new BusinessRuleError(
            contractPayload.message || 'FazerCards code-delivery payload contract failed.',
            contractPayload.code || 'FAZERCARDS_CODE_DELIVERY_PAYLOAD_INVALID'
        );
    }
    const executionState = product.providerExecutionEnabled === true ? 'enabled' : 'disabled';

    return {
        success: true,
        dryRun: true,
        wouldCall: contractPayload.wouldCall,
        provider: 'FazerCards',
        contract,
        product: {
            id: product._id.toString(),
            name: product.name,
            familyKey: product.familyKey || familyKey,
            fulfillmentMode: product.fulfillmentMode || providerProduct.fulfillmentMode,
            providerExecutionEnabled: product.providerExecutionEnabled === true,
            providerExecutionBlocked: product.providerExecutionBlocked === true,
        },
        providerProduct: {
            id: providerProduct._id.toString(),
            externalProductId: providerProduct.externalProductId,
            familyKey,
            fulfillmentMode: providerProduct.fulfillmentMode,
            costPrice: String(providerProduct.costPrice ?? providerProduct.rawPrice),
            currency: providerProduct.currency || 'USD',
            stock: providerProduct.stock ?? null,
            minQty: providerProduct.minQty || 1,
            maxQty: providerProduct.maxQty || 9999,
            region: providerProduct.region || null,
            platform: providerProduct.platform || null,
        },
        payload: contractPayload.payload,
        requiredFields: contractPayload.requiredFields || [],
        warnings: [
            'Dry run only. No FazerCards order was created.',
            'Code delivery live execution is not implemented yet.',
            `Product execution is currently ${executionState}.`,
            ...contract.warnings,
        ],
    };
};

const getConfiguredMaxOrderUsd = () => {
    const max = Number(config.providers.fazerCards.maxOrderUsd);
    return Number.isFinite(max) && max > 0 ? max : null;
};

const loadFazerCardsProduct = async (productId) => {
    const product = await Product.findById(productId)
        .populate('provider', 'name slug code providerCode isActive baseUrl authType token encryptedCredentials')
        .populate({
            path: 'providerProduct',
            select: 'provider providerCode externalProductId rawName costPrice rawPrice currency category categoryName offerId offerName familyKey fulfillmentMode supportLevel executionBlocked isSupported isBlocked blockReason requiredFields rawPayload stock minQty maxQty region platform',
            populate: { path: 'provider', select: 'name slug code providerCode isActive baseUrl authType token encryptedCredentials' },
        });
    if (!product) throw new NotFoundError('Product');
    return product;
};

const assertFazerCardsProductLink = (product) => {
    const providerProduct = product?.providerProduct;
    const providerCode = product?.providerCode
        || product?.provider?.providerCode
        || product?.provider?.code
        || product?.provider?.slug
        || providerProduct?.providerCode
        || providerProduct?.provider?.providerCode
        || providerProduct?.provider?.slug;
    const providerSlug = String(product?.provider?.slug || providerProduct?.provider?.slug || '').trim().toLowerCase();

    if (!isFazerCardsProviderCode(providerCode) && providerSlug !== FAZERCARDS_SLUG) {
        throw new BusinessRuleError('Product is not linked to FazerCards.', 'FAZERCARDS_PRODUCT_REQUIRED');
    }
};

const getTopupProductReadiness = async (productId, adapterOptions = {}) => {
    const product = await loadFazerCardsProduct(productId);
    assertFazerCardsProductLink(product);

    const providerProduct = product.providerProduct || null;
    const identifiers = providerProduct ? extractTopupIdentifiers(providerProduct) : {};
    const rawCost = providerProduct?.costPrice ?? providerProduct?.rawPrice;
    const cost = Number(rawCost);
    const costValid = rawCost !== undefined && rawCost !== null && rawCost !== '' && Number.isFinite(cost) && cost > 0;
    const maxOrderUsd = getConfiguredMaxOrderUsd();
    let balanceSufficient = 'unknown';
    let balance = null;
    const warnings = [];

    if (config.providers.fazerCards.enabled === true && providerProduct && costValid) {
        try {
            const providerDoc = product.provider || providerProduct.provider || await findFazerCardsProvider();
            const adapter = new FazerCardsAdapter(providerDoc, adapterOptions);
            const balanceResult = await adapter.getBalance();
            const parsedBalance = Number(balanceResult?.balance);
            if (Number.isFinite(parsedBalance)) {
                balance = parsedBalance;
                balanceSufficient = parsedBalance >= cost;
            } else {
                warnings.push('FazerCards balance response did not include a valid balance.');
            }
        } catch (_) {
            warnings.push('FazerCards balance could not be checked.');
        }
    } else if (config.providers.fazerCards.enabled !== true) {
        warnings.push('FazerCards integration is disabled.');
    }

    const checks = {
        fazerCardsEnabled: config.providers.fazerCards.enabled === true,
        globalRealOrdersEnabled: config.providers.fazerCards.realOrdersEnabled === true,
        productExecutionEnabled: product.providerExecutionEnabled === true,
        linkedProviderProduct: Boolean(providerProduct),
        supportedProviderProduct: providerProduct?.isSupported === true,
        notBlocked: providerProduct ? providerProduct.isBlocked !== true : false,
        hasCategoryId: Boolean(identifiers.categoryId),
        hasOfferId: Boolean(identifiers.offerId),
        hasRequiredFields: Array.isArray(providerProduct?.requiredFields) && providerProduct.requiredFields.length > 0,
        costValid,
        underMaxCost: maxOrderUsd === null ? true : costValid && cost <= maxOrderUsd,
        balanceSufficient,
        productVisible: product.visibleInStore === true,
        productActive: product.isActive === true && product.status === PRODUCT_STATUSES.AVAILABLE,
    };

    if (!checks.globalRealOrdersEnabled) warnings.push('Global real order gate is disabled.');
    if (!checks.productExecutionEnabled) warnings.push('Product provider execution is disabled.');
    if (!checks.linkedProviderProduct) warnings.push('Product is not linked to a FazerCards ProviderProduct.');
    if (!checks.supportedProviderProduct) warnings.push('Linked ProviderProduct is not supported.');
    if (!checks.notBlocked) warnings.push('Linked ProviderProduct is blocked.');
    if (!checks.hasCategoryId || !checks.hasOfferId) warnings.push('FazerCards category_id or offer_id is missing.');
    if (!checks.hasRequiredFields) warnings.push('FazerCards required fields are missing.');
    if (!checks.costValid) warnings.push('FazerCards ProviderProduct has an invalid cost price.');
    if (!checks.underMaxCost) warnings.push('FazerCards order blocked by max cost guard.');
    if (checks.balanceSufficient === false) warnings.push('FazerCards balance is insufficient for this provider cost.');
    if (!checks.productVisible) warnings.push('Product is hidden from customers.');
    if (!checks.productActive) warnings.push('Product is inactive or unavailable.');
    if (!config.providers.fazerCards.topupOrderStatusPath) warnings.push('FazerCards top-up order status endpoint is not confirmed/configured.');

    const readinessChecks = [
        checks.fazerCardsEnabled,
        checks.globalRealOrdersEnabled,
        checks.productExecutionEnabled,
        checks.linkedProviderProduct,
        checks.supportedProviderProduct,
        checks.notBlocked,
        checks.hasCategoryId,
        checks.hasOfferId,
        checks.hasRequiredFields,
        checks.costValid,
        checks.underMaxCost,
        checks.balanceSufficient === true,
    ];
    const contractMeta = getContractMetadata('TOPUPS', checks);

    return {
        success: true,
        productId: product._id.toString(),
        productName: product.name,
        readyForLiveExecution: readinessChecks.every(Boolean),
        ...contractMeta,
        checks,
        providerProduct: providerProduct ? {
            id: providerProduct._id.toString(),
            externalProductId: providerProduct.externalProductId,
            costPrice: String(rawCost ?? ''),
            currency: providerProduct.currency || 'USD',
            maxOrderUsd,
            balance,
        } : null,
        warnings: [...new Set(warnings)],
        nextActions: [
            'Enable FAZERCARDS_REAL_ORDERS_ENABLED only for a controlled live test.',
            'Enable providerExecutionEnabled only for one cheap product.',
            'Use a real valid account ID.',
        ],
    };
};

const getCodeDeliveryReadiness = async (productId) => {
    const product = await loadCodeDeliveryProduct(productId);
    assertFazerCardsProductLink(product);

    const providerProduct = product.providerProduct || null;
    const familyKey = providerProduct ? getProviderProductFamilyKey(providerProduct) : null;
    const identifiers = providerProduct ? extractCodeDeliveryIdentifiers(providerProduct) : {};
    const rawCost = providerProduct?.costPrice ?? providerProduct?.rawPrice;
    const cost = Number(rawCost);
    const costValid = rawCost !== undefined && rawCost !== null && rawCost !== '' && Number.isFinite(cost) && cost > 0;
    const stock = Number(providerProduct?.stock);
    const minQty = Number(providerProduct?.minQty || 1);
    const maxQty = Number(providerProduct?.maxQty || 9999);
    const quantitySupported = Number.isFinite(minQty) && Number.isFinite(maxQty) && minQty <= 1 && maxQty >= 1;
    const stockSufficient = Number.isFinite(stock) && stock >= 0 ? stock >= 1 : 'unknown';
    const codeDeliveryStorageReady = Boolean(ProviderDeliveredCode?.modelName);

    const checks = {
        productExists: true,
        linkedToFazerCards: true,
        familySupportedForPreview: CODE_DELIVERY_IMPORT_FAMILIES.has(familyKey),
        fulfillmentModeCodeDelivery: providerProduct?.fulfillmentMode === FULFILLMENT_MODES.CODE_DELIVERY,
        providerProductExists: Boolean(providerProduct),
        stockSufficient,
        costValid,
        quantitySupported,
        globalRealOrdersEnabled: config.providers.fazerCards.realOrdersEnabled === true,
        providerExecutionEnabled: product.providerExecutionEnabled === true,
        codeDeliveryStorageReady,
        productHidden: product.visibleInStore !== true,
        productInactive: product.isActive !== true || product.status !== PRODUCT_STATUSES.AVAILABLE,
        hasCategoryId: Boolean(identifiers.categoryId),
        hasItemId: Boolean(identifiers.itemId),
    };

    const warnings = [
        'Code delivery live execution is not implemented yet.',
    ];
    if (!checks.globalRealOrdersEnabled) warnings.push('Global real order gate is disabled.');
    if (!checks.providerExecutionEnabled) warnings.push('Product provider execution is disabled.');
    if (!checks.productHidden) warnings.push('Product is visible; keep it hidden until code delivery execution is implemented.');
    if (!checks.productInactive) warnings.push('Product is active; keep it inactive until code delivery execution is implemented.');
    if (checks.stockSufficient === 'unknown') warnings.push('Provider stock is unknown.');
    if (checks.stockSufficient === false) warnings.push('Provider stock is insufficient for quantity 1.');
    if (!checks.codeDeliveryStorageReady) warnings.push('Encrypted provider code storage is not ready.');
    const contractMeta = getContractMetadata(familyKey, checks);

    return {
        success: true,
        productId: product._id.toString(),
        productName: product.name,
        readyForLiveExecution: false,
        familyKey,
        fulfillmentMode: providerProduct?.fulfillmentMode || product.fulfillmentMode || null,
        ...contractMeta,
        providerProduct: providerProduct ? {
            id: providerProduct._id.toString(),
            externalProductId: providerProduct.externalProductId,
            costPrice: String(rawCost ?? ''),
            currency: providerProduct.currency || 'USD',
            stock: providerProduct.stock ?? null,
            minQty: providerProduct.minQty || 1,
            maxQty: providerProduct.maxQty || 9999,
            region: providerProduct.region || null,
            platform: providerProduct.platform || null,
        } : null,
        checks,
        warnings: [...new Set(warnings)],
        nextActions: [
            'Keep product hidden and inactive until code delivery execution is implemented.',
            'Use dry-run preview to confirm the provider payload.',
            'Implement admin/customer code reveal only after encrypted delivery storage is wired into live execution.',
        ],
    };
};

const getRequiredFieldKeys = (requiredFields = []) => (
    (Array.isArray(requiredFields) ? requiredFields : [])
        .map((field) => (typeof field === 'string' ? field : field?.key || field?.name || field?.id))
        .map((key) => String(key || '').trim())
        .filter(Boolean)
);

const buildUnifiedDryRun = async ({ productId, fields = {}, quantity = 1, orderId = null } = {}) => {
    const product = await loadFazerCardsProduct(productId);
    assertFazerCardsProductLink(product);
    const providerProduct = product.providerProduct;
    if (!providerProduct) throw new NotFoundError('ProviderProduct');

    const familyKey = getProviderProductFamilyKey(providerProduct);
    if (providerProduct.fulfillmentMode === FULFILLMENT_MODES.TOPUP_WITH_FIELDS) {
        return buildTopupDryRun({ productId, fields, orderId });
    }
    if (providerProduct.fulfillmentMode === FULFILLMENT_MODES.CODE_DELIVERY && CODE_DELIVERY_IMPORT_FAMILIES.has(familyKey)) {
        return buildCodeDeliveryDryRun({ productId, quantity });
    }

    if (!DRAFT_IMPORT_FAMILIES.has(familyKey)) {
        throw new BusinessRuleError('FazerCards product family is not supported for dry-run preview.', 'FAZERCARDS_DRY_RUN_FAMILY_UNSUPPORTED');
    }

    const rawCost = providerProduct.costPrice ?? providerProduct.rawPrice;
    const cost = Number(rawCost);
    if (rawCost === undefined || rawCost === null || rawCost === '' || !Number.isFinite(cost) || cost <= 0) {
        throw new BusinessRuleError('FazerCards ProviderProduct has an invalid cost price.', 'FAZERCARDS_PROVIDER_PRODUCT_INVALID_COST');
    }

    const executionState = product.providerExecutionEnabled === true ? 'enabled' : 'disabled';
    const family = getFazerCardsFamily(familyKey);
    const contract = fazerCardsContracts.getContractOrUnknown(familyKey);
    const contractPayload = fazerCardsContracts.buildPayloadFromContract({
        familyKey,
        providerProduct,
        fields,
        quantity,
    });

    if (contractPayload.success === true) {
        return {
            success: true,
            dryRun: true,
            wouldCall: contractPayload.wouldCall,
            precheckWouldCall: contractPayload.precheckWouldCall || null,
            provider: 'FazerCards',
            executionAvailable: contract.canLivePilot === true,
            controlledLiveCandidate: contract.executionStage === fazerCardsContracts.EXECUTION_STAGES.CONTROLLED_LIVE_CANDIDATE,
            contract,
            product: {
                id: product._id.toString(),
                name: product.name,
                familyKey: product.familyKey || familyKey,
                fulfillmentMode: product.fulfillmentMode || providerProduct.fulfillmentMode,
                providerExecutionEnabled: product.providerExecutionEnabled === true,
                providerExecutionBlocked: product.providerExecutionBlocked === true,
            },
            providerProduct: {
                id: providerProduct._id.toString(),
                externalProductId: providerProduct.externalProductId,
                familyKey,
                fulfillmentMode: providerProduct.fulfillmentMode,
                costPrice: String(rawCost),
                currency: providerProduct.currency || 'USD',
                stock: providerProduct.stock ?? null,
                minQty: providerProduct.minQty || 1,
                maxQty: providerProduct.maxQty || 9999,
                region: providerProduct.region || null,
                platform: providerProduct.platform || null,
                blockReason: getFamilyBlockReason(providerProduct),
            },
            payload: contractPayload.payload,
            requiredFields: contractPayload.requiredFields || providerProduct.requiredFields || [],
            blockers: contract.blockers || [],
            warnings: [
                'Dry run only. No FazerCards order was created.',
                contract.executionStage === fazerCardsContracts.EXECUTION_STAGES.CONTROLLED_LIVE_CANDIDATE
                    ? `${family?.displayName || familyKey} is eligible only for explicit product-level controlled execution; bulk auto remains disabled.`
                    : `${family?.displayName || familyKey} provider payload is documented, but live execution remains disabled in this phase.`,
                `Product execution is currently ${executionState}.`,
                ...contract.warnings,
            ],
        };
    }

    return {
        success: false,
        dryRun: false,
        code: contractPayload.code || 'CONTRACT_UNCONFIRMED',
        message: contractPayload.message || `${family?.displayName || familyKey} provider payload contract is not confirmed.`,
        wouldCall: contractPayload.wouldCall || null,
        provider: 'FazerCards',
        executionAvailable: contract.canLivePilot === true,
        controlledLiveCandidate: contract.executionStage === fazerCardsContracts.EXECUTION_STAGES.CONTROLLED_LIVE_CANDIDATE,
        contract,
        product: {
            id: product._id.toString(),
            name: product.name,
            familyKey: product.familyKey || familyKey,
            fulfillmentMode: product.fulfillmentMode || providerProduct.fulfillmentMode,
            providerExecutionEnabled: product.providerExecutionEnabled === true,
            providerExecutionBlocked: product.providerExecutionBlocked === true,
        },
        providerProduct: {
            id: providerProduct._id.toString(),
            externalProductId: providerProduct.externalProductId,
            familyKey,
            fulfillmentMode: providerProduct.fulfillmentMode,
            costPrice: String(rawCost),
            currency: providerProduct.currency || 'USD',
            stock: providerProduct.stock ?? null,
            minQty: providerProduct.minQty || 1,
            maxQty: providerProduct.maxQty || 9999,
            region: providerProduct.region || null,
            platform: providerProduct.platform || null,
            blockReason: getFamilyBlockReason(providerProduct),
        },
        payload: contractPayload.payload || null,
        requiredFields: contractPayload.requiredFields || providerProduct.requiredFields || [],
        blockers: contractPayload.blockers || contract.blockers || [],
        warnings: [
            'Dry run was not built because this FazerCards family contract is unconfirmed.',
            'No FazerCards order was created.',
            `${family?.displayName || familyKey} live execution is not implemented yet.`,
            `Product execution is currently ${executionState}.`,
            ...contract.warnings,
        ],
    };
};

const getUnsupportedFamilyReadiness = async (productId) => {
    const product = await loadFazerCardsProduct(productId);
    assertFazerCardsProductLink(product);
    const providerProduct = product.providerProduct || null;
    const familyKey = providerProduct ? getProviderProductFamilyKey(providerProduct) : product.familyKey || null;
    const family = getFazerCardsFamily(familyKey);
    const contract = fazerCardsContracts.getContractOrUnknown(familyKey);
    const rawCost = providerProduct?.costPrice ?? providerProduct?.rawPrice;
    const cost = Number(rawCost);
    const requiredFields = Array.isArray(providerProduct?.requiredFields) ? providerProduct.requiredFields : [];
    const identifiers = fazerCardsContracts.getAutoProviderIdentifiers(familyKey, providerProduct || {});
    const controlledLiveCandidate = contract.executionStage === fazerCardsContracts.EXECUTION_STAGES.CONTROLLED_LIVE_CANDIDATE;
    const autoReadiness = controlledLiveCandidate
        ? fazerCardsContracts.validateAutoProviderReadinessForProduct({
            product,
            providerProduct: providerProduct || {},
            familyKey,
            requireCustomerVisible: true,
        })
        : null;
    const checks = {
        productExists: true,
        linkedToFazerCards: Boolean(providerProduct),
        familyCatalogSupported: DRAFT_IMPORT_FAMILIES.has(familyKey),
        executionImplemented: controlledLiveCandidate,
        controlledLiveCandidate,
        autoProviderAllowedForExplicitProduct: contract.autoProviderAllowed === true,
        bulkAutoProviderAllowed: contract.bulkAutoProviderAllowed === true,
        globalRealOrdersEnabled: config.providers.fazerCards.realOrdersEnabled === true,
        productExecutionEnabled: product.providerExecutionEnabled === true,
        productExecutionBlocked: product.providerExecutionBlocked === true,
        providerProductExecutionBlocked: providerProduct?.executionBlocked === true,
        providerProductBlocked: providerProduct?.isBlocked === true,
        providerProductSupported: providerProduct?.isSupported === true,
        costValid: rawCost !== undefined && rawCost !== null && rawCost !== '' && Number.isFinite(cost) && cost > 0,
        hasRequiredFields: requiredFields.length > 0,
        hasTelegramKind: familyKey !== 'TELEGRAM' || Boolean(identifiers.kind),
        hasSteamCurrency: familyKey !== 'STEAM_TOPUP' || Boolean(identifiers.currency),
        hasSteamAmount: familyKey !== 'STEAM_TOPUP' || Boolean(identifiers.amount),
        hasSteamGiftAppId: familyKey !== 'STEAM_GIFTS' || Boolean(identifiers.appId),
        hasSteamGiftSubId: familyKey !== 'STEAM_GIFTS' || Boolean(identifiers.subId),
        hasSteamGiftRegion: familyKey !== 'STEAM_GIFTS' || Boolean(identifiers.region),
        hasSteamGiftInviteField: familyKey !== 'STEAM_GIFTS' || requiredFields.some((field) => /invite[_\s-]?url|steam[_\s-]?invite/i.test(`${field.key || ''} ${field.label || ''}`)),
        productHidden: product.visibleInStore !== true,
        productInactive: product.isActive !== true || product.status !== PRODUCT_STATUSES.AVAILABLE,
    };

    const warnings = [
        controlledLiveCandidate
            ? `${family?.displayName || familyKey || 'FazerCards'} can use gated AUTO_PROVIDER when all readiness checks pass.`
            : `${family?.displayName || familyKey || 'FazerCards'} live execution is not implemented yet.`,
    ];
    if (familyKey === 'STEAM_GIFTS') warnings.push('Steam Gifts catalog access is read-only confirmed; use explicit appid/on-demand import; broad catalog sync remains disabled.');
    if (familyKey === 'STEAM_TOPUP') warnings.push('Steam top-up requires successful check-login immediately before any provider order.');
    if (familyKey === 'TELEGRAM') warnings.push('Telegram fulfillment is asynchronous; completed/failed statuses must be confirmed by response, status sync, or webhook.');
    if (!checks.globalRealOrdersEnabled) warnings.push('Global real order gate is disabled.');
    if (!controlledLiveCandidate && !checks.productHidden) warnings.push('Product is visible; keep it hidden until this family is implemented.');
    if (!controlledLiveCandidate && !checks.productInactive) warnings.push('Product is active; keep it inactive until this family is implemented.');
    if (checks.productExecutionBlocked) warnings.push(product.providerBlockReason || getFamilyBlockReason(providerProduct));
    for (const error of autoReadiness?.errors || []) warnings.push(error.message);
    const contractMeta = getContractMetadata(familyKey, checks);

    return {
        success: true,
        productId: product._id.toString(),
        productName: product.name,
        readyForLiveExecution: Boolean(
            controlledLiveCandidate
            && checks.globalRealOrdersEnabled
            && product.providerExecutionEnabled === true
            && product.providerExecutionMode === fazerCardsContracts.PROVIDER_EXECUTION_MODES.AUTO_PROVIDER
            && autoReadiness?.ok
        ),
        familyKey,
        fulfillmentMode: providerProduct?.fulfillmentMode || product.fulfillmentMode || null,
        ...contractMeta,
        providerProduct: providerProduct ? {
            id: providerProduct._id.toString(),
            externalProductId: providerProduct.externalProductId,
            costPrice: String(rawCost ?? ''),
            currency: providerProduct.currency || 'USD',
            stock: providerProduct.stock ?? null,
            minQty: providerProduct.minQty || 1,
            maxQty: providerProduct.maxQty || 9999,
            region: providerProduct.region || null,
            platform: providerProduct.platform || null,
            blockReason: getFamilyBlockReason(providerProduct),
            requiredFieldKeys: getRequiredFieldKeys(requiredFields),
        } : null,
        checks,
        warnings: [...new Set(warnings.filter(Boolean))],
        nextActions: [
            controlledLiveCandidate
                ? 'Enable AUTO_PROVIDER only for products that pass readiness and server-side gates.'
                : 'Keep the product hidden and inactive until this family has a tested execution flow.',
            'Use dry-run preview to inspect stored identifiers and required fields.',
            controlledLiveCandidate
                ? 'Bulk AUTO_PROVIDER will skip or fail products that do not pass readiness.'
                : 'Do not enable live execution for this family until a controlled pilot is approved.',
        ],
    };
};

const getProductReadiness = async (productId, adapterOptions = {}) => {
    const product = await loadFazerCardsProduct(productId);
    assertFazerCardsProductLink(product);
    const providerProduct = product.providerProduct;
    if (!providerProduct) throw new NotFoundError('ProviderProduct');
    const familyKey = getProviderProductFamilyKey(providerProduct);

    if (providerProduct.fulfillmentMode === FULFILLMENT_MODES.TOPUP_WITH_FIELDS) {
        return getTopupProductReadiness(productId, adapterOptions);
    }
    if (providerProduct.fulfillmentMode === FULFILLMENT_MODES.CODE_DELIVERY && CODE_DELIVERY_IMPORT_FAMILIES.has(familyKey)) {
        return getCodeDeliveryReadiness(productId);
    }
    return getUnsupportedFamilyReadiness(productId);
};

const getConfiguredCodeDeliveryMaxOrderUsd = () => {
    const max = Number(config.providers.fazerCards.codeDeliveryMaxOrderUsd);
    return Number.isFinite(max) && max > 0 ? max : null;
};

const buildCodeDeliveryPilotChecks = ({
    product = null,
    providerProduct = null,
    familyKey = null,
    quantity = 1,
    cost = null,
    balance = null,
    identifiers = {},
    confirmRealOrder = false,
} = {}) => {
    const normalizedFamilyKey = familyKey || (providerProduct ? getProviderProductFamilyKey(providerProduct) : null);
    const maxOrderUsd = getConfiguredCodeDeliveryMaxOrderUsd();
    const totalProviderCost = Number.isFinite(Number(cost)) && Number.isFinite(Number(quantity))
        ? Number((Number(cost) * Number(quantity)).toFixed(6))
        : null;
    const stock = Number(providerProduct?.stock);

    return {
        confirmRealOrder: confirmRealOrder === true,
        fazerCardsEnabled: config.providers.fazerCards.enabled === true,
        globalRealOrdersEnabled: config.providers.fazerCards.realOrdersEnabled === true,
        codeDeliveryEnabled: config.providers.fazerCards.codeDeliveryEnabled === true,
        productExists: Boolean(product),
        linkedToFazerCards: Boolean(product && providerProduct),
        familySupportedForLivePilot: CODE_DELIVERY_IMPORT_FAMILIES.has(normalizedFamilyKey),
        fulfillmentModeCodeDelivery: providerProduct?.fulfillmentMode === FULFILLMENT_MODES.CODE_DELIVERY,
        providerProductExists: Boolean(providerProduct),
        hasCategoryId: Boolean(identifiers.categoryId),
        hasItemId: Boolean(identifiers.itemId),
        productExecutionEnabled: product?.providerExecutionEnabled === true,
        productExecutionNotBlocked: product?.providerExecutionBlocked !== true,
        providerProductExecutionNotBlocked: providerProduct?.executionBlocked !== true,
        quantityValid: Number.isInteger(Number(quantity)) && Number(quantity) >= 1,
        stockSufficient: Number.isFinite(stock) && stock >= 0 ? Number(quantity) <= stock : 'unknown',
        costValid: Number.isFinite(Number(cost)) && Number(cost) > 0,
        underCodeDeliveryMaxCost: maxOrderUsd === null ? true : totalProviderCost !== null && totalProviderCost <= maxOrderUsd,
        balanceSufficient: Number.isFinite(Number(balance)) && totalProviderCost !== null ? Number(balance) >= totalProviderCost : 'unknown',
        codeDeliveryStorageReady: Boolean(ProviderDeliveredCode?.modelName),
    };
};

const makePilotGateError = (message, code, checks = {}, warnings = []) => {
    const err = new BusinessRuleError(message, code);
    err.checks = checks;
    err.warnings = warnings;
    return err;
};

const assertPilotGate = (condition, message, code, checks, warnings = []) => {
    if (!condition) throw makePilotGateError(message, code, checks, warnings);
};

const loadCodeDeliveryPilotProduct = loadCodeDeliveryProduct;

const getProviderBalanceForPilot = async (product, providerProduct, adapterOptions = {}) => {
    const providerDoc = product.provider || providerProduct.provider || await findFazerCardsProvider();
    const adapter = new FazerCardsAdapter(providerDoc, adapterOptions);
    const balanceResult = await adapter.getBalance();
    const balance = Number(balanceResult?.balance);
    if (!Number.isFinite(balance)) {
        const err = new BusinessRuleError('FazerCards balance response did not include a valid balance.', 'FAZERCARDS_BALANCE_UNKNOWN');
        err.providerRequestId = balanceResult?.requestId || null;
        err.providerBody = balanceResult?.raw || { balance: balanceResult?.balance ?? null };
        throw err;
    }
    return { adapter, providerDoc, balance, balanceResult };
};

const extractProviderOrderNode = (data = {}) => (
    data.order
    || data.providerOrder
    || data.data?.order
    || data.data
    || data
);

const extractProviderOrderId = (data = {}, order = {}) => firstValue(
    order.id,
    order.order_id,
    order.orderId,
    order.provider_order_id,
    data.order_id,
    data.orderId,
    data.id,
    data.data?.order_id,
    data.data?.id,
    null
);

const DELIVERY_SECRET_KEY_PATTERN = /(^|_)(code|pin|serial|voucher|license|claim)(_|$)|cardnumber|card_number|card_no|key_value|game_key|gift_card/i;

const CODE_DELIVERY_COLLECTION_KEY_PATTERN = /^(codes|keys|cards|vouchers)$/i;

const redactCodeDeliverySecrets = sanitizeProviderCodePayload;

const getCodeValueFromObject = (obj = {}, parentKey = '') => {
    const code = firstValue(
        obj.code,
        obj.cardCode,
        obj.card_code,
        obj.voucher,
        obj.voucherCode,
        obj.voucher_code,
        obj.licenseKey,
        obj.license_key,
        obj.gameKey,
        obj.game_key,
        obj.keyValue,
        obj.key_value,
        obj.codeValue,
        obj.code_value,
        null
    );
    if (code) return code;
    if (typeof obj.key === 'string' && !obj.key_id && !obj.keyId) return obj.key;
    if (typeof obj.value === 'string' && CODE_DELIVERY_COLLECTION_KEY_PATTERN.test(parentKey)) return obj.value;
    return null;
};

const extractDeliveredCodes = (value, parentKey = '') => {
    const found = [];
    const visit = (node, key = '') => {
        if (node === null || node === undefined) return;
        if (typeof node === 'string') {
            if (CODE_DELIVERY_COLLECTION_KEY_PATTERN.test(key)) {
                found.push({ code: node, serial: null, pin: null, metadata: { source: key } });
            }
            return;
        }
        if (Array.isArray(node)) {
            node.forEach((item) => visit(item, key));
            return;
        }
        if (typeof node !== 'object') return;

        const code = getCodeValueFromObject(node, key);
        const pin = firstValue(node.pin, node.pinCode, node.pin_code, null);
        const serial = firstValue(node.serial, node.serialNumber, node.serial_number, node.cardNumber, node.card_number, null);
        if (code || pin || serial) {
            found.push({
                code: code ? String(code) : null,
                pin: pin ? String(pin) : null,
                serial: serial ? String(serial) : null,
                metadata: {
                    source: key || null,
                    id: firstValue(node.id, node.item_id, node.card_id, node.key_id, null),
                },
            });
        }

        Object.entries(node).forEach(([childKey, child]) => visit(child, childKey));
    };

    visit(value, parentKey);
    const seen = new Set();
    return found.filter((item) => {
        const key = [item.code, item.pin, item.serial].filter(Boolean).join('|');
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

const storeDeliveredCodes = async ({ pilotOrder, providerDoc, providerProduct, product, familyKey, rawResponse }) => {
    const deliveredCodes = fazerCardsContracts.extractDeliveredCodes(rawResponse);
    const stored = [];
    for (const delivered of deliveredCodes) {
        const doc = new ProviderDeliveredCode({
            pilotOrder: pilotOrder._id,
            provider: providerDoc?._id || providerProduct.provider,
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            providerProduct: providerProduct._id,
            product: product._id,
            familyKey,
            fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
            metadata: delivered.metadata,
            providerRawResponse: redactCodeDeliverySecrets(sanitizePayload(rawResponse)),
            deliveryStatus: DELIVERY_STATUSES.DELIVERED,
            deliveredAt: new Date(),
        });
        if (delivered.code) doc.setSecretValue('codeEncrypted', delivered.code);
        if (delivered.pin) doc.setSecretValue('pinEncrypted', delivered.pin);
        if (delivered.serial) doc.setSecretValue('serialEncrypted', delivered.serial);
        await doc.save();
        stored.push({
            hasPin: Boolean(delivered.pin),
            hasSerial: Boolean(delivered.serial),
        });
    }
    return {
        deliveredCodeCount: stored.length,
        hasPin: stored.some((item) => item.hasPin),
        hasSerial: stored.some((item) => item.hasSerial),
        storedEncrypted: stored.length > 0,
    };
};

const applyPilotProviderResult = async ({ pilotOrder, response, familyKey, providerDoc, providerProduct, product }) => {
    const data = response?.data || {};
    const order = extractProviderOrderNode(data);
    const providerOrderId = asTrimmedString(extractProviderOrderId(data, order));
    const rawStatus = firstValue(order?.status, data?.status, order?.state, data?.state, 'processing');
    const mapped = normalizeTopupOrderStatus(rawStatus);
    const providerStatus = mapped.status;
    const providerRequestId = firstValue(response?.requestId, data?.requestId, data?.request_id, null);
    const safeRawResponse = redactCodeDeliverySecrets(sanitizePayload(data));
    const warnings = [];
    const codeStorage = await storeDeliveredCodes({
        pilotOrder,
        providerDoc,
        providerProduct,
        product,
        familyKey,
        rawResponse: data,
    });

    let status = ORDER_STATUS.PROCESSING;
    let providerErrorCode = null;
    let providerErrorMessage = null;
    const now = new Date();
    const statusUpdate = { lastCheckedAt: now };

    if (!mapped.known || !providerOrderId) {
        status = ORDER_STATUS.MANUAL_REVIEW;
        providerErrorCode = !providerOrderId ? 'FAZERCARDS_CODE_DELIVERY_ORDER_ID_MISSING' : 'FAZERCARDS_CODE_DELIVERY_UNKNOWN_STATUS';
        providerErrorMessage = !providerOrderId
            ? 'FazerCards code-delivery response did not include provider order id.'
            : 'FazerCards code-delivery response returned an unknown status.';
        warnings.push(providerErrorMessage);
    } else if (mapped.terminalFailure) {
        status = ORDER_STATUS.FAILED;
        providerErrorCode = 'FAZERCARDS_CODE_DELIVERY_ORDER_FAILED';
        providerErrorMessage = 'FazerCards code-delivery order failed.';
        statusUpdate.failedAt = now;
    } else if (providerStatus === 'Completed') {
        if (codeStorage.deliveredCodeCount > 0) {
            status = ORDER_STATUS.COMPLETED;
            statusUpdate.completedAt = now;
        } else {
            status = ORDER_STATUS.MANUAL_REVIEW;
            providerErrorCode = 'FAZERCARDS_CODE_DELIVERY_CODE_MISSING';
            providerErrorMessage = 'Provider response did not contain a recognized code payload.';
            warnings.push(providerErrorMessage);
        }
    }

    const updated = await ProviderPilotOrder.findByIdAndUpdate(pilotOrder._id, {
        $set: {
            status,
            providerOrderId: providerOrderId || null,
            providerStatus,
            providerRequestId,
            providerRawResponse: safeRawResponse,
            providerErrorCode,
            providerErrorMessage,
            deliveredCodeCount: codeStorage.deliveredCodeCount,
            hasPin: codeStorage.hasPin,
            hasSerial: codeStorage.hasSerial,
            storedEncrypted: codeStorage.storedEncrypted,
            warnings,
            ...statusUpdate,
        },
    }, { new: true });

    return updated;
};

const markPilotManualReview = async (pilotOrder, err, fallbackCode = 'FAZERCARDS_CODE_DELIVERY_UNKNOWN') => ProviderPilotOrder.findByIdAndUpdate(pilotOrder._id, {
    $set: {
        status: ORDER_STATUS.MANUAL_REVIEW,
        providerRequestId: err.requestId || null,
        providerRawResponse: redactCodeDeliverySecrets(sanitizePayload(err.providerBody || {
            errorCode: err.code || fallbackCode,
            message: err.safeUpstreamMessage || err.message,
        })),
        providerErrorCode: err.code || fallbackCode,
        providerErrorMessage: err.safeUpstreamMessage || err.message || 'FazerCards code-delivery outcome is unknown.',
        warnings: ['Provider outcome is uncertain. Manual review required.'],
        lastCheckedAt: new Date(),
    },
}, { new: true });

const markPilotFailed = async (pilotOrder, err, fallbackCode = 'FAZERCARDS_CODE_DELIVERY_REJECTED') => ProviderPilotOrder.findByIdAndUpdate(pilotOrder._id, {
    $set: {
        status: ORDER_STATUS.FAILED,
        providerRequestId: err.requestId || null,
        providerRawResponse: redactCodeDeliverySecrets(sanitizePayload(err.providerBody || {
            errorCode: err.code || fallbackCode,
            message: err.safeUpstreamMessage || err.message,
        })),
        providerErrorCode: err.code || fallbackCode,
        providerErrorMessage: err.safeUpstreamMessage || err.message || 'FazerCards code-delivery order was rejected.',
        failedAt: new Date(),
        lastCheckedAt: new Date(),
    },
}, { new: true });

const summarizePilotOrder = async (pilotOrder) => {
    const deliveredCodeCount = await ProviderDeliveredCode.countDocuments({ pilotOrder: pilotOrder._id });
    return {
        localOrderId: pilotOrder._id.toString(),
        localStatus: pilotOrder.status,
        productName: pilotOrder.product?.name || null,
        familyKey: pilotOrder.familyKey,
        fulfillmentMode: pilotOrder.fulfillmentMode,
        providerOrderId: pilotOrder.providerOrderId ?? null,
        providerStatus: pilotOrder.providerStatus ?? null,
        providerRequestId: pilotOrder.providerRequestId ?? null,
        providerCost: pilotOrder.providerCost,
        providerCostCurrency: pilotOrder.providerCostCurrency,
        quantity: pilotOrder.quantity,
        deliveredCodeCount,
        hasPin: pilotOrder.hasPin === true,
        hasSerial: pilotOrder.hasSerial === true,
        storedEncrypted: pilotOrder.storedEncrypted === true,
        providerRawResponse: redactCodeDeliverySecrets(sanitizePayload(pilotOrder.providerRawResponse)),
        warnings: pilotOrder.warnings || [],
    };
};

const runCodeDeliveryLivePilot = async ({
    productId,
    quantity = 1,
    confirmRealOrder = false,
    operatorNote = null,
} = {}, adminUserId = null, adapterOptions = {}) => {
    assertPilotGate(confirmRealOrder === true, 'confirmRealOrder=true is required for a real FazerCards code-delivery pilot.', 'FAZERCARDS_CONFIRM_REAL_ORDER_REQUIRED', {
        confirmRealOrder: false,
    });

    const product = await loadCodeDeliveryPilotProduct(productId);
    const providerProduct = product.providerProduct;
    assertCodeDeliveryProduct(product, providerProduct);
    const familyKey = getProviderProductFamilyKey(providerProduct);
    const identifiers = extractCodeDeliveryIdentifiers(providerProduct);
    const normalizedQuantity = normalizeCodeDeliveryQuantity(quantity, providerProduct);
    const unitCost = Number(providerProduct.costPrice ?? providerProduct.rawPrice);
    const totalProviderCost = Number((unitCost * normalizedQuantity).toFixed(6));
    const initialChecks = buildCodeDeliveryPilotChecks({
        product,
        providerProduct,
        familyKey,
        quantity: normalizedQuantity,
        cost: unitCost,
        identifiers,
        confirmRealOrder,
    });

    assertPilotGate(config.providers.fazerCards.enabled === true, 'FazerCards integration is disabled.', 'FAZERCARDS_DISABLED', initialChecks);
    assertPilotGate(config.providers.fazerCards.realOrdersEnabled === true, 'FazerCards real orders are disabled by global safety gate.', 'FAZERCARDS_REAL_ORDERS_DISABLED', initialChecks);
    assertPilotGate(config.providers.fazerCards.codeDeliveryEnabled === true, 'FazerCards code delivery is disabled by global safety gate.', 'FAZERCARDS_CODE_DELIVERY_DISABLED', initialChecks);
    assertPilotGate(Boolean(identifiers.categoryId), 'FazerCards code-delivery category/game id is missing.', 'FAZERCARDS_CODE_DELIVERY_CATEGORY_ID_MISSING', initialChecks);
    assertPilotGate(Boolean(identifiers.itemId), 'FazerCards code-delivery card/key id is missing.', 'FAZERCARDS_CODE_DELIVERY_ITEM_ID_MISSING', initialChecks);
    assertPilotGate(product.providerExecutionEnabled === true, 'Product provider execution is disabled.', 'FAZERCARDS_PROVIDER_EXECUTION_DISABLED', initialChecks);
    assertPilotGate(product.providerExecutionBlocked !== true, 'Product provider execution is blocked.', 'FAZERCARDS_PROVIDER_EXECUTION_BLOCKED', initialChecks);
    assertPilotGate(providerProduct.executionBlocked !== true, 'ProviderProduct execution is blocked.', 'FAZERCARDS_PROVIDER_PRODUCT_EXECUTION_BLOCKED', initialChecks);
    assertPilotGate(Number.isFinite(unitCost) && unitCost > 0, 'FazerCards ProviderProduct has an invalid cost price.', 'FAZERCARDS_PROVIDER_PRODUCT_INVALID_COST', initialChecks);

    const maxOrderUsd = getConfiguredCodeDeliveryMaxOrderUsd();
    assertPilotGate(maxOrderUsd === null || totalProviderCost <= maxOrderUsd, 'FazerCards code-delivery order blocked by max cost guard.', 'FAZERCARDS_CODE_DELIVERY_MAX_COST_GUARD', initialChecks);

    let preflight;
    try {
        preflight = await getProviderBalanceForPilot(product, providerProduct, adapterOptions);
    } catch (err) {
        const checks = buildCodeDeliveryPilotChecks({
            product,
            providerProduct,
            familyKey,
            quantity: normalizedQuantity,
            cost: unitCost,
            identifiers,
            confirmRealOrder,
        });
        throw makePilotGateError('FazerCards balance could not be checked; code-delivery pilot requires manual retry.', 'FAZERCARDS_BALANCE_UNKNOWN', checks, ['No provider order was created.']);
    }

    const checks = buildCodeDeliveryPilotChecks({
        product,
        providerProduct,
        familyKey,
        quantity: normalizedQuantity,
        cost: unitCost,
        balance: preflight.balance,
        identifiers,
        confirmRealOrder,
    });
    assertPilotGate(preflight.balance >= totalProviderCost, 'FazerCards balance is insufficient for this code-delivery pilot.', 'FAZERCARDS_INSUFFICIENT_PROVIDER_BALANCE', checks);

    const pilotOrder = await ProviderPilotOrder.create({
        product: product._id,
        provider: product.provider?._id || providerProduct.provider,
        providerProduct: providerProduct._id,
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        familyKey,
        fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
        quantity: normalizedQuantity,
        providerCost: String(totalProviderCost),
        providerCostCurrency: providerProduct.currency || 'USD',
        status: ORDER_STATUS.PROCESSING,
        operator: adminUserId || null,
        operatorNote: operatorNote || null,
    });
    const idempotencyKey = `fazercards:code-delivery:${pilotOrder._id.toString()}`;
    await ProviderPilotOrder.findByIdAndUpdate(pilotOrder._id, { $set: { providerIdempotencyKey: idempotencyKey } });
    pilotOrder.providerIdempotencyKey = idempotencyKey;

    let response;
    try {
        if (familyKey === 'GIFTCARDS') {
            response = await preflight.adapter.client.createGiftCardOrder({
                categoryId: identifiers.categoryId,
                cardId: identifiers.itemId,
                quantity: normalizedQuantity,
                idempotencyKey,
            });
        } else {
            response = await preflight.adapter.client.createGameKeyOrder({
                gameId: identifiers.categoryId,
                keyId: identifiers.itemId,
                quantity: normalizedQuantity,
                idempotencyKey,
            });
        }
    } catch (err) {
        const httpStatus = Number(err.httpStatus || err.statusCode || 0);
        const retryUnsafe = err.code === 'FAZERCARDS_TIMEOUT'
            || err.code === 'FAZERCARDS_NETWORK_ERROR'
            || httpStatus === 0
            || httpStatus === 429
            || httpStatus >= 500;
        const updated = retryUnsafe
            ? await markPilotManualReview(pilotOrder, err, 'FAZERCARDS_CODE_DELIVERY_UNKNOWN')
            : await markPilotFailed(pilotOrder, err, 'FAZERCARDS_CODE_DELIVERY_REJECTED');
        return {
            success: false,
            livePilot: true,
            checks,
            order: await summarizePilotOrder(await updated.populate('product', 'name')),
        };
    }

    const updated = await applyPilotProviderResult({
        pilotOrder,
        response,
        familyKey,
        providerDoc: preflight.providerDoc,
        providerProduct,
        product,
    });

    return {
        success: updated.status === ORDER_STATUS.COMPLETED || updated.status === ORDER_STATUS.PROCESSING,
        livePilot: true,
        checks,
        order: await summarizePilotOrder(await updated.populate('product', 'name')),
    };
};

const getCodeDeliveryLivePilotDebug = async (orderId) => {
    const pilotOrder = await ProviderPilotOrder.findById(orderId)
        .populate('product', 'name')
        .lean();
    if (!pilotOrder) throw new NotFoundError('ProviderPilotOrder');
    if (pilotOrder.providerCode !== PROVIDER_CODES.FAZER_CARDS || pilotOrder.fulfillmentMode !== FULFILLMENT_MODES.CODE_DELIVERY) {
        throw new BusinessRuleError('Pilot order is not a FazerCards code-delivery order.', 'INVALID_PROVIDER_ORDER');
    }
    const deliveredCodeCount = await ProviderDeliveredCode.countDocuments({ pilotOrder: pilotOrder._id });
    return {
        localOrderId: pilotOrder._id.toString(),
        localStatus: pilotOrder.status,
        productName: pilotOrder.product?.name || null,
        familyKey: pilotOrder.familyKey,
        fulfillmentMode: pilotOrder.fulfillmentMode,
        providerOrderId: pilotOrder.providerOrderId ?? null,
        providerStatus: pilotOrder.providerStatus ?? null,
        providerCost: pilotOrder.providerCost,
        providerCostCurrency: pilotOrder.providerCostCurrency,
        quantity: pilotOrder.quantity,
        deliveredCodeCount,
        storedEncrypted: pilotOrder.storedEncrypted === true,
        sanitizedRawResponse: redactCodeDeliverySecrets(sanitizePayload(pilotOrder.providerRawResponse)),
        warnings: pilotOrder.warnings || [],
    };
};

const buildDeliveredCodeSafeSummary = (code) => ({
    id: code._id.toString(),
    localOrderId: code.order ? code.order.toString() : null,
    pilotOrderId: code.pilotOrder ? code.pilotOrder.toString() : null,
    providerCode: code.providerCode,
    familyKey: code.familyKey,
    fulfillmentMode: code.fulfillmentMode,
    providerProductId: code.providerProduct ? code.providerProduct.toString() : null,
    productId: code.product ? code.product.toString() : null,
    deliveryStatus: code.deliveryStatus,
    deliveredAt: code.deliveredAt || null,
    revealedAt: code.revealedAt || null,
    revealCount: code.revealCount || 0,
    hasCode: Boolean(code.codeEncrypted),
    hasPin: Boolean(code.pinEncrypted),
    hasSerial: Boolean(code.serialEncrypted),
    storedEncrypted: Boolean(code.codeEncrypted || code.pinEncrypted || code.serialEncrypted),
    metadata: redactCodeDeliverySecrets(sanitizePayload(code.metadata)),
    createdAt: code.createdAt,
    updatedAt: code.updatedAt,
});

const listCodeDeliveryPilotDeliveredCodes = async (orderId) => {
    const pilotOrder = await ProviderPilotOrder.findById(orderId).lean();
    if (!pilotOrder) throw new NotFoundError('ProviderPilotOrder');
    if (pilotOrder.providerCode !== PROVIDER_CODES.FAZER_CARDS || pilotOrder.fulfillmentMode !== FULFILLMENT_MODES.CODE_DELIVERY) {
        throw new BusinessRuleError('Pilot order is not a FazerCards code-delivery order.', 'INVALID_PROVIDER_ORDER');
    }

    const codes = await ProviderDeliveredCode.find({ pilotOrder: pilotOrder._id })
        .select('+codeEncrypted +serialEncrypted +pinEncrypted')
        .sort({ createdAt: 1 })
        .lean();

    return {
        success: true,
        localOrderId: pilotOrder._id.toString(),
        localStatus: pilotOrder.status,
        deliveredCodeCount: codes.length,
        items: codes.map(buildDeliveredCodeSafeSummary),
        warnings: ['Plaintext provider codes are not returned by this endpoint.'],
    };
};

const getDeliveredCodeDebug = async (codeId) => {
    const code = await ProviderDeliveredCode.findById(codeId)
        .select('+codeEncrypted +serialEncrypted +pinEncrypted +providerRawResponse')
        .lean();
    if (!code) throw new NotFoundError('ProviderDeliveredCode');
    if (code.providerCode !== PROVIDER_CODES.FAZER_CARDS) {
        throw new BusinessRuleError('Delivered code is not linked to FazerCards.', 'INVALID_PROVIDER_ORDER');
    }

    return {
        success: true,
        code: buildDeliveredCodeSafeSummary(code),
        sanitizedRawResponse: redactCodeDeliverySecrets(sanitizePayload(code.providerRawResponse)),
        warnings: ['Plaintext provider codes are not returned by this endpoint.'],
    };
};

const isFazerCardsProviderCode = (value) => {
    const normalized = String(value || '').trim();
    return normalized.toUpperCase() === PROVIDER_CODES.FAZER_CARDS
        || normalized.toLowerCase() === FAZERCARDS_SLUG;
};

const loadOrderForFazerCardsReconcile = async (orderId) => {
    const order = await Order.findById(orderId)
        .populate({
            path: 'productId',
            select: 'name provider providerProduct providerCode providerExecutionEnabled providerExecutionMode familyKey fulfillmentMode',
            populate: [
                { path: 'provider', select: 'name slug code providerCode isActive baseUrl authType token encryptedCredentials' },
                {
                    path: 'providerProduct',
                    select: 'provider providerCode externalProductId rawName costPrice rawPrice currency category categoryName offerId offerName familyKey fulfillmentMode isSupported isBlocked requiredFields rawPayload',
                    populate: { path: 'provider', select: 'name slug code providerCode isActive baseUrl authType token encryptedCredentials' },
                },
            ],
        });
    if (!order) throw new NotFoundError('Order');
    return order;
};

const getOrderProduct = (order) => order?.productId || null;

const getOrderProviderProduct = (order) => {
    const product = getOrderProduct(order);
    return product?.providerProduct || null;
};

const assertFazerCardsOrder = (order) => {
    const product = getOrderProduct(order);
    const providerProduct = getOrderProviderProduct(order);
    const providerCode = order.providerCode
        || product?.providerCode
        || product?.provider?.providerCode
        || product?.provider?.slug
        || providerProduct?.providerCode
        || providerProduct?.provider?.providerCode
        || providerProduct?.provider?.slug;

    if (!isFazerCardsProviderCode(providerCode)) {
        throw new BusinessRuleError('Order is not linked to FazerCards.', 'INVALID_PROVIDER_ORDER');
    }
    if (!providerProduct || !isFazerCardsProviderCode(providerProduct.providerCode)) {
        throw new BusinessRuleError('Order is not linked to a FazerCards ProviderProduct.', 'INVALID_PROVIDER_ORDER');
    }
};

const assertFazerCardsOrderSent = (order) => {
    if (order.providerOrderId === null || order.providerOrderId === undefined || order.providerOrderId === '') {
        throw new BusinessRuleError('FazerCards order has not been sent to the provider.', 'FAZERCARDS_ORDER_NOT_SENT');
    }
};

const buildProviderResultUpdate = (result = {}, fallbackProviderOrderId = null) => {
    const update = {
        providerOrderId: result.providerOrderId ?? fallbackProviderOrderId,
        providerStatus: result.providerStatus,
        providerRawResponse: sanitizeProviderCodePayload(sanitizePayload(result.rawResponse)),
        lastCheckedAt: new Date(),
    };

    for (const key of [
        'providerRequestId',
        'providerIdempotencyKey',
        'providerMessage',
        'providerErrorCode',
        'providerErrorMessage',
    ]) {
        if (result[key] !== undefined) update[key] = result[key];
    }

    return update;
};

const getOrderFamilyKey = (order) => String(
    order?.familyKey
    || getOrderProduct(order)?.familyKey
    || getOrderProviderProduct(order)?.familyKey
    || ''
).trim().toUpperCase();

const getOrderFulfillmentMode = (order) => String(
    order?.fulfillmentMode
    || getOrderProduct(order)?.fulfillmentMode
    || getOrderProviderProduct(order)?.fulfillmentMode
    || ''
).trim().toUpperCase();

const isCodeDeliveryFazerCardsOrder = (order) => (
    getOrderFulfillmentMode(order) === FULFILLMENT_MODES.CODE_DELIVERY
    || ['GIFTCARDS', 'GAME_KEYS'].includes(getOrderFamilyKey(order))
);

const appendFazerCardsStatusHistory = (status, note, metadata = null) => ({
    status,
    note,
    metadata: sanitizeProviderCodePayload(sanitizePayload(metadata)),
    at: new Date(),
});

const getExistingDeliveredCodeCount = (orderId) => ProviderDeliveredCode.countDocuments({ order: orderId });

const storeDeliveredCodesFromProviderPayload = async (order, rawPayload) => {
    if (!isCodeDeliveryFazerCardsOrder(order) || !rawPayload) {
        return {
            deliveredCodeCount: 0,
            storedEncrypted: false,
            hasPin: false,
            hasSerial: false,
        };
    }

    const product = getOrderProduct(order);
    const providerProduct = getOrderProviderProduct(order);
    const providerDoc = product?.provider || providerProduct?.provider || await findFazerCardsProvider();
    return storeDeliveredCodesForOrder({
        order,
        providerDoc,
        providerProduct,
        product,
        familyKey: getOrderFamilyKey(order),
        rawResponse: rawPayload,
    });
};

const updateOrderFromFazerCardsStatus = async (order, result, { source = 'fazercards_status_sync' } = {}) => {
    const now = new Date();
    const update = buildProviderResultUpdate(result, order.providerOrderId);
    const normalizedStatus = result.normalizedStatus || (
        result.manualReview === true
            ? NORMALIZED_STATUSES.UNKNOWN
            : result.success === false
                ? NORMALIZED_STATUSES.FAILED
                : result.providerStatus === 'Completed'
                    ? NORMALIZED_STATUSES.COMPLETED
                    : NORMALIZED_STATUSES.PROCESSING
    );

    if ([ORDER_STATUS.FAILED, ORDER_STATUS.CANCELED].includes(order.status) && normalizedStatus === NORMALIZED_STATUSES.COMPLETED) {
        const updated = await Order.findByIdAndUpdate(order._id, {
            $set: {
                ...update,
                lastCheckedAt: now,
            },
            $push: {
                statusHistory: appendFazerCardsStatusHistory(order.status, 'Ignored provider completion for a locally terminal failed/refunded order.', { source }),
            },
        }, { new: true });
        return { order: updated, action: 'ignoredTerminal', refunded: updated?.refunded === true };
    }

    if (order.status === ORDER_STATUS.COMPLETED && normalizedStatus === NORMALIZED_STATUSES.COMPLETED) {
        let deliveredCodeCount = 0;
        if (isCodeDeliveryFazerCardsOrder(order)) {
            await storeDeliveredCodesFromProviderPayload(order, result.rawProviderPayload || result.rawResponse);
            deliveredCodeCount = await getExistingDeliveredCodeCount(order._id);
        }
        const updated = await Order.findByIdAndUpdate(order._id, {
            $set: {
                ...update,
                lastCheckedAt: now,
            },
        }, { new: true });
        return {
            order: updated,
            action: 'completed',
            idempotent: true,
            refunded: updated?.refunded === true,
            deliveredCodeCount,
        };
    }

    if (normalizedStatus === NORMALIZED_STATUSES.UNKNOWN || result.manualReview === true) {
        const updated = await Order.findByIdAndUpdate(order._id, {
            $set: {
                status: ORDER_STATUS.MANUAL_REVIEW,
                ...update,
                rejectionReason: result.errorMessage
                    || result.providerErrorMessage
                    || 'FazerCards provider status is unknown and requires manual review.',
            },
            $push: {
                statusHistory: appendFazerCardsStatusHistory(ORDER_STATUS.MANUAL_REVIEW, 'FazerCards provider status is unknown and requires manual review.', {
                    source,
                    providerOrderId: update.providerOrderId,
                    providerStatus: result.providerStatus,
                }),
            },
        }, { new: true });
        notifyOrderManualReview(updated, {
            reason: result.providerErrorCode || result.providerErrorMessage || 'FAZERCARDS_STATUS_MANUAL_REVIEW',
            source,
        });
        return { order: updated, action: 'manualReview', refunded: false };
    }

    if (normalizedStatus === NORMALIZED_STATUSES.PROCESSING) {
        const updated = await Order.findByIdAndUpdate(order._id, {
            $set: {
                status: ORDER_STATUS.PROCESSING,
                ...update,
            },
            $push: {
                statusHistory: appendFazerCardsStatusHistory(ORDER_STATUS.PROCESSING, 'FazerCards provider order is still processing.', {
                    source,
                    providerOrderId: update.providerOrderId,
                    providerStatus: result.providerStatus,
                }),
            },
        }, { new: true });
        return { order: updated, action: 'processing', refunded: updated?.refunded === true };
    }

    if (normalizedStatus === NORMALIZED_STATUSES.FAILED || normalizedStatus === NORMALIZED_STATUSES.REFUNDED || result.success === false) {
        await Order.findByIdAndUpdate(order._id, {
            $set: {
                status: ORDER_STATUS.FAILED,
                ...update,
                rejectionReason: result.errorMessage
                    || result.providerErrorMessage
                    || 'FazerCards provider reported the order failed.',
                failedAt: order.failedAt || now,
            },
            $push: {
                statusHistory: appendFazerCardsStatusHistory(ORDER_STATUS.FAILED, 'FazerCards provider reported a terminal failed/refunded status.', {
                    source,
                    providerOrderId: update.providerOrderId,
                    providerStatus: result.providerStatus,
                    normalizedStatus,
                }),
            },
        });
        const failedOrder = await Order.findById(order._id);
        const refunded = await refundFailedOrder(failedOrder, {
            source,
            reason: normalizedStatus === NORMALIZED_STATUSES.REFUNDED ? 'PROVIDER_REFUNDED' : 'PROVIDER_FAILED',
            providerRejected: true,
        });
        return { order: await Order.findById(order._id), action: 'failed', refunded };
    }

    if (normalizedStatus === NORMALIZED_STATUSES.COMPLETED && isCodeDeliveryFazerCardsOrder(order)) {
        const storedCodes = await storeDeliveredCodesFromProviderPayload(order, result.rawProviderPayload || result.rawResponse);
        const deliveredCodeCount = await getExistingDeliveredCodeCount(order._id);
        if (deliveredCodeCount <= 0) {
            const updated = await Order.findByIdAndUpdate(order._id, {
                $set: {
                    status: ORDER_STATUS.MANUAL_REVIEW,
                    ...update,
                    providerErrorCode: result.providerErrorCode || 'FAZERCARDS_CODE_DELIVERY_CODE_MISSING',
                    providerErrorMessage: result.providerErrorMessage || 'Provider completed but code payload was not recognized.',
                    rejectionReason: result.errorMessage || result.providerErrorMessage || 'Provider completed but code payload was not recognized.',
                },
                $push: {
                    statusHistory: appendFazerCardsStatusHistory(ORDER_STATUS.MANUAL_REVIEW, 'Provider completed but code payload was not recognized.', {
                        source,
                        providerOrderId: update.providerOrderId,
                        storedEncrypted: storedCodes.storedEncrypted,
                    }),
                },
            }, { new: true });
            notifyOrderManualReview(updated, {
                reason: result.providerErrorCode || 'FAZERCARDS_CODE_DELIVERY_CODE_MISSING',
                source,
            });
            return { order: updated, action: 'manualReview', refunded: false, deliveredCodeCount: 0 };
        }
    }

    const updated = await Order.findByIdAndUpdate(order._id, {
        $set: {
            status: ORDER_STATUS.COMPLETED,
            ...update,
        },
        $push: {
            statusHistory: appendFazerCardsStatusHistory(ORDER_STATUS.COMPLETED, 'FazerCards provider order completed.', {
                source,
                providerOrderId: update.providerOrderId,
                providerStatus: result.providerStatus,
            }),
        },
    }, { new: true });

    return {
        order: updated,
        action: 'completed',
        refunded: updated?.refunded === true,
        deliveredCodeCount: isCodeDeliveryFazerCardsOrder(order)
            ? await getExistingDeliveredCodeCount(order._id)
            : 0,
    };
};

const summarizeOrder = (order) => ({
    id: order?._id?.toString(),
    status: order?.status,
    providerOrderId: order?.providerOrderId ?? null,
    providerStatus: order?.providerStatus ?? null,
    refunded: order?.refunded === true,
    lastCheckedAt: order?.lastCheckedAt ?? null,
});

const syncOrderStatus = async (orderId, adapterOptions = {}) => {
    const order = await loadOrderForFazerCardsReconcile(orderId);
    assertFazerCardsOrder(order);
    assertFazerCardsOrderSent(order);
    const oldStatus = order.status;

    const product = getOrderProduct(order);
    const providerProduct = getOrderProviderProduct(order);
    const providerDoc = product?.provider || providerProduct?.provider || await findFazerCardsProvider();
    const adapter = new FazerCardsAdapter(providerDoc, adapterOptions);
    const result = await adapter.getOrderStatus({ providerOrderId: order.providerOrderId });
    const applied = await updateOrderFromFazerCardsStatus(order, result, { source: 'fazercards_status_sync' });
    const finalDeliveredCodeCount = isCodeDeliveryFazerCardsOrder(order)
        ? await getExistingDeliveredCodeCount(order._id)
        : 0;

    return {
        success: applied.action !== 'manualReview',
        action: applied.action,
        oldStatus,
        newStatus: applied.order?.status || null,
        reviewRequired: applied.action === 'manualReview',
        codeStored: finalDeliveredCodeCount > 0,
        deliveredCodeCount: finalDeliveredCodeCount,
        statusEndpointConfirmed: result.providerErrorCode !== 'FAZERCARDS_STATUS_ENDPOINT_UNCONFIRMED',
        providerResult: {
            providerOrderId: result.providerOrderId ?? order.providerOrderId,
            providerStatus: result.providerStatus,
            normalizedStatus: result.normalizedStatus ?? null,
            providerRequestId: result.providerRequestId ?? null,
            providerErrorCode: result.providerErrorCode ?? null,
            providerErrorMessage: result.providerErrorMessage ?? null,
            manualReview: result.manualReview === true,
        },
        refunded: applied.refunded === true,
        order: summarizeOrder(applied.order),
        warnings: result.manualReview === true
            ? ['Provider status could not be confirmed. Order moved to manual review without an automatic refund.']
            : [],
    };
};

const applyProviderStatusPayloadToOrder = async (orderId, payload = {}, {
    source = 'fazercards_webhook',
    providerOrderId = null,
    providerRequestId = null,
    providerIdempotencyKey = null,
    fallbackStatus = null,
    requireProviderOrderId = true,
} = {}) => {
    const order = await loadOrderForFazerCardsReconcile(orderId);
    assertFazerCardsOrder(order);

    const parsed = parseFazerCardsOrderPayload(payload, {
        fallbackProviderOrderId: providerOrderId || order.providerOrderId,
        requestId: providerRequestId,
        providerIdempotencyKey: providerIdempotencyKey || order.providerIdempotencyKey,
        fallbackStatus,
        requireProviderOrderId,
    });
    const applied = await updateOrderFromFazerCardsStatus(order, parsed, { source });
    const finalDeliveredCodeCount = isCodeDeliveryFazerCardsOrder(order)
        ? await getExistingDeliveredCodeCount(order._id)
        : 0;
    return {
        success: applied.action !== 'manualReview',
        action: applied.action,
        oldStatus: order.status,
        newStatus: applied.order?.status || null,
        reviewRequired: applied.action === 'manualReview',
        codeStored: finalDeliveredCodeCount > 0,
        deliveredCodeCount: finalDeliveredCodeCount,
        providerResult: {
            providerOrderId: parsed.providerOrderId ?? order.providerOrderId,
            providerStatus: parsed.providerStatus,
            normalizedStatus: parsed.normalizedStatus,
            providerRequestId: parsed.providerRequestId ?? null,
            providerErrorCode: parsed.providerErrorCode ?? null,
            providerErrorMessage: parsed.providerErrorMessage ?? null,
            manualReview: parsed.manualReview === true,
        },
        refunded: applied.refunded === true,
        order: summarizeOrder(applied.order),
        warnings: applied.action === 'manualReview'
            ? ['Provider status could not be safely completed. Order requires review without an automatic refund.']
            : [],
    };
};

const getOrderProviderDebug = async (orderId) => {
    const order = await loadOrderForFazerCardsReconcile(orderId);
    assertFazerCardsOrder(order);

    const product = getOrderProduct(order);
    const providerProduct = getOrderProviderProduct(order);
    const identifiers = extractTopupIdentifiers(providerProduct);
    const requiredFields = Array.isArray(providerProduct?.requiredFields) ? providerProduct.requiredFields : [];
    const warnings = [];

    if (!order.providerOrderId) warnings.push('FazerCards order has not been sent to the provider.');
    if (product?.providerExecutionEnabled !== true) {
        warnings.push('Product provider execution is currently disabled.');
    }
    if (!identifiers.categoryId || !identifiers.offerId) {
        warnings.push('FazerCards category_id or offer_id is missing from the linked ProviderProduct.');
    }

    return {
        localOrderId: order._id.toString(),
        localStatus: order.status,
        providerOrderId: order.providerOrderId ?? null,
        providerStatus: order.providerStatus ?? null,
        providerCode: order.providerCode || product?.providerCode || providerProduct?.providerCode || null,
        providerProduct: providerProduct ? {
            id: providerProduct._id.toString(),
            externalProductId: providerProduct.externalProductId,
        } : null,
        categoryId: identifiers.categoryId,
        offerId: identifiers.offerId,
        requiredFieldKeys: requiredFields
            .map((field) => (typeof field === 'string' ? field : field?.key || field?.name || field?.id))
            .filter(Boolean),
        providerExecutionEnabled: product?.providerExecutionEnabled === true,
        lastProviderRawResponse: sanitizePayload(order.providerRawResponse),
        warnings,
    };
};

const normalizeManualStatusFilter = (status) => {
    const normalized = String(status || '').trim().toUpperCase();
    if (!normalized) return null;
    if (normalized === 'PENDING_MANUAL') return ORDER_STATUS.PENDING;
    if (normalized === 'PROCESSING_MANUAL') return ORDER_STATUS.PROCESSING;
    if (normalized === 'MANUAL_REVIEW') return ORDER_STATUS.MANUAL_REVIEW;
    return normalized;
};

const normalizeObjectId = (value, label = 'id') => {
    if (!value) return null;
    const stringValue = String(value).trim();
    if (!mongoose.Types.ObjectId.isValid(stringValue)) {
        throw new BusinessRuleError(`${label} must be a valid ObjectId.`, 'INVALID_OBJECT_ID');
    }
    return new mongoose.Types.ObjectId(stringValue);
};

const SUBMITTED_FIELD_SECRET_PATTERN = /(password|passwd|token|secret|credential|authorization|auth_key|api_key)/i;

const buildSubmittedFieldSummaries = (order = {}) => {
    const values = order.customerInput?.values && typeof order.customerInput.values === 'object'
        ? order.customerInput.values
        : {};
    const snapshot = Array.isArray(order.customerInput?.fieldsSnapshot)
        ? order.customerInput.fieldsSnapshot
        : [];
    const labelsByKey = new Map(snapshot.map((field) => [
        String(field.key || field.name || '').trim(),
        field,
    ]).filter(([key]) => key));

    return Object.entries(values).map(([key, value]) => {
        const field = labelsByKey.get(key) || {};
        return {
            key,
            label: field.label || key,
            type: field.type || 'text',
            value: SUBMITTED_FIELD_SECRET_PATTERN.test(key)
                ? '[REDACTED]'
                : (value === undefined || value === null ? '' : String(value)),
        };
    });
};

const getSafeOrderUser = (user) => {
    if (!user || typeof user !== 'object') return null;
    return {
        id: user._id?.toString?.() || String(user._id || user.id || ''),
        name: user.name || '',
        email: user.email || '',
    };
};

const getSafeOrderProduct = (product = {}, providerProduct = null) => ({
    id: product?._id?.toString?.() || String(product?._id || product?.id || ''),
    name: product?.name || '',
    familyKey: product?.familyKey || providerProduct?.familyKey || null,
    fulfillmentMode: product?.fulfillmentMode || providerProduct?.fulfillmentMode || null,
    providerExecutionMode: product?.providerExecutionMode || null,
    providerExecutionEnabled: product?.providerExecutionEnabled === true,
    providerExecutionBlocked: product?.providerExecutionBlocked === true,
    providerBlockReason: product?.providerBlockReason || null,
});

const countDeliveredCodesForOrders = async (orderIds = []) => {
    if (!orderIds.length) return new Map();
    const counts = await ProviderDeliveredCode.aggregate([
        { $match: { order: { $in: orderIds } } },
        { $group: { _id: '$order', count: { $sum: 1 } } },
    ]);
    return new Map(counts.map((item) => [String(item._id), Number(item.count || 0)]));
};

const safeProviderMetadataForManualOrder = (order = {}, providerProduct = null) => ({
    providerCode: order.providerCode || PROVIDER_CODES.FAZER_CARDS.toLowerCase(),
    providerOrderId: order.providerOrderId ?? null,
    providerStatus: order.providerStatus ?? null,
    providerRequestId: order.providerRequestId ?? null,
    providerErrorCode: order.providerErrorCode ?? null,
    providerErrorMessage: order.providerErrorMessage ?? null,
    providerProduct: providerProduct ? {
        id: providerProduct._id?.toString?.() || String(providerProduct._id || ''),
        externalProductId: providerProduct.externalProductId || null,
        familyKey: getProviderProductFamilyKey(providerProduct),
        fulfillmentMode: providerProduct.fulfillmentMode || null,
        costPrice: providerProduct.costPrice ?? providerProduct.rawPrice ?? null,
        currency: providerProduct.currency || 'USD',
        stock: providerProduct.stock ?? null,
        minQty: providerProduct.minQty || 1,
        maxQty: providerProduct.maxQty || 9999,
        region: providerProduct.region || null,
        platform: providerProduct.platform || null,
    } : null,
    rawResponseStored: Boolean(order.providerRawResponse),
});

const summarizeManualOrder = (order, deliveredCodeCount = 0, detail = false) => {
    const product = getOrderProduct(order);
    const providerProduct = getOrderProviderProduct(order);
    const plainOrder = order && typeof order.toObject === 'function' ? order.toObject() : order;
    return {
        id: order._id.toString(),
        orderNumber: order.orderNumber || null,
        status: order.status,
        executionType: order.executionType,
        familyKey: order.familyKey || product?.familyKey || providerProduct?.familyKey || null,
        fulfillmentMode: order.fulfillmentMode || product?.fulfillmentMode || providerProduct?.fulfillmentMode || null,
        quantity: order.quantity,
        totalPrice: order.totalPrice,
        currency: order.currency || 'USD',
        refunded: order.refunded === true,
        refundedAt: order.refundedAt || null,
        failedAt: order.failedAt || null,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        customer: getSafeOrderUser(order.userId),
        product: getSafeOrderProduct(product, providerProduct),
        submittedFields: buildSubmittedFieldSummaries(order),
        deliveredCodeCount,
        hasDeliveredCodes: deliveredCodeCount > 0,
        provider: safeProviderMetadataForManualOrder(order, providerProduct),
        internalNotes: detail ? (plainOrder.internalNotes || []) : undefined,
        statusHistory: detail ? (plainOrder.statusHistory || []) : undefined,
        warnings: [
            'Plaintext delivered codes are never returned by manual order list/detail endpoints.',
        ],
    };
};

const populateFazerCardsManualOrder = (query) => query
    .populate({
        path: 'productId',
        select: 'name provider providerProduct providerCode familyKey fulfillmentMode providerExecutionMode providerExecutionEnabled providerExecutionBlocked providerBlockReason',
        populate: [
            { path: 'provider', select: 'name slug providerCode' },
            {
                path: 'providerProduct',
                select: 'provider providerCode externalProductId rawName costPrice rawPrice currency familyKey fulfillmentMode category categoryName offerId offerName region platform stock minQty maxQty requiredFields blockReason executionBlocked isSupported isBlocked',
                populate: { path: 'provider', select: 'name slug providerCode' },
            },
        ],
    })
    .populate('userId', 'name email');

const buildFazerCardsProductIdsForOrderFilters = async ({ familyKey, fulfillmentMode, productId } = {}) => {
    const productQuery = {
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        deletedAt: null,
    };
    if (productId) productQuery._id = normalizeObjectId(productId, 'productId');
    if (familyKey) productQuery.familyKey = String(familyKey).trim().toUpperCase();
    if (fulfillmentMode) productQuery.fulfillmentMode = String(fulfillmentMode).trim().toUpperCase();
    const products = await Product.find(productQuery).select('_id').lean();
    return products.map((product) => product._id);
};

const listManualOrders = async ({
    page = 1,
    limit = 20,
    familyKey,
    fulfillmentMode,
    status,
    productId,
    userId,
    from,
    to,
} = {}) => {
    const normalizedPage = Math.max(parseInt(page, 10) || 1, 1);
    const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
    const productIds = await buildFazerCardsProductIdsForOrderFilters({ familyKey, fulfillmentMode, productId });
    const query = {
        productId: { $in: productIds },
        $or: [
            { status: ORDER_STATUS.MANUAL_REVIEW },
            { executionType: EXECUTION_TYPES.MANUAL },
        ],
    };

    const normalizedStatus = normalizeManualStatusFilter(status);
    if (normalizedStatus) query.status = normalizedStatus;
    if (!normalizedStatus) query.status = { $in: [ORDER_STATUS.MANUAL_REVIEW, ORDER_STATUS.PENDING, ORDER_STATUS.PROCESSING] };
    if (userId) query.userId = normalizeObjectId(userId, 'userId');
    if (from || to) {
        query.createdAt = {};
        if (from) query.createdAt.$gte = new Date(from);
        if (to) query.createdAt.$lte = new Date(to);
    }

    const skip = (normalizedPage - 1) * normalizedLimit;
    const [orders, total] = await Promise.all([
        populateFazerCardsManualOrder(Order.find(query))
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(normalizedLimit),
        Order.countDocuments(query),
    ]);
    const deliveredCounts = await countDeliveredCodesForOrders(orders.map((order) => order._id));

    return {
        orders: orders.map((order) => summarizeManualOrder(order, deliveredCounts.get(String(order._id)) || 0)),
        pagination: {
            page: normalizedPage,
            limit: normalizedLimit,
            total,
            pages: Math.ceil(total / normalizedLimit),
        },
    };
};

const loadManualOrder = async (orderId) => {
    const order = await populateFazerCardsManualOrder(Order.findById(orderId));
    if (!order) throw new NotFoundError('Order');
    assertFazerCardsOrder(order);
    const isManual = order.status === ORDER_STATUS.MANUAL_REVIEW || order.executionType === EXECUTION_TYPES.MANUAL;
    if (!isManual) {
        throw new BusinessRuleError('Order is not a manual FazerCards order.', 'FAZERCARDS_ORDER_NOT_MANUAL');
    }
    return order;
};

const appendManualOrderNote = (order, {
    adminId = null,
    note = '',
    proof = null,
    type = 'admin_note',
    status = null,
    metadata = null,
} = {}) => {
    const trimmedNote = String(note || '').trim();
    if (trimmedNote || proof) {
        order.internalNotes = order.internalNotes || [];
        order.internalNotes.push({
            note: trimmedNote,
            proof: proof || null,
            type,
            createdBy: adminId || null,
            createdAt: new Date(),
        });
    }
    if (status) {
        order.statusHistory = order.statusHistory || [];
        order.statusHistory.push({
            status,
            note: trimmedNote,
            actor: adminId || null,
            at: new Date(),
            metadata: sanitizePayload(metadata),
        });
    }
};

const auditManualOrderAction = ({
    order,
    adminId,
    action,
    metadata = {},
    ipAddress = null,
    userAgent = null,
} = {}) => createAuditLog({
    actorId: adminId || order.userId || null,
    actorRole: ACTOR_ROLES.ADMIN,
    ipAddress,
    userAgent,
    action,
    entityType: ENTITY_TYPES.ORDER,
    entityId: order._id,
    metadata: sanitizePayload({
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        familyKey: order.familyKey,
        fulfillmentMode: order.fulfillmentMode,
        ...metadata,
    }),
});

const isCodeDeliveryManualOrder = (order) => {
    const product = getOrderProduct(order);
    const providerProduct = getOrderProviderProduct(order);
    const familyKey = String(order.familyKey || product?.familyKey || providerProduct?.familyKey || '').trim().toUpperCase();
    const fulfillmentMode = String(order.fulfillmentMode || product?.fulfillmentMode || providerProduct?.fulfillmentMode || '').trim().toUpperCase();
    return fulfillmentMode === FULFILLMENT_MODES.CODE_DELIVERY && CODE_DELIVERY_IMPORT_FAMILIES.has(familyKey);
};

const completeManualOrder = async (orderId, {
    adminNote = '',
    proof = null,
    deliveredCodes = [],
} = {}, adminId = null, auditContext = {}) => {
    const order = await loadManualOrder(orderId);
    if (order.status === ORDER_STATUS.COMPLETED) {
        throw new BusinessRuleError('Order is already completed.', 'ORDER_ALREADY_COMPLETED');
    }
    if (order.refunded === true) {
        throw new BusinessRuleError('Refunded orders cannot be completed.', 'ORDER_ALREADY_REFUNDED');
    }

    const suppliedCodes = Array.isArray(deliveredCodes) ? deliveredCodes : [];
    if (suppliedCodes.length > 0 && !isCodeDeliveryManualOrder(order)) {
        throw new BusinessRuleError('Delivered codes can only be stored for CODE_DELIVERY orders.', 'ORDER_NOT_CODE_DELIVERY');
    }
    if (isCodeDeliveryManualOrder(order) && suppliedCodes.length === 0 && await getExistingDeliveredCodeCount(order._id) === 0) {
        throw new BusinessRuleError('At least one delivered code/key is required to complete this CODE_DELIVERY order.', 'DELIVERED_CODE_REQUIRED');
    }

    const storedCodes = [];
    for (const delivered of suppliedCodes) {
        storedCodes.push(await storeManualDeliveredCodeForOrder({
            orderId: order._id,
            code: delivered.code,
            pin: delivered.pin,
            serial: delivered.serial,
            metadata: delivered.metadata || { source: 'admin_manual_complete' },
        }));
    }

    order.status = ORDER_STATUS.COMPLETED;
    order.providerErrorCode = null;
    order.providerErrorMessage = null;
    order.rejectionReason = null;
    appendManualOrderNote(order, {
        adminId,
        note: adminNote || 'Manual FazerCards order completed by admin.',
        proof,
        type: 'manual_complete',
        status: ORDER_STATUS.COMPLETED,
        metadata: {
            deliveredCodeCountAdded: storedCodes.length,
        },
    });
    await order.save();
    notifyOrderCompleted(order, { source: 'fazercards_manual_fulfillment' });
    await auditManualOrderAction({
        order,
        adminId,
        action: ORDER_ACTIONS.COMPLETED,
        metadata: {
            action: 'fazercards_manual_complete',
            deliveredCodeCountAdded: storedCodes.length,
            plaintextReturned: false,
        },
        ...auditContext,
    });

    const deliveredCodeCount = await getExistingDeliveredCodeCount(order._id);
    return {
        success: true,
        order: summarizeManualOrder(await loadManualOrder(order._id), deliveredCodeCount, true),
        deliveredCodes: storedCodes.map((item) => ({
            id: item.id,
            deliveryStatus: item.deliveryStatus,
            hasCode: item.hasCode,
            hasPin: item.hasPin,
            hasSerial: item.hasSerial,
            storedEncrypted: item.storedEncrypted,
            deliveredAt: item.deliveredAt,
        })),
        warnings: ['Plaintext delivered codes were stored encrypted and are not returned by this endpoint.'],
    };
};

const getRefundableAmount = (order = {}) => {
    const walletPortion = Number(order.walletDeducted || 0);
    const creditPortion = Number(order.creditUsedAmount || 0);
    const charged = Number(order.chargedAmount || 0);
    return walletPortion + creditPortion > 0 ? walletPortion + creditPortion : charged;
};

const failManualOrder = async (orderId, {
    reason = '',
    refund = false,
} = {}, adminId = null, auditContext = {}) => {
    const order = await loadManualOrder(orderId);
    const trimmedReason = String(reason || '').trim();
    if (!trimmedReason) {
        throw new BusinessRuleError('reason is required.', 'FAZERCARDS_MANUAL_FAIL_REASON_REQUIRED');
    }
    if (order.status === ORDER_STATUS.FAILED && order.refunded === true) {
        return {
            success: true,
            alreadyFailed: true,
            refunded: true,
            order: summarizeManualOrder(order, await getExistingDeliveredCodeCount(order._id), true),
        };
    }

    let refundApplied = false;
    let refundSkippedReason = null;
    if (refund === true) {
        if (order.refunded === true) {
            refundSkippedReason = 'ALREADY_REFUNDED';
        } else if (getRefundableAmount(order) <= 0) {
            refundSkippedReason = 'NO_REFUNDABLE_AMOUNT';
        } else {
            refundApplied = await refundFailedOrder(order, {
                source: 'fazercards_manual_fail',
                reason: 'ADMIN_MANUAL_FAIL',
                providerRejected: false,
            });
            if (!refundApplied) refundSkippedReason = 'ALREADY_REFUNDED';
        }
    }

    const freshOrder = await Order.findById(order._id);
    freshOrder.status = ORDER_STATUS.FAILED;
    freshOrder.failedAt = freshOrder.failedAt || new Date();
    freshOrder.rejectionReason = trimmedReason;
    freshOrder.providerErrorCode = 'FAZERCARDS_MANUAL_FULFILLMENT_FAILED';
    freshOrder.providerErrorMessage = trimmedReason;
    appendManualOrderNote(freshOrder, {
        adminId,
        note: trimmedReason,
        type: 'manual_fail',
        status: ORDER_STATUS.FAILED,
        metadata: {
            refundRequested: refund === true,
            refundApplied,
            refundSkippedReason,
        },
    });
    await freshOrder.save();
    notifyOrderFailed(freshOrder, {
        source: 'fazercards_manual_fulfillment',
        reason: trimmedReason,
        notifyUser: true,
    });
    await auditManualOrderAction({
        order: freshOrder,
        adminId,
        action: ORDER_ACTIONS.FAILED,
        metadata: {
            action: 'fazercards_manual_fail',
            reason: trimmedReason,
            refundRequested: refund === true,
            refundApplied,
            refundSkippedReason,
        },
        ...auditContext,
    });

    const loaded = await loadManualOrder(freshOrder._id);
    return {
        success: true,
        refunded: refundApplied,
        refundSkippedReason,
        order: summarizeManualOrder(loaded, await getExistingDeliveredCodeCount(loaded._id), true),
    };
};

const addManualOrderNote = async (orderId, {
    adminNote = '',
    proof = null,
} = {}, adminId = null, auditContext = {}) => {
    const note = String(adminNote || '').trim();
    if (!note && !proof) {
        throw new BusinessRuleError('adminNote or proof is required.', 'FAZERCARDS_MANUAL_NOTE_REQUIRED');
    }
    const order = await loadManualOrder(orderId);
    appendManualOrderNote(order, {
        adminId,
        note,
        proof,
        type: 'manual_note',
        metadata: { proofProvided: Boolean(proof) },
    });
    await order.save();
    await auditManualOrderAction({
        order,
        adminId,
        action: ORDER_ACTIONS.MANUAL_REVIEW,
        metadata: {
            action: 'fazercards_manual_note',
            proofProvided: Boolean(proof),
        },
        ...auditContext,
    });
    return {
        success: true,
        order: summarizeManualOrder(await loadManualOrder(order._id), await getExistingDeliveredCodeCount(order._id), true),
    };
};

const getManualOrderDetail = async (orderId) => {
    const order = await loadManualOrder(orderId);
    const deliveredCodeCount = await getExistingDeliveredCodeCount(order._id);
    return {
        success: true,
        order: summarizeManualOrder(order, deliveredCodeCount, true),
    };
};

const validateBulkLaunchProductUpdate = (product, updates) => {
    const providerProduct = product.providerProduct;
    const familyKey = String(product.familyKey || providerProduct?.familyKey || '').trim().toUpperCase();
    const contract = fazerCardsContracts.getContractOrUnknown(familyKey);
    const requestedMode = updates.providerExecutionMode || product.providerExecutionMode || fazerCardsContracts.getDefaultExecutionMode(familyKey);
    const modeValidation = fazerCardsContracts.validateExecutionModeForFamily(familyKey, requestedMode);
    const errors = [];
    const validatedMode = modeValidation.ok ? modeValidation.mode : String(requestedMode || '').trim().toUpperCase();
    const simulatedProduct = {
        ...product,
        ...updates,
        providerExecutionMode: validatedMode,
        providerProduct,
    };
    const simulatedStatus = String(simulatedProduct.status || '').trim().toLowerCase();
    const launchingForCustomers = simulatedProduct.customerPurchaseEnabled === true
        && simulatedProduct.isActive === true
        && simulatedProduct.visibleInStore !== false
        && simulatedStatus === PRODUCT_STATUSES.AVAILABLE
        && simulatedProduct.isPaused !== true
        && simulatedProduct.isAvailableForApi !== false;
    const enablingCustomerPurchase = updates.customerPurchaseEnabled === true;
    const enablingVisibility = updates.isActive === true
        || updates.visibleInStore === true
        || updates.status === PRODUCT_STATUSES.AVAILABLE
        || enablingCustomerPurchase;
    const enablingAutoProvider = validatedMode === fazerCardsContracts.PROVIDER_EXECUTION_MODES.AUTO_PROVIDER
        && updates.providerExecutionEnabled === true;

    if (!modeValidation.ok) {
        errors.push({ code: modeValidation.code, message: modeValidation.message, allowedModes: modeValidation.allowedModes });
    }
    if (
        validatedMode === fazerCardsContracts.PROVIDER_EXECUTION_MODES.AUTO_PROVIDER
        && !fazerCardsContracts.canBulkAutoExecuteFamily(familyKey)
        && updates._explicitProductLevelAuto !== true
    ) {
        errors.push({
            code: 'CONTRACT_AUTO_EXECUTION_NOT_ALLOWED',
            message: 'This FazerCards family can only be enabled for AUTO_PROVIDER through an explicit single-product controlled action.',
        });
    }
    if (contract.supportStage === fazerCardsContracts.SUPPORT_STAGES.DISABLED_UNAVAILABLE && enablingVisibility) {
        errors.push({ code: 'FAMILY_DISABLED_UNAVAILABLE', message: 'This FazerCards family is currently unavailable.' });
    }
    if (enablingCustomerPurchase && contract.canCustomerPurchase !== true) {
        errors.push({ code: 'CUSTOMER_PURCHASE_NOT_ALLOWED', message: 'Customer purchase is not allowed for this FazerCards family contract.' });
    }
    if (enablingAutoProvider && !launchingForCustomers) {
        errors.push({
            code: 'AUTO_PROVIDER_REQUIRES_CUSTOMER_VISIBLE_PRODUCT',
            message: 'Auto provider execution can only be enabled for an active, visible, available customer product.',
        });
    }
    if (modeValidation.ok && modeValidation.mode === fazerCardsContracts.PROVIDER_EXECUTION_MODES.AUTO_PROVIDER) {
        const autoReadiness = fazerCardsContracts.validateAutoProviderReadinessForProduct({
            product: simulatedProduct,
            providerProduct,
            familyKey,
            requireCustomerVisible: true,
        });
        if (!autoReadiness.ok) errors.push(...autoReadiness.errors);
    }
    const manualFieldValidation = fazerCardsContracts.validateManualCustomerFieldsForProduct({
        product: simulatedProduct,
        providerProduct,
        familyKey,
        providerExecutionMode: validatedMode,
        fulfillmentMode: simulatedProduct.fulfillmentMode,
    });
    if (launchingForCustomers && !manualFieldValidation.ok) {
        errors.push({
            code: manualFieldValidation.code || 'MANUAL_PRODUCT_REQUIRES_CUSTOMER_FIELDS',
            message: manualFieldValidation.message || 'Manual fulfillment products require customer input fields before launch.',
            reason: manualFieldValidation.reason || 'manual fulfillment requires customer fields',
            suggestions: manualFieldValidation.suggestions || [],
        });
    }

    return {
        ok: errors.length === 0,
        familyKey,
        contract: {
            supportStage: contract.supportStage,
            executionStage: contract.executionStage,
            allowedModes: modeValidation.allowedModes || fazerCardsContracts.getAllowedExecutionModes(familyKey),
        },
        requestedMode: validatedMode,
        errors,
    };
};

const buildBulkLaunchUpdateSet = (product, payload, validatedMode) => {
    const allowed = [
        'customerPurchaseEnabled',
        'isActive',
        'visibleInStore',
        'status',
        'providerExecutionMode',
        'providerExecutionEnabled',
        'providerExecutionBlocked',
        'providerBlockReason',
    ];
    const update = {};
    for (const key of allowed) {
        if (payload[key] !== undefined) update[key] = payload[key];
    }
    update.providerExecutionMode = validatedMode;
    if (validatedMode !== fazerCardsContracts.PROVIDER_EXECUTION_MODES.AUTO_PROVIDER) {
        update.providerExecutionEnabled = false;
        update.executionType = EXECUTION_TYPES.MANUAL;
    } else {
        update.providerExecutionEnabled = payload.providerExecutionEnabled === undefined
            ? product.providerExecutionEnabled === true
            : payload.providerExecutionEnabled === true;
        update.executionType = update.providerExecutionEnabled === true
            ? EXECUTION_TYPES.AUTOMATIC
            : EXECUTION_TYPES.MANUAL;
        if (update.providerExecutionEnabled === true) {
            if (payload.providerExecutionBlocked === undefined) update.providerExecutionBlocked = false;
            if (payload.providerBlockReason === undefined) update.providerBlockReason = null;
        }
    }
    if (validatedMode === fazerCardsContracts.PROVIDER_EXECUTION_MODES.DISABLED) {
        update.customerPurchaseEnabled = false;
        update.providerExecutionEnabled = false;
        update.executionType = EXECUTION_TYPES.MANUAL;
    }
    return update;
};

const normalizePublishFamilyFilter = (familyKey) => {
    const normalized = String(familyKey || '').trim().toUpperCase();
    if (!normalized || normalized === 'ALL') return null;
    if (!ALL_LAUNCH_FAMILIES.includes(normalized)) {
        throw new BusinessRuleError('Unknown FazerCards family.', 'FAZERCARDS_UNKNOWN_FAMILY');
    }
    return normalized;
};

const getPublishFamilies = ({ familyKey = null, providerExecutionMode } = {}) => {
    const familyFilter = normalizePublishFamilyFilter(familyKey);
    if (providerExecutionMode === fazerCardsContracts.PROVIDER_EXECUTION_MODES.AUTO_PROVIDER) {
        if (familyFilter && !AUTO_PROVIDER_FAMILIES.has(familyFilter)) {
            throw new BusinessRuleError(
                'Bulk AUTO_PROVIDER publishing is allowed only for confirmed FazerCards families.',
                'CONTRACT_AUTO_EXECUTION_NOT_ALLOWED'
            );
        }
        if (familyFilter) return [familyFilter];
        return [...AUTO_PROVIDER_FAMILIES];
    }
    if (familyFilter) return [familyFilter];
    return [...LAUNCH_PUBLISH_FAMILIES];
};

const publishEligibleLaunchControls = async (payload = {}, adminId = null, auditContext = {}) => {
    const requestedMode = String(payload.providerExecutionMode || '').trim().toUpperCase();
    if (![
        fazerCardsContracts.PROVIDER_EXECUTION_MODES.AUTO_PROVIDER,
        fazerCardsContracts.PROVIDER_EXECUTION_MODES.MANUAL_FULFILLMENT,
    ].includes(requestedMode)) {
        throw new BusinessRuleError('providerExecutionMode is required.', 'FAZERCARDS_LAUNCH_MODE_REQUIRED');
    }

    const families = getPublishFamilies({
        familyKey: payload.familyKey,
        providerExecutionMode: requestedMode,
    });
    const limit = Math.min(Math.max(Number(payload.limit) || 500, 1), 1000);
    const products = await Product.find({
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        deletedAt: null,
        providerProduct: { $ne: null },
        familyKey: { $in: families },
    })
        .select('_id')
        .limit(limit)
        .lean();
    const productIds = products.map((product) => product._id.toString());

    if (productIds.length === 0) {
        return {
            success: true,
            dryRun: payload.dryRun === true,
            total: 0,
            updated: 0,
            wouldUpdate: 0,
            failed: 0,
            publishScope: {
                familyKey: normalizePublishFamilyFilter(payload.familyKey) || 'ALL',
                families,
                providerExecutionMode: requestedMode,
                limit,
            },
            results: [],
        };
    }

    const result = await bulkUpdateLaunchControls({
        productIds,
        customerPurchaseEnabled: true,
        isActive: true,
        visibleInStore: true,
        status: PRODUCT_STATUSES.AVAILABLE,
        providerExecutionMode: requestedMode,
        providerExecutionEnabled: requestedMode === fazerCardsContracts.PROVIDER_EXECUTION_MODES.AUTO_PROVIDER,
        dryRun: payload.dryRun === true,
    }, adminId, auditContext);

    return {
        ...result,
        publishScope: {
            familyKey: normalizePublishFamilyFilter(payload.familyKey) || 'ALL',
            families,
            providerExecutionMode: requestedMode,
            limit,
        },
    };
};

const bulkUpdateLaunchControls = async (payload = {}, adminId = null, auditContext = {}) => {
    const productIds = [...new Set((Array.isArray(payload.productIds) ? payload.productIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean))];
    if (productIds.length === 0) {
        throw new BusinessRuleError('productIds is required.', 'FAZERCARDS_BULK_PRODUCT_IDS_REQUIRED');
    }

    const dryRun = payload.dryRun === true;
    const products = await Product.find({ _id: { $in: productIds }, deletedAt: null })
        .populate('providerProduct', 'providerCode familyKey fulfillmentMode externalProductId rawName category categoryName offerId offerName requiredFields rawPayload minQty maxQty stock costPrice rawPrice currency isSupported isBlocked executionBlocked blockReason region platform')
        .lean();
    const productsById = new Map(products.map((product) => [product._id.toString(), product]));
    const results = [];

    for (const productId of productIds) {
        const product = productsById.get(productId);
        if (!product) {
            results.push({ productId, ok: false, errors: [{ code: 'PRODUCT_NOT_FOUND', message: 'Product not found.' }] });
            continue;
        }
        if (normalizeProviderCode(product.providerCode) !== PROVIDER_CODES.FAZER_CARDS) {
            results.push({ productId, ok: false, errors: [{ code: 'FAZERCARDS_PRODUCT_REQUIRED', message: 'Product is not linked to FazerCards.' }] });
            continue;
        }

        const validation = validateBulkLaunchProductUpdate(product, payload);
        const update = validation.ok ? buildBulkLaunchUpdateSet(product, payload, validation.requestedMode) : {};
        const simulatedProduct = validation.ok ? { ...product, ...update } : product;
        const visibility = buildCustomerVisibilityStatus(simulatedProduct);
        const changedFields = validation.ok ? diffLaunchFields(product, update) : [];
        results.push({
            productId,
            productName: product.name,
            ok: validation.ok,
            success: validation.ok,
            familyKey: validation.familyKey,
            requestedMode: validation.requestedMode,
            contract: validation.contract,
            errors: validation.errors,
            changedFields,
            visibleToCustomer: visibility.visibleToCustomer,
            visibilityReasons: visibility.reasons,
            customerVisibilityStatus: visibility,
            update,
        });
    }

    if (!dryRun) {
        for (const result of results.filter((item) => item.ok)) {
            const updatedProduct = await Product.findByIdAndUpdate(
                result.productId,
                { $set: result.update },
                { new: true, runValidators: true }
            ).lean();
            const visibility = buildCustomerVisibilityStatus(updatedProduct);
            result.visibleToCustomer = visibility.visibleToCustomer;
            result.visibilityReasons = visibility.reasons;
            result.customerVisibilityStatus = visibility;
            result.importedProduct = summarizeImportedLaunchProduct(updatedProduct);
            await createAuditLog({
                actorId: adminId || result.productId,
                actorRole: ACTOR_ROLES.ADMIN,
                ipAddress: auditContext.ipAddress || null,
                userAgent: auditContext.userAgent || null,
                action: PRODUCT_ACTIONS.UPDATED,
                entityType: ENTITY_TYPES.PRODUCT,
                entityId: result.productId,
                metadata: sanitizePayload({
                    action: 'fazercards_bulk_update_launch',
                    familyKey: result.familyKey,
                    update: result.update,
                }),
            });
        }
    }

    const successful = results.filter((item) => item.ok).length;
    return {
        success: results.every((item) => item.ok),
        dryRun,
        total: results.length,
        updated: dryRun ? 0 : successful,
        wouldUpdate: dryRun ? successful : 0,
        failed: results.length - successful,
        results,
    };
};

const updateSingleProductLaunchControls = async (productId, payload = {}, adminId = null, auditContext = {}) => {
    const result = await bulkUpdateLaunchControls({
        ...payload,
        productIds: [productId],
        _explicitProductLevelAuto: true,
        dryRun: false,
    }, adminId, auditContext);
    const productResult = result.results[0];
    if (!productResult?.ok) {
        const firstError = productResult?.errors?.[0] || {};
        throw new BusinessRuleError(
            firstError.message || 'FazerCards product launch settings are invalid.',
            firstError.code || 'FAZERCARDS_LAUNCH_UPDATE_INVALID'
        );
    }

    return {
        success: true,
        product: productResult.importedProduct,
        result: productResult,
        launchStatus: productResult.customerVisibilityStatus,
    };
};

const getCatalogSyncStatus = async () => ({
    success: true,
    inProgress: syncAllInProgress,
    lastSync: lastSyncAllSummary,
    catalog: await getCatalogSummary(),
});

const getFazerCardsProductIds = async () => (
    Product.find({ providerCode: PROVIDER_CODES.FAZER_CARDS, deletedAt: null }).select('_id').lean()
);

const getLaunchHealth = async (adapterOptions = {}) => {
    const warnings = [];
    let balance = null;
    let connectionOk = false;
    let connectionError = null;
    if (config.providers.fazerCards.enabled === true) {
        try {
            const balanceResult = await getBalance(adapterOptions);
            balance = balanceResult.balance?.balance ?? balanceResult.balance ?? null;
            connectionOk = true;
        } catch (err) {
            connectionError = err.code || 'FAZERCARDS_CONNECTION_UNKNOWN';
            warnings.push('FazerCards balance/connection could not be checked.');
        }
    } else {
        warnings.push('FazerCards integration is disabled.');
    }

    const catalog = await getCatalogSummary();
    const fazerProductIds = (await getFazerCardsProductIds()).map((product) => product._id);
    const visibleFilter = {
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        deletedAt: null,
        isActive: true,
        visibleInStore: true,
        status: PRODUCT_STATUSES.AVAILABLE,
        customerPurchaseEnabled: true,
    };
    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const orderBase = fazerProductIds.length ? { productId: { $in: fazerProductIds } } : { _id: { $exists: false } };

    const [
        activeCustomerVisible,
        autoProvider,
        manualFulfillment,
        disabled,
        visibleAutoProvider,
        manualPending,
        manualReview,
        processing,
        completed24h,
        failed24h,
    ] = await Promise.all([
        Product.countDocuments(visibleFilter),
        Product.countDocuments({ providerCode: PROVIDER_CODES.FAZER_CARDS, deletedAt: null, providerExecutionMode: fazerCardsContracts.PROVIDER_EXECUTION_MODES.AUTO_PROVIDER }),
        Product.countDocuments({ providerCode: PROVIDER_CODES.FAZER_CARDS, deletedAt: null, providerExecutionMode: fazerCardsContracts.PROVIDER_EXECUTION_MODES.MANUAL_FULFILLMENT }),
        Product.countDocuments({ providerCode: PROVIDER_CODES.FAZER_CARDS, deletedAt: null, providerExecutionMode: fazerCardsContracts.PROVIDER_EXECUTION_MODES.DISABLED }),
        Product.countDocuments({ ...visibleFilter, providerExecutionMode: fazerCardsContracts.PROVIDER_EXECUTION_MODES.AUTO_PROVIDER }),
        Order.countDocuments({ ...orderBase, executionType: EXECUTION_TYPES.MANUAL, status: { $in: [ORDER_STATUS.PENDING, ORDER_STATUS.PROCESSING, ORDER_STATUS.MANUAL_REVIEW] } }),
        Order.countDocuments({ ...orderBase, status: ORDER_STATUS.MANUAL_REVIEW }),
        Order.countDocuments({ ...orderBase, status: ORDER_STATUS.PROCESSING }),
        Order.countDocuments({ ...orderBase, status: ORDER_STATUS.COMPLETED, updatedAt: { $gte: since24h } }),
        Order.countDocuments({ ...orderBase, status: { $in: [ORDER_STATUS.FAILED, ORDER_STATUS.CANCELED] }, updatedAt: { $gte: since24h } }),
    ]);

    if (config.providers.fazerCards.customerPurchaseEnabled === false) warnings.push('FazerCards customer purchase gate is disabled.');
    if (config.providers.fazerCards.realOrdersEnabled !== true) warnings.push('FazerCards real order gate is disabled.');
    if (config.providers.fazerCards.codeDeliveryEnabled !== true) warnings.push('FazerCards code delivery gate is disabled.');
    if (config.providers.fazerCards.webhookEnabled === true && !config.providers.fazerCards.webhookSecret) {
        warnings.push('FazerCards webhook processing is enabled but the webhook secret is missing.');
    }
    if (visibleAutoProvider > 0 && config.providers.fazerCards.realOrdersEnabled !== true) {
        warnings.push('Visible AUTO_PROVIDER products exist while the global real order gate is disabled; orders will require manual review.');
    }
    warnings.push('Steam Gifts broad catalog sync remains disabled; use explicit appid/on-demand import for controlled products.');

    const appUrl = String(process.env.APP_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/+$/, '');

    return {
        success: true,
        api: {
            enabled: config.providers.fazerCards.enabled === true,
            balance,
            connectionOk,
            connectionError,
        },
        gates: {
            customerPurchaseEnabled: config.providers.fazerCards.customerPurchaseEnabled !== false,
            realOrdersEnabled: config.providers.fazerCards.realOrdersEnabled === true,
            codeDeliveryEnabled: config.providers.fazerCards.codeDeliveryEnabled === true,
        },
        webhooks: {
            endpointUrl: `${appUrl}/api/webhooks/providers/fazercards`,
            enabled: config.providers.fazerCards.webhookEnabled === true,
            secretConfigured: Boolean(config.providers.fazerCards.webhookSecret),
            status: config.providers.fazerCards.webhookEnabled !== true
                ? 'disabled'
                : config.providers.fazerCards.webhookSecret
                    ? 'enabled'
                    : 'missing_secret',
        },
        catalog: {
            byFamily: catalog.byFamily,
            totalProviderProducts: catalog.totalProviderProducts,
        },
        products: {
            activeCustomerVisible,
            autoProvider,
            manualFulfillment,
            disabled,
            visibleAutoProvider,
        },
        orders: {
            manualPending,
            manualReview,
            processing,
            completed24h,
            failed24h,
        },
        warnings: [...new Set(warnings.filter(Boolean))],
    };
};

const storeManualDeliveredCode = async ({ orderId, code, pin = null, serial = null, metadata = null } = {}) =>
    storeManualDeliveredCodeForOrder({ orderId, code, pin, serial, metadata });

module.exports = {
    FAZERCARDS_SLUG,
    findFazerCardsProvider,
    ensureFazerCardsProvider,
    testConnection,
    getBalance,
    listContracts,
    getContract,
    getContractsSummary,
    syncCatalogPage,
    listFamilies,
    syncCatalogFamily,
    syncAllCatalogFamilies,
    getCatalogSyncStatus,
    getCatalogSummary,
    refreshSteamGiftGameIndex,
    searchSteamGiftGameIndex,
    getLaunchHealth,
    backfillLegacyFamilies,
    listProviderProducts,
    getProviderProductDetails,
    getImportPreview,
    importProviderProduct,
    buildTopupDryRun,
    buildCodeDeliveryDryRun,
    buildUnifiedDryRun,
    getProductReadiness,
    getCodeDeliveryReadiness,
    runCodeDeliveryLivePilot,
    getCodeDeliveryLivePilotDebug,
    listCodeDeliveryPilotDeliveredCodes,
    getDeliveredCodeDebug,
    storeManualDeliveredCode,
    listManualOrders,
    getManualOrderDetail,
    completeManualOrder,
    failManualOrder,
    addManualOrderNote,
    bulkUpdateLaunchControls,
    publishEligibleLaunchControls,
    updateSingleProductLaunchControls,
    syncOrderStatus,
    applyProviderStatusPayloadToOrder,
    getOrderProviderDebug,
};
