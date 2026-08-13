'use strict';

const mongoose = require('mongoose');

/**
 * product.service.js  (Layer 3 — Platform Products)
 *
 * Admin-controlled catalogue of products exposed to users.
 * This is the ONLY layer users ever interact with — they never see
 * ProviderProducts or raw provider data.
 *
 * Flow:
 *   User places order
 *     → Platform Product  (Layer 3 — this service)
 *     → ProviderProduct   (Layer 2)
 *     → Provider API      (Layer 1, via adapter)
 *
 * Key responsibilities:
 *   - CRUD for platform products (manual + provider-linked)
 *   - Publish a ProviderProduct as a platform product (admin flow)
 *   - Override name, price, qty, image at publish time
 *   - Compute finalPrice = providerPrice + markup
 *   - If pricingMode=sync: basePrice auto-tracks providerPrice on each sync
 *   - Toggle active / deactivate
 */

const {
    Product,
    PRICING_MODES,
    MARKUP_TYPES,
    EXECUTION_TYPES,
    PRODUCT_STATUSES,
    PROVIDER_EXECUTION_MODES,
    computeFinalPrice,
} = require('./product.model');
const { ProviderProduct } = require('../providers/providerProduct.model');
const { PROVIDER_CODES } = require('../providers/provider.constants');
const fazerCardsContracts = require('../providers/fazercards/fazercardsContracts');
const {
    canonicalizeXenaProductForResponse,
    canonicalizeXenaProductUpdate,
    isXenaProductLike,
} = require('../providers/xena/xenaProductFields');
const { isPositive, add } = require('../../shared/utils/decimalPrecision');
const {
    NotFoundError,
    ConflictError,
    BusinessRuleError,
} = require('../../shared/errors/AppError');

const PROVIDER_PRODUCT_ADMIN_SELECT = 'rawName translatedName externalProductId rawPrice costPrice currency minQty maxQty isActive lastSyncedAt providerCode familyKey fulfillmentMode supportLevel executionBlocked isSupported isBlocked blockReason category categoryName offerId offerName region platform stock requiredFields';

const dynamicFieldsFromOrderFields = (orderFields = []) => (
    (Array.isArray(orderFields) ? orderFields : []).map((field) => ({
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

const assertProviderProductAllowedForCustomerCatalog = (pp) => {
    if (!pp) return;

    const isFazerCards = pp.providerCode === PROVIDER_CODES.FAZER_CARDS
        || pp.provider?.providerCode === PROVIDER_CODES.FAZER_CARDS
        || pp.provider?.slug === 'fazer-cards';

    if (isFazerCards) {
        throw new BusinessRuleError(
            'FazerCards raw catalog products cannot be published or linked in this phase.',
            'FAZERCARDS_PURCHASE_UNSUPPORTED'
        );
    }
    if (pp.isBlocked) {
        throw new BusinessRuleError('Cannot publish or link a blocked provider product.', 'PROVIDER_PRODUCT_BLOCKED');
    }
};

const isFazerCardsProviderCode = (value) => {
    const normalized = String(value || '').trim();
    return normalized.toUpperCase() === PROVIDER_CODES.FAZER_CARDS
        || normalized.toLowerCase() === 'fazer-cards'
        || normalized.toLowerCase() === 'fazercards';
};

const inferFazerCardsFamilyKey = (product = {}, providerProduct = {}) => {
    const explicit = String(product.familyKey || providerProduct.familyKey || providerProduct.rawPayload?.family || '').trim().toUpperCase();
    if (explicit) return explicit;
    const external = String(product.externalProductId || providerProduct.externalProductId || '').trim();
    if (external.startsWith('FAZER_TOPUP:')) return 'TOPUPS';
    if (external.startsWith('FAZER_GIFTCARD:')) return 'GIFTCARDS';
    if (external.startsWith('FAZER_GAMEKEY:')) return 'GAME_KEYS';
    if (external.startsWith('FAZER_TELEGRAM:')) return 'TELEGRAM';
    if (external.startsWith('FAZER_STEAM_TOPUP:')) return 'STEAM_TOPUP';
    if (external.startsWith('FAZER_MANUAL_SERVICE:')) return 'MANUAL_SERVICES';
    if (external.startsWith('FAZER_STEAM_GIFT:')) return 'STEAM_GIFTS';
    return null;
};

const validateFazerCardsProductSettings = ({ product, safe, providerProduct }) => {
    const providerCode = safe.providerCode
        || product.providerCode
        || providerProduct?.providerCode
        || product.provider?.providerCode
        || product.provider?.slug;
    if (!isFazerCardsProviderCode(providerCode)) return safe;

    const familyKey = inferFazerCardsFamilyKey({ ...product.toObject?.(), ...safe }, providerProduct || product.providerProduct);
    const contract = fazerCardsContracts.getContractOrUnknown(familyKey);
    const requestedMode = safe.providerExecutionMode
        || product.providerExecutionMode
        || fazerCardsContracts.getDefaultExecutionMode(familyKey);
    const modeValidation = fazerCardsContracts.validateExecutionModeForFamily(familyKey, requestedMode);
    if (!modeValidation.ok) {
        throw new BusinessRuleError(modeValidation.message, modeValidation.code);
    }

    safe.providerExecutionMode = modeValidation.mode;
    safe.familyKey = safe.familyKey || familyKey;
    safe.fulfillmentMode = safe.fulfillmentMode || providerProduct?.fulfillmentMode || product.fulfillmentMode || contract.fulfillmentMode;

    const enablesAutoExecution = safe.providerExecutionEnabled === true
        || (safe.providerExecutionEnabled === undefined && product.providerExecutionEnabled === true);
    if (enablesAutoExecution && modeValidation.mode !== PROVIDER_EXECUTION_MODES.AUTO_PROVIDER) {
        throw new BusinessRuleError(
            'Auto provider execution is not allowed for this FazerCards family contract.',
            'CONTRACT_AUTO_EXECUTION_NOT_ALLOWED'
        );
    }

    const enablesCustomerPurchase = safe.customerPurchaseEnabled === true
        || (safe.customerPurchaseEnabled === undefined && product.customerPurchaseEnabled === true);
    if (enablesCustomerPurchase && contract.canCustomerPurchase !== true) {
        throw new BusinessRuleError(
            contract.supportStage === fazerCardsContracts.SUPPORT_STAGES.DISABLED_UNAVAILABLE
                ? 'This FazerCards family is currently unavailable.'
                : 'Customer purchase is not allowed for this FazerCards family contract.',
            contract.supportStage === fazerCardsContracts.SUPPORT_STAGES.DISABLED_UNAVAILABLE
                ? 'FAMILY_DISABLED_UNAVAILABLE'
                : 'CUSTOMER_PURCHASE_NOT_ALLOWED'
        );
    }

    if (modeValidation.mode === PROVIDER_EXECUTION_MODES.AUTO_PROVIDER) {
        safe.executionType = safe.providerExecutionEnabled === true
            ? EXECUTION_TYPES.AUTOMATIC
            : (safe.executionType || product.executionType || EXECUTION_TYPES.MANUAL);
    } else {
        safe.executionType = EXECUTION_TYPES.MANUAL;
        if (safe.providerExecutionEnabled === true) {
            throw new BusinessRuleError(
                'Auto provider execution is not allowed for this FazerCards family contract.',
                'CONTRACT_AUTO_EXECUTION_NOT_ALLOWED'
            );
        }
        safe.providerExecutionEnabled = false;
    }

    if (modeValidation.mode === PROVIDER_EXECUTION_MODES.DISABLED && enablesCustomerPurchase) {
        throw new BusinessRuleError('Customer purchase is not allowed for this FazerCards family.', 'CUSTOMER_PURCHASE_NOT_ALLOWED');
    }

    return safe;
};

// =============================================================================
// USER-FACING QUERIES
// =============================================================================

/**
 * listProducts({ activeOnly, page, limit })
 *
 * Public-facing product list. Returns only active products for customers;
 * admins pass activeOnly=false to see everything.
 */
const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const sortForProducts = (sort) => {
    const normalized = String(sort || '').trim().toLowerCase();
    if (normalized === 'newest' || normalized === 'created_desc') return { createdAt: -1, _id: -1 };
    if (normalized === 'oldest' || normalized === 'created_asc') return { createdAt: 1, _id: 1 };
    if (normalized === 'name_desc') return { name: -1 };
    if (normalized === 'price_asc') return { basePrice: 1, name: 1 };
    if (normalized === 'price_desc') return { basePrice: -1, name: 1 };
    return { displayOrder: 1, name: 1 };
};

const listProducts = async ({
    activeOnly = true,
    page = 1,
    limit = 50,
    search,
    category,
    status,
    linkType,
    provider,
    sort,
} = {}) => {
    const filter = { deletedAt: null };
    if (activeOnly) {
        filter.isActive = true;
        filter.visibleInStore = { $ne: false };
        filter.$and = [
            ...(filter.$and || []),
            {
                $or: [
                    { providerCode: { $ne: PROVIDER_CODES.FAZER_CARDS } },
                    {
                        providerCode: PROVIDER_CODES.FAZER_CARDS,
                        customerPurchaseEnabled: true,
                        status: PRODUCT_STATUSES.AVAILABLE,
                    },
                ],
            },
        ];
    }
    if (category) filter.category = String(category).trim();
    if (status) {
        const normalizedStatus = String(status).trim().toLowerCase();
        if (normalizedStatus === 'active') filter.isActive = true;
        else if (normalizedStatus === 'inactive') filter.isActive = false;
        else if (normalizedStatus === 'paused') filter.isPaused = true;
        else filter.status = normalizedStatus;
    }
    if (provider && mongoose.Types.ObjectId.isValid(String(provider))) {
        filter.provider = new mongoose.Types.ObjectId(String(provider));
    }
    if (linkType) {
        const normalizedLinkType = String(linkType).trim().toLowerCase();
        if (['automatic', 'linked', 'provider'].includes(normalizedLinkType)) {
            filter.$and = [
                ...(filter.$and || []),
                {
                    $or: [
                        { executionType: EXECUTION_TYPES.AUTOMATIC },
                        { provider: { $ne: null } },
                        { providerProduct: { $ne: null } },
                    ],
                },
            ];
        } else if (['manual', 'unlinked', 'none'].includes(normalizedLinkType)) {
            filter.executionType = EXECUTION_TYPES.MANUAL;
            filter.provider = null;
            filter.providerProduct = null;
        }
    }
    if (search && String(search).trim()) {
        const term = String(search).trim();
        const regex = new RegExp(escapeRegex(term), 'i');
        const providerProducts = await ProviderProduct.find({
            $or: [{ rawName: regex }, { translatedName: regex }, { externalProductId: regex }],
        }).select('_id').lean();
        const orConditions = [
            { name: regex },
            { description: regex },
            { category: regex },
        ];
        if (/^[a-f\d]{24}$/i.test(term)) orConditions.push({ _id: term });
        if (providerProducts.length) orConditions.push({ providerProduct: { $in: providerProducts.map((product) => product._id) } });
        filter.$and = [
            ...(filter.$and || []),
            { $or: orConditions },
        ];
    }
    const normalizedPage = Math.max(parseInt(page, 10) || 1, 1);
    const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const skip = (normalizedPage - 1) * normalizedLimit;

    const [products, total] = await Promise.all([
        Product.find(filter)
            .sort(sortForProducts(sort))
            .skip(skip)
            .limit(normalizedLimit)
            .populate('provider', 'name slug code providerCode')
            .populate('providerProduct', PROVIDER_PRODUCT_ADMIN_SELECT),
        Product.countDocuments(filter),
    ]);

    return {
        products: products.map((product) => (
            isXenaProductLike(product) ? canonicalizeXenaProductForResponse(product) : product
        )),
        pagination: { page: normalizedPage, limit: normalizedLimit, total, pages: Math.ceil(total / normalizedLimit) },
    };
};

/**
 * getProductById(id)
 * Throws NotFoundError if missing.
 */
const getProductById = async (id) => {
    const product = await Product.findById(id)
        .populate('provider', 'name slug code providerCode baseUrl isActive')
        .populate('providerProduct', PROVIDER_PRODUCT_ADMIN_SELECT);
    if (!product) throw new NotFoundError('Product');
    return isXenaProductLike(product) ? canonicalizeXenaProductForResponse(product) : product;
};

// =============================================================================
// ADMIN — MANUAL PRODUCT CREATION (no provider link)
// =============================================================================

/**
 * createProduct(params, adminUserId)
 *
 * Create a standalone platform product with no provider linkage.
 * Used when admin wants full manual control over all aspects.
 */
const createProduct = async ({
    name,
    description = null,
    basePrice,
    minQty,
    maxQty,
    category = null,
    image = null,
    displayOrder = 0,
    isActive = true,
    visibleInStore = true,
    isPaused = false,
    status = PRODUCT_STATUSES.AVAILABLE,
    customerPurchaseEnabled = true,
    executionType = 'manual',
    providerExecutionMode = PROVIDER_EXECUTION_MODES.MANUAL_FULFILLMENT,
    orderFields = [],
    dynamicFields = [],
    providerMapping = {},
    provider = null,
    providerProduct = null,
    pricingMode = PRICING_MODES.MANUAL,
    markupType = MARKUP_TYPES.PERCENTAGE,
    markupValue = 0,
}, adminUserId = null) => {
    const existing = await Product.findOne({ name: new RegExp(`^${name}$`, 'i') });
    if (existing) throw new ConflictError(`A product named '${name}' already exists.`);

    if (Number(maxQty) < Number(minQty)) {
        throw new BusinessRuleError('maxQty must be >= minQty.', 'INVALID_QTY_RANGE');
    }

    // Products become automatic only after a concrete provider product link exists.
    const hasProviderProductLink = Boolean(provider && providerProduct);
    const resolvedExecutionType = hasProviderProductLink
        ? (executionType === EXECUTION_TYPES.MANUAL ? EXECUTION_TYPES.AUTOMATIC : executionType)
        : EXECUTION_TYPES.MANUAL;

    // ── Pricing calculation ───────────────────────────────────────────────
    let resolvedBasePrice = String(basePrice);
    let resolvedFinalPrice = null;
    let resolvedProviderPrice = null;

    if (providerProduct) {
        // Fetch provider product's raw price for markup calculation
        const pp = await ProviderProduct.findById(providerProduct)
            .select('rawPrice rawPayload providerCode isBlocked isSupported provider')
            .populate('provider', 'slug providerCode');
        if (pp) {
            assertProviderProductAllowedForCustomerCatalog(pp);
            const effectiveRawPrice = String(pp.rawPrice || pp.rawPayload?.product_price || 0);
            resolvedProviderPrice = effectiveRawPrice;

            if (pricingMode === PRICING_MODES.SYNC) {
                resolvedFinalPrice = computeFinalPrice(resolvedProviderPrice, markupType, markupValue);
                resolvedBasePrice = resolvedFinalPrice ?? resolvedProviderPrice;
            } else if (markupValue > 0) {
                // Manual mode with markup: apply one-time markup on top of provider price
                resolvedFinalPrice = computeFinalPrice(resolvedProviderPrice, markupType, markupValue);
                resolvedBasePrice = resolvedFinalPrice ?? resolvedProviderPrice;
            } else {
                // Manual mode, no markup: use admin's basePrice as-is
                resolvedFinalPrice = resolvedBasePrice;
            }
        }
    }

    // Guard: if computed price is 0 but admin supplied a valid basePrice, use it
    if (!isPositive(resolvedBasePrice) && isPositive(basePrice)) {
        resolvedBasePrice = String(basePrice);
        resolvedFinalPrice = resolvedBasePrice;
    }

    return Product.create({
        name,
        description,
        basePrice: resolvedBasePrice,
        providerPrice: resolvedProviderPrice,
        finalPrice: resolvedFinalPrice,
        minQty,
        maxQty,
        category,
        image,
        displayOrder,
        isActive,
        visibleInStore,
        isPaused,
        status,
        customerPurchaseEnabled,
        pricingMode,
        markupType,
        markupValue,
        executionType: resolvedExecutionType,
        providerExecutionMode,
        orderFields,
        dynamicFields,
        providerMapping,
        provider,
        providerProduct,
        createdBy: adminUserId,
    });
};


// =============================================================================
// ADMIN — PUBLISH FROM PROVIDER PRODUCT (3-layer flow)
// =============================================================================

/**
 * publishFromProviderProduct(params, adminUserId)
 *
 * Admin selects a ProviderProduct and publishes it as a public Platform Product.
 *
 * Rules:
 *   - ProviderProduct must exist and its Provider must be active.
 *   - One ProviderProduct → at most one Platform Product (enforced here).
 *   - Admin may override name, qty bounds, image, and all pricing fields.
 *   - markupType + markupValue → finalPrice = providerPrice + markup
 *   - If pricingMode=sync: basePrice is immediately set from providerPrice+markup
 *     and will auto-update on each future sync.
 *   - executionType defaults to 'automatic' (provider-linked products are
 *     usually auto-fulfilled).
 *
 * @returns {Promise<Product>}
 */
const publishFromProviderProduct = async ({
    providerProductId,
    name,
    description = null,
    basePrice = null,            // used when pricingMode=manual and no markup
    minQty = null,
    maxQty = null,
    category = null,
    image = null,
    displayOrder = 0,
    isActive = true,
    visibleInStore = true,
    isPaused = false,
    status = PRODUCT_STATUSES.AVAILABLE,
    customerPurchaseEnabled = true,
    pricingMode = PRICING_MODES.MANUAL,
    markupType = MARKUP_TYPES.PERCENTAGE,
    markupValue = 0,
    executionType = 'automatic',
    providerExecutionEnabled = true,
    providerExecutionMode = PROVIDER_EXECUTION_MODES.MANUAL_FULFILLMENT,
    providerExecutionBlocked = false,
    providerBlockReason = null,
    createdBy = null,            // accepted here for the createProductFromProvider alias
}, adminUserId = null) => {
    // Resolve createdBy from either param location
    const resolvedCreatedBy = createdBy ?? adminUserId;

    // ── Validate ProviderProduct ───────────────────────────────────────────────
    const pp = await ProviderProduct.findById(providerProductId).populate('provider');
    if (!pp) throw new NotFoundError('ProviderProduct');
    if (!pp.provider.isActive) {
        throw new BusinessRuleError(
            'The provider for this product is currently inactive.',
            'PROVIDER_INACTIVE'
        );
    }
    if (!pp.isActive) {
        throw new BusinessRuleError(
            'Cannot publish an inactive provider product.',
            'PROVIDER_PRODUCT_INACTIVE'
        );
    }
    assertProviderProductAllowedForCustomerCatalog(pp);

    // ── Prevent duplicate publish ─────────────────────────────────────────────
    const alreadyPublished = await Product.findOne({ providerProduct: providerProductId });
    if (alreadyPublished) {
        throw new ConflictError(
            `ProviderProduct '${pp.rawName}' has already been published as '${alreadyPublished.name}'.`
        );
    }

    // ── Compute pricing ───────────────────────────────────────────────────────
    // Fallback: if rawPrice is 0 but rawPayload has the real price, use that
    const effectiveRawPrice = String(pp.rawPrice || pp.rawPayload?.product_price || 0);
    const providerPrice = effectiveRawPrice;

    let resolvedFinalPrice;
    let resolvedBasePrice;

    if (pricingMode === PRICING_MODES.SYNC) {
        // Compute from providerPrice + markup; basePrice tracks it forever
        resolvedFinalPrice = computeFinalPrice(providerPrice, markupType, markupValue);
        resolvedBasePrice = resolvedFinalPrice ?? providerPrice;
    } else {
        // Manual — admin either supplies basePrice directly OR markup is applied one-time
        if (markupValue > 0) {
            resolvedFinalPrice = computeFinalPrice(providerPrice, markupType, markupValue);
            resolvedBasePrice = resolvedFinalPrice ?? providerPrice;
        } else if (basePrice != null) {
            resolvedBasePrice = String(basePrice);
            resolvedFinalPrice = resolvedBasePrice;
        } else {
            resolvedBasePrice = providerPrice;
            resolvedFinalPrice = providerPrice;
        }
    }

    // Guard: if computed price is 0 but admin supplied a valid basePrice, use it
    if (!isPositive(resolvedBasePrice) && basePrice != null && isPositive(basePrice)) {
        resolvedBasePrice = String(basePrice);
        resolvedFinalPrice = resolvedBasePrice;
    }

    return Product.create({
        name,
        description,
        basePrice: resolvedBasePrice,
        providerPrice,
        finalPrice: resolvedFinalPrice,
        minQty: minQty ?? pp.minQty,
        maxQty: maxQty ?? pp.maxQty,
        category,
        image,
        displayOrder,
        isActive,
        visibleInStore,
        isPaused,
        status,
        customerPurchaseEnabled,
        pricingMode,
        markupType,
        markupValue,
        executionType,
        providerExecutionEnabled,
        providerExecutionMode,
        providerExecutionBlocked,
        providerBlockReason,
        provider: pp.provider._id,
        providerProduct: pp._id,
        createdBy: resolvedCreatedBy,
    });
};

// =============================================================================
// ADMIN — UPDATE PUBLISHED PRODUCT
// =============================================================================

/**
 * updateProduct(productId, updates, adminUserId?)
 *
 * Admin modifies a published product.
 *
 * Safe fields (all optional):
     *   name, description, image, category, displayOrder, isActive,
     *   visibleInStore, isPaused, status,
 *   basePrice, minQty, maxQty, pricingMode, markupType, markupValue, executionType
 *
 * Pricing rules on update:
 *   - If pricingMode changes to 'sync' AND providerProduct is linked:
 *       recompute basePrice from current providerPrice + markup immediately.
 *   - If markupType or markupValue changes while in 'sync' pricingMode:
 *       recompute basePrice immediately.
 *   - In 'manual' pricingMode: basePrice is whatever admin sets.
 *
 * @returns {Promise<Product>}
 */
const updateProduct = async (productId, updates) => {
    const product = await Product.findById(productId)
        .populate('provider', 'name slug code')
        .populate('providerProduct', 'rawPrice rawPayload externalProductId provider providerCode familyKey fulfillmentMode');
    if (!product) throw new NotFoundError('Product');

    const ALLOWED = [
        'name', 'description', 'image', 'category', 'displayOrder', 'isActive',
        'visibleInStore', 'isPaused', 'status', 'customerPurchaseEnabled',
        'basePrice', 'minQty', 'maxQty', 'pricingMode', 'markupType', 'markupValue',
        'executionType', 'providerExecutionEnabled', 'providerExecutionMode',
        'providerExecutionBlocked', 'providerBlockReason',
        'orderFields', 'dynamicFields', 'providerMapping',
        'provider', 'providerProduct',
        'syncPriceWithProvider', 'enableManualPrice', 'manualPriceAdjustment', 'finalPrice',
    ];
    let safe = Object.fromEntries(
        Object.entries(updates).filter(([k]) => ALLOWED.includes(k))
    );

    // ── Determine effective pricing fields ────────────────────────────────
    const requestedPricingMode = safe.pricingMode ?? (
        safe.syncPriceWithProvider === undefined
            ? undefined
            : safe.syncPriceWithProvider ? PRICING_MODES.SYNC : PRICING_MODES.MANUAL
    );
    const effectivePricingMode = requestedPricingMode ?? product.pricingMode;
    const effectiveMarkupType = safe.markupType ?? product.markupType;
    const effectiveMarkupValue = safe.markupValue ?? product.markupValue;

    const pricingModeChanged = requestedPricingMode != null && requestedPricingMode !== product.pricingMode;
    const markupChanged = safe.markupType != null || safe.markupValue != null;
    const basePriceChanged = safe.basePrice != null;
    const hasProviderLink = product.providerProduct != null;

    // ── Fix 5 — Safety net: provider link changed ─────────────────────────
    //
    // When the admin changes the providerProduct reference (switches to a
    // different provider service), the frontend's price payload may be stale
    // or corrupted by the state mutation bug.  We treat the DB as the single
    // source of truth: fetch the NEW ProviderProduct and forcefully override
    // all pricing fields with its canonical rawPrice.
    //
    const incomingProviderProduct = safe.providerProduct ?? undefined;
    const currentProviderProductId = product.providerProduct?._id?.toString()
        ?? product.providerProduct?.toString()
        ?? null;
    const providerLinkChanged = incomingProviderProduct != null
        && String(incomingProviderProduct) !== currentProviderProductId;

    let providerLinkTargetProduct = null;

    if (providerLinkChanged) {
        const newPP = await ProviderProduct.findById(incomingProviderProduct)
            .select('rawPrice rawPayload externalProductId provider providerCode isBlocked isSupported familyKey fulfillmentMode')
            .populate('provider', 'slug providerCode');
        if (newPP) {
            assertProviderProductAllowedForCustomerCatalog(newPP);
            providerLinkTargetProduct = newPP;
            const canonicalRawPrice = String(
                newPP.rawPrice || newPP.rawPayload?.product_price || 0
            );
            safe.providerPrice = canonicalRawPrice;

            if (effectivePricingMode === PRICING_MODES.SYNC || safe.syncPriceWithProvider === true) {
                const newFinalPrice = computeFinalPrice(
                    canonicalRawPrice, effectiveMarkupType, effectiveMarkupValue
                );
                safe.finalPrice = newFinalPrice ?? canonicalRawPrice;
                safe.basePrice = safe.finalPrice;
            } else if (basePriceChanged) {
                safe.basePrice = String(safe.basePrice);
                safe.finalPrice = safe.basePrice;
            } else if (safe.finalPrice === undefined) {
                safe.finalPrice = product.finalPrice ?? product.basePrice;
            }

            // Update provider reference to match the new ProviderProduct's provider
            if (newPP.provider) {
                safe.provider = newPP.provider;
            }
        }
    }

    // ── Recompute pricing ────────────────────────────────────────────────
    // Skip recomputation if we already handled this in the safety-net above.
    if (!providerLinkChanged && effectivePricingMode === PRICING_MODES.SYNC && hasProviderLink) {
        // SYNC mode: always compute from providerPrice + markup
        if (pricingModeChanged || markupChanged || basePriceChanged || safe.finalPrice != null || safe.syncPriceWithProvider === true) {
            const pp = product.providerProduct;
            const effectiveRawPrice = String(pp.rawPrice || pp.rawPayload?.product_price || 0);
            const rawPrice = effectiveRawPrice;
            const newFinalPrice = computeFinalPrice(rawPrice, effectiveMarkupType, effectiveMarkupValue);
            safe.providerPrice = rawPrice;
            safe.finalPrice = newFinalPrice;
            safe.basePrice = newFinalPrice ?? rawPrice;
        }
    } else if (!providerLinkChanged && effectivePricingMode === PRICING_MODES.MANUAL) {
        // MANUAL mode: admin controls basePrice
        if (basePriceChanged && !markupChanged) {
            // Admin directly set a basePrice — use it as-is
            safe.basePrice = String(safe.basePrice);
            safe.finalPrice = safe.basePrice;
            safe.enableManualPrice = safe.enableManualPrice ?? false;
        } else if (markupChanged && hasProviderLink) {
            // Admin changed markup while in manual mode — apply one-time markup
            const pp = product.providerProduct;
            const effectiveRawPrice = String(pp.rawPrice || pp.rawPayload?.product_price || 0);
            const rawPrice = effectiveRawPrice;
            const newFinalPrice = computeFinalPrice(rawPrice, effectiveMarkupType, effectiveMarkupValue);
            safe.providerPrice = rawPrice;
            safe.finalPrice = newFinalPrice;
            safe.basePrice = newFinalPrice ?? rawPrice;
        } else if (basePriceChanged && markupChanged && hasProviderLink) {
            // Both changed — markup takes precedence over basePrice
            const pp = product.providerProduct;
            const effectiveRawPrice = String(pp.rawPrice || pp.rawPayload?.product_price || 0);
            const rawPrice = effectiveRawPrice;
            const newFinalPrice = computeFinalPrice(rawPrice, effectiveMarkupType, effectiveMarkupValue);
            safe.providerPrice = rawPrice;
            safe.finalPrice = newFinalPrice;
            safe.basePrice = newFinalPrice ?? rawPrice;
        }
    }

    // ── Manual price adjustment recalculation ─────────────────────────────
    // When enableManualPrice is on and a provider link exists, enforce:
    //   finalPrice = providerPrice + manualPriceAdjustment
    const effectiveEnableManual = safe.enableManualPrice ?? product.enableManualPrice;
    const effectiveManualAdj = safe.manualPriceAdjustment ?? product.manualPriceAdjustment ?? 0;

    if (!providerLinkChanged && effectiveEnableManual && hasProviderLink && !basePriceChanged) {
        const pp = product.providerProduct;
        const effectiveRawPrice = String(pp.rawPrice || pp.rawPayload?.product_price || 0);
        const rawPrice = effectiveRawPrice;
        const computedFinal = add(rawPrice, String(effectiveManualAdj));
        safe.providerPrice = rawPrice;
        safe.finalPrice = computedFinal;
        safe.basePrice = computedFinal;
    }

    // Keep syncPriceWithProvider in sync with pricingMode
    if (safe.syncPriceWithProvider !== undefined && safe.pricingMode === undefined) {
        safe.pricingMode = safe.syncPriceWithProvider ? PRICING_MODES.SYNC : PRICING_MODES.MANUAL;
    }
    if (safe.pricingMode !== undefined && safe.syncPriceWithProvider === undefined) {
        safe.syncPriceWithProvider = safe.pricingMode === PRICING_MODES.SYNC;
    }

    if (Array.isArray(safe.orderFields)) {
        safe.dynamicFields = dynamicFieldsFromOrderFields(safe.orderFields);
    }

    const nextProviderProduct = safe.providerProduct !== undefined
        ? safe.providerProduct
        : product.providerProduct;
    if (safe.executionType === EXECUTION_TYPES.AUTOMATIC && !nextProviderProduct) {
        safe.executionType = EXECUTION_TYPES.MANUAL;
    }

    const effectiveProviderProduct = providerLinkTargetProduct || product.providerProduct;
    safe = validateFazerCardsProductSettings({
        product,
        safe,
        providerProduct: effectiveProviderProduct,
    });

    safe = canonicalizeXenaProductUpdate(safe, {
        ...product.toObject(),
        provider: product.provider,
        providerProduct: providerLinkTargetProduct || product.providerProduct,
    });

    product.set(safe);
    await product.validate();

    const updateSet = {};
    for (const key of Object.keys(safe)) {
        updateSet[key] = product.get(key);
    }

    await Product.updateOne(
        { _id: product._id },
        { $set: updateSet },
        { runValidators: true }
    );

    const updatedProduct = await Product.findById(product._id)
        .populate('provider', 'name slug code providerCode')
        .populate('providerProduct', PROVIDER_PRODUCT_ADMIN_SELECT);
    return isXenaProductLike(updatedProduct)
        ? canonicalizeXenaProductForResponse(updatedProduct)
        : updatedProduct;
};

// =============================================================================
// ADMIN — TOGGLE STATUS
// =============================================================================

const syncProductPriceFromProvider = async (productId) => {
    const product = await Product.findById(productId).populate({
        path: 'providerProduct',
        select: 'rawPrice rawPayload provider isActive',
        populate: { path: 'provider', select: 'name slug isActive' },
    });
    if (!product) throw new NotFoundError('Product');
    if (!product.providerProduct) {
        throw new BusinessRuleError(
            'Product is not linked to a provider product.',
            'PRODUCT_NOT_PROVIDER_LINKED'
        );
    }

    const providerProduct = product.providerProduct;
    if (providerProduct.isActive === false) {
        throw new BusinessRuleError(
            'The linked provider product is inactive.',
            'PROVIDER_PRODUCT_INACTIVE'
        );
    }
    assertProviderProductAllowedForCustomerCatalog(providerProduct);
    if (providerProduct.provider?.isActive === false) {
        throw new BusinessRuleError('The linked provider is inactive.', 'PROVIDER_INACTIVE');
    }

    const rawPrice = String(providerProduct.rawPrice || providerProduct.rawPayload?.product_price || 0);
    const finalPrice = product.enableManualPrice
        ? add(rawPrice, String(product.manualPriceAdjustment ?? 0))
        : computeFinalPrice(rawPrice, product.markupType, product.markupValue);

    product.providerPrice = rawPrice;
    product.finalPrice = finalPrice ?? rawPrice;
    product.basePrice = product.finalPrice;
    product.pricingMode = PRICING_MODES.SYNC;
    product.syncPriceWithProvider = true;
    if (providerProduct.provider?._id) {
        product.provider = providerProduct.provider._id;
    }

    await product.save();
    return product.populate([
        { path: 'provider', select: 'name slug code providerCode' },
        { path: 'providerProduct', select: PROVIDER_PRODUCT_ADMIN_SELECT },
    ]);
};

const unlinkProductProvider = async (productId) => {
    const product = await Product.findById(productId);
    if (!product) throw new NotFoundError('Product');

    product.provider = null;
    product.providerProduct = null;
    product.providerPrice = null;
    product.pricingMode = PRICING_MODES.MANUAL;
    product.syncPriceWithProvider = false;
    product.executionType = EXECUTION_TYPES.MANUAL;
    product.finalPrice = product.basePrice;

    await product.save();
    return product.populate([
        { path: 'provider', select: 'name slug code providerCode' },
        { path: 'providerProduct', select: PROVIDER_PRODUCT_ADMIN_SELECT },
    ]);
};

const toggleProductStatus = async (productId) => {
    const product = await Product.findById(productId);
    if (!product) throw new NotFoundError('Product');
    product.isActive = !product.isActive;
    await product.save();
    return product;
};

// =============================================================================
// ADMIN — SOFT DELETE
// =============================================================================

/**
 * deleteProduct(productId)
 *
 * Soft-delete a product by setting deletedAt + isActive = false.
 * The product is excluded from all future list queries.
 * Throws NotFoundError if missing, BusinessRuleError if already deleted.
 */
const deleteProduct = async (productId) => {
    const product = await Product.findById(productId);
    if (!product) throw new NotFoundError('Product');
    if (product.deletedAt) throw new BusinessRuleError('Product is already deleted.', 'ALREADY_DELETED');

    product.deletedAt = new Date();
    product.isActive = false;
    await product.save();
    return product;
};

// =============================================================================
// INTERNAL — ORDER FULFILLMENT HELPER
// =============================================================================

/**
 * getExternalProductId(productId)
 *
 * Resolves the externalProductId for a Platform Product.
 * Used by the fulfillment engine to know what ID to send to the provider.
 *
 * Chain: Order.productId → Product.providerProduct → ProviderProduct.externalProductId
 *
 * @param {string|ObjectId} productId — Platform Product _id
 * @returns {Promise<string|null>} externalProductId, or null if not provider-linked
 */
const getExternalProductId = async (productId) => {
    const product = await Product.findById(productId)
        .select('providerProduct')
        .populate('providerProduct', 'externalProductId');
    return product?.providerProduct?.externalProductId ?? null;
};

module.exports = {
    listProducts,
    getProductById,
    createProduct,
    publishFromProviderProduct,
    updateProduct,
    syncProductPriceFromProvider,
    unlinkProductProvider,
    toggleProductStatus,
    deleteProduct,
    getExternalProductId,

    // Canonical alias names used by admin catalog API
    createProductFromProvider: publishFromProviderProduct,  // prompt-specified name
    toggleProduct: toggleProductStatus,                     // prompt-specified name
};

