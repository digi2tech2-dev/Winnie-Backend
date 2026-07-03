'use strict';

const PaymentGatewayInterface = require('./gateway.interface');
const { PAYMENT_GATEWAYS, PAYMENT_STATUSES } = require('../payment.constants');
const config = require('../../../config/config');

class MockPaymentGateway extends PaymentGatewayInterface {
    constructor() {
        super(PAYMENT_GATEWAYS.MOCK);
    }

    async createPaymentIntent({ paymentId, amount, totalAmount, currency, returnUrl, cancelUrl }) {
        const id = paymentId.toString();
        const baseUrl = config.payments.mockCheckoutBaseUrl.replace(/\/+$/, '');

        return {
            gatewayPaymentId: `mock_${id}`,
            gatewayReference: `mock_ref_${id}`,
            checkoutUrl: `${baseUrl}/${id}`,
            status: PAYMENT_STATUSES.REQUIRES_ACTION,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            metadata: {
                mode: 'mock',
                amount,
                totalAmount,
                currency,
                returnUrl: returnUrl || null,
                cancelUrl: cancelUrl || null,
            },
        };
    }

    async getPaymentStatus(payment) {
        return {
            status: payment.status,
            gatewayPaymentId: payment.gatewayPaymentId,
            mode: 'mock',
        };
    }

    async confirmMockPayment(payment) {
        return {
            status: PAYMENT_STATUSES.SUCCEEDED,
            gatewayPaymentId: payment.gatewayPaymentId,
            mode: 'mock',
        };
    }

    async failMockPayment(payment) {
        return {
            status: PAYMENT_STATUSES.FAILED,
            gatewayPaymentId: payment.gatewayPaymentId,
            mode: 'mock',
        };
    }
}

module.exports = MockPaymentGateway;
