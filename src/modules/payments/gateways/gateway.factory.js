'use strict';

const { BusinessRuleError } = require('../../../shared/errors/AppError');
const { PAYMENT_GATEWAYS } = require('../payment.constants');
const MockPaymentGateway = require('./mock.gateway');
const NetworkInternationalGateway = require('./networkInternational.gateway');
const ZiinaGateway = require('./ziina.gateway');
const TapGateway = require('./tap.gateway');

const GATEWAY_CLASSES = Object.freeze({
    [PAYMENT_GATEWAYS.MOCK]: MockPaymentGateway,
    [PAYMENT_GATEWAYS.NETWORK_INTERNATIONAL]: NetworkInternationalGateway,
    [PAYMENT_GATEWAYS.ZIINA]: ZiinaGateway,
    [PAYMENT_GATEWAYS.TAP]: TapGateway,
});

const normalizeGatewayKey = (gateway) => String(gateway || PAYMENT_GATEWAYS.MOCK).trim().toUpperCase();

const getPaymentGateway = (gateway) => {
    const key = normalizeGatewayKey(gateway);
    const GatewayClass = GATEWAY_CLASSES[key];

    if (!GatewayClass) {
        throw new BusinessRuleError(`Unsupported payment gateway: ${gateway}`, 'UNSUPPORTED_PAYMENT_GATEWAY');
    }

    return new GatewayClass();
};

module.exports = {
    getPaymentGateway,
    normalizeGatewayKey,
};
