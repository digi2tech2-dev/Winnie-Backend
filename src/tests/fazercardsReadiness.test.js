'use strict';

const {
    evaluateFazerCardsReadiness,
    READINESS_OPERATIONS,
} = require('../modules/providers/fazercards/fazercardsReadiness.service');

const enabledRuntime = {
    enabled: true,
    realOrdersEnabled: true,
    codeDeliveryEnabled: true,
};

const buildFixture = (overrides = {}) => ({
    product: {
        provider: 'provider-a',
        providerCode: 'FAZER_CARDS',
        providerExecutionMode: 'AUTO_PROVIDER',
        providerExecutionEnabled: true,
        providerExecutionBlocked: false,
        isActive: true,
        visibleInStore: true,
        status: 'available',
        customerPurchaseEnabled: true,
        familyKey: 'GIFTCARDS',
        fulfillmentMode: 'CODE_DELIVERY',
        minQty: 1,
        maxQty: 100,
        ...overrides.product,
    },
    provider: { _id: 'provider-a', providerCode: 'FAZER_CARDS', isActive: true, ...overrides.provider },
    providerProduct: {
        provider: 'provider-a',
        providerCode: 'FAZER_CARDS',
        // These two raw catalog values intentionally do not block a valid
        // existing gift-card execution contract.
        isActive: false,
        supportLevel: 'CATALOG_ONLY',
        isSupported: true,
        isBlocked: false,
        executionBlocked: false,
        costPrice: '19.5031',
        stock: 2477,
        minQty: 1,
        maxQty: 100,
        familyKey: 'GIFTCARDS',
        fulfillmentMode: 'CODE_DELIVERY',
        externalProductId: 'FAZER_GIFTCARD:steam_wallet_test:75_test',
        category: 'steam_wallet_test',
        offerId: '75_test',
        ...overrides.providerProduct,
    },
});

const evaluate = (overrides = {}) => {
    const fixture = buildFixture(overrides);
    return evaluateFazerCardsReadiness({
        ...fixture,
        operation: READINESS_OPERATIONS.CUSTOMER_AUTOMATIC_PURCHASE,
        runtimeConfig: { ...enabledRuntime, ...overrides.runtimeConfig },
        purchaseContext: { quantity: 1, ...overrides.purchaseContext },
    });
};

describe('FazerCards deterministic readiness', () => {
    it('accepts an existing GIFTCARDS link despite raw inactive/CATALOG_ONLY catalog metadata', () => {
        const readiness = evaluate();

        expect(readiness.ready).toBe(true);
        expect(readiness.reasons.map((reason) => reason.code)).not.toContain('PROVIDER_PRODUCT_INACTIVE');
        expect(readiness.reasons.map((reason) => reason.code)).not.toContain('CATALOG_ONLY');
    });

    it('rejects unsupported or execution-blocked offers', () => {
        expect(evaluate({ providerProduct: { isSupported: false } }).reasons)
            .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'AUTO_PROVIDER_REQUIRES_SUPPORTED_PROVIDER_PRODUCT' })]));
        expect(evaluate({ providerProduct: { executionBlocked: true } }).reasons)
            .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'AUTO_PROVIDER_REQUIRES_EXECUTION_UNBLOCKED' })]));
    });

    it('reports deterministic global gates before a customer can be debited', () => {
        expect(evaluate({ runtimeConfig: { realOrdersEnabled: false } }).reasons)
            .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'FAZERCARDS_REAL_ORDERS_DISABLED' })]));
        expect(evaluate({ runtimeConfig: { codeDeliveryEnabled: false } }).reasons)
            .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'FAZERCARDS_CODE_DELIVERY_DISABLED' })]));
    });

    it('rejects provider ownership mismatches and invalid requested quantity', () => {
        expect(evaluate({ providerProduct: { provider: 'provider-b' } }).reasons)
            .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PROVIDER_LINK_MISMATCH' })]));
        expect(evaluate({ purchaseContext: { quantity: 101 } }).reasons)
            .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'FAZERCARDS_QUANTITY_NOT_ALLOWED' })]));
    });

    it('rejects authoritatively unavailable and confirmed-missing source offers before debit', () => {
        for (const sourceAvailability of ['EXPLICITLY_UNAVAILABLE', 'MISSING_CONFIRMED']) {
            const readiness = evaluate({ providerProduct: { sourceAvailability } });
            expect(readiness.ready).toBe(false);
            expect(readiness.reasons).toEqual(expect.arrayContaining([
                expect.objectContaining({ code: `FAZERCARDS_SOURCE_${sourceAvailability}` }),
            ]));
        }
    });

    it('does not reject unknown or first-snapshot pending absence', () => {
        expect(evaluate({ providerProduct: { sourceAvailability: 'UNKNOWN' } }).ready).toBe(true);
        expect(evaluate({ providerProduct: { sourceAvailability: 'MISSING_PENDING' } }).ready).toBe(true);
    });

    it('rejects finite zero and requested quantity above known stock, but not unknown stock', () => {
        expect(evaluate({ providerProduct: { stock: 0 } }).reasons)
            .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'FAZERCARDS_STOCK_INSUFFICIENT' })]));
        expect(evaluate({ providerProduct: { stock: 2 }, purchaseContext: { quantity: 3 } }).reasons)
            .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'FAZERCARDS_STOCK_INSUFFICIENT' })]));
        expect(evaluate({ providerProduct: { stock: null } }).ready).toBe(true);
    });
});
