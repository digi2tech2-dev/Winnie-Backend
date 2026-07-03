'use strict';

const { BusinessRuleError } = require('../../../shared/errors/AppError');

class PaymentGatewayInterface {
    constructor(gatewayKey) {
        this.gatewayKey = gatewayKey;
    }

    async createPaymentIntent() {
        throw new BusinessRuleError(
            `${this.gatewayKey} payment gateway is not implemented yet.`,
            'PAYMENT_GATEWAY_NOT_IMPLEMENTED'
        );
    }

    async getPaymentStatus() {
        throw new BusinessRuleError(
            `${this.gatewayKey} payment gateway status checks are not implemented yet.`,
            'PAYMENT_GATEWAY_NOT_IMPLEMENTED'
        );
    }

    async confirmMockPayment() {
        throw new BusinessRuleError(
            `${this.gatewayKey} does not support mock confirmation.`,
            'PAYMENT_GATEWAY_NOT_IMPLEMENTED'
        );
    }

    async failMockPayment() {
        throw new BusinessRuleError(
            `${this.gatewayKey} does not support mock failure.`,
            'PAYMENT_GATEWAY_NOT_IMPLEMENTED'
        );
    }
}

module.exports = PaymentGatewayInterface;
