'use strict';

const mongoose = require('mongoose');
const { Product, PROVIDER_EXECUTION_MODES } = require('../products/product.model');
const { Provider } = require('../providers/provider.model');
const { ProviderProduct, FULFILLMENT_MODES } = require('../providers/providerProduct.model');
const { ProviderDeliveredCode, DELIVERY_STATUSES } = require('../providers/fazercards/providerDeliveredCode.model');
const { PROVIDER_CODES } = require('../providers/provider.constants');
const { Order, ORDER_STATUS, ORDER_EXECUTION_TYPES } = require('./order.model');
const { CheckoutQuote, CHECKOUT_QUOTE_STATUS } = require('./checkoutQuote.model');
const { Review } = require('../reviews/review.model');
const { getNextSequence } = require('./counter.model');
const { debitWalletAtomic, refundWalletAtomic } = require('../wallet/wallet.service');
const {
    WalletTransaction,
    LEDGER_TRANSACTION_TYPES,
    TRANSACTION_SOURCE_TYPES,
} = require('../wallet/walletTransaction.model');
const { calculateUserPrice, getProductFinalUnitPrice, getProviderCostUnitPrice } = require('./pricing.service');
const { getProviderAdapter } = require('../providers/adapters/adapter.factory');
const { validateOrderFields } = require('./orderFields.validator');
const {
    NotFoundError,
    BusinessRuleError,
} = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const {
    ORDER_ACTIONS,
    WALLET_ACTIONS,
    PROVIDER_ACTIONS,
    ENTITY_TYPES,
    ACTOR_ROLES,
} = require('../audit/audit.constants');
const { RATE_PURPOSES, convertUsdToUserCurrency } = require('../../services/currencyConverter.service');
const { User } = require('../users/user.model');
const { assertIdentityVerificationNotRequired } = require('../users/identityVerification.guard');
const {
    notifyOrderCompleted,
    notifyOrderCreated,
    notifyOrderFailed,
    notifyOrderRefunded,
} = require('../notifications/notification.events');
const { getLivePrice } = require('../providers/providerPriceCache');
const { applyLiveProviderPrice } = require('../providers/providerProductSync.service');
const { toDecimal, toStr, toFiat, multiply, subtract, add, isPositive, compare } = require('../../shared/utils/decimalPrecision');
const config = require('../../config/config');
const fazerCardsContracts = require('../providers/fazercards/fazercardsContracts');
const {
    evaluateFazerCardsReadiness,
    READINESS_OPERATIONS,
} = require('../providers/fazercards/fazercardsReadiness.service');

const XENA_EXTERNAL_PRODUCT_ID = 'xena-dynamic-recharge';
const CHECKOUT_QUOTE_TTL_MS = 10 * 60 * 1000;
const serializeDecimal = (value) => toStr(toDecimal(value));
const XENA_TARGET_FIELD_KEY = 'target_uid';
const XENA_LEGACY_TARGET_FIELD_KEY = 'account_id';
const FAZER_CARDS_CODE_DELIVERY_FAMILIES = new Set(['GIFTCARDS', 'GAME_KEYS']);
const DEFAULT_CHECKOUT_PROVIDER_PRICE_GUARD_TIMEOUT_MS = 5_000;
const MAX_CHECKOUT_COMMIT_ATTEMPTS = 3;

const _hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

const _isXenaLinkedProduct = async (product, session) => {
    if (!product?.providerProduct) return false;

    const providerProduct = await ProviderProduct.findById(product.providerProduct)
        .select('externalProductId')
        .session(session)
        .lean();

    return String(providerProduct?.externalProductId || '').trim() === XENA_EXTERNAL_PRODUCT_ID;
};

const _canonicalizeXenaOrderFields = async ({ product, orderFieldsValues, session }) => {
    const submitted = orderFieldsValues && typeof orderFieldsValues === 'object'
        ? { ...orderFieldsValues }
        : orderFieldsValues;
    const fields = Array.isArray(product?.orderFields) ? product.orderFields : [];
    const hasRelevantField = fields.some((field) =>
        field?.key === XENA_TARGET_FIELD_KEY || field?.key === XENA_LEGACY_TARGET_FIELD_KEY
    );
    const hasRelevantValue = submitted && typeof submitted === 'object' && (
        _hasOwn(submitted, XENA_TARGET_FIELD_KEY) || _hasOwn(submitted, XENA_LEGACY_TARGET_FIELD_KEY)
    );

    if ((!hasRelevantField && !hasRelevantValue) || !(await _isXenaLinkedProduct(product, session))) {
        return { orderFields: fields, orderFieldsValues };
    }

    const hasTargetField = fields.some((field) => field?.key === XENA_TARGET_FIELD_KEY);
    const canonicalFields = fields
        .filter((field) => !(hasTargetField && field?.key === XENA_LEGACY_TARGET_FIELD_KEY))
        .map((field) => {
            if (field?.key !== XENA_LEGACY_TARGET_FIELD_KEY) return field;
            const plain = field.toObject ? field.toObject() : { ...field };
            return {
                ...plain,
                id: plain.id || XENA_TARGET_FIELD_KEY,
                key: XENA_TARGET_FIELD_KEY,
                label: plain.label || 'Xena ID',
                type: plain.type || 'text',
                required: plain.required !== false,
                isActive: plain.isActive !== false,
            };
        });

    if (!submitted || typeof submitted !== 'object') {
        return { orderFields: canonicalFields, orderFieldsValues: submitted };
    }

    if (!_hasOwn(submitted, XENA_TARGET_FIELD_KEY) && _hasOwn(submitted, XENA_LEGACY_TARGET_FIELD_KEY)) {
        submitted[XENA_TARGET_FIELD_KEY] = submitted[XENA_LEGACY_TARGET_FIELD_KEY];
    }
    delete submitted[XENA_LEGACY_TARGET_FIELD_KEY];

    return { orderFields: canonicalFields, orderFieldsValues: submitted };
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// PRE-DEBIT PROVIDER PRICE GUARD
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const _assertProductAvailable = (product) => {
    if (!product) throw new NotFoundError('Product');
    if (
        !product.isActive
        || product.visibleInStore === false
        || product.isPaused === true
        || product.status === 'unavailable'
        || product.isAvailableForApi === false
    ) {
        throw new BusinessRuleError('This product is currently unavailable.', 'PRODUCT_INACTIVE');
    }

    if (product.customerPurchaseEnabled === false) {
        throw new BusinessRuleError('This product is currently unavailable.', 'PRODUCT_INACTIVE');
    }

    if (String(product.providerCode || '').trim().toUpperCase() === PROVIDER_CODES.FAZER_CARDS) {
        if (config.providers.fazerCards.customerPurchaseEnabled === false) {
            throw new BusinessRuleError(
                'FazerCards customer purchases are currently disabled.',
                'FAZERCARDS_CUSTOMER_PURCHASE_DISABLED'
            );
        }

        const familyKey = String(product.familyKey || '').trim().toUpperCase();
        const contract = fazerCardsContracts.getContractOrUnknown(familyKey);
        if (contract.canCustomerPurchase !== true) {
            throw new BusinessRuleError(
                contract.supportStage === fazerCardsContracts.SUPPORT_STAGES.DISABLED_UNAVAILABLE
                    ? 'This FazerCards family is currently unavailable.'
                    : 'This product is currently unavailable.',
                contract.supportStage === fazerCardsContracts.SUPPORT_STAGES.DISABLED_UNAVAILABLE
                    ? 'FAMILY_DISABLED_UNAVAILABLE'
                    : 'CUSTOMER_PURCHASE_NOT_ALLOWED'
            );
        }
        const manualFieldValidation = fazerCardsContracts.validateManualCustomerFieldsForProduct({ product });
        if (!manualFieldValidation.ok) {
            throw new BusinessRuleError(
                'This product is not configured for purchase. Manual fulfillment requires customer fields.',
                manualFieldValidation.code || 'MANUAL_PRODUCT_REQUIRES_CUSTOMER_FIELDS'
            );
        }
    }
};

// A cold provider price cache may require a full supplier-catalog fetch. That
// read protects pricing, but it is not part of the financial commit and must
// never hold a MongoDB transaction open. Bound it as well: a slow supplier is
// allowed to fall back to the last durable catalog price, not to hold checkout
// until the reverse proxy times out.
const _checkoutProviderPriceGuardTimeoutMs = () => {
    const configured = Number(process.env.CHECKOUT_PROVIDER_PRICE_GUARD_TIMEOUT_MS);
    if (!Number.isFinite(configured) || configured <= 0) {
        return DEFAULT_CHECKOUT_PROVIDER_PRICE_GUARD_TIMEOUT_MS;
    }
    return Math.min(Math.max(Math.trunc(configured), 100), 15_000);
};

const _getLivePriceWithinCheckoutDeadline = async (providerId, externalProductId, provider, options = {}) => {
    const timeoutMs = _checkoutProviderPriceGuardTimeoutMs();
    let timeoutId;
    const deadline = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            const error = new Error('Provider price verification exceeded the checkout deadline');
            error.code = 'CHECKOUT_PROVIDER_PRICE_GUARD_TIMEOUT';
            reject(error);
        }, timeoutMs);
    });

    try {
        return await Promise.race([
            getLivePrice(providerId, externalProductId, provider, options),
            deadline,
        ]);
    } finally {
        clearTimeout(timeoutId);
    }
};

const verifyProviderPriceBeforeCheckout = async ({ product, provider }) => {
    if (isFazerCardsProduct(product) || !product?.provider || !product?.providerProduct || !provider) return;

    try {
        const ppDoc = await ProviderProduct.findById(product.providerProduct)
            .select('externalProductId')
            .lean();
        if (!ppDoc?.externalProductId) return;

        const observedPrice = await _getLivePriceWithinCheckoutDeadline(
            String(product.provider),
            ppDoc.externalProductId,
            provider
        );
        const storedCostIncreased = observedPrice !== null && product.providerPrice != null
            && compare(String(observedPrice), String(product.providerPrice)) > 0;
        const publishedPriceIsBelowCost = observedPrice !== null
            && compare(String(observedPrice), String(getProductFinalUnitPrice(product))) > 0;

        if (!storedCostIncreased && !publishedPriceIsBelowCost) return;

        let livePrice;
        try {
            livePrice = await _getLivePriceWithinCheckoutDeadline(
                String(product.provider),
                ppDoc.externalProductId,
                provider,
                { forceRefresh: true }
            );
        } catch (_) {
            throw new BusinessRuleError(
                'The supplier price changed recently but could not be confirmed. Please try again shortly.',
                'PROVIDER_PRICE_CONFIRMATION_UNAVAILABLE'
            );
        }

        const confirmedCostIncrease = livePrice !== null && product.providerPrice != null
            && compare(String(livePrice), String(product.providerPrice)) > 0;
        const confirmedPublishedPriceBelowCost = livePrice !== null
            && compare(String(livePrice), String(getProductFinalUnitPrice(product))) > 0;
        if (!confirmedCostIncrease && !confirmedPublishedPriceBelowCost) return;

        const refreshed = await applyLiveProviderPrice({
            providerProductId: product.providerProduct,
            rawPrice: livePrice,
        });
        if (!refreshed.applied) {
            throw new BusinessRuleError(
                'The supplier price changed while the catalog was being refreshed. Please try again shortly.',
                'PROVIDER_PRICE_REFRESH_CONFLICT'
            );
        }

        throw new BusinessRuleError(
            'The provider has increased the price for this service. ' +
            'The catalog has been automatically updated. ' +
            'Please refresh and review the new price before ordering.',
            'PROVIDER_PRICE_INCREASED'
        );
    } catch (jitErr) {
        if ([
            'PROVIDER_PRICE_INCREASED',
            'PROVIDER_PRICE_CONFIRMATION_UNAVAILABLE',
            'PROVIDER_PRICE_REFRESH_CONFLICT',
        ].includes(jitErr.code)) throw jitErr;
        // An unavailable or slow price read falls back to the durable catalog
        // price. The supplier request continues outside the checkout
        // transaction and can never turn into a financial partial write.
    }
};

const _hasTransactionErrorLabel = (error, label) => (
    Array.isArray(error?.errorLabels) && error.errorLabels.includes(label)
);

const _isRetryableCheckoutTransactionError = (error) => (
    [24, 112, 251].includes(error?.code)
    || _hasTransactionErrorLabel(error, 'TransientTransactionError')
);

const _abortCheckoutTransactionQuietly = async (session) => {
    if (!session?.inTransaction()) return;
    try {
        await session.abortTransaction();
    } catch (_) {
        // MongoDB may already have aborted an expired transaction. Preserve
        // the original operation error so retry classification stays correct.
    }
};

const _commitCheckoutTransaction = async (session) => {
    let lastError;
    for (let attempt = 0; attempt < MAX_CHECKOUT_COMMIT_ATTEMPTS; attempt++) {
        try {
            await session.commitTransaction();
            return;
        } catch (error) {
            lastError = error;
            if (!_hasTransactionErrorLabel(error, 'UnknownTransactionCommitResult')) throw error;
        }
    }
    throw lastError;
};

const getFazerCardsExecutionMode = (product = {}) => {
    if (String(product.providerCode || '').trim().toUpperCase() !== PROVIDER_CODES.FAZER_CARDS) {
        return null;
    }
    const familyKey = String(product.familyKey || '').trim().toUpperCase();
    const mode = product.providerExecutionMode || fazerCardsContracts.getDefaultExecutionMode(familyKey);
    const validation = fazerCardsContracts.validateExecutionModeForFamily(familyKey, mode);
    if (!validation.ok) {
        throw new BusinessRuleError(validation.message, validation.code);
    }
    if (validation.mode === PROVIDER_EXECUTION_MODES.DISABLED) {
        throw new BusinessRuleError('This FazerCards family is currently unavailable.', 'FAMILY_DISABLED_UNAVAILABLE');
    }
    return {
        mode: validation.mode,
        familyKey,
        isManualFulfillment: validation.mode === PROVIDER_EXECUTION_MODES.MANUAL_FULFILLMENT,
        isAutoProvider: validation.mode === PROVIDER_EXECUTION_MODES.AUTO_PROVIDER,
    };
};

const assertFazerCardsManualCustomerInput = (product, fazerCardsMode, customerInput) => {
    if (fazerCardsMode?.isManualFulfillment !== true) return;
    const manualFieldValidation = fazerCardsContracts.validateManualCustomerFieldsForProduct({ product });
    if (!manualFieldValidation.ok) {
        throw new BusinessRuleError(
            'This product is not configured for purchase. Manual fulfillment requires customer fields.',
            manualFieldValidation.code || 'MANUAL_PRODUCT_REQUIRES_CUSTOMER_FIELDS'
        );
    }
    if (manualFieldValidation.required !== true) return;

    const submittedValues = customerInput?.values && typeof customerInput.values === 'object'
        ? customerInput.values
        : {};
    const missing = (manualFieldValidation.requiredFields || [])
        .filter((field) => field.isActive !== false && field.required !== false)
        .map((field) => field.key)
        .filter(Boolean)
        .filter((key) => submittedValues[key] === undefined || submittedValues[key] === null || submittedValues[key] === '');

    if (missing.length) {
        throw new BusinessRuleError(
            `Required customer field(s) missing for manual fulfillment: ${missing.join(', ')}.`,
            'INVALID_ORDER_FIELDS'
        );
    }
};

const normalizeUpper = (value) => String(value || '').trim().toUpperCase();

const isFazerCardsProduct = (product = {}) =>
    normalizeUpper(product.providerCode) === PROVIDER_CODES.FAZER_CARDS;

const isCodeDeliveryOrderLike = (order = {}, product = {}) => {
    const familyKey = normalizeUpper(order.familyKey || product.familyKey);
    const fulfillmentMode = normalizeUpper(order.fulfillmentMode || product.fulfillmentMode);
    return fulfillmentMode === FULFILLMENT_MODES.CODE_DELIVERY
        || FAZER_CARDS_CODE_DELIVERY_FAMILIES.has(familyKey);
};

const serializeOrderWithDeliveryMetadata = (order, deliveredCodeCount = 0) => {
    const plain = order && typeof order.toObject === 'function' ? order.toObject() : { ...(order || {}) };
    const product = plain.productId && typeof plain.productId === 'object' ? plain.productId : {};
    if (isCodeDeliveryOrderLike(plain, product)) {
        plain.deliveryType = 'CODE_DELIVERY';
        plain.hasDeliveredCodes = deliveredCodeCount > 0;
        plain.deliveredCodeCount = deliveredCodeCount;
    }
    return plain;
};

const sanitizeOrderForCustomer = (order) => {
    const plain = order && typeof order.toObject === 'function' ? order.toObject() : { ...(order || {}) };
    if (plain.status === ORDER_STATUS.COMPLETED) {
        plain.customerStatusMessage = plain.hasDeliveredCodes
            ? 'الكود الرقمي جاهز للعرض'
            : 'تم إكمال الطلب';
    } else if (plain.status === ORDER_STATUS.PROCESSING) {
        plain.customerStatusMessage = 'طلبك قيد التنفيذ';
    } else if (plain.status === ORDER_STATUS.MANUAL_REVIEW) {
        plain.customerStatusMessage = 'طلبك قيد التنفيذ بواسطة الفريق';
    } else if (plain.status === ORDER_STATUS.FAILED || plain.status === ORDER_STATUS.CANCELED) {
        plain.customerStatusMessage = plain.refunded
            ? 'تم رد الرصيد'
            : 'فشل الطلب';
    } else {
        plain.customerStatusMessage = 'طلبك قيد التنفيذ';
    }
    if (plain.status === ORDER_STATUS.MANUAL_REVIEW) {
        plain.customerStatusMessage = 'طلبك قيد التنفيذ';
    }

    if (
        plain.status === ORDER_STATUS.MANUAL_REVIEW
        && normalizeUpper(plain.providerCode).includes('FAZER')
        && (
            plain.providerErrorCode === 'FAZERCARDS_MANUAL_FULFILLMENT_REQUIRED'
            || plain.providerErrorCode === 'FAZERCARDS_PROVIDER_EXECUTION_DISABLED'
        )
    ) {
        plain.fulfillmentNotice = 'طلبك قيد التنفيذ.';
    }

    for (const field of [
        'providerRawResponse',
        'providerRequestId',
        'providerIdempotencyKey',
        'providerTargetSnapshot',
        'providerErrorCode',
        'providerErrorMessage',
        'providerMessage',
        'providerOrderId',
        'providerStatus',
        'providerCode',
        'familyKey',
        'fulfillmentMode',
    ]) {
        delete plain[field];
    }
    return plain;
};

const attachDeliveryMetadata = async (orders) => {
    const list = Array.isArray(orders) ? orders : [orders].filter(Boolean);
    if (list.length === 0) return orders;

    const orderIds = list
        .filter((order) => isCodeDeliveryOrderLike(order, order.productId))
        .map((order) => order._id);

    if (orderIds.length === 0) {
        return Array.isArray(orders)
            ? list.map((order) => serializeOrderWithDeliveryMetadata(order, 0))
            : serializeOrderWithDeliveryMetadata(list[0], 0);
    }

    const counts = await ProviderDeliveredCode.aggregate([
        { $match: { order: { $in: orderIds } } },
        { $group: { _id: '$order', count: { $sum: 1 } } },
    ]);
    const countByOrderId = new Map(counts.map((item) => [String(item._id), Number(item.count || 0)]));
    const serialized = list.map((order) =>
        serializeOrderWithDeliveryMetadata(order, countByOrderId.get(String(order._id)) || 0)
    );
    return Array.isArray(orders) ? serialized : serialized[0];
};

const attachReviewMetadata = async (orders, userId = null) => {
    const list = Array.isArray(orders) ? orders : [orders].filter(Boolean);
    if (list.length === 0) return orders;

    const orderIds = list.map((order) => order._id).filter(Boolean);
    if (orderIds.length === 0) return orders;

    const query = { orderId: { $in: orderIds } };
    if (userId) query.userId = userId;

    const reviews = await Review.find(query)
        .select('orderId status createdAt')
        .lean();
    const reviewByOrderId = new Map(reviews.map((review) => [String(review.orderId), review]));

    const serialized = list.map((order) => {
        const plain = order && typeof order.toObject === 'function' ? order.toObject() : { ...(order || {}) };
        const review = reviewByOrderId.get(String(plain._id));
        plain.hasReview = Boolean(review);
        plain.reviewSubmitted = Boolean(review);
        plain.reviewStatus = review?.status || null;
        plain.reviewedAt = review?.createdAt || null;
        return plain;
    });

    return Array.isArray(orders) ? serialized : serialized[0];
};

const _normaliseOrderQuantity = (quantity, product) => {
    const qty = parseInt(quantity, 10);
    if (!Number.isInteger(qty) || qty < product.minQty || qty > product.maxQty) {
        throw new BusinessRuleError(
            `Quantity must be between ${product.minQty} and ${product.maxQty}.`,
            'QUANTITY_OUT_OF_RANGE'
        );
    }
    return qty;
};

const _normaliseQuoteQuantity = (quantity) => {
    const qty = parseInt(quantity, 10);
    if (!Number.isInteger(qty) || qty <= 0) {
        throw new BusinessRuleError(
            'Quantity must be a positive integer.',
            'INVALID_QUANTITY'
        );
    }
    return qty;
};

const _getQuantityValidation = (qty, product) => {
    if (qty < product.minQty) {
        return {
            isQuantityValid: false,
            quantityErrorCode: 'QUANTITY_BELOW_MIN',
            quantityErrorMessage: `Minimum quantity is ${product.minQty}`,
        };
    }

    if (qty > product.maxQty) {
        return {
            isQuantityValid: false,
            quantityErrorCode: 'QUANTITY_ABOVE_MAX',
            quantityErrorMessage: `Maximum quantity is ${product.maxQty}`,
        };
    }

    return {
        isQuantityValid: true,
        quantityErrorCode: null,
        quantityErrorMessage: null,
    };
};

const calculateOrderPricing = async ({ userId, product, quantity, session = null, enforceQuantityLimits = true }) => {
    _assertProductAvailable(product);
    const qty = enforceQuantityLimits
        ? _normaliseOrderQuantity(quantity, product)
        : _normaliseQuoteQuantity(quantity);

    const productFinalUnitPriceUsd = getProductFinalUnitPrice(product);
    const providerCostUnitUsd = getProviderCostUnitPrice(product);
    const pricing = await calculateUserPrice(userId, productFinalUnitPriceUsd, session, {
        baseUnitPriceUsd: product.basePrice ?? productFinalUnitPriceUsd,
    });
    pricing.providerCostUnitUsd = providerCostUnitUsd;

    const usdTotalPrice = multiply(pricing.customerUnitPriceUsd, String(qty));
    const profitUsd = multiply(subtract(pricing.customerUnitPriceUsd, providerCostUnitUsd), String(qty));

    const userQuery = User.findById(userId).select('currency walletBalance');
    if (session) userQuery.session(session);
    const userDoc = await userQuery;
    if (!userDoc) throw new NotFoundError('User');

    const userCurrency = userDoc.currency ?? 'USD';
    const conversion = await convertUsdToUserCurrency(Number(toDecimal(usdTotalPrice).toNumber()), userCurrency, {
        purpose: RATE_PURPOSES.PURCHASE,
    });
    const chargedAmount = toFiat(conversion.finalAmount);
    const rateSnapshot = conversion.rate;
    const purchaseRateSnapshot = conversion.rate;

    if (!Number.isFinite(chargedAmount) || chargedAmount <= 0) {
        throw new BusinessRuleError(
            'Invalid order price calculation. The final charged amount must be a positive number. ' +
            `(basePrice=${pricing.basePrice}, markup=${pricing.markupPercentage}%, ` +
            `usdTotal=${usdTotalPrice}, currency=${userCurrency}, rate=${rateSnapshot}, ` +
            `chargedAmount=${chargedAmount})`,
            'INVALID_PRICE_CALCULATION'
        );
    }

    const walletBalance = Number(userDoc.walletBalance ?? 0);

    return {
        qty,
        pricing,
        usdTotalPrice,
        profitUsd,
        userCurrency,
        rateSnapshot,
        purchaseRateSnapshot,
        rateType: 'purchase',
        chargedAmount,
        walletBalance,
        hasEnoughBalance: walletBalance >= chargedAmount,
    };
};

const quoteOrder = async ({ userId, productId, quantity }) => {
    const product = await Product.findById(productId);
    const quote = await calculateOrderPricing({
        userId,
        product,
        quantity,
        enforceQuantityLimits: false,
    });
    const quantityValidation = _getQuantityValidation(quote.qty, product);

    const createdAt = new Date();
    const checkoutQuote = await CheckoutQuote.create({
        userId,
        productId: product._id,
        quantity: quote.qty,
        currency: quote.userCurrency,
        payableAmount: quote.chargedAmount.toFixed(2),
        totalUsd: serializeDecimal(quote.usdTotalPrice),
        customerUnitPriceUsd: serializeDecimal(quote.pricing.customerUnitPriceUsd),
        basePriceSnapshot: serializeDecimal(quote.pricing.basePrice),
        markupPercentage: serializeDecimal(quote.pricing.markupPercentage || 0),
        groupId: quote.pricing.groupId || null,
        groupPercentage: serializeDecimal(quote.pricing.groupPercentage || 0),
        purchaseRateSnapshot: serializeDecimal(quote.purchaseRateSnapshot),
        rateType: quote.rateType,
        expiresAt: new Date(createdAt.getTime() + CHECKOUT_QUOTE_TTL_MS),
    });

    return {
        quoteId: checkoutQuote._id.toString(),
        quoteCreatedAt: createdAt,
        quoteExpiresAt: checkoutQuote.expiresAt,
        productId: product._id.toString(),
        quantity: quote.qty,
        minQty: product.minQty,
        maxQty: product.maxQty,
        isQuantityValid: quantityValidation.isQuantityValid,
        quantityErrorCode: quantityValidation.quantityErrorCode,
        quantityErrorMessage: quantityValidation.quantityErrorMessage,
        currency: quote.userCurrency,
        baseUnitPriceUsd: quote.pricing.baseUnitPriceUsd,
        productFinalUnitPriceUsd: quote.pricing.productFinalUnitPriceUsd,
        groupId: quote.pricing.groupId ? quote.pricing.groupId.toString() : null,
        groupName: quote.pricing.groupName,
        groupPercentage: quote.pricing.groupPercentage,
        customerUnitPriceUsd: quote.pricing.customerUnitPriceUsd,
        unitPriceUsd: quote.pricing.customerUnitPriceUsd,
        totalUsd: quote.usdTotalPrice,
        rateSnapshot: quote.rateSnapshot,
        purchaseRateSnapshot: quote.purchaseRateSnapshot,
        exchangeRate: quote.purchaseRateSnapshot,
        rateType: quote.rateType,
        payableAmount: quote.chargedAmount,
        chargedAmount: quote.chargedAmount,
        displayTotal: `${quote.userCurrency} ${quote.chargedAmount.toFixed(2)}`,
        walletBalance: quote.walletBalance,
        hasEnoughBalance: quote.hasEnoughBalance,
        canSubmit: quantityValidation.isQuantityValid && quote.hasEnoughBalance,
        basePriceSnapshot: quote.pricing.basePrice,
        markupPercentage: quote.pricing.markupPercentage,
        finalPriceCharged: quote.pricing.customerUnitPriceUsd,
    };
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// CREATE ORDER
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Create a new order with full financial safety.
 *
 * For AUTOMATIC products (linked to a provider):
 *   - Order lands in PROCESSING status after the financial transaction commits.
 *   - executeOrder() is called fire-and-forget, so the HTTP response is
 *     returned to the client immediately with PROCESSING status.
 *   - The fulfillment engine handles provider call + result handling + refund.
 *
 * For MANUAL products:
 *   - Behaviour unchanged. Order lands in PENDING status (admin fulfils manually).
 *
 * @param {Object}      params
 * @param {ObjectId}    params.userId
 * @param {ObjectId}    params.productId
 * @param {number}      params.quantity
 * @param {string|null} params.idempotencyKey
 * @param {Object|null} params.auditContext
 * @param {Object|null} params.orderFieldsValues  - dynamic field values submitted by customer
 * @param {Object|null} params.customerInput       - pre-validated dynamic field input
 * @param {Object|null} params.provider           - adapter instance (injected for testability)
 */
const createOrder = async ({
    userId,
    productId,
    quantity,
    idempotencyKey = null,
    auditContext = null,
    orderFieldsValues = null,   // â† new param
    provider = null,   // â† injected; null = auto-resolve from factory
    customerInput = null,
    source = 'web',
    apiKeyPrefix = null,
    externalOrderId = null,
    quoteId = null,
    requireQuoteConsent = false,
}) => {
    const actionUser = await User.findById(userId).select('identityVerificationRequired');
    if (!actionUser) throw new NotFoundError('User');
    assertIdentityVerificationNotRequired(actionUser);

    // â”€â”€ Pre-transaction: Idempotency Check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (idempotencyKey) {
        const existing = await Order.findOne({ userId, idempotencyKey })
            .populate('productId', 'name basePrice executionType providerProduct');
        if (existing) {
            return { order: existing, idempotent: true };
        }
    }

    // Xena live balance remains available through the provider diagnostics, but
    // must not decide whether a customer order is accepted. Provider stock can
    // change between a read and the later recharge request; definitive Xena
    // rejections are handled by the post-debit fulfillment/refund lifecycle.

    // â”€â”€ Auto-resolve provider adapter (production flow) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // If no adapter was injected (i.e. called from HTTP controller), resolve
    // the adapter from the factory using the product's linked Provider doc.
    // Tests always inject their own mock, so this branch is never reached
    // in test runs.
    let resolvedProvider = provider;

    // providerCode is the canonical slug/name snapshot written to the Order.
    // The cron uses this field â€” NOT the product â€” so a later admin provider
    // swap cannot corrupt in-flight PROCESSING orders.
    let providerCode = null;

    if (!resolvedProvider) {
        try {
            const prod = await Product.findById(productId)
                .select('executionType provider providerCode providerExecutionMode providerExecutionEnabled familyKey')
                .populate('provider');
            const isFazerCardsAuto = String(prod?.providerCode || '').trim().toUpperCase() === PROVIDER_CODES.FAZER_CARDS
                && prod?.providerExecutionMode === PROVIDER_EXECUTION_MODES.AUTO_PROVIDER
                && prod?.providerExecutionEnabled === true;
            if (
                (prod?.executionType === ORDER_EXECUTION_TYPES.AUTOMATIC || isFazerCardsAuto) &&
                prod?.provider?._id
            ) {
                const providerDoc = prod.provider.toObject
                    ? prod.provider
                    : await Provider.findById(prod.provider);

                // â”€â”€ Snapshot the provider code UNCONDITIONALLY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
                // providerCode must be captured even when the provider is
                // inactive â€” the code identifies which provider the order
                // belongs to for admin review / DLQ.  The adapter is only
                // obtained when the provider is active.
                if (providerDoc) {
                    providerCode = String(providerDoc.slug || providerDoc.name || '')
                        .toLowerCase().trim() || null;
                }

                if (providerDoc?.isActive) {
                    resolvedProvider = getProviderAdapter(providerDoc);
                } else {
                    console.warn(`[Order] Provider ${prod.provider._id} is INACTIVE â€” fulfillment will self-resolve.`);
                }
            }
        } catch (resolveErr) {
            // Log instead of silently swallowing â€” critical for debugging
            console.error(`[Order] Provider resolution failed for product ${productId}:`, resolveErr.message);
            // resolvedProvider stays null â€” executeOrder will self-resolve
            // providerCode may have been set before the error; if not, the
            // fallback inside _attemptCreateOrder will try again.
        }
    }

    return _attemptCreateOrder({
        userId,
        productId,
        quantity,
        idempotencyKey,
        auditContext,
        orderFieldsValues,
        customerInput,
        provider: resolvedProvider,
        providerCode,
        source,
        apiKeyPrefix,
        externalOrderId,
        quoteId,
        requireQuoteConsent,
    });

};

/**
 * Internal helper â€” executes the transactional order creation.
 * Retried once after a transient MongoDB transaction abort.
 * @private
 */
const _attemptCreateOrder = async (
    {
        userId,
        productId,
        quantity,
        idempotencyKey,
        auditContext,
        orderFieldsValues,
        customerInput: validatedCustomerInput = null,
        provider,
        providerCode = null,
        source = 'web',
        apiKeyPrefix = null,
        externalOrderId = null,
        quoteId = null,
        requireQuoteConsent = false,
    },
    isRetry = false
) => {
    // Provider catalog reads can take seconds (and a cold Luban catalog has a
    // deliberately longer adapter timeout). Keep that work entirely outside
    // the financial transaction. Re-read the product inside the transaction
    // below before debiting so its local availability/pricing snapshots remain
    // authoritative at commit time.
    const preflightProduct = await Product.findById(productId);
    _assertProductAvailable(preflightProduct);
    _normaliseOrderQuantity(quantity, preflightProduct);
    await verifyProviderPriceBeforeCheckout({ product: preflightProduct, provider });

    const session = await mongoose.startSession();

    // â”€â”€ 0. Assign sequential order number (OUTSIDE txn) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Auto-increment counters are intentionally non-transactional (same as
    // PostgreSQL sequences / MySQL AUTO_INCREMENT). A wasted number on
    // abort is acceptable. Running inside snapshot-isolation would fail
    // because the session can't see counter docs created after its snapshot.
    const orderNumber = await getNextSequence('orderNumber', 9999);

    try {
        session.startTransaction({
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
        });

        // â”€â”€ 1. Load & Validate Product â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const product = await Product.findById(productId).session(session);
        _assertProductAvailable(product);
        const fazerCardsMode = getFazerCardsExecutionMode(product);

        // â”€â”€ 2. Validate Quantity Bounds â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const qty = _normaliseOrderQuantity(quantity, product);

        let acceptedQuote = null;
        if (requireQuoteConsent) {
            if (!quoteId || !mongoose.Types.ObjectId.isValid(quoteId)) {
                throw new BusinessRuleError('Please review the current price before ordering.', 'QUOTE_REQUIRED');
            }
            acceptedQuote = await CheckoutQuote.findOne({
                _id: quoteId,
                userId,
                productId: product._id,
                quantity: qty,
                status: CHECKOUT_QUOTE_STATUS.ACTIVE,
            }).session(session);
            if (!acceptedQuote) {
                throw new BusinessRuleError('This checkout quote is no longer available. Please review the current price.', 'QUOTE_INVALID');
            }
            if (acceptedQuote.expiresAt.getTime() <= Date.now()) {
                throw new BusinessRuleError('This checkout quote has expired. Please review the current price.', 'QUOTE_EXPIRED');
            }
        }

        // â”€â”€ 2b. Validate / capture dynamic order fields â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Runs BEFORE any financial mutation so a bad field value costs nothing.
        //
        // If the product defines formal orderFields, validate against them.
        // Otherwise, pass through raw values so that link/target/etc. still
        // reach the provider (critical for SMM-panel services).
        let customerInput = validatedCustomerInput;
        if (!customerInput && product.orderFields && product.orderFields.length > 0) {
            const {
                orderFields: effectiveOrderFields,
                orderFieldsValues: effectiveOrderFieldsValues,
            } = await _canonicalizeXenaOrderFields({ product, orderFieldsValues, session });
            // validateOrderFields throws BusinessRuleError on invalid input
            const { values, fieldsSnapshot } = validateOrderFields(
                effectiveOrderFields,
                effectiveOrderFieldsValues
            );
            customerInput = { values, fieldsSnapshot };
        } else if (!customerInput && orderFieldsValues && typeof orderFieldsValues === 'object' && Object.keys(orderFieldsValues).length > 0) {
            // No formal schema â€” save raw values so the fulfillment engine
            // can forward them to the provider (e.g. { link: '...' }).
            customerInput = { values: orderFieldsValues, fieldsSnapshot: [] };
        }
        assertFazerCardsManualCustomerInput(product, fazerCardsMode, customerInput);

        // Deterministic, local FazerCards blockers must fail before the
        // wallet debit. This does not call the provider or decide uncertain
        // provider outcomes, which remain part of post-debit fulfillment.
        if (fazerCardsMode?.isAutoProvider === true && product.providerExecutionEnabled === true) {
            const [providerProduct, providerDoc] = await Promise.all([
                product.providerProduct
                    ? ProviderProduct.findById(product.providerProduct).session(session).lean()
                    : null,
                product.provider
                    ? Provider.findById(product.provider).select('name slug providerCode isActive').session(session).lean()
                    : null,
            ]);
            const readiness = evaluateFazerCardsReadiness({
                product,
                providerProduct,
                provider: providerDoc,
                operation: READINESS_OPERATIONS.CUSTOMER_AUTOMATIC_PURCHASE,
                purchaseContext: { quantity: qty },
            });
            if (!readiness.ready) {
                const firstReason = readiness.reasons[0] || {};
                throw new BusinessRuleError(
                    firstReason.message || 'This FazerCards product is not ready for automatic fulfillment.',
                    firstReason.code || 'FAZERCARDS_AUTOMATIC_FULFILLMENT_NOT_READY',
                    { reasons: readiness.reasons }
                );
            }
        }

        // â”€â”€ 2c. JIT Provider Price Verification â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        //
        // â”€â”€ 3. Pricing Engine (USD) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const orderPricing = await calculateOrderPricing({ userId, product, quantity: qty, session });
        const pricing = orderPricing.pricing;

        // â”€â”€ 3a. Profit Calculation (USD) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Profit = markup portion only = (markedUpPrice - basePrice) Ã— quantity
        const usdTotalPrice = orderPricing.usdTotalPrice;

        // â”€â”€ 3b. Currency Conversion â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Fetch the user's preferred currency (within the session for consistency).
        // For USD users this is a no-op (rate = 1, finalAmount = usdTotalPrice).
        const profitUsd = orderPricing.profitUsd;
        const userCurrency = orderPricing.userCurrency;
        const rateSnapshot = orderPricing.rateSnapshot;
        const purchaseRateSnapshot = orderPricing.purchaseRateSnapshot;
        // â”€â”€ FINAL ROUNDING â€” only place we round to 2dp â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const chargedAmount = orderPricing.chargedAmount;

        if (acceptedQuote) {
            const quoteMatches = acceptedQuote.currency === userCurrency
                && compare(acceptedQuote.payableAmount, chargedAmount.toFixed(2)) === 0
                && compare(acceptedQuote.totalUsd, serializeDecimal(usdTotalPrice)) === 0
                && compare(acceptedQuote.customerUnitPriceUsd, serializeDecimal(pricing.customerUnitPriceUsd)) === 0
                && compare(acceptedQuote.basePriceSnapshot, serializeDecimal(pricing.basePrice)) === 0
                && compare(acceptedQuote.purchaseRateSnapshot, serializeDecimal(purchaseRateSnapshot)) === 0
                && compare(acceptedQuote.markupPercentage, serializeDecimal(pricing.markupPercentage || 0)) === 0
                && compare(acceptedQuote.groupPercentage, serializeDecimal(pricing.groupPercentage || 0)) === 0;
            if (!quoteMatches) {
                throw new BusinessRuleError(
                    'The price has changed. Please review and confirm the updated price before ordering.',
                    'QUOTE_PRICE_CHANGED',
                    {
                        currency: userCurrency,
                        payableAmount: chargedAmount.toFixed(2),
                        totalUsd: serializeDecimal(usdTotalPrice),
                        purchaseRateSnapshot,
                    }
                );
            }
        }

        // â”€â”€ 3c. FINAL PRICE GUARD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Prevent NaN / Infinity / zero from reaching the wallet debit.
        if (!Number.isFinite(chargedAmount) || chargedAmount <= 0) {
            throw new BusinessRuleError(
                'Invalid order price calculation. The final charged amount must be a positive number. ' +
                `(basePrice=${pricing.basePrice}, markup=${pricing.markupPercentage}%, ` +
                `usdTotal=${usdTotalPrice}, currency=${userCurrency}, rate=${rateSnapshot}, ` +
                `chargedAmount=${chargedAmount})`,
                'INVALID_PRICE_CALCULATION'
            );
        }

        const orderId = new mongoose.Types.ObjectId();

        if (acceptedQuote) {
            const consumed = await CheckoutQuote.updateOne(
                { _id: acceptedQuote._id, userId, status: CHECKOUT_QUOTE_STATUS.ACTIVE },
                { $set: { status: CHECKOUT_QUOTE_STATUS.CONSUMED, consumedAt: new Date(), consumedOrderId: orderId } },
                { session }
            );
            if (consumed.modifiedCount !== 1) {
                throw new BusinessRuleError('This checkout quote was already used. Please review the current price.', 'QUOTE_ALREADY_USED');
            }
        }

        // â”€â”€ 4. Atomic Debit (in user currency) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const { walletDeducted, creditUsedAmount } = await debitWalletAtomic({
            userId,
            amount: chargedAmount,     // â† wallet always in user currency
            reference: orderId,
            semanticType: LEDGER_TRANSACTION_TYPES.ORDER_DEBIT,
            sourceType: TRANSACTION_SOURCE_TYPES.ORDER,
            sourceId: orderId,
            currency: userCurrency,
            description: `Payment for: ${product.name} x${qty}`,
            metadata: {
                orderId: orderId.toString(),
                productId: product._id.toString(),
                quantity: qty,
                usdAmount: usdTotalPrice,
                rateSnapshot,
                purchaseRateSnapshot,
                rateType: 'purchase',
                chargedAmount,
            },
            idempotencyKey: `order:${orderId.toString()}:debit`,
            actorId: auditContext?.actorId ?? userId,
            actorRole: auditContext?.actorRole ?? ACTOR_ROLES.CUSTOMER,
            session,
        });

        // â”€â”€ 5. Determine initial status & execution type â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // An AUTOMATIC product â†’ PROCESSING (fulfillment attempted post-commit)
        // Any other case        â†’ PENDING   (admin handles manually)
        const isAutomatic = fazerCardsMode
            ? fazerCardsMode.isAutoProvider && product.providerExecutionEnabled === true
            : product.executionType === ORDER_EXECUTION_TYPES.AUTOMATIC;
        const isFazerCardsProviderDisabled = Boolean(fazerCardsMode && !isAutomatic);
        const isManualOrder = (
            fazerCardsMode?.isManualFulfillment === true ||
            isFazerCardsProviderDisabled ||
            product.executionType === ORDER_EXECUTION_TYPES.MANUAL ||
            !product.provider ||
            !product.providerProduct
        );
        const initialStatus = isAutomatic
            ? ORDER_STATUS.PROCESSING
            : (fazerCardsMode?.isManualFulfillment === true || isFazerCardsProviderDisabled)
                ? ORDER_STATUS.MANUAL_REVIEW
                : ORDER_STATUS.PENDING;

        // â”€â”€ 6. Create Order â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const orderData = {
            _id: orderId,
            userId,
            productId: product._id,
            orderNumber,
            quantity: qty,
            basePriceSnapshot: pricing.basePrice,
            markupPercentageSnapshot: pricing.markupPercentage,
            groupNameSnapshot: pricing.groupName,
            groupPercentageSnapshot: pricing.groupPercentage,
            finalPriceCharged: pricing.customerUnitPriceUsd,
            groupIdSnapshot: pricing.groupId,
            profitUsd: profitUsd,
            unitPrice: pricing.customerUnitPriceUsd,
            totalPrice: String(chargedAmount),   // legacy field â€” now equals chargedAmount
            walletDeducted,
            creditUsedAmount,
            status: initialStatus,
            executionType: isAutomatic ? ORDER_EXECUTION_TYPES.AUTOMATIC : ORDER_EXECUTION_TYPES.MANUAL,
            familyKey: product.familyKey || null,
            fulfillmentMode: product.fulfillmentMode || null,
            customerInput,
            // â”€â”€ Provider code snapshot (immutable â€” cron uses this, not product.provider) â”€â”€
            providerCode: providerCode ?? (product.providerCode ? String(product.providerCode).toLowerCase().trim() : null),
            providerMessage: fazerCardsMode?.isManualFulfillment === true
                ? 'Manual fulfillment required because provider contract is not confirmed or auto execution is not enabled.'
                : isFazerCardsProviderDisabled
                    ? 'FazerCards provider execution is disabled for this product.'
                    : null,
            providerErrorCode: fazerCardsMode?.isManualFulfillment === true
                ? 'FAZERCARDS_MANUAL_FULFILLMENT_REQUIRED'
                : isFazerCardsProviderDisabled
                    ? 'FAZERCARDS_PROVIDER_EXECUTION_DISABLED'
                : null,
            // â”€â”€ Currency snapshot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            currency: userCurrency,
            rateSnapshot,
            purchaseRateSnapshot,
            rateType: 'purchase',
            usdAmount: usdTotalPrice,
            chargedAmount,
            source,
            apiKeyPrefix,
            externalOrderId,
        };
        if (idempotencyKey) orderData.idempotencyKey = idempotencyKey;

        let order;
        try {
            [order] = await Order.create([orderData], { session });
        } catch (createErr) {
            if (createErr.code === 11000 && idempotencyKey) {
                await session.abortTransaction();
                session.endSession();
                const existing = await Order.findOne({ userId, idempotencyKey })
                    .populate('productId', 'name basePrice executionType providerProduct');
                return { order: existing, idempotent: true };
            }
            throw createErr;
        }

        // â”€â”€ 8. Commit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        await _commitCheckoutTransaction(session);

        await order.populate([{ path: 'productId', select: 'name basePrice executionType providerProduct' }]);

        // â”€â”€ 9. Audit: AFTER commit â€” fire-and-forget â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const actorId = auditContext?.actorId ?? userId;
        const actorRole = auditContext?.actorRole ?? ACTOR_ROLES.CUSTOMER;
        const ipAddress = auditContext?.ipAddress ?? null;
        const userAgent = auditContext?.userAgent ?? null;

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: ORDER_ACTIONS.CREATED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: {
                userId,
                productId: product._id,
                quantity: qty,
                usdAmount: usdTotalPrice,
                currency: userCurrency,
                rateSnapshot,
                purchaseRateSnapshot,
                rateType: 'purchase',
                chargedAmount,
                walletDeducted,
                creditUsedAmount,
                basePriceSnapshot: pricing.basePrice,
                markupPercentageSnapshot: pricing.markupPercentage,
                groupNameSnapshot: pricing.groupName,
                groupPercentageSnapshot: pricing.groupPercentage,
                finalPriceCharged: pricing.customerUnitPriceUsd,
                status: initialStatus,
                source,
                apiKeyPrefix,
                externalOrderId,
            },
        });

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: WALLET_ACTIONS.DEBIT,
            entityType: ENTITY_TYPES.WALLET,
            entityId: userId,
            metadata: {
                orderId: order._id,
                usdAmount: usdTotalPrice,
                currency: userCurrency,
                rateSnapshot,
                purchaseRateSnapshot,
                rateType: 'purchase',
                chargedAmount,
                walletDeducted,
                creditUsedAmount,
            },
        });

        // â”€â”€ 10. Trigger provider fulfillment (fire-and-forget) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Always fires for AUTOMATIC products. executeOrder self-resolves the
        // provider adapter if none was pre-resolved, and handles all failures
        // (marks FAILED + refunds the wallet).
        if (source === 'client_api') {
            createAuditLog({
                actorId, actorRole, ipAddress, userAgent,
                action: ORDER_ACTIONS.CLIENT_API_CREATED,
                entityType: ENTITY_TYPES.ORDER,
                entityId: order._id,
                metadata: {
                    userId,
                    productId: product._id,
                    quantity: qty,
                    idempotencyKey,
                    externalOrderId,
                    apiKeyPrefix,
                    status: initialStatus,
                },
            });
        }

        notifyOrderCreated(order, { manualReview: isManualOrder });

        if (isAutomatic) {
            createAuditLog({
                actorId, actorRole, ipAddress, userAgent,
                action: ORDER_ACTIONS.PROCESSING,
                entityType: ENTITY_TYPES.ORDER,
                entityId: order._id,
                metadata: { orderId: order._id.toString(), status: ORDER_STATUS.PROCESSING },
            });

            // Lazy-require to avoid circular dependency issues
            const { executeOrder } = require('./orderFulfillment.service');

            // Fire-and-forget â€” client gets PROCESSING response immediately.
            // Pass provider if we have one; executeOrder self-resolves if null.
            executeOrder(order._id, provider, auditContext).catch((err) => {
                console.error(`[Order] executeOrder failed for ${order._id}:`, err.message);
            });
        }

        return { order, idempotent: false };

    } catch (err) {
        await _abortCheckoutTransactionQuietly(session);

        if (_isRetryableCheckoutTransactionError(err) && !isRetry) {
            await new Promise((r) => setTimeout(r, 10));
            return _attemptCreateOrder(
                {
                    userId,
                    productId,
                    quantity,
                    idempotencyKey,
                    auditContext,
                    orderFieldsValues,
                    customerInput: validatedCustomerInput,
                    provider,
                    providerCode,
                    source,
                    apiKeyPrefix,
                    externalOrderId,
                    quoteId,
                    requireQuoteConsent,
                },
                true
            );

        }

        throw err;
    } finally {
        try { session.endSession(); } catch (_) { /* already ended */ }
    }
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// MARK ORDER AS FAILED (REFUND) â€” manual admin action
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Mark an order as FAILED and issue a REFUND.
 *
 * CROSS-CURRENCY SAFE:
 *   The refund uses order.usdAmount (the USD truth frozen at order time)
 *   and converts it to the user's CURRENT currency rate. This prevents
 *   the bug where a currency change between order and refund causes
 *   the wrong numeric amount to be credited.
 *
 * Double-refund prevention via TWO independent guards:
 *   Guard 1 â€” status check:    order.status === 'FAILED'  â†’ already failed
 *   Guard 2 â€” timestamp check: order.refundedAt !== null  â†’ already refunded
 */
const markOrderAsFailed = async (orderId, auditContext = null) => {
    const session = await mongoose.startSession();

    try {
        session.startTransaction({
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
        });

        const order = await Order.findById(orderId).session(session);
        if (!order) throw new NotFoundError('Order');

        const existingRefund = await WalletTransaction.findOne({
            reference: order._id,
            type: 'REFUND',
            semanticType: LEDGER_TRANSACTION_TYPES.ORDER_REFUND,
        }).session(session);

        if (existingRefund) {
            // Repair old partial settlement state without ever crediting twice.
            if (!order.refunded || !order.refundedAt) {
                order.status = ORDER_STATUS.FAILED;
                order.failedAt = order.failedAt || new Date();
                order.refunded = true;
                order.refundedAt = existingRefund.createdAt || new Date();
                await order.save({ session });
                await session.commitTransaction();
                return order;
            }
            if (order.status === ORDER_STATUS.FAILED) {
                throw new BusinessRuleError(
                    'This order has already been marked as failed.',
                    'ORDER_ALREADY_FAILED'
                );
            }
            throw new BusinessRuleError(
                'A refund has already been issued for this order.',
                'ALREADY_REFUNDED'
            );
        }

        // A FAILED order without a refund ledger is recoverable. The financial
        // settlement below is driven by ledger evidence, not status alone.

        // â”€â”€ Refund amount â€” use the EXACT amounts originally deducted â”€â”€â”€â”€â”€â”€â”€â”€
        // NEVER do a live currency conversion here. Exchange rates fluctuate.
        // The user must receive back exactly what was taken from their wallet.
        //
        // Source of truth (frozen at order creation):
        //   walletDeducted   â€“ amount taken from the wallet balance
        //   creditUsedAmount â€“ amount taken from the credit line
        //   chargedAmount    â€“ total (walletDeducted + creditUsed), fallback
        const walletPortion = Number(order.walletDeducted || 0);
        const creditPortion = Number(order.creditUsedAmount || 0);

        // Fallback: if both split fields are 0 but chargedAmount exists,
        // treat chargedAmount as a pure wallet charge (legacy orders).
        const refundWallet = walletPortion > 0 ? walletPortion : Number(order.chargedAmount || 0);
        const refundCredit = creditPortion;
        const totalRefund = refundWallet + refundCredit;

        if (totalRefund <= 0) {
            throw new BusinessRuleError(
                'Order has no charged amount to refund.',
                'NO_REFUNDABLE_AMOUNT'
            );
        }

        // â”€â”€ Update order status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        order.status = ORDER_STATUS.FAILED;
        order.failedAt = new Date();
        order.refundedAt = new Date();
        order.refunded = true;
        await order.save({ session });

        // â”€â”€ Credit the wallet with the exact original amounts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        await refundWalletAtomic({
            userId: order.userId,
            walletDeducted: refundWallet,
            creditUsedAmount: refundCredit,
            reference: order._id,
            semanticType: LEDGER_TRANSACTION_TYPES.ORDER_REFUND,
            sourceType: TRANSACTION_SOURCE_TYPES.ORDER,
            sourceId: order._id,
            currency: order.currency || 'USD',
            description: `Refund for failed order #${order.orderNumber || order._id} (${totalRefund} ${order.currency || 'USD'})`,
            metadata: {
                orderId: order._id.toString(),
                orderNumber: order.orderNumber,
                walletRefunded: refundWallet,
                creditRefunded: refundCredit,
                totalRefund,
                reason: 'ORDER_FAILED',
            },
            idempotencyKey: `order:${order._id.toString()}:refund:failed`,
            actorId: auditContext?.actorId ?? order.userId,
            actorRole: auditContext?.actorRole ?? ACTOR_ROLES.ADMIN,
            session,
        });

        await session.commitTransaction();

        // â”€â”€ Audit â€” AFTER commit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const actorId = auditContext?.actorId ?? order.userId;
        const actorRole = auditContext?.actorRole ?? ACTOR_ROLES.ADMIN;
        const ipAddress = auditContext?.ipAddress ?? null;
        const userAgent = auditContext?.userAgent ?? null;

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: ORDER_ACTIONS.REFUNDED,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: {
                userId: order.userId,
                currency: order.currency,
                walletRefunded: refundWallet,
                creditRefunded: refundCredit,
                totalRefund,
                originalChargedAmount: order.chargedAmount,
                originalWalletDeducted: order.walletDeducted,
            },
        });

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: WALLET_ACTIONS.CREDIT,
            entityType: ENTITY_TYPES.WALLET,
            entityId: order.userId,
            metadata: {
                orderId: order._id,
                orderNumber: order.orderNumber,
                walletRefunded: refundWallet,
                creditRefunded: refundCredit,
                totalRefund,
                currency: order.currency,
            },
        });

        notifyOrderFailed(order, {
            source: 'manual_refund',
            reason: 'MANUAL_REFUND',
            notifyUser: false,
        });
        notifyOrderRefunded(order, {
            refundAmount: totalRefund,
            currency: order.currency,
            source: 'manual_refund',
            reason: 'MANUAL_REFUND',
        });

        return order;
    } catch (err) {
        if (session.inTransaction()) {
            await session.abortTransaction();
        }
        throw err;
    } finally {
        try { session.endSession(); } catch (_) { /* already ended */ }
    }
};

// -----------------------------------------------------------------------------
// PROCESS ORDER REFUND - CANCELED (full) & PARTIAL (proportional)
// -----------------------------------------------------------------------------

/**
 * Process a refund for an order that was CANCELED or PARTIAL.
 *
 * FULL REFUND (remains === 0, status CANCELED):
 *   refundAmount = order.chargedAmount
 *
 * PARTIAL REFUND (remains > 0, status PARTIAL):
 *   refundAmount = Math.floor((remains / order.quantity) * order.chargedAmount)
 *
 * Uses the ORIGINAL chargedAmount (what the user paid at order time) -
 * NOT live USD conversion. If they paid 100 EGP, max refund is 100 EGP.
 *
 * Idempotency: if order.refunded === true, throws ALREADY_REFUNDED.
 *
 * @param {string|ObjectId} orderId
 * @param {number}          remains      - undelivered units (0 = full refund)
 * @param {Object|null}     auditContext - { actorId, actorRole, ipAddress?, userAgent? }
 * @returns {Promise<Order>}
 */
const processOrderRefund = async (orderId, remains = 0, auditContext = null) => {
    const session = await mongoose.startSession();

    try {
        session.startTransaction({
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
        });

        const order = await Order.findById(orderId).session(session);
        if (!order) throw new NotFoundError('Order');

        // Idempotency guard
        if (order.refunded === true) {
            throw new BusinessRuleError(
                'A refund has already been issued for this order.',
                'ALREADY_REFUNDED'
            );
        }

        // Calculate refund amount
        const chargedAmount = Number(order.chargedAmount || order.walletDeducted || 0);
        if (chargedAmount <= 0) {
            throw new BusinessRuleError(
                'Order has no charged amount to refund.',
                'NO_REFUNDABLE_AMOUNT'
            );
        }

        const remainsCount = Math.max(0, parseInt(remains, 10) || 0);
        const isPartial = remainsCount > 0 && remainsCount < order.quantity;

        let refundAmount;
        if (isPartial) {
            // Proportional refund based on undelivered quantity
            refundAmount = Math.floor((remainsCount / order.quantity) * chargedAmount);
        } else {
            // Full refund
            refundAmount = chargedAmount;
        }

        if (refundAmount <= 0) {
            throw new BusinessRuleError(
                'Calculated refund amount is zero or negative.',
                'INVALID_REFUND_AMOUNT'
            );
        }

        // Update order state before wallet mutation for idempotency.
        order.refunded = true;
        order.refundedAt = new Date();
        if (isPartial) {
            order.remains = remainsCount;
        }
        await order.save({ session });

        // Atomic wallet refund
        const description = isPartial
            ? `Partial refund for Order #${order.orderNumber} (Remains: ${remainsCount}/${order.quantity})`
            : `Full refund for Order #${order.orderNumber}`;

        await refundWalletAtomic({
            userId: order.userId,
            walletDeducted: refundAmount,
            creditUsedAmount: 0,
            reference: order._id,
            semanticType: LEDGER_TRANSACTION_TYPES.ORDER_REFUND,
            sourceType: TRANSACTION_SOURCE_TYPES.ORDER,
            sourceId: order._id,
            currency: order.currency || 'USD',
            description,
            metadata: {
                orderId: order._id.toString(),
                orderNumber: order.orderNumber,
                refundAmount,
                remains: remainsCount,
                quantity: order.quantity,
                isPartial,
                reason: isPartial ? 'PARTIAL_DELIVERY' : 'ORDER_CANCELED',
            },
            idempotencyKey: `order:${order._id.toString()}:refund:${isPartial ? `partial:${remainsCount}` : 'full'}`,
            actorId: auditContext?.actorId ?? order.userId,
            actorRole: auditContext?.actorRole ?? ACTOR_ROLES.SYSTEM,
            session,
        });

        await session.commitTransaction();

        // Audit after commit (fire-and-forget)
        const actorId = auditContext?.actorId ?? order.userId;
        const actorRole = auditContext?.actorRole ?? ACTOR_ROLES.SYSTEM;
        const ipAddress = auditContext?.ipAddress ?? null;
        const userAgent = auditContext?.userAgent ?? null;

        const auditAction = isPartial
            ? ORDER_ACTIONS.PARTIAL_REFUNDED
            : ORDER_ACTIONS.REFUNDED;

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: auditAction,
            entityType: ENTITY_TYPES.ORDER,
            entityId: order._id,
            metadata: {
                userId: order.userId,
                orderNumber: order.orderNumber,
                chargedAmount,
                refundAmount,
                remains: remainsCount,
                quantity: order.quantity,
                isPartial,
                currency: order.currency,
            },
        });

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: WALLET_ACTIONS.CREDIT,
            entityType: ENTITY_TYPES.WALLET,
            entityId: order.userId,
            metadata: {
                orderId: order._id,
                orderNumber: order.orderNumber,
                refundAmount,
                currency: order.currency,
                reason: isPartial ? 'PARTIAL_DELIVERY' : 'ORDER_CANCELED',
            },
        });

        notifyOrderRefunded(order, {
            refundAmount,
            currency: order.currency,
            source: auditContext?.notificationSource || (isPartial ? 'partial_refund' : 'order_refund'),
            reason: auditContext?.notificationReason || (isPartial ? 'PARTIAL_DELIVERY' : 'ORDER_CANCELED'),
            providerRejected: auditContext?.providerRejected === true,
            partial: isPartial,
        });

        return order;

    } catch (err) {
        if (session.inTransaction()) {
            await session.abortTransaction();
        }
        throw err;
    } finally {
        try { session.endSession(); } catch (_) { /* already ended */ }
    }
};

// -----------------------------------------------------------------------------
// MARK ORDER AS COMPLETED
// -----------------------------------------------------------------------------

const markOrderAsCompleted = async (orderId) => {
    const order = await Order.findById(orderId);
    if (!order) throw new NotFoundError('Order');

    if (order.status !== ORDER_STATUS.PENDING) {
        throw new BusinessRuleError(
            `Cannot complete an order with status '${order.status}'.`,
            'INVALID_STATUS_TRANSITION'
        );
    }

    order.status = ORDER_STATUS.COMPLETED;
    await order.save();
    notifyOrderCompleted(order, { source: 'manual_service' });
    return order;
};

const revealDeliveredCodes = async (orderId, userId, auditContext = null) => {
    const order = await Order.findOne({ _id: orderId, userId })
        .populate('productId', 'name familyKey fulfillmentMode providerCode');
    if (!order) throw new NotFoundError('Order');

    if (order.status !== ORDER_STATUS.COMPLETED) {
        throw new BusinessRuleError(
            'Delivered codes can only be revealed after the order is completed.',
            'ORDER_NOT_COMPLETED'
        );
    }

    if (!isCodeDeliveryOrderLike(order, order.productId)) {
        throw new BusinessRuleError(
            'This order does not have code delivery.',
            'ORDER_NOT_CODE_DELIVERY'
        );
    }

    const deliveredCodes = await ProviderDeliveredCode.find({ order: order._id })
        .select('+codeEncrypted +pinEncrypted +serialEncrypted');
    if (deliveredCodes.length === 0) {
        throw new BusinessRuleError(
            'No delivered codes are available for this order yet.',
            'DELIVERED_CODES_NOT_AVAILABLE'
        );
    }

    const revealedAt = new Date();
    const items = [];

    for (const delivered of deliveredCodes) {
        const code = delivered.getSecretValue('codeEncrypted');
        const pin = delivered.getSecretValue('pinEncrypted');
        const serial = delivered.getSecretValue('serialEncrypted');

        delivered.revealCount = Number(delivered.revealCount || 0) + 1;
        delivered.revealedAt = revealedAt;
        delivered.revealedBy = userId;
        delivered.deliveryStatus = DELIVERY_STATUSES.REVEALED;
        await delivered.save();

        items.push({
            id: delivered._id.toString(),
            code: code || null,
            pin: pin || null,
            serial: serial || null,
            metadata: delivered.metadata || null,
            revealCount: delivered.revealCount,
            deliveredAt: delivered.deliveredAt || null,
            revealedAt,
        });
    }

    createAuditLog({
        actorId: auditContext?.actorId ?? userId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.CUSTOMER,
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
        action: ORDER_ACTIONS.DELIVERED_CODES_REVEALED,
        entityType: ENTITY_TYPES.ORDER,
        entityId: order._id,
        metadata: {
            orderId: order._id.toString(),
            orderNumber: order.orderNumber,
            deliveredCodeCount: items.length,
            deliveredCodeIds: deliveredCodes.map((delivered) => delivered._id.toString()),
        },
    });

    return {
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        deliveryType: 'CODE_DELIVERY',
        deliveredCodeCount: items.length,
        items,
        warning: 'Plaintext codes are returned only by this reveal endpoint.',
    };
};

// -----------------------------------------------------------------------------
// QUERIES
// -----------------------------------------------------------------------------

const listOrdersForUser = async (userId, { page = 1, limit = 20 } = {}) => {
    const skip = (page - 1) * limit;
    const [orders, total] = await Promise.all([
        Order.find({ userId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('productId', 'name basePrice executionType'),
        Order.countDocuments({ userId }),
    ]);
    const ordersWithDelivery = await attachDeliveryMetadata(orders);
    const ordersWithReviews = await attachReviewMetadata(ordersWithDelivery, userId);
    return {
        orders: ordersWithReviews.map(sanitizeOrderForCustomer),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

const listAllOrders = async ({ page = 1, limit = 20, status } = {}) => {
    const filter = status ? { status } : {};
    const skip = (page - 1) * limit;
    const [orders, total] = await Promise.all([
        Order.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('productId', 'name basePrice')
            .populate('userId', 'name email'),
        Order.countDocuments(filter),
    ]);
    return { orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

const getOrderById = async (orderId, userId = null) => {
    const filter = { _id: orderId };
    if (userId) filter.userId = userId;

    const order = await Order.findOne(filter)
        .populate('productId', 'name basePrice minQty maxQty executionType')
        .populate('userId', 'name email');

    if (!order) throw new NotFoundError('Order');
    const orderWithDelivery = await attachDeliveryMetadata(order);
    const orderWithReview = userId ? await attachReviewMetadata(orderWithDelivery, userId) : orderWithDelivery;
    return userId ? sanitizeOrderForCustomer(orderWithReview) : orderWithDelivery;
};

module.exports = {
    createOrder,
    quoteOrder,
    calculateOrderPricing,
    markOrderAsFailed,
    processOrderRefund,
    markOrderAsCompleted,
    revealDeliveredCodes,
    listOrdersForUser,
    listAllOrders,
    getOrderById,
};
