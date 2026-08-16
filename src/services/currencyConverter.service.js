'use strict';

/**
 * Stateless currency conversion utilities.
 *
 * Rates follow the convention: 1 USD = <rate> units of the target currency.
 * marketRate is reference-only. platformRate is retained as a legacy fallback.
 */

const { Currency } = require('../modules/currency/currency.model');
const { NotFoundError, BusinessRuleError } = require('../shared/errors/AppError');

const RATE_PURPOSES = Object.freeze({
    DEPOSIT: 'deposit',
    PURCHASE: 'purchase',
    LEGACY: 'legacy',
    PLATFORM: 'platform',
});

const _cache = new Map();
const CACHE_TTL_MS = 60_000;

const normalizePurpose = (purpose = RATE_PURPOSES.LEGACY) => {
    const normalized = String(purpose || RATE_PURPOSES.LEGACY).trim().toLowerCase();
    if ([
        RATE_PURPOSES.DEPOSIT,
        RATE_PURPOSES.PURCHASE,
        RATE_PURPOSES.LEGACY,
        RATE_PURPOSES.PLATFORM,
    ].includes(normalized)) {
        return normalized;
    }
    throw new BusinessRuleError(`Unsupported currency rate purpose '${purpose}'.`, 'INVALID_RATE_PURPOSE');
};

const _getCurrency = async (code, bypassCache = false) => {
    const upper = (code ?? '').toUpperCase().trim();
    if (!upper) throw new BusinessRuleError('Currency code is required.', 'MISSING_CURRENCY_CODE');
    if (upper === 'USD') return null;

    if (!bypassCache) {
        const cached = _cache.get(upper);
        if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
            return cached.doc;
        }
    }

    const doc = await Currency.findOne({ code: upper });
    if (!doc) throw new NotFoundError(`Currency '${upper}'`);
    if (!doc.isActive) {
        throw new BusinessRuleError(
            `Currency '${upper}' is currently inactive.`,
            'CURRENCY_INACTIVE'
        );
    }

    _cache.set(upper, { doc, cachedAt: Date.now() });
    return doc;
};

const getRateFromCurrencyDoc = (currDoc, purpose = RATE_PURPOSES.LEGACY) => {
    if (!currDoc) return 1;

    const normalized = normalizePurpose(purpose);
    const candidate = normalized === RATE_PURPOSES.DEPOSIT
        ? currDoc.depositRate ?? currDoc.platformRate
        : normalized === RATE_PURPOSES.PURCHASE
            ? currDoc.purchaseRate ?? currDoc.platformRate
            : currDoc.platformRate ?? currDoc.purchaseRate ?? currDoc.depositRate;

    const rate = Number(candidate);
    if (!Number.isFinite(rate) || rate <= 0) {
        throw new BusinessRuleError(
            `Currency '${currDoc.code}' does not have a valid ${normalized} rate.`,
            'INVALID_CURRENCY_RATE'
        );
    }
    return rate;
};

const invalidateCurrencyCache = (code) => {
    _cache.delete((code ?? '').toUpperCase().trim());
};

const convertUsdToUserCurrency = async (usdAmount, userCurrency, options = {}) => {
    if (typeof usdAmount !== 'number' || usdAmount < 0) {
        throw new BusinessRuleError('usdAmount must be a non-negative number.', 'INVALID_AMOUNT');
    }

    const rateType = normalizePurpose(options.purpose || RATE_PURPOSES.PURCHASE);
    const currDoc = await _getCurrency(userCurrency);
    const rate = getRateFromCurrencyDoc(currDoc, rateType);

    return {
        usdAmount,
        currency: currDoc ? currDoc.code : 'USD',
        rate,
        rateType,
        finalAmount: parseFloat((usdAmount * rate).toFixed(currDoc ? 4 : 6)),
    };
};

const convertUserCurrencyToUsd = async (amount, userCurrency, options = {}) => {
    if (typeof amount !== 'number' || amount < 0) {
        throw new BusinessRuleError('amount must be a non-negative number.', 'INVALID_AMOUNT');
    }

    const rateType = normalizePurpose(options.purpose || RATE_PURPOSES.LEGACY);
    const currDoc = await _getCurrency(userCurrency);
    const rate = getRateFromCurrencyDoc(currDoc, rateType);

    return {
        originalAmount: amount,
        currency: currDoc ? currDoc.code : 'USD',
        rate,
        rateType,
        usdAmount: parseFloat((amount / rate).toFixed(currDoc ? 6 : 2)),
    };
};

const getRateForPurpose = async (currencyCode, purpose = RATE_PURPOSES.LEGACY) => {
    const currDoc = await _getCurrency(currencyCode);
    return getRateFromCurrencyDoc(currDoc, purpose);
};

const getDepositRate = (currencyCode) => getRateForPurpose(currencyCode, RATE_PURPOSES.DEPOSIT);

const getPurchaseRate = (currencyCode) => getRateForPurpose(currencyCode, RATE_PURPOSES.PURCHASE);

const getConversionRate = (currencyCode, purpose = RATE_PURPOSES.LEGACY) => getRateForPurpose(currencyCode, purpose);

module.exports = {
    RATE_PURPOSES,
    convertUsdToUserCurrency,
    convertUserCurrencyToUsd,
    getDepositRate,
    getPurchaseRate,
    getRateForPurpose,
    getConversionRate,
    invalidateCurrencyCache,
    _getCurrency,
    getRateFromCurrencyDoc,
};
