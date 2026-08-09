'use strict';

const config = require('../../../config/config');
const { Provider } = require('../provider.model');
const { ProviderProduct, FULFILLMENT_MODES, SUPPORT_LEVELS } = require('../providerProduct.model');
const { Product, PRICING_MODES, EXECUTION_TYPES, PRODUCT_STATUSES } = require('../../products/product.model');
const { Order, ORDER_STATUS } = require('../../orders/order.model');
const { refundFailedOrder } = require('../../orders/orderFulfillment.service');
const { Currency } = require('../../currency/currency.model');
const { PROVIDER_CODES } = require('../provider.constants');
const { BusinessRuleError, ConflictError, NotFoundError } = require('../../../shared/errors/AppError');
const { FazerCardsAdapter, extractTopupIdentifiers, buildTopupFields } = require('./fazercards.adapter');
const { sanitizePayload } = require('./fazercards.client');
const { getFazerCardsFamily, listFazerCardsFamilies } = require('./fazercardsFamilies');

const FAZERCARDS_SLUG = 'fazer-cards';

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

const syncCatalogPage = async ({ limit = 100, cursor, category } = {}, adapterOptions = {}) => {
    const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const { provider, adapter } = await getConfiguredAdapter(adapterOptions);

    if (!provider.isActive) {
        throw new BusinessRuleError('FazerCards provider is inactive.', 'PROVIDER_INACTIVE');
    }

    const page = await adapter.fetchTopupCategoriesPage({ limit: normalizedLimit, cursor });
    const now = new Date();
    let providerProductsCreated = 0;
    let providerProductsUpdated = 0;
    let offersFetched = 0;
    let blocked = 0;
    let unsupported = 0;
    const errors = [];
    const categoryFilter = String(category || '').trim();
    const categories = categoryFilter
        ? page.items.filter((item) => getCategoryId(item) === categoryFilter)
        : page.items;

    if (page.malformed) {
        blocked++;
        unsupported++;
        errors.push('FazerCards top-up category response has an unknown shape');
    }

    for (const categoryItem of categories) {
        const categoryId = getCategoryId(categoryItem);
        if (!categoryId) {
            blocked++;
            unsupported++;
            errors.push('FazerCards top-up category is missing category_id');
            continue;
        }

        let offerPage;
        try {
            offerPage = await adapter.fetchTopupOffers(categoryId);
        } catch (err) {
            errors.push(err.message || `Failed to fetch FazerCards offers for ${categoryId}`);
            continue;
        }

        if (offerPage.malformed) {
            blocked++;
            unsupported++;
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
                errors.push(err.message || 'Failed to normalize FazerCards top-up offer');
            }
        }
    }

    return {
        providerId: provider._id.toString(),
        provider: provider.name,
        endpoints: ['GET /topups', 'GET /topups/offers'],
        categoriesFetched: categories.length,
        offersFetched,
        providerProductsCreated,
        providerProductsUpdated,
        blocked,
        unsupported,
        nextCursor: page.meta?.next_cursor ?? null,
        hasMore: Boolean(page.meta?.has_more),
        deleted: 0,
        deactivated: 0,
        errors,
        meta: page.meta,
        requestId: page.requestId,
        syncedAt: now,
    };
};

const firstValue = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

const parseNumber = (value, fallback = null) => {
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeMeta = (data = {}, params = {}) => ({
    total: data?.meta?.total ?? data?.total ?? null,
    limit: data?.meta?.limit ?? data?.limit ?? params.limit ?? null,
    next_cursor: data?.meta?.next_cursor ?? data?.meta?.nextCursor ?? data?.next_cursor ?? data?.nextCursor ?? null,
    has_more: Boolean(data?.meta?.has_more ?? data?.meta?.hasMore ?? data?.has_more ?? data?.hasMore ?? false),
});

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
    const cardId = String(firstValue(offer.card_id, offer.cardId, offer.id, 'unknown_card'));
    const categoryName = String(firstValue(category.name, category.title, categoryId));
    const offerName = String(firstValue(offer.name, offer.title, cardId));
    const costPrice = parseNumber(firstValue(offer.price_usd, offer.priceUsd, offer.cost_usd), null);
    return makeBlockedFamilyProduct(family, {
        externalProductId: `FAZER_GIFTCARD:${categoryId}:${cardId}`,
        name: `${categoryName} - ${offerName}`,
        rawName: `${categoryName} - ${offerName}`,
        rawPrice: costPrice === null ? '0' : String(firstValue(offer.price_usd, offer.priceUsd, offer.cost_usd)),
        costPrice,
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
    const keyId = String(firstValue(key.key_id, key.keyId, key.id, 'unknown_key'));
    const gameName = String(firstValue(game.GameName, game.name, game.title, gameId));
    const keyName = String(firstValue(key.name, key.title, keyId));
    const costPrice = parseNumber(firstValue(key.price_usd, key.priceUsd, key.cost_usd), null);
    return makeBlockedFamilyProduct(family, {
        externalProductId: `FAZER_GAMEKEY:${gameId}:${keyId}`,
        name: `${gameName} - ${keyName}`,
        rawName: `${gameName} - ${keyName}`,
        rawPrice: costPrice === null ? '0' : String(firstValue(key.price_usd, key.priceUsd, key.cost_usd)),
        costPrice,
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
    const gameName = String(firstValue(game.name, details.name, appId));
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
                name: `${gameName} - ${offerName} (${region})`,
                rawName: `${gameName} - ${offerName} (${region})`,
                rawPrice: costPrice === null ? '0' : String(firstValue(regionOffer.price, regionOffer.price_usd, offer.price_usd)),
                costPrice,
                category: appId,
                categoryName: gameName,
                offerId: subId,
                offerName,
                region,
                platform: 'steam',
                rawPayload: { family: family.familyKey, game, offer, region: regionOffer },
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
            minQty: parseNumber(firstValue(starsData.min_amount, starsData.minAmount), 1) || 1,
            maxQty: parseNumber(firstValue(starsData.max_amount, starsData.maxAmount), 9999) || 9999,
            requiredFields: [{ key: 'telegram_username', label: 'Telegram Username', type: 'text', required: true }],
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
            rawPayload: { family: family.familyKey, kind: 'telegram_premium', plan, response: premiumData },
        }));
    }
    return products;
};

const normalizeManualServiceProduct = (category = {}, offer = {}) => {
    const family = getFazerCardsFamily('MANUAL_SERVICES');
    const serviceId = String(firstValue(category.id, category.manual_service_id, category.manualServiceId, 'unknown_service'));
    const offerId = String(firstValue(offer.id, offer.product_id, offer.productId, 'unknown_offer'));
    const categoryName = String(firstValue(category.name, category.title, serviceId));
    const offerName = String(firstValue(offer.name, offer.title, offerId));
    const price = firstValue(offer.price_usd, offer.priceUsd);
    return makeBlockedFamilyProduct(family, {
        externalProductId: `FAZER_MANUAL_SERVICE:${serviceId}:${offerId}`,
        name: `${categoryName} - ${offerName}`,
        rawName: `${categoryName} - ${offerName}`,
        rawPrice: String(price || '0'),
        costPrice: parseNumber(price, null),
        category: serviceId,
        categoryName,
        offerId,
        offerName,
        subCategory: firstValue(category.kind, null),
        requiredFields: [],
        rawPayload: { family: family.familyKey, category, offer },
    });
};

const syncFamilyDtos = async (family, adapter, { limit, cursor } = {}) => {
    const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    if (family.familyKey === 'GIFTCARDS') {
        const page = await adapter.fetchCatalogPath('/giftcards', { limit: normalizedLimit, cursor }, 'giftcards');
        const categories = Array.isArray(page.data?.items) ? page.data.items : [];
        const products = [];
        for (const category of categories) {
            const categoryId = getCategoryId(category);
            if (!categoryId) continue;
            const cards = await adapter.fetchCatalogPath('/giftcards/cards', { category_id: categoryId }, 'giftcards_cards');
            const offers = Array.isArray(cards.data?.offers) ? cards.data.offers : [];
            for (const offer of offers) products.push(normalizeGiftCardProduct({ ...category, ...cards.data }, offer));
        }
        return { products, categoriesFetched: categories.length, offersFetched: products.length, meta: normalizeMeta(page.data, { limit: normalizedLimit }), requestId: page.requestId };
    }

    if (family.familyKey === 'GAME_KEYS') {
        const page = await adapter.fetchCatalogPath('/gamekeys', { limit: normalizedLimit, cursor }, 'gamekeys');
        const games = Array.isArray(page.data?.items) ? page.data.items : [];
        const products = [];
        for (const game of games) {
            const gameId = String(firstValue(game.game_id, game.gameId, game.id, '')).trim();
            if (!gameId) continue;
            const keys = await adapter.fetchCatalogPath('/gamekeys/keys', { game_id: gameId }, 'gamekeys_keys');
            const keyItems = Array.isArray(keys.data?.keys) ? keys.data.keys : [];
            const mergedGame = { ...game, ...keys.data };
            for (const key of keyItems) products.push(normalizeGameKeyProduct(mergedGame, key));
        }
        return { products, categoriesFetched: games.length, offersFetched: products.length, meta: normalizeMeta(page.data, { limit: normalizedLimit }), requestId: page.requestId };
    }

    if (family.familyKey === 'STEAM_GIFTS') {
        const page = await adapter.fetchCatalogPath('/steam-gifts/games', { limit: normalizedLimit }, 'steam_gifts_games');
        const games = Array.isArray(page.data?.games) ? page.data.games : [];
        const products = [];
        for (const game of games) {
            const appId = String(firstValue(game.appid, game.app_id, game.id, '')).trim();
            if (!appId) continue;
            const details = await adapter.fetchCatalogPath(`/steam-gifts/games/${encodeURIComponent(appId)}`, {}, 'steam_gifts_game_details');
            products.push(...normalizeSteamGiftProducts(game, details.data));
        }
        return { products, categoriesFetched: games.length, offersFetched: products.length, meta: page.data?.meta || {}, requestId: page.requestId };
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
        const page = await adapter.fetchCatalogPath('/manual-services', {}, 'manual_services');
        const categories = Array.isArray(page.data?.items) ? page.data.items.slice(0, normalizedLimit) : [];
        const products = [];
        for (const category of categories) {
            const serviceId = String(firstValue(category.id, category.manual_service_id, '')).trim();
            if (!serviceId) continue;
            const offers = await adapter.fetchCatalogPath(`/manual-services/${encodeURIComponent(serviceId)}/offers`, {}, 'manual_service_offers');
            const offerItems = Array.isArray(offers.data?.items) ? offers.data.items : [];
            const mergedCategory = { ...category, ...(offers.data?.category || {}) };
            for (const offer of offerItems) products.push(normalizeManualServiceProduct(mergedCategory, offer));
        }
        return { products, categoriesFetched: categories.length, offersFetched: products.length, meta: {}, requestId: page.requestId };
    }

    throw new BusinessRuleError(`FazerCards family '${family.familyKey}' is not syncable yet.`, 'FAZERCARDS_FAMILY_DISCOVERY_UNCONFIRMED');
};

const syncCatalogFamily = async ({ family, limit = 20, cursor } = {}, adapterOptions = {}) => {
    const registryEntry = getFazerCardsFamily(family);
    if (!registryEntry || registryEntry.familyKey === 'UNKNOWN') {
        throw new BusinessRuleError('Unknown FazerCards catalog family.', 'FAZERCARDS_UNKNOWN_FAMILY');
    }
    if (registryEntry.familyKey === 'TOPUPS') {
        return syncCatalogPage({ limit, cursor }, adapterOptions);
    }

    const { provider, adapter } = await getConfiguredAdapter(adapterOptions);
    if (!provider.isActive) {
        throw new BusinessRuleError('FazerCards provider is inactive.', 'PROVIDER_INACTIVE');
    }

    const now = new Date();
    const { products, categoriesFetched, offersFetched, meta, requestId } = await syncFamilyDtos(registryEntry, adapter, { limit, cursor });
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
        offersFetched,
        providerProductsCreated,
        providerProductsUpdated,
        blocked: products.filter((product) => product.isBlocked).length,
        unsupported: products.filter((product) => !product.isSupported).length,
        nextCursor: meta?.next_cursor ?? null,
        hasMore: Boolean(meta?.has_more),
        deleted: 0,
        deactivated: 0,
        errors: [],
        meta,
        requestId,
        syncedAt: now,
        catalogOnly: registryEntry.executionAvailable !== true,
    };
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
                    'rawPayload.category': { $exists: true },
                    'rawPayload.offer': { $exists: true },
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

const listProviderProducts = async ({
    page = 1,
    limit = 50,
    search,
    category,
    region,
    available,
    supported,
    blocked,
    imported,
    fulfillmentMode,
    familyKey,
    supportLevel,
    blockReason,
} = {}) => {
    const query = { providerCode: PROVIDER_CODES.FAZER_CARDS };
    if (category) query.category = String(category).trim();
    if (region) query.region = String(region).trim();
    if (fulfillmentMode) query.fulfillmentMode = String(fulfillmentMode).trim().toUpperCase();
    addAndCondition(query, buildFamilyFilter(familyKey));
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
        }).select('_id name providerProduct isActive visibleInStore status').lean();
        importedProductMap = new Map(importedProducts.map((product) => [
            String(product.providerProduct),
            product,
        ]));
        const importedIds = importedProducts.map((product) => product.providerProduct).filter(Boolean);
        query._id = importedFilter ? { $in: importedIds } : { $nin: importedIds };
    }

    if (search) {
        const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'i');
        addAndCondition(query, { $or: [
            { rawName: regex },
            { translatedName: regex },
            { externalProductId: regex },
            { category: regex },
            { categoryName: regex },
            { offerId: regex },
            { offerName: regex },
            { subCategory: regex },
            { region: regex },
        ] });
    }

    const normalizedPage = Math.max(parseInt(page, 10) || 1, 1);
    const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const skip = (normalizedPage - 1) * normalizedLimit;

    const [products, total] = await Promise.all([
        ProviderProduct.find(query)
            .sort({ rawName: 1, externalProductId: 1 })
            .skip(skip)
            .limit(normalizedLimit)
            .populate('provider', 'name slug providerCode')
            .lean(),
        ProviderProduct.countDocuments(query),
    ]);

    if (importedFilter === undefined && products.length) {
        const importedProducts = await Product.find({
            providerProduct: { $in: products.map((product) => product._id) },
            deletedAt: null,
        }).select('_id name providerProduct isActive visibleInStore status').lean();
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
                importedProduct: importedProduct ? {
                    id: importedProduct._id,
                    name: importedProduct.name,
                    isActive: importedProduct.isActive,
                    visibleInStore: importedProduct.visibleInStore,
                    status: importedProduct.status,
                } : null,
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
    return product;
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

const assertImportableProviderProduct = (providerProduct) => {
    if (!providerProduct) throw new NotFoundError('ProviderProduct');
    if (providerProduct.providerCode !== PROVIDER_CODES.FAZER_CARDS) {
        throw new BusinessRuleError('Only FazerCards provider products can be imported here.', 'FAZERCARDS_PROVIDER_PRODUCT_REQUIRED');
    }
    if (providerProduct.fulfillmentMode !== 'TOPUP_WITH_FIELDS') {
        throw new BusinessRuleError('Only FazerCards top-up offers can be imported.', 'FAZERCARDS_IMPORT_UNSUPPORTED_FULFILLMENT_MODE');
    }
    if (providerProduct.isSupported !== true) {
        throw new BusinessRuleError('Unsupported FazerCards provider products cannot be imported.', 'FAZERCARDS_PROVIDER_PRODUCT_UNSUPPORTED');
    }
    if (providerProduct.isBlocked === true) {
        throw new BusinessRuleError('Blocked FazerCards provider products cannot be imported.', 'FAZERCARDS_PROVIDER_PRODUCT_BLOCKED');
    }
    if (!Array.isArray(providerProduct.requiredFields) || providerProduct.requiredFields.length === 0) {
        throw new BusinessRuleError('FazerCards provider product is missing required fields.', 'FAZERCARDS_PROVIDER_PRODUCT_MISSING_FIELDS');
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
    return {
        providerProductId: providerProduct._id.toString(),
        providerProductName: providerProduct.rawName,
        externalProductId: providerProduct.externalProductId,
        costPrice: String(providerProduct.costPrice ?? providerProduct.rawPrice),
        currency: providerProduct.currency || 'USD',
        requiredFields: providerProduct.requiredFields,
        suggestedProductName: providerProduct.translatedName || providerProduct.rawName,
        suggestedOrderFields: orderFields.map(({ providerKey, ...field }) => field),
        warning: 'Imported product will be created inactive and not visible to customers.',
    };
};

const getImportPreview = async (id) => {
    const providerProduct = await ProviderProduct.findById(id).populate('provider', 'name slug providerCode isActive').lean();
    assertImportableProviderProduct(providerProduct);
    return buildImportPreview(providerProduct);
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
    const sellPrice = Number(payload.sellPrice);
    if (!Number.isFinite(sellPrice) || sellPrice <= 0) {
        throw new BusinessRuleError('sellPrice must be a positive number.', 'INVALID_SELL_PRICE');
    }

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

    const costPrice = String(providerProduct.costPrice ?? providerProduct.rawPrice);
    const orderFieldsWithProviderKeys = buildOrderFieldsFromProviderFields(providerProduct.requiredFields);
    const providerMapping = buildProviderMapping(orderFieldsWithProviderKeys);
    const orderFields = orderFieldsWithProviderKeys.map(({ providerKey, ...field }) => field);
    const dynamicFields = buildDynamicFieldsFromOrderFields(orderFields);
    const syncPrice = payload.syncPriceFromProvider === true;
    const nowUpdate = {
        name: productName,
        description: payload.description ?? providerProduct.rawPayload?.category?.note ?? null,
        image: payload.image || null,
        category: payload.categoryId || payload.category || providerProduct.category || null,
        basePrice: String(sellPrice),
        providerPrice: costPrice,
        finalPrice: String(sellPrice),
        currency,
        minQty: providerProduct.minQty || 1,
        maxQty: providerProduct.maxQty || 9999,
        isActive: false,
        visibleInStore: false,
        isPaused: false,
        status: PRODUCT_STATUSES.UNAVAILABLE,
        executionType: EXECUTION_TYPES.MANUAL,
        pricingMode: syncPrice ? PRICING_MODES.SYNC : PRICING_MODES.MANUAL,
        syncPriceWithProvider: syncPrice,
        syncNameWithProvider: payload.syncNameFromProvider === true,
        syncAvailabilityWithProvider: payload.syncAvailabilityFromProvider !== false,
        providerExecutionEnabled: false,
        provider: providerProduct.provider._id,
        providerProduct: providerProduct._id,
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        externalProductId: providerProduct.externalProductId,
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

    const { fields: payloadFields, missing } = buildTopupFields(fields, providerProduct.requiredFields);
    if (missing.length > 0) {
        throw new BusinessRuleError(
            `Missing FazerCards customer field(s): ${missing.join(', ')}.`,
            'FAZERCARDS_CUSTOMER_FIELDS_MISSING'
        );
    }

    const suppliedOrderId = String(orderId || '').trim();
    const idempotencyKeyPreview = `fazercards:topup:${suppliedOrderId || 'DRY_RUN_PREVIEW'}`;
    const executionState = product.providerExecutionEnabled === true ? 'enabled' : 'disabled';

    return {
        success: true,
        dryRun: true,
        wouldCall: 'POST /topups/order',
        provider: 'FazerCards',
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
        payload: {
            category_id: categoryId,
            offer_id: offerId,
            fields: payloadFields,
        },
        requiredFields: providerProduct.requiredFields,
        warnings: [
            'Dry run only. No FazerCards order was created.',
            `Product execution is currently ${executionState}.`,
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
            select: 'provider providerCode externalProductId rawName costPrice rawPrice currency category offerId fulfillmentMode isSupported isBlocked requiredFields rawPayload',
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

const getProductReadiness = async (productId, adapterOptions = {}) => {
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

    return {
        success: true,
        productId: product._id.toString(),
        productName: product.name,
        readyForLiveExecution: readinessChecks.every(Boolean),
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

const isFazerCardsProviderCode = (value) => {
    const normalized = String(value || '').trim();
    return normalized.toUpperCase() === PROVIDER_CODES.FAZER_CARDS
        || normalized.toLowerCase() === FAZERCARDS_SLUG;
};

const loadOrderForFazerCardsReconcile = async (orderId) => {
    const order = await Order.findById(orderId)
        .populate({
            path: 'productId',
            select: 'name provider providerProduct providerCode providerExecutionEnabled fulfillmentMode',
            populate: [
                { path: 'provider', select: 'name slug code providerCode isActive baseUrl authType token encryptedCredentials' },
                {
                    path: 'providerProduct',
                    select: 'provider providerCode externalProductId rawName costPrice rawPrice currency category offerId fulfillmentMode isSupported isBlocked requiredFields rawPayload',
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
        providerRawResponse: sanitizePayload(result.rawResponse),
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

const updateOrderFromFazerCardsStatus = async (order, result) => {
    const now = new Date();
    const update = buildProviderResultUpdate(result, order.providerOrderId);

    if (result.manualReview === true) {
        const updated = await Order.findByIdAndUpdate(order._id, {
            $set: {
                status: ORDER_STATUS.MANUAL_REVIEW,
                ...update,
                rejectionReason: result.errorMessage
                    || result.providerErrorMessage
                    || 'FazerCards provider status is unknown and requires manual review.',
            },
        }, { new: true });
        return { order: updated, action: 'manualReview', refunded: false };
    }

    if (result.success === false) {
        await Order.findByIdAndUpdate(order._id, {
            $set: {
                status: ORDER_STATUS.FAILED,
                ...update,
                rejectionReason: result.errorMessage
                    || result.providerErrorMessage
                    || 'FazerCards provider reported the order failed.',
                failedAt: order.failedAt || now,
            },
        });
        const failedOrder = await Order.findById(order._id);
        const refunded = await refundFailedOrder(failedOrder, {
            source: 'fazercards_status_sync',
            reason: 'PROVIDER_FAILED',
            providerRejected: true,
        });
        return { order: await Order.findById(order._id), action: 'failed', refunded };
    }

    const nextStatus = result.providerStatus === 'Completed'
        ? ORDER_STATUS.COMPLETED
        : ORDER_STATUS.PROCESSING;
    const updated = await Order.findByIdAndUpdate(order._id, {
        $set: {
            status: nextStatus,
            ...update,
        },
    }, { new: true });

    return {
        order: updated,
        action: nextStatus === ORDER_STATUS.COMPLETED ? 'completed' : 'processing',
        refunded: updated?.refunded === true,
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

    const product = getOrderProduct(order);
    const providerProduct = getOrderProviderProduct(order);
    const providerDoc = product?.provider || providerProduct?.provider || await findFazerCardsProvider();
    const adapter = new FazerCardsAdapter(providerDoc, adapterOptions);
    const result = await adapter.getTopupOrderStatus({ providerOrderId: order.providerOrderId });
    const applied = await updateOrderFromFazerCardsStatus(order, result);

    return {
        success: applied.action !== 'manualReview',
        action: applied.action,
        statusEndpointConfirmed: result.providerErrorCode !== 'FAZERCARDS_STATUS_ENDPOINT_UNCONFIRMED',
        providerResult: {
            providerOrderId: result.providerOrderId ?? order.providerOrderId,
            providerStatus: result.providerStatus,
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

const getOrderProviderDebug = async (orderId) => {
    const order = await loadOrderForFazerCardsReconcile(orderId);
    assertFazerCardsOrder(order);

    const product = getOrderProduct(order);
    const providerProduct = getOrderProviderProduct(order);
    const identifiers = extractTopupIdentifiers(providerProduct);
    const requiredFields = Array.isArray(providerProduct?.requiredFields) ? providerProduct.requiredFields : [];
    const warnings = [];

    if (!order.providerOrderId) warnings.push('FazerCards order has not been sent to the provider.');
    if (!config.providers.fazerCards.topupOrderStatusPath) {
        warnings.push('FazerCards top-up order status endpoint is not confirmed/configured.');
    }
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

module.exports = {
    FAZERCARDS_SLUG,
    findFazerCardsProvider,
    ensureFazerCardsProvider,
    testConnection,
    getBalance,
    syncCatalogPage,
    listFamilies,
    syncCatalogFamily,
    getCatalogSummary,
    backfillLegacyFamilies,
    listProviderProducts,
    getProviderProductDetails,
    getImportPreview,
    importProviderProduct,
    buildTopupDryRun,
    getProductReadiness,
    syncOrderStatus,
    getOrderProviderDebug,
};
