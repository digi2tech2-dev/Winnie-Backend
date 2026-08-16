'use strict';

const { BaseProviderAdapter } = require('./base.adapter');
const { BusinessRuleError } = require('../../../shared/errors/AppError');
const xenaService = require('../xena/xena.service');
const xenaProductService = require('../xena/xenaProduct.service');
const { validateTargetUid } = require('../xena/xenaTarget.service');

const XENA_TARGET_FIELD_KEY = 'target_uid';
const XENA_LEGACY_TARGET_FIELD_KEY = 'account_id';

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

const buildStatusPendingResult = ({
    providerOrderId,
    providerRequestId = null,
    providerErrorCode,
    providerErrorMessage,
    rawResponse = null,
}) => ({
    providerOrderId,
    providerStatus: 'Pending',
    providerRequestId,
    providerErrorCode,
    providerErrorMessage,
    rawResponse: rawResponse || { errorCode: providerErrorCode, message: providerErrorMessage },
    manualReviewOnRetryLimit: true,
});

const buildRechargeAttemptMetadata = ({
    orderId,
    providerIdempotencyKey,
    amount,
    targetUid,
    reason,
    providerResponse = null,
} = {}) => ({
    action: 'placeOrder',
    endpoint: 'POST /v1/recharges',
    idempotencyKey: providerIdempotencyKey,
    requestStartedAt: new Date().toISOString(),
    unknownReason: reason || null,
    requestSummary: {
        orderId,
        amount,
        targetUidPresent: Boolean(targetUid),
    },
    providerResponse,
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
        const buildAttemptMetadata = ({ reason, targetUid = null, providerResponse = null } = {}) => buildRechargeAttemptMetadata({
            orderId,
            providerIdempotencyKey,
            amount: params.amount,
            targetUid,
            reason,
            providerResponse,
        });

        if (!xenaService.isXenaRechargeEnabled()) {
            return buildManualReviewResult({
                providerIdempotencyKey,
                providerErrorCode: xenaService.XENA_DISABLED_ERROR_CODE,
                providerErrorMessage: 'Xena Recharge is disabled by environment configuration.',
                rawResponse: buildAttemptMetadata({ reason: xenaService.XENA_DISABLED_ERROR_CODE }),
            });
        }

        const nestedParams = params.params && typeof params.params === 'object' ? params.params : {};
        const rawTargetUid = firstPresent(
            nestedParams[XENA_TARGET_FIELD_KEY],
            params[XENA_TARGET_FIELD_KEY],
            nestedParams[XENA_LEGACY_TARGET_FIELD_KEY],
            params[XENA_LEGACY_TARGET_FIELD_KEY]
        );
        const usedLegacyTargetField = firstPresent(nestedParams[XENA_TARGET_FIELD_KEY], params[XENA_TARGET_FIELD_KEY]) === undefined
            && firstPresent(nestedParams[XENA_LEGACY_TARGET_FIELD_KEY], params[XENA_LEGACY_TARGET_FIELD_KEY]) !== undefined;
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
                rawResponse: {
                    errorCode: 'XENA_TARGET_INVALID',
                    ...(usedLegacyTargetField ? { legacyTargetField: XENA_LEGACY_TARGET_FIELD_KEY } : {}),
                },
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
                rawResponse: buildAttemptMetadata({
                    targetUid,
                    reason: err.code || 'XENA_RECHARGE_UNKNOWN',
                    providerResponse: safeErrorPayload(err, err.code || 'XENA_RECHARGE_UNKNOWN'),
                }),
            });
        }

        const baseResult = {
            providerOrderId: recharge.providerOrderId,
            providerStatus: recharge.providerStatus,
            providerRequestId: recharge.providerRequestId,
            providerIdempotencyKey,
            providerMessage: [
                recharge.providerMessage,
                usedLegacyTargetField ? 'Used legacy account_id field as target_uid.' : null,
            ].filter(Boolean).join(' ') || recharge.providerMessage,
            providerErrorCode: recharge.providerErrorCode,
            providerErrorMessage: recharge.providerErrorMessage,
            providerTargetSnapshot: verification?.user || null,
            rawResponse: usedLegacyTargetField
                ? { ...recharge.rawResponse, legacyTargetField: XENA_LEGACY_TARGET_FIELD_KEY }
                : recharge.rawResponse,
            errorMessage: recharge.providerErrorMessage,
        };

        if ((recharge.xenaStatus === 'succeeded' || recharge.xenaStatus === 'processing') && !recharge.providerOrderId) {
            return buildManualReviewResult({
                ...baseResult,
                providerErrorCode: 'XENA_RECHARGE_ID_MISSING',
                providerErrorMessage: 'Xena recharge response did not include a trusted recharge id.',
                rawResponse: buildAttemptMetadata({
                    targetUid,
                    reason: 'XENA_RECHARGE_ID_MISSING',
                    providerResponse: recharge.rawResponse,
                }),
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
            rawResponse: buildAttemptMetadata({
                targetUid,
                reason: recharge.providerErrorCode || 'XENA_RECHARGE_UNKNOWN',
                providerResponse: recharge.rawResponse,
            }),
        });
    }

    async checkOrder(orderId) {
        const rechargeId = typeof orderId === 'string' ? orderId.trim() : '';
        if (!rechargeId) {
            return buildManualReviewResult({
                providerErrorCode: 'XENA_RECHARGE_ID_MISSING',
                providerErrorMessage: 'Xena recharge id is missing.',
            });
        }

        let recharge;
        try {
            recharge = await xenaService.getRecharge({
                provider: this.provider,
                rechargeId,
            });
        } catch (err) {
            if ([
                xenaService.XENA_DISABLED_ERROR_CODE,
                'XENA_RECHARGE_NOT_FOUND',
                'XENA_PROVIDER_AUTH_FAILED',
                'XENA_REAUTHENTICATION_REQUIRED',
                'XENA_MALFORMED_RESPONSE',
            ].includes(err.code)) {
                return buildManualReviewResult({
                    providerOrderId: rechargeId,
                    providerStatus: 'Unknown',
                    providerRequestId: err.requestId || null,
                    providerErrorCode: err.code,
                    providerErrorMessage: err.message,
                    rawResponse: safeErrorPayload(err, err.code),
                });
            }

            return buildStatusPendingResult({
                providerOrderId: rechargeId,
                providerRequestId: err.requestId || null,
                providerErrorCode: err.code || 'XENA_STATUS_UNAVAILABLE',
                providerErrorMessage: 'Xena recharge status is currently unavailable.',
                rawResponse: safeErrorPayload(err, err.code || 'XENA_STATUS_UNAVAILABLE'),
            });
        }

        const baseResult = {
            providerOrderId: recharge.providerOrderId,
            providerStatus: recharge.providerStatus,
            providerRequestId: recharge.providerRequestId,
            providerMessage: recharge.providerMessage,
            providerErrorCode: recharge.providerErrorCode,
            providerErrorMessage: recharge.providerErrorMessage,
            rawResponse: recharge.rawResponse,
        };

        if (!recharge.providerOrderId || recharge.providerOrderId !== rechargeId) {
            return buildManualReviewResult({
                ...baseResult,
                providerOrderId: rechargeId,
                providerStatus: 'Unknown',
                providerErrorCode: 'XENA_RECHARGE_ID_MISSING',
                providerErrorMessage: 'Xena recharge status response did not include the trusted recharge id.',
            });
        }

        if (recharge.xenaStatus === 'succeeded') {
            return { ...baseResult, providerStatus: 'Completed' };
        }

        if (recharge.xenaStatus === 'processing') {
            return { ...baseResult, providerStatus: 'Pending', manualReviewOnRetryLimit: true };
        }

        if (recharge.xenaStatus === 'failed') {
            return {
                ...baseResult,
                providerStatus: 'Failed',
                providerErrorCode: recharge.providerErrorCode || 'XENA_RECHARGE_FAILED',
                providerErrorMessage: recharge.providerErrorMessage || 'Xena recharge failed.',
            };
        }

        return buildManualReviewResult({
            ...baseResult,
            providerOrderId: rechargeId,
            providerStatus: 'Unknown',
            providerErrorCode: recharge.providerErrorCode || 'XENA_RECHARGE_UNKNOWN',
            providerErrorMessage: recharge.providerErrorMessage || 'Xena recharge returned an unknown status.',
        });
    }

    async checkOrders(orderIds = []) {
        const results = [];
        for (const orderId of orderIds) {
            results.push(await this.checkOrder(orderId));
        }
        return results;
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
