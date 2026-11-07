'use strict';

const crypto = require('crypto');
const { Order, ORDER_STATUS } = require('../../orders/order.model');

const normalizeFamily = (family) => String(family || 'order').trim().toUpperCase();
const buildFazerCardsProviderIdempotencyKey = (order, family) => {
    if (order.providerIdempotencyKey) return order.providerIdempotencyKey;
    const suffix = order._id.toString();
    const key = normalizeFamily(family);
    if (key === 'GIFTCARDS' || key === 'GAME_KEYS') return `fazercards:code-delivery:${suffix}`;
    if (key === 'STEAM_GIFTS') return `fazercards:steam-gift:${suffix}`;
    if (key === 'MANUAL_SERVICES') return `fazercards:manual-service:${suffix}`;
    if (key === 'STEAM_TOPUP') return `fazercards:steam-topup:${suffix}`;
    if (key === 'TELEGRAM') return `fazercards:telegram-unknown:${suffix}`;
    return `fazercards:${key.toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${suffix}`;
};

const claimFazerCardsPlacement = async ({ order, family }) => {
    const ownerToken = crypto.randomUUID();
    const providerIdempotencyKey = buildFazerCardsProviderIdempotencyKey(order, family);
    const claimed = await Order.findOneAndUpdate({
        _id: order._id,
        status: ORDER_STATUS.PROCESSING,
        providerOrderId: null,
        $or: [
            { fazerCardsPlacementState: { $exists: false } },
            { fazerCardsPlacementState: null },
            { fazerCardsPlacementState: 'UNCLAIMED' },
        ],
    }, {
        $set: {
            fazerCardsPlacementState: 'CLAIMED',
            fazerCardsPlacementOwner: ownerToken,
            fazerCardsPlacementClaimedAt: new Date(),
            providerIdempotencyKey,
        },
    }, { new: true });

    if (claimed) return { claimed: true, ownerToken, providerIdempotencyKey, order: claimed };
    return { claimed: false, current: await Order.findById(order._id) };
};

const markFazerCardsPlacementSubmitted = ({ orderId, ownerToken }) => Order.findOneAndUpdate({
    _id: orderId,
    fazerCardsPlacementState: 'CLAIMED',
    fazerCardsPlacementOwner: ownerToken,
}, {
    $set: { fazerCardsPlacementState: 'SUBMITTED', fazerCardsPlacementSubmittedAt: new Date() },
}, { new: true });

const markFazerCardsPlacementOutcome = ({ orderId, ownerToken, state }) => Order.findOneAndUpdate({
    _id: orderId,
    fazerCardsPlacementOwner: ownerToken,
    fazerCardsPlacementState: { $in: ['CLAIMED', 'SUBMITTED'] },
}, {
    $set: {
        fazerCardsPlacementState: state,
        fazerCardsPlacementResolvedAt: state === 'RESOLVED' ? new Date() : null,
    },
}, { new: true });

module.exports = {
    buildFazerCardsProviderIdempotencyKey,
    claimFazerCardsPlacement,
    markFazerCardsPlacementSubmitted,
    markFazerCardsPlacementOutcome,
};
