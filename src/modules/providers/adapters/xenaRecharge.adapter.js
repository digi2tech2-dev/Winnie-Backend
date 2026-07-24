'use strict';

const { BaseProviderAdapter } = require('./base.adapter');
const { BusinessRuleError } = require('../../../shared/errors/AppError');
const xenaService = require('../xena/xena.service');

class XenaRechargeAdapter extends BaseProviderAdapter {
    async getProducts() {
        return [];
    }

    async placeOrder() {
        throw new BusinessRuleError(
            'Xena recharge execution is not implemented in Phase 1.',
            'XENA_RECHARGE_NOT_IMPLEMENTED'
        );
    }

    async checkOrder() {
        throw new BusinessRuleError(
            'Xena recharge polling is not implemented in Phase 1.',
            'XENA_RECHARGE_POLLING_NOT_IMPLEMENTED'
        );
    }

    async checkOrders() {
        return [];
    }

    async getBalance() {
        return xenaService.refreshBalance({ provider: this.provider });
    }

    async challengeConnection(params) {
        return xenaService.challengeConnection({ provider: this.provider, ...params });
    }

    async reconnectConnection(params) {
        return xenaService.reconnectConnection({ provider: this.provider, ...params });
    }

    async verifyConnection(params) {
        return xenaService.verifyConnection({ provider: this.provider, ...params });
    }

    async getConnectionStatus() {
        return xenaService.getConnectionStatus({ provider: this.provider });
    }
}

module.exports = { XenaRechargeAdapter };
