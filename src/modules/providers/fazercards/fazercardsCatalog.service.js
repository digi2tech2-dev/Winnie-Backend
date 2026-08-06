'use strict';

const config = require('../../../config/config');
const { Provider } = require('../provider.model');
const { ProviderProduct } = require('../providerProduct.model');
const { PROVIDER_CODES } = require('../provider.constants');
const { BusinessRuleError, NotFoundError } = require('../../../shared/errors/AppError');
const { FazerCardsAdapter } = require('./fazercards.adapter');

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

const parseBooleanFilter = (value) => {
    if (value === undefined || value === null || value === '') return undefined;
    return ['true', '1', 'yes'].includes(String(value).trim().toLowerCase());
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
    fulfillmentMode,
} = {}) => {
    const query = { providerCode: PROVIDER_CODES.FAZER_CARDS };
    if (category) query.category = String(category).trim();
    if (region) query.region = String(region).trim();
    if (fulfillmentMode) query.fulfillmentMode = String(fulfillmentMode).trim().toUpperCase();

    const availableFilter = parseBooleanFilter(available);
    if (availableFilter !== undefined) query.available = availableFilter;
    const supportedFilter = parseBooleanFilter(supported);
    if (supportedFilter !== undefined) query.isSupported = supportedFilter;
    const blockedFilter = parseBooleanFilter(blocked);
    if (blockedFilter !== undefined) query.isBlocked = blockedFilter;

    if (search) {
        const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'i');
        query.$or = [
            { rawName: regex },
            { translatedName: regex },
            { externalProductId: regex },
            { category: regex },
            { categoryName: regex },
            { offerId: regex },
            { offerName: regex },
            { subCategory: regex },
            { region: regex },
        ];
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

    return {
        products,
        pagination: {
            page: normalizedPage,
            limit: normalizedLimit,
            total,
            pages: Math.ceil(total / normalizedLimit),
        },
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

module.exports = {
    FAZERCARDS_SLUG,
    findFazerCardsProvider,
    ensureFazerCardsProvider,
    testConnection,
    getBalance,
    syncCatalogPage,
    listProviderProducts,
    getProviderProductDetails,
};
