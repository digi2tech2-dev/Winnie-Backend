'use strict';

const PaymentGatewayInterface = require('./gateway.interface');
const { PAYMENT_GATEWAYS } = require('../payment.constants');

class TapGateway extends PaymentGatewayInterface {
    constructor() {
        super(PAYMENT_GATEWAYS.TAP);
    }
}

module.exports = TapGateway;
