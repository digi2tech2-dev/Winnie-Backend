'use strict';

const PaymentGatewayInterface = require('./gateway.interface');
const { PAYMENT_GATEWAYS } = require('../payment.constants');

class NetworkInternationalGateway extends PaymentGatewayInterface {
    constructor() {
        super(PAYMENT_GATEWAYS.NETWORK_INTERNATIONAL);
    }
}

module.exports = NetworkInternationalGateway;
