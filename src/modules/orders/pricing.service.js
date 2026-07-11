'use strict';

/**
 * pricing.service.js — Pure Pricing Engine (Arbitrary Precision)
 * ──────────────────────────────────────────────────────────────
 * All functions here are pure where possible (no side effects, no DB).
 * calculateUserPrice is the only one that touches the DB.
 *
 * Single source of truth for markup math — used by order.service.js
 * at order creation time to produce the price snapshots burned into
 * each Order document.
 *
 * Prices are STRING throughout (up to 50 dp). Only chargedAmount is
 * a 2 dp Number because wallet balances are standard fiat.
 */

const { BusinessRuleError } = require('../../shared/errors/AppError');
const { resolveUserPricingGroup } = require('../groups/group.service');
const { Decimal, toDecimal, toStr, isPositive, multiply, add } = require('../../shared/utils/decimalPrecision');

// ─────────────────────────────────────────────────────────────────────────────
// PURE CALCULATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the final price after applying a group markup percentage.
 *
 * Rules:
 *  - basePrice must be >= 0 (string or number)
 *  - percentage must be >= 0
 *  - finalPrice = basePrice + (basePrice × percentage / 100)
 *
 * @param {string|number} basePrice   - Raw product price (>= 0)
 * @param {number}        percentage  - Group markup percentage (>= 0)
 * @returns {string} finalPrice as an arbitrary-precision string
 * @throws {BusinessRuleError} if inputs are invalid
 */
const calculateFinalPrice = (basePrice, percentage) => {
    const base = toDecimal(basePrice);
    if (base.isNegative()) {
        throw new BusinessRuleError(
            'basePrice must be a non-negative number.',
            'INVALID_BASE_PRICE'
        );
    }
    let pct;
    try {
        if (percentage === null || percentage === undefined || percentage === '') {
            throw new Error('Missing percentage');
        }
        pct = new Decimal(percentage);
    } catch {
        throw new BusinessRuleError(
            'percentage must be a non-negative number.',
            'INVALID_PERCENTAGE'
        );
    }

    if (!pct.isFinite() || pct.isNegative()) {
        throw new BusinessRuleError(
            'percentage must be a non-negative number.',
            'INVALID_PERCENTAGE'
        );
    }

    // basePrice + basePrice * (percentage / 100)
    const markup = multiply(basePrice, toStr(pct.dividedBy(100)));
    return add(basePrice, markup);
};

const getProductFinalUnitPrice = (product) => {
    const candidate = product?.finalPrice ?? product?.basePrice ?? product?.providerPrice ?? '0';
    return isPositive(candidate) || toDecimal(candidate).isZero() ? String(candidate) : '0';
};

const getProviderCostUnitPrice = (product) => {
    const candidate = product?.providerPrice ?? product?.basePrice ?? product?.finalPrice ?? '0';
    return isPositive(candidate) || toDecimal(candidate).isZero() ? String(candidate) : '0';
};

// ─────────────────────────────────────────────────────────────────────────────
// DB-BACKED CALCULATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the effective price for a specific user by looking up their
 * group's markup percentage, then applying calculateFinalPrice.
 *
 * @param {string|ObjectId} userId    - The buying user's ID
 * @param {string|number}   productFinalUnitPriceUsd - Product-level final unit price
 * @param {Object}          [session] - Optional Mongoose session (for transactions)
 * @param {Object}          [options]
 * @param {string|number}   [options.baseUnitPriceUsd] - Provider/base cost snapshot
 * @returns {Promise<{
 *   basePrice:        string,
 *   markupPercentage: number,
 *   finalPrice:       string,
 *   groupId:          ObjectId|null
 * }>}
 */
const calculateUserPrice = async (userId, productFinalUnitPriceUsd, session = null, options = {}) => {
    const groupPricing = await resolveUserPricingGroup(userId, { session });
    const markupPercentage = groupPricing.percentage;
    const safeProductFinal = isPositive(productFinalUnitPriceUsd) || toDecimal(productFinalUnitPriceUsd).isZero()
        ? String(productFinalUnitPriceUsd)
        : '0';
    const safeBasePrice = options.baseUnitPriceUsd !== undefined
        && (isPositive(options.baseUnitPriceUsd) || toDecimal(options.baseUnitPriceUsd).isZero())
        ? String(options.baseUnitPriceUsd)
        : safeProductFinal;

    const finalPrice = calculateFinalPrice(safeProductFinal, markupPercentage);

    return {
        basePrice: safeBasePrice,
        baseUnitPriceUsd: safeBasePrice,
        productFinalUnitPriceUsd: safeProductFinal,
        markupPercentage,
        groupPercentage: markupPercentage,
        finalPrice,
        customerUnitPriceUsd: finalPrice,
        groupId: groupPricing.groupId,
        groupName: groupPricing.groupName,
    };
};

module.exports = {
    calculateFinalPrice,
    calculateUserPrice,
    getProductFinalUnitPrice,
    getProviderCostUnitPrice,
};
