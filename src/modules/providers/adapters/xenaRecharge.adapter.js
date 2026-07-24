'use strict';

const { BaseProviderAdapter } = require('./base.adapter');
const { BusinessRuleError } = require('../../../shared/errors/AppError');
const xenaService = require('../xena/xena.service');
const xenaProductService = require('../xena/xenaProduct.service');
const { validateTargetUid } = require('../xena/xenaTarget.service');

const XENA_TARGET_FIELD_KEY = 'target_uid';

const firstPresent = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

const safeErrorPayload = (err, fallbackCode) => ({
    errorCode: err?.code || fallbackCode,
    message: err?.code?.startsWith?.('XENA_')
        ? err.message
        : 'Xena recharge requires review.',
    requestId: err?.requestId || null,
    httpStatus: err?.httpStatus || null,
});

const buildManualReviewResult = ({
    providerOrderId = null,
    providerStatus = 'Unknown',
    providerRequestId = null,
    providerIdempotencyKey,
    providerErrorCode,
    providerErrorMessage,
    providerMessage = null,
    rawResponse = null,
}) => ({
    success: false,
    manualReview: true,
    providerOrderId,
    providerStatus,
    providerRequestId,
    providerIdempotencyKey,
    providerErrorCode,
    providerErrorMessage,
    providerMessage,
    rawResponse: rawResponse || { errorCode: providerErrorCode, message: providerErrorMessage },
    errorMessage: providerErrorMessage,
});

class XenaRechargeAdapter extends BaseProviderAdapter {
    async getProducts() {
        const dto = await xenaProductService.buildSyntheticProductDTO({ provider: this.provider });
        return [this._validateDTO(dto)];
    }

    async placeOrder(params = {}) {
        const orderId = String(firstPresent(params.localOrderId, params.orderId, params.order_id) || '').trim();
        if (!orderId) {
            return buildManualReviewResult({
                providerIdempotencyKey: null,
                providerErrorCode: 'XENA_RECHARGE_UNKNOWN',
                providerErrorMessage: 'Local order id is required for Xena recharge idempotency.',
            });
        }

        const providerIdempotencyKey = `provider:xena:${orderId}`;
        const nestedParams = params.params && typeof params.params === 'object' ? params.params : {};
        const rawTargetUid = firstPresent(nestedParams[XENA_TARGET_FIELD_KEY], params[XENA_TARGET_FIELD_KEY]);
        let targetUid;
        try {
            targetUid = validateTargetUid(rawTargetUid);
        } catch (err) {
            return {
                success: false,
                providerOrderId: null,
                providerStatus: 'Cancelled',
                providerIdempotencyKey,
                providerErrorCode: 'XENA_TARGET_INVALID',
                providerErrorMessage: 'Xena target UID is invalid.',
                rawResponse: { errorCode: 'XENA_TARGET_INVALID' },
                errorMessage: 'Xena target UID is invalid.',
            };
        }

        const amount = params.amount;
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            return {
                success: false,
                providerOrderId: null,
                providerStatus: 'Cancelled',
                providerIdempotencyKey,
                providerErrorCode: 'XENA_RECHARGE_FAILED',
                providerErrorMessage: 'Xena recharge amount is invalid.',
                rawResponse: { errorCode: 'XENA_RECHARGE_FAILED' },
                errorMessage: 'Xena recharge amount is invalid.',
            };
        }

        let verification;
        try {
            verification = await xenaService.verifyTargetUser({ provider: this.provider, targetUid });
        } catch (err) {
            if (err.code === 'XENA_TARGET_INVALID') {
                return {
                    success: false,
                    providerOrderId: null,
                    providerStatus: 'Cancelled',
                    providerIdempotencyKey,
                    providerErrorCode: 'XENA_TARGET_INVALID',
                    providerErrorMessage: 'Xena target UID is invalid.',
                    rawResponse: safeErrorPayload(err, 'XENA_TARGET_INVALID'),
                    errorMessage: 'Xena target UID is invalid.',
                };
            }

            return buildManualReviewResult({
                providerIdempotencyKey,
                providerErrorCode: err.code || 'XENA_VERIFICATION_UNAVAILABLE',
                providerErrorMessage: 'Xena target verification could not be completed before recharge.',
                rawResponse: safeErrorPayload(err, err.code || 'XENA_VERIFICATION_UNAVAILABLE'),
            });
        }

        let recharge;
        try {
            recharge = await xenaService.createRecharge({
                provider: this.provider,
                targetUid,
                amount,
                clientReference: `order:${orderId}`,
                idempotencyKey: providerIdempotencyKey,
            });
        } catch (err) {
            return buildManualReviewResult({
                providerIdempotencyKey,
                providerErrorCode: err.code || 'XENA_RECHARGE_UNKNOWN',
                providerErrorMessage: 'Xena recharge outcome is uncertain and requires manual review.',
                rawResponse: safeErrorPayload(err, err.code || 'XENA_RECHARGE_UNKNOWN'),
            });
        }

        const baseResult = {
            providerOrderId: recharge.providerOrderId,
            providerStatus: recharge.providerStatus,
            providerRequestId: recharge.providerRequestId,
            providerIdempotencyKey,
            providerMessage: recharge.providerMessage,
            providerErrorCode: recharge.providerErrorCode,
            providerErrorMessage: recharge.providerErrorMessage,
            providerTargetSnapshot: verification?.user || null,
            rawResponse: recharge.rawResponse,
            errorMessage: recharge.providerErrorMessage,
        };

        if ((recharge.xenaStatus === 'succeeded' || recharge.xenaStatus === 'processing') && !recharge.providerOrderId) {
            return buildManualReviewResult({
                ...baseResult,
                providerErrorCode: 'XENA_RECHARGE_ID_MISSING',
                providerErrorMessage: 'Xena recharge response did not include a trusted recharge id.',
            });
        }

        if (recharge.xenaStatus === 'succeeded') {
            return { ...baseResult, success: true };
        }

        if (recharge.xenaStatus === 'processing') {
            return { ...baseResult, success: true };
        }

        if (recharge.xenaStatus === 'failed') {
            return {
                ...baseResult,
                success: false,
                providerStatus: 'Cancelled',
                providerErrorCode: recharge.providerErrorCode || 'XENA_RECHARGE_FAILED',
                providerErrorMessage: recharge.providerErrorMessage || 'Xena recharge failed.',
                errorMessage: recharge.providerErrorMessage || 'Xena recharge failed.',
            };
        }

        return buildManualReviewResult({
            ...baseResult,
            providerErrorCode: recharge.providerErrorCode || 'XENA_RECHARGE_UNKNOWN',
            providerErrorMessage: recharge.providerErrorMessage || 'Xena recharge returned an unknown status.',
        });
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
