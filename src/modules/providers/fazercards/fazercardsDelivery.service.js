'use strict';

const { ProviderDeliveredCode, DELIVERY_STATUSES } = require('./providerDeliveredCode.model');
const { FULFILLMENT_MODES } = require('../providerProduct.model');
const { PROVIDER_CODES } = require('../provider.constants');
const { Order } = require('../../orders/order.model');
const { BusinessRuleError, NotFoundError } = require('../../../shared/errors/AppError');
const {
    extractDeliveredCodes,
    redactSecrets,
} = require('./fazercardsContracts');

const CODE_DELIVERY_FAMILIES = new Set(['GIFTCARDS', 'GAME_KEYS']);

const sanitizeProviderCodePayload = (value) => redactSecrets(value);

const storeDeliveredCodesForOrder = async ({
    order,
    providerDoc = null,
    providerProduct,
    product,
    familyKey,
    rawResponse,
} = {}) => {
    const deliveredCodes = extractDeliveredCodes(rawResponse);
    const stored = [];
    const existing = order?._id
        ? await ProviderDeliveredCode.find({ order: order._id }).select('+codeEncrypted +serialEncrypted +pinEncrypted')
        : [];
    const seen = new Set(existing.map((doc) => {
        const code = doc.codeEncrypted ? doc.getSecretValue('codeEncrypted') : '';
        const pin = doc.pinEncrypted ? doc.getSecretValue('pinEncrypted') : '';
        const serial = doc.serialEncrypted ? doc.getSecretValue('serialEncrypted') : '';
        return [code, pin, serial].join('|');
    }));

    for (const delivered of deliveredCodes) {
        const dedupeKey = [delivered.code || '', delivered.pin || '', delivered.serial || ''].join('|');
        if (!dedupeKey.replace(/\|/g, '') || seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const doc = new ProviderDeliveredCode({
            order: order._id,
            provider: providerDoc?._id || product?.provider || providerProduct?.provider || null,
            providerCode: PROVIDER_CODES.FAZER_CARDS,
            providerProduct: providerProduct?._id || product?.providerProduct || null,
            product: product?._id || order.productId || null,
            familyKey,
            fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
            metadata: sanitizeProviderCodePayload(delivered.metadata),
            providerRawResponse: sanitizeProviderCodePayload(rawResponse),
            deliveryStatus: DELIVERY_STATUSES.DELIVERED,
            deliveredAt: new Date(),
        });

        if (delivered.code) doc.setSecretValue('codeEncrypted', delivered.code);
        if (delivered.pin) doc.setSecretValue('pinEncrypted', delivered.pin);
        if (delivered.serial) doc.setSecretValue('serialEncrypted', delivered.serial);

        await doc.save();
        stored.push({
            hasPin: Boolean(delivered.pin),
            hasSerial: Boolean(delivered.serial),
        });
    }

    return {
        deliveredCodeCount: stored.length,
        hasPin: stored.some((item) => item.hasPin),
        hasSerial: stored.some((item) => item.hasSerial),
        storedEncrypted: stored.length > 0,
    };
};

const storeManualDeliveredCodeForOrder = async ({
    orderId,
    code,
    pin = null,
    serial = null,
    metadata = null,
} = {}) => {
    const order = await Order.findById(orderId)
        .populate('productId', 'name provider providerProduct providerCode familyKey fulfillmentMode')
        .populate({
            path: 'productId',
            populate: { path: 'providerProduct', select: 'provider familyKey fulfillmentMode providerCode' },
        });
    if (!order) throw new NotFoundError('Order');

    const product = order.productId;
    const providerProduct = product?.providerProduct;
    const familyKey = String(order.familyKey || product?.familyKey || providerProduct?.familyKey || '').trim().toUpperCase();
    const fulfillmentMode = String(order.fulfillmentMode || product?.fulfillmentMode || providerProduct?.fulfillmentMode || '').trim().toUpperCase();
    const providerCode = String(product?.providerCode || providerProduct?.providerCode || '').trim().toUpperCase();

    if (providerCode !== PROVIDER_CODES.FAZER_CARDS || fulfillmentMode !== FULFILLMENT_MODES.CODE_DELIVERY || !CODE_DELIVERY_FAMILIES.has(familyKey)) {
        throw new BusinessRuleError(
            'Manual delivered-code storage is only available for FazerCards GiftCards/GameKeys orders.',
            'ORDER_NOT_FAZERCARDS_CODE_DELIVERY'
        );
    }

    if (!code && !pin && !serial) {
        throw new BusinessRuleError('code, pin, or serial is required.', 'DELIVERED_CODE_SECRET_REQUIRED');
    }

    const doc = new ProviderDeliveredCode({
        order: order._id,
        provider: product?.provider || providerProduct?.provider || null,
        providerCode: PROVIDER_CODES.FAZER_CARDS,
        providerProduct: providerProduct?._id || product?.providerProduct || null,
        product: product?._id || null,
        familyKey,
        fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
        metadata: sanitizeProviderCodePayload(metadata || { source: 'admin_manual_entry' }),
        deliveryStatus: DELIVERY_STATUSES.DELIVERED,
        deliveredAt: new Date(),
    });

    if (code) doc.setSecretValue('codeEncrypted', code);
    if (pin) doc.setSecretValue('pinEncrypted', pin);
    if (serial) doc.setSecretValue('serialEncrypted', serial);
    await doc.save();

    return {
        id: doc._id.toString(),
        orderId: order._id.toString(),
        deliveryStatus: doc.deliveryStatus,
        familyKey,
        fulfillmentMode: doc.fulfillmentMode,
        hasCode: Boolean(code),
        hasPin: Boolean(pin),
        hasSerial: Boolean(serial),
        storedEncrypted: true,
        deliveredAt: doc.deliveredAt,
    };
};

module.exports = {
    sanitizeProviderCodePayload,
    storeDeliveredCodesForOrder,
    storeManualDeliveredCodeForOrder,
};
