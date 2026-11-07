'use strict';

const { ProviderDeliveredCode, DELIVERY_STATUSES } = require('../fazercards/providerDeliveredCode.model');
const { PROVIDER_CODES } = require('../provider.constants');
const { FULFILLMENT_MODES } = require('../providerProduct.model');

const storeLubanDeliveredCodes = async ({ order, product, providerProduct, providerDoc, deliveredCodes = [] } = {}) => {
    const existing = await ProviderDeliveredCode.find({ order: order._id })
        .select('+codeEncrypted +pinEncrypted +serialEncrypted');
    const seen = new Set(existing.map((doc) => [
        doc.codeEncrypted ? doc.getSecretValue('codeEncrypted') : '',
        doc.pinEncrypted ? doc.getSecretValue('pinEncrypted') : '',
        doc.serialEncrypted ? doc.getSecretValue('serialEncrypted') : '',
    ].join('|')));

    let stored = 0;
    for (const item of deliveredCodes) {
        const code = item?.code || null;
        const pin = item?.pin || null;
        const serial = item?.serial || null;
        const key = [code || '', pin || '', serial || ''].join('|');
        if (!key.replace(/\|/g, '') || seen.has(key)) continue;
        seen.add(key);

        const doc = new ProviderDeliveredCode({
            order: order._id,
            provider: providerDoc?._id || product?.provider || providerProduct?.provider || null,
            providerCode: PROVIDER_CODES.LUBAN_PLAY,
            providerProduct: providerProduct?._id || product?.providerProduct || null,
            product: product?._id || order.productId || null,
            familyKey: 'GIFTCARDS',
            fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
            metadata: { expirationDate: item?.expirationDate || null },
            deliveryStatus: DELIVERY_STATUSES.DELIVERED,
            deliveredAt: new Date(),
        });
        if (code) doc.setSecretValue('codeEncrypted', code);
        if (pin) doc.setSecretValue('pinEncrypted', pin);
        if (serial) doc.setSecretValue('serialEncrypted', serial);
        await doc.save();
        stored += 1;
    }
    return { deliveredCodeCount: stored + existing.length, storedEncrypted: stored > 0 };
};

module.exports = { storeLubanDeliveredCodes };
