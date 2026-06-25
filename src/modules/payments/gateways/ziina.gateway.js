'use strict';

const PaymentGatewayInterface = require('./gateway.interface');
const { PAYMENT_GATEWAYS } = require('../payment.constants');

class ZiinaGateway extends PaymentGatewayInterface {
    constructor() {
        super(PAYMENT_GATEWAYS.ZIINA);
    }
}

module.exports = ZiinaGateway;
