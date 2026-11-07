'use strict';

const mongoose = require('mongoose');

const CHECKOUT_QUOTE_STATUS = Object.freeze({
    ACTIVE: 'ACTIVE',
    CONSUMED: 'CONSUMED',
});

// Immutable customer-consent snapshot. Monetary values are strings so the
// quote is compared with the same decimal helpers used by order pricing.
const checkoutQuoteSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    quantity: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    payableAmount: { type: String, required: true },
    totalUsd: { type: String, required: true },
    customerUnitPriceUsd: { type: String, required: true },
    basePriceSnapshot: { type: String, required: true },
    markupPercentage: { type: String, required: true },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', default: null },
    groupPercentage: { type: String, default: '0' },
    purchaseRateSnapshot: { type: String, required: true },
    rateType: { type: String, required: true },
    status: { type: String, enum: Object.values(CHECKOUT_QUOTE_STATUS), default: CHECKOUT_QUOTE_STATUS.ACTIVE, index: true },
    expiresAt: { type: Date, required: true, index: true },
    consumedAt: { type: Date, default: null },
    consumedOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
}, { timestamps: true });

checkoutQuoteSchema.index({ userId: 1, status: 1, expiresAt: 1 });

const CheckoutQuote = mongoose.model('CheckoutQuote', checkoutQuoteSchema);

module.exports = { CheckoutQuote, CHECKOUT_QUOTE_STATUS };
