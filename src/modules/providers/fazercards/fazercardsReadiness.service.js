'use strict';

/**
 * Deterministic, local FazerCards readiness checks.
 *
 * ProviderProduct.isActive and supportLevel deliberately do not appear as
 * execution blockers here.  They describe raw catalog publication and
 * classification; existing FazerCards products may legitimately execute when
 * those values are false/CATALOG_ONLY.  The family contract and explicit
 * execution flags are the authority for automatic fulfillment.
 */
const config = require('../../../config/config');
const { PROVIDER_CODES } = require('../provider.constants');
const fazerCardsContracts = require('./fazercardsContracts');

const READINESS_OPERATIONS = Object.freeze({
    ADMIN_AUTO_CONFIGURATION: 'ADMIN_AUTO_CONFIGURATION',
    CUSTOMER_AUTOMATIC_PURCHASE: 'CUSTOMER_AUTOMATIC_PURCHASE',
});

const normalize = (value) => String(value || '').trim();
const normalizeUpper = (value) => normalize(value).toUpperCase();
const idOf = (value) => String(value?._id || value?.id || value || '').trim();

const isFazerCardsProvider = ({ product = {}, providerProduct = {}, provider = {} } = {}) => {
    const candidates = [
        product.providerCode,
        providerProduct.providerCode,
        provider.providerCode,
        provider.code,
        provider.slug,
        provider.name,
    ].map(normalizeUpper);
    return candidates.some((value) => value === PROVIDER_CODES.FAZER_CARDS || value === 'FAZERCARDS' || value === 'FAZER-CARDS');
};

const categoryForContractCode = (code = '') => {
    if (/^AUTO_PROVIDER_REQUIRES_(ACTIVE_PRODUCT|VISIBLE_PRODUCT|AVAILABLE_PRODUCT|CUSTOMER_PURCHASE_ENABLED)/.test(code)) {
        return 'CUSTOMER_ELIGIBILITY';
    }
    if (/^(AUTO_PROVIDER_REQUIRES_|AUTO_PROVIDER_(TOPUP|GIFTCARD|GAMEKEY|TELEGRAM|STEAM|MANUAL_SERVICE|QUANTITY|STOCK|PROVIDER_COST)|CONTRACT_AUTO_EXECUTION)/.test(code)) {
        return 'CATALOG_COMPATIBILITY';
    }
    return 'AUTOMATIC_EXECUTION';
};

const addReason = (target, reason) => {
    if (!reason?.code) return;
    if (target.some((item) => item.code === reason.code)) return;
    target.push(reason);
};

const evaluateFazerCardsReadiness = ({
    product = {},
    providerProduct = null,
    provider = null,
    operation = READINESS_OPERATIONS.ADMIN_AUTO_CONFIGURATION,
    runtimeConfig = config.providers.fazerCards,
    purchaseContext = {},
} = {}) => {
    const configuration = [];
    const catalog = [];
    const customer = [];
    const automatic = [];
    const runtime = [];
    const reasons = [];
    const familyKey = normalizeUpper(product?.familyKey || providerProduct?.familyKey);
    const fulfillmentMode = normalizeUpper(product?.fulfillmentMode || providerProduct?.fulfillmentMode);
    const effectiveProvider = provider || (product?.provider && typeof product.provider === 'object' ? product.provider : null);
    const isFazerCards = isFazerCardsProvider({ product, providerProduct: providerProduct || {}, provider: effectiveProvider || {} });

    const add = (bucket, code, message, category) => {
        const reason = { code, message, category };
        addReason(bucket, reason);
        addReason(reasons, reason);
    };

    if (!isFazerCards) {
        add(catalog, 'FAZERCARDS_PRODUCT_REQUIRED', 'The product is not linked to FazerCards.', 'CATALOG_COMPATIBILITY');
        return {
            ready: false,
            operation,
            familyKey,
            fulfillmentMode,
            configuration: { ready: configuration.length === 0, reasons: configuration },
            catalog: { ready: catalog.length === 0, reasons: catalog },
            customerPurchase: { ready: customer.length === 0, reasons: customer },
            automaticExecution: { ready: automatic.length === 0, reasons: automatic },
            runtime: { knownReady: runtime.length === 0, uncertain: runtime },
            reasons,
        };
    }

    if (runtimeConfig?.enabled !== true) {
        add(configuration, 'FAZERCARDS_DISABLED', 'FazerCards integration is disabled.', 'CONFIGURATION');
    }
    if (runtimeConfig?.realOrdersEnabled !== true) {
        add(configuration, 'FAZERCARDS_REAL_ORDERS_DISABLED', 'FazerCards real orders are disabled by the global safety gate.', 'CONFIGURATION');
    }
    if (fulfillmentMode === 'CODE_DELIVERY' && runtimeConfig?.codeDeliveryEnabled !== true) {
        add(configuration, 'FAZERCARDS_CODE_DELIVERY_DISABLED', 'FazerCards code delivery is disabled by the global safety gate.', 'CONFIGURATION');
    }
    if (effectiveProvider?.isActive === false) {
        add(configuration, 'PROVIDER_INACTIVE', 'The linked FazerCards provider is inactive.', 'CONFIGURATION');
    }
    if (!product?.provider) {
        add(configuration, 'FAZERCARDS_PROVIDER_REQUIRED', 'Automatic FazerCards execution requires a linked provider.', 'CONFIGURATION');
    }
    if (!providerProduct?.provider) {
        add(catalog, 'FAZERCARDS_PROVIDER_PRODUCT_PROVIDER_MISSING', 'The linked FazerCards ProviderProduct has no provider ownership.', 'CATALOG_COMPATIBILITY');
    }

    if (product?.providerExecutionMode !== fazerCardsContracts.PROVIDER_EXECUTION_MODES.AUTO_PROVIDER) {
        add(automatic, 'FAZERCARDS_PROVIDER_EXECUTION_MODE_INVALID', 'FazerCards automatic execution requires providerExecutionMode=AUTO_PROVIDER.', 'AUTOMATIC_EXECUTION');
    }
    if (product?.providerExecutionEnabled !== true) {
        add(automatic, 'FAZERCARDS_PROVIDER_EXECUTION_DISABLED', 'FazerCards automatic execution is disabled for this product.', 'AUTOMATIC_EXECUTION');
    }
    if (product?.providerExecutionBlocked === true) {
        add(automatic, 'FAZERCARDS_PROVIDER_EXECUTION_BLOCKED', product?.providerBlockReason || 'FazerCards automatic execution is blocked for this product.', 'AUTOMATIC_EXECUTION');
    }

    const sourceAvailability = normalizeUpper(providerProduct?.sourceAvailability);
    if (sourceAvailability === 'EXPLICITLY_UNAVAILABLE' || sourceAvailability === 'MISSING_CONFIRMED') {
        add(catalog,
            `FAZERCARDS_SOURCE_${sourceAvailability}`,
            providerProduct?.sourceAvailabilityReason || 'FazerCards has authoritatively marked this offer unavailable.',
            'CATALOG_COMPATIBILITY');
    }

    const productProviderId = idOf(product?.provider);
    const providerProductProviderId = idOf(providerProduct?.provider);
    if (productProviderId && providerProductProviderId && productProviderId !== providerProductProviderId) {
        add(catalog, 'PROVIDER_LINK_MISMATCH', 'The linked ProviderProduct belongs to a different provider.', 'CATALOG_COMPATIBILITY');
    }

    const contractReadiness = fazerCardsContracts.validateAutoProviderReadinessForProduct({
        product,
        providerProduct,
        familyKey,
        requireCustomerVisible: true,
    });
    for (const error of contractReadiness.errors || []) {
        const category = categoryForContractCode(error.code);
        const bucket = category === 'CUSTOMER_ELIGIBILITY'
            ? customer
            : category === 'CATALOG_COMPATIBILITY' ? catalog : automatic;
        add(bucket, error.code, error.message, category);
    }

    if (product?.isPaused === true) {
        add(customer, 'PRODUCT_PAUSED', 'The product is paused.', 'CUSTOMER_ELIGIBILITY');
    }
    if (product?.isAvailableForApi === false) {
        add(customer, 'PRODUCT_API_UNAVAILABLE', 'The product is unavailable for customer purchase.', 'CUSTOMER_ELIGIBILITY');
    }

    const requestedQuantity = purchaseContext?.quantity;
    if (requestedQuantity !== undefined && requestedQuantity !== null) {
        const quantity = Number(requestedQuantity);
        const minQty = Number(providerProduct?.minQty ?? product?.minQty ?? 1);
        const maxQty = Number(providerProduct?.maxQty ?? product?.maxQty ?? Number.MAX_SAFE_INTEGER);
        const stock = providerProduct?.stock === null || providerProduct?.stock === undefined ? null : Number(providerProduct.stock);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity < minQty || quantity > maxQty) {
            add(catalog, 'FAZERCARDS_QUANTITY_NOT_ALLOWED', 'The requested quantity is outside the FazerCards offer limits.', 'CATALOG_COMPATIBILITY');
        }
        if (stock !== null && Number.isFinite(stock) && quantity > stock) {
            add(catalog, 'FAZERCARDS_STOCK_INSUFFICIENT', 'The requested quantity exceeds the known FazerCards stock.', 'CATALOG_COMPATIBILITY');
        }
    }

    const configurationReady = configuration.length === 0;
    const catalogReady = catalog.length === 0;
    const customerReady = customer.length === 0;
    const automaticReady = automatic.length === 0;
    const canConfigureAutomaticExecution = catalogReady && customerReady && automaticReady;
    const ready = operation === READINESS_OPERATIONS.CUSTOMER_AUTOMATIC_PURCHASE
        ? canConfigureAutomaticExecution && configurationReady
        : canConfigureAutomaticExecution;

    return {
        ready,
        canConfigureAutomaticExecution,
        canExecuteAutomatically: canConfigureAutomaticExecution && configurationReady,
        operation,
        familyKey: contractReadiness.familyKey || familyKey,
        fulfillmentMode,
        identifiers: contractReadiness.identifiers || {},
        configuration: { ready: configurationReady, reasons: configuration },
        catalog: { ready: catalogReady, reasons: catalog },
        customerPurchase: { ready: customerReady, reasons: customer },
        automaticExecution: { ready: automaticReady, reasons: automatic },
        // Network reachability, provider balance, and an actual supplier
        // response are intentionally not evaluated here.
        runtime: { knownReady: runtime.length === 0, uncertain: runtime },
        reasons,
    };
};

module.exports = {
    READINESS_OPERATIONS,
    evaluateFazerCardsReadiness,
    isFazerCardsProvider,
};
