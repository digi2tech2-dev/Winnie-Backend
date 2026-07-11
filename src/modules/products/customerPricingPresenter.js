'use strict';

const { multiply, toDecimal, toFiat, compare, subtract, divide } = require('../../shared/utils/decimalPrecision');

const formatAmount = (amount) => Number(amount || 0).toFixed(2);

const formatDisplayMoney = (amount, currency) => `${String(currency || 'USD').toUpperCase()} ${formatAmount(amount)}`;

const calculateDiscount = (basePrice, finalPrice) => {
    if (compare(basePrice, '0') <= 0 || compare(finalPrice, '0') <= 0 || compare(finalPrice, basePrice) >= 0) {
        return { hasDiscount: false, discountPercent: 0 };
    }

    const discount = toDecimal(divide(subtract(basePrice, finalPrice), basePrice)).times(100);
    const rounded = Number(discount.toDecimalPlaces(2).toNumber());

    return {
        hasDiscount: rounded > 0,
        discountPercent: rounded,
    };
};

const buildCustomerPricingFields = ({
    product,
    unitPriceUsd,
    productFinalUnitPriceUsd,
    groupPercentage = 0,
    customerUnitPriceUsd,
    currency = 'USD',
    rate = 1,
}) => {
    const minQty = Math.max(1, Number(product.minQty) || 1);
    const safeCurrency = String(currency || 'USD').toUpperCase();
    const safeProductFinalUnitPriceUsd = String(productFinalUnitPriceUsd ?? unitPriceUsd ?? product.finalPrice ?? product.basePrice ?? '0');
    const safeCustomerUnitPriceUsd = String(customerUnitPriceUsd ?? unitPriceUsd ?? safeProductFinalUnitPriceUsd);
    const minTotalUsd = multiply(safeCustomerUnitPriceUsd, String(minQty));
    const unitPriceCustomerCurrency = toDecimal(safeCustomerUnitPriceUsd).times(rate);
    const minTotalCustomerCurrency = toFiat(toDecimal(minTotalUsd).times(rate));
    const unitRounded = toFiat(unitPriceCustomerCurrency);
    const priceDisplayMode = minQty > 1 || unitRounded === 0 ? 'min_total' : 'unit';
    const displayPriceLabel = priceDisplayMode === 'min_total'
        ? `${minQty.toLocaleString('en-US')} = ${formatDisplayMoney(minTotalCustomerCurrency, safeCurrency)}`
        : formatDisplayMoney(unitRounded, safeCurrency);
    const discount = calculateDiscount(product.basePrice ?? safeProductFinalUnitPriceUsd, safeProductFinalUnitPriceUsd);

    return {
        basePrice: String(product.basePrice ?? '0'),
        finalPrice: safeCustomerUnitPriceUsd,
        finalPriceUsd: safeCustomerUnitPriceUsd,
        unitPriceUsd: safeCustomerUnitPriceUsd,
        productFinalUnitPriceUsd: safeProductFinalUnitPriceUsd,
        groupPercentage: Number.isFinite(Number(groupPercentage)) ? Number(groupPercentage) : 0,
        customerUnitPriceUsd: safeCustomerUnitPriceUsd,
        minTotalUsd,
        minTotalCustomerCurrency,
        customerCurrency: safeCurrency,
        displayCurrency: safeCurrency,
        displayPrice: priceDisplayMode === 'min_total' ? minTotalCustomerCurrency : unitRounded,
        displayPriceLabel,
        minTotalDisplay: formatDisplayMoney(minTotalCustomerCurrency, safeCurrency),
        unitPriceDisplay: formatDisplayMoney(unitRounded, safeCurrency),
        priceDisplayMode,
        hasDiscount: discount.hasDiscount,
        discountPercent: discount.discountPercent,
        discountPercentage: discount.discountPercent,
    };
};

module.exports = {
    buildCustomerPricingFields,
    calculateDiscount,
};
