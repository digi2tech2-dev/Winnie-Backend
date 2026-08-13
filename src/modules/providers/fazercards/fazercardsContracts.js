'use strict';

const { FULFILLMENT_MODES } = require('../providerProduct.model');

const SUPPORT_STAGES = Object.freeze({
    CATALOG_ONLY: 'CATALOG_ONLY',
    IMPORT_READY: 'IMPORT_READY',
    DRY_RUN_READY: 'DRY_RUN_READY',
    PILOT_READY: 'PILOT_READY',
    LIVE_READY: 'LIVE_READY',
    DISABLED_UNAVAILABLE: 'DISABLED_UNAVAILABLE',
});

const EXECUTION_STAGES = Object.freeze({
    NONE: 'NONE',
    ADMIN_PILOT_ONLY: 'ADMIN_PILOT_ONLY',
    CUSTOMER_FLOW_NOT_READY: 'CUSTOMER_FLOW_NOT_READY',
    CUSTOMER_FLOW_READY_BUT_GATED: 'CUSTOMER_FLOW_READY_BUT_GATED',
    LIVE_ENABLED: 'LIVE_ENABLED',
});

const RISK_LEVELS = Object.freeze({
    LOW: 'LOW',
    MEDIUM: 'MEDIUM',
    HIGH: 'HIGH',
});

const PARSED_STATUSES = Object.freeze({
    COMPLETED: 'COMPLETED',
    PROCESSING: 'PROCESSING',
    FAILED: 'FAILED',
    MANUAL_REVIEW: 'MANUAL_REVIEW',
});

const CONTRACT_CODES = Object.freeze({
    CONTRACT_UNCONFIRMED: 'CONTRACT_UNCONFIRMED',
    CUSTOMER_INPUT_MISSING: 'CUSTOMER_INPUT_MISSING',
    PAYLOAD_IDENTIFIER_MISSING: 'PAYLOAD_IDENTIFIER_MISSING',
});

const asString = (value, fallback = '') => {
    if (value === undefined || value === null) return fallback;
    return String(value).trim();
};

const firstValue = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

const extractExternalParts = (externalProductId, prefix) => {
    const external = asString(externalProductId);
    if (!external.startsWith(prefix)) return [];
    return external.slice(prefix.length).split(':').map((part) => part.trim()).filter(Boolean);
};

const getRequiredFieldKey = (field) => asString(
    typeof field === 'string'
        ? field
        : firstValue(field?.key, field?.name, field?.id, field?.code)
);

const normalizeRequiredFields = (requiredFields = []) => (
    (Array.isArray(requiredFields) ? requiredFields : [])
        .map((field) => {
            const key = getRequiredFieldKey(field);
            if (!key) return null;
            return {
                key,
                label: typeof field === 'string' ? key : asString(firstValue(field.label, field.title, field.name), key),
                type: typeof field === 'string' ? 'text' : asString(field.type, 'text'),
                required: typeof field === 'string' ? true : field.required !== false,
            };
        })
        .filter(Boolean)
);

const buildFieldPayload = (input = {}, requiredFields = []) => {
    const fields = normalizeRequiredFields(requiredFields);
    const source = input && typeof input === 'object' ? input : {};
    const payload = {};
    const missing = [];

    for (const field of fields) {
        const rawValue = source[field.key];
        const isMissing = rawValue === undefined || rawValue === null || rawValue === '';
        if (field.required && isMissing) {
            missing.push(field.key);
            continue;
        }
        if (!isMissing) payload[field.key] = String(rawValue);
    }

    return { payload, missing, fields };
};

const normalizeQuantity = (quantity = 1, providerProduct = {}) => {
    const parsed = Number(quantity ?? 1);
    if (!Number.isInteger(parsed) || parsed < 1) {
        return { ok: false, code: 'QUANTITY_INVALID', message: 'quantity must be a positive integer.' };
    }

    const minQty = Number(providerProduct.minQty || 1);
    const maxQty = Number(providerProduct.maxQty || 9999);
    const stock = Number(providerProduct.stock);
    if (Number.isFinite(minQty) && parsed < minQty) {
        return { ok: false, code: 'QUANTITY_BELOW_MIN', message: 'quantity is below the provider minimum.' };
    }
    if (Number.isFinite(maxQty) && parsed > maxQty) {
        return { ok: false, code: 'QUANTITY_ABOVE_MAX', message: 'quantity exceeds the provider maximum.' };
    }
    if (providerProduct.stock !== undefined && providerProduct.stock !== null && providerProduct.stock !== '' && Number.isFinite(stock) && stock >= 0 && parsed > stock) {
        return { ok: false, code: 'STOCK_INSUFFICIENT', message: 'quantity exceeds available provider stock.' };
    }
    return { ok: true, quantity: parsed };
};

const extractTopupIdentifiers = (providerProduct = {}) => {
    const raw = providerProduct.rawPayload || {};
    const externalParts = extractExternalParts(providerProduct.externalProductId, 'FAZER_TOPUP:');
    return {
        categoryId: asString(firstValue(
            providerProduct.category,
            raw.category?.category_id,
            raw.category?.categoryId,
            raw.category_id,
            externalParts[0]
        )),
        offerId: asString(firstValue(
            providerProduct.offerId,
            raw.offer?.offer_id,
            raw.offer?.offerId,
            raw.offer?.id,
            raw.offer_id,
            externalParts[1]
        )),
    };
};

const extractGiftCardIdentifiers = (providerProduct = {}) => {
    const raw = providerProduct.rawPayload || {};
    const externalParts = extractExternalParts(providerProduct.externalProductId, 'FAZER_GIFTCARD:');
    return {
        categoryId: asString(firstValue(
            providerProduct.category,
            raw.category?.category_id,
            raw.category?.categoryId,
            raw.category_id,
            externalParts[0]
        )),
        cardId: asString(firstValue(
            providerProduct.offerId,
            raw.offer?.card_id,
            raw.offer?.cardId,
            raw.card_id,
            externalParts[1]
        )),
    };
};

const extractGameKeyIdentifiers = (providerProduct = {}) => {
    const raw = providerProduct.rawPayload || {};
    const externalParts = extractExternalParts(providerProduct.externalProductId, 'FAZER_GAMEKEY:');
    return {
        gameId: asString(firstValue(
            providerProduct.category,
            raw.game?.game_id,
            raw.game?.gameId,
            raw.game_id,
            externalParts[0]
        )),
        keyId: asString(firstValue(
            providerProduct.offerId,
            raw.key?.key_id,
            raw.key?.keyId,
            raw.key_id,
            externalParts[1]
        )),
    };
};

const buildContractError = (message, code = CONTRACT_CODES.CONTRACT_UNCONFIRMED, details = {}) => ({
    success: false,
    dryRun: false,
    code,
    message,
    ...details,
});

const buildTopupPayload = ({ providerProduct, fields = {} } = {}) => {
    const { categoryId, offerId } = extractTopupIdentifiers(providerProduct);
    if (!categoryId || !offerId) {
        return buildContractError('FazerCards top-up category_id and offer_id are required.', CONTRACT_CODES.PAYLOAD_IDENTIFIER_MISSING, {
            missing: [!categoryId ? 'category_id' : null, !offerId ? 'offer_id' : null].filter(Boolean),
        });
    }

    const built = buildFieldPayload(fields, providerProduct?.requiredFields);
    if (built.missing.length) {
        return buildContractError(`Missing FazerCards customer field(s): ${built.missing.join(', ')}.`, CONTRACT_CODES.CUSTOMER_INPUT_MISSING, {
            missing: built.missing,
        });
    }

    return {
        success: true,
        wouldCall: 'POST /topups/order',
        payload: {
            category_id: categoryId,
            offer_id: offerId,
            fields: built.payload,
        },
        requiredFields: built.fields,
    };
};

const buildGiftCardPayload = ({ providerProduct, quantity = 1 } = {}) => {
    const normalized = normalizeQuantity(quantity, providerProduct);
    if (!normalized.ok) return buildContractError(normalized.message, normalized.code);
    const { categoryId, cardId } = extractGiftCardIdentifiers(providerProduct);
    if (!categoryId || !cardId) {
        return buildContractError('FazerCards gift-card category_id and card_id are required.', CONTRACT_CODES.PAYLOAD_IDENTIFIER_MISSING, {
            missing: [!categoryId ? 'category_id' : null, !cardId ? 'card_id' : null].filter(Boolean),
        });
    }
    return {
        success: true,
        wouldCall: 'POST /giftcards/order',
        payload: {
            category_id: categoryId,
            card_id: cardId,
            quantity: normalized.quantity,
        },
        requiredFields: [],
    };
};

const buildGameKeyPayload = ({ providerProduct, quantity = 1 } = {}) => {
    const normalized = normalizeQuantity(quantity, providerProduct);
    if (!normalized.ok) return buildContractError(normalized.message, normalized.code);
    const { gameId, keyId } = extractGameKeyIdentifiers(providerProduct);
    if (!gameId || !keyId) {
        return buildContractError('FazerCards game-key game_id and key_id are required.', CONTRACT_CODES.PAYLOAD_IDENTIFIER_MISSING, {
            missing: [!gameId ? 'game_id' : null, !keyId ? 'key_id' : null].filter(Boolean),
        });
    }
    return {
        success: true,
        wouldCall: 'POST /gamekeys/order',
        payload: {
            game_id: gameId,
            key_id: keyId,
            quantity: normalized.quantity,
        },
        requiredFields: [],
    };
};

const buildUnconfirmedPayload = ({ contract } = {}) => buildContractError(
    `${contract?.displayName || 'FazerCards'} provider payload contract is not confirmed.`,
    CONTRACT_CODES.CONTRACT_UNCONFIRMED,
    {
        wouldCall: null,
        payload: null,
        requiredFields: contract?.customerInputSchema?.fields || [],
        blockers: contract?.blockers || [],
    }
);

const mapProviderStatus = (rawStatus) => {
    const normalized = asString(rawStatus).toLowerCase();
    if (['completed', 'complete', 'success', 'succeeded'].includes(normalized)) {
        return { status: PARSED_STATUSES.COMPLETED, providerStatus: 'Completed', known: true, terminalFailure: false };
    }
    if (['processing', 'pending', 'in_progress', 'in progress', 'inprogress'].includes(normalized)) {
        return { status: PARSED_STATUSES.PROCESSING, providerStatus: 'Pending', known: true, terminalFailure: false };
    }
    if (['failed', 'error', 'cancelled', 'canceled', 'refunded'].includes(normalized)) {
        return { status: PARSED_STATUSES.FAILED, providerStatus: 'Cancelled', known: true, terminalFailure: true };
    }
    return { status: PARSED_STATUSES.MANUAL_REVIEW, providerStatus: rawStatus ? String(rawStatus) : 'Unknown', known: false, terminalFailure: false };
};

const extractOrderNode = (data = {}) => (
    data.order
    || data.providerOrder
    || data.data?.order
    || data.data
    || data
);

const extractOrderId = (data = {}, order = {}) => firstValue(
    order.id,
    order.order_id,
    order.orderId,
    order.provider_order_id,
    data.order_id,
    data.orderId,
    data.id,
    data.data?.order_id,
    data.data?.id,
    null
);

const SECRET_KEY_PATTERN = /(^|_)(code|pin|serial|voucher|license|claim)(_|$)|cardnumber|card_number|card_no|key_value|game_key|gift_card/i;
const CODE_COLLECTION_PATTERN = /^(codes|keys|cards|vouchers)$/i;

const redactSecrets = (value, depth = 0, parentKey = '') => {
    if (value === null || value === undefined) return value;
    if (depth > 8) return '[REDACTED_DEPTH_LIMIT]';
    if (typeof value === 'string' && CODE_COLLECTION_PATTERN.test(parentKey)) return '[REDACTED_CODE]';
    if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1, parentKey));
    if (typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => {
            const normalizedKey = String(key || '');
            const redact = SECRET_KEY_PATTERN.test(normalizedKey)
                || (normalizedKey.toLowerCase() === 'key' && typeof child !== 'object');
            return [key, redact ? '[REDACTED_CODE]' : redactSecrets(child, depth + 1, normalizedKey)];
        }));
    }
    return value;
};

const getCodeValueFromObject = (obj = {}, parentKey = '') => {
    const code = firstValue(
        obj.code,
        obj.cardCode,
        obj.card_code,
        obj.voucher,
        obj.voucherCode,
        obj.voucher_code,
        obj.licenseKey,
        obj.license_key,
        obj.gameKey,
        obj.game_key,
        obj.keyValue,
        obj.key_value,
        obj.codeValue,
        obj.code_value,
        null
    );
    if (code) return code;
    if (typeof obj.key === 'string' && !obj.key_id && !obj.keyId) return obj.key;
    if (typeof obj.value === 'string' && CODE_COLLECTION_PATTERN.test(parentKey)) return obj.value;
    return null;
};

const extractDeliveredCodes = (value, parentKey = '') => {
    const found = [];
    const visit = (node, key = '') => {
        if (node === null || node === undefined) return;
        if (typeof node === 'string') {
            if (CODE_COLLECTION_PATTERN.test(key)) {
                found.push({ code: node, serial: null, pin: null, metadata: { source: key } });
            }
            return;
        }
        if (Array.isArray(node)) {
            node.forEach((item) => visit(item, key));
            return;
        }
        if (typeof node !== 'object') return;

        const code = getCodeValueFromObject(node, key);
        const pin = firstValue(node.pin, node.pinCode, node.pin_code, null);
        const serial = firstValue(node.serial, node.serialNumber, node.serial_number, node.cardNumber, node.card_number, null);
        if (code || pin || serial) {
            found.push({
                code: code ? String(code) : null,
                pin: pin ? String(pin) : null,
                serial: serial ? String(serial) : null,
                metadata: {
                    source: key || null,
                    id: firstValue(node.id, node.item_id, node.card_id, node.key_id, null),
                },
            });
        }

        Object.entries(node).forEach(([childKey, child]) => visit(child, childKey));
    };

    visit(value, parentKey);
    const seen = new Set();
    return found.filter((item) => {
        const key = [item.code, item.pin, item.serial].filter(Boolean).join('|');
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

const parseProviderOrderResponse = (data = {}) => {
    const order = extractOrderNode(data);
    const providerOrderId = asString(extractOrderId(data, order));
    const rawStatus = firstValue(order?.status, data?.status, order?.state, data?.state, 'processing');
    const mapped = mapProviderStatus(rawStatus);
    return {
        status: !mapped.known || !providerOrderId ? PARSED_STATUSES.MANUAL_REVIEW : mapped.status,
        providerOrderId,
        providerStatus: mapped.providerStatus,
        knownStatus: mapped.known,
        terminalFailure: mapped.terminalFailure,
        manualReview: !mapped.known || !providerOrderId,
        sanitizedRawResponse: redactSecrets(data),
        warnings: [
            !mapped.known ? 'Provider response status is unknown.' : null,
            !providerOrderId ? 'Provider response did not include an order id.' : null,
        ].filter(Boolean),
    };
};

const parseTopupResponse = (data = {}) => parseProviderOrderResponse(data);

const parseCodeDeliveryResponse = (data = {}) => {
    const parsed = parseProviderOrderResponse(data);
    const deliveredCodes = extractDeliveredCodes(data);
    const hasRecognizedCodePayload = deliveredCodes.length > 0;
    const status = parsed.status === PARSED_STATUSES.COMPLETED && !hasRecognizedCodePayload
        ? PARSED_STATUSES.MANUAL_REVIEW
        : parsed.status;
    return {
        ...parsed,
        status,
        manualReview: parsed.manualReview || status === PARSED_STATUSES.MANUAL_REVIEW,
        deliveredCodeCount: deliveredCodes.length,
        hasPin: deliveredCodes.some((item) => item.pin),
        hasSerial: deliveredCodes.some((item) => item.serial),
        hasRecognizedCodePayload,
        codeMetadata: deliveredCodes.map((item) => ({
            hasCode: Boolean(item.code),
            hasPin: Boolean(item.pin),
            hasSerial: Boolean(item.serial),
            metadata: item.metadata,
        })),
        warnings: [
            ...parsed.warnings,
            !hasRecognizedCodePayload ? 'Provider response did not contain a recognized code/key payload.' : null,
        ].filter(Boolean),
    };
};

const parseGiftCardResponse = (data = {}) => parseCodeDeliveryResponse(data);
const parseGameKeyResponse = (data = {}) => parseCodeDeliveryResponse(data);

const parseUnconfirmedResponse = (data = {}, familyKey = 'UNKNOWN') => ({
    status: PARSED_STATUSES.MANUAL_REVIEW,
    providerOrderId: null,
    providerStatus: 'Unknown',
    manualReview: true,
    code: CONTRACT_CODES.CONTRACT_UNCONFIRMED,
    sanitizedRawResponse: redactSecrets(data),
    warnings: [`${familyKey} response contract is unconfirmed; manual review is required.`],
});

const parseTelegramResponse = (data = {}) => parseUnconfirmedResponse(data, 'TELEGRAM');
const parseSteamTopupResponse = (data = {}) => parseUnconfirmedResponse(data, 'STEAM_TOPUP');
const parseManualServiceResponse = (data = {}) => parseUnconfirmedResponse(data, 'MANUAL_SERVICES');

const CONTRACTS = Object.freeze({
    TOPUPS: Object.freeze({
        familyKey: 'TOPUPS',
        displayName: 'Top-ups',
        fulfillmentMode: FULFILLMENT_MODES.TOPUP_WITH_FIELDS,
        supportStage: SUPPORT_STAGES.PILOT_READY,
        executionStage: EXECUTION_STAGES.CUSTOMER_FLOW_READY_BUT_GATED,
        riskLevel: RISK_LEVELS.MEDIUM,
        catalogStatus: 'implemented',
        canImportDraft: true,
        canDryRun: true,
        canLivePilot: true,
        canCustomerPurchase: false,
        customerInputSchema: {
            source: 'providerProduct.requiredFields',
            fields: [],
            dynamicRequiredFields: true,
        },
        providerPayloadSchema: {
            confirmed: true,
            endpoint: 'POST /topups/order',
            body: { category_id: 'string', offer_id: 'string', fields: 'object<string,string>' },
        },
        expectedResponseSchema: {
            confirmed: true,
            providerOrderIdPaths: ['order.id', 'order.order_id', 'orderId'],
            statusPaths: ['order.status', 'status', 'state'],
        },
        storageStrategy: 'ORDER_PROVIDER_METADATA',
        customerDeliveryStrategy: 'NO_CODE_DELIVERY_STATUS_ONLY',
        requiredCapabilities: ['FAZERCARDS_ENABLED', 'FAZERCARDS_REAL_ORDERS_ENABLED', 'providerExecutionEnabled', 'requiredFields'],
        blockers: ['Real target/account ID validation not completed in production.'],
        warnings: ['Live customer purchase remains gated until a controlled real target ID pilot succeeds.'],
    }),
    GIFTCARDS: Object.freeze({
        familyKey: 'GIFTCARDS',
        displayName: 'Gift Cards',
        fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
        supportStage: SUPPORT_STAGES.PILOT_READY,
        executionStage: EXECUTION_STAGES.ADMIN_PILOT_ONLY,
        riskLevel: RISK_LEVELS.MEDIUM,
        catalogStatus: 'implemented',
        canImportDraft: true,
        canDryRun: true,
        canLivePilot: true,
        canCustomerPurchase: false,
        customerInputSchema: { fields: [{ key: 'quantity', type: 'number', required: true, min: 1 }] },
        providerPayloadSchema: {
            confirmed: true,
            endpoint: 'POST /giftcards/order',
            body: { category_id: 'string', card_id: 'string', quantity: 'integer' },
        },
        expectedResponseSchema: {
            confirmed: true,
            codeCandidates: ['codes[]', 'cards[]', 'voucherCode', 'code', 'pin', 'serial'],
        },
        storageStrategy: 'PROVIDER_DELIVERED_CODE_ENCRYPTED',
        customerDeliveryStrategy: 'CUSTOMER_REVEAL_NOT_IMPLEMENTED',
        requiredCapabilities: ['FAZERCARDS_ENABLED', 'FAZERCARDS_REAL_ORDERS_ENABLED', 'FAZERCARDS_CODE_DELIVERY_ENABLED', 'ProviderDeliveredCode encryption'],
        blockers: ['Customer code reveal is not implemented.'],
        warnings: ['Admin pilot only; never return plaintext codes in list/debug responses.'],
    }),
    GAME_KEYS: Object.freeze({
        familyKey: 'GAME_KEYS',
        displayName: 'Game Keys',
        fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
        supportStage: SUPPORT_STAGES.PILOT_READY,
        executionStage: EXECUTION_STAGES.ADMIN_PILOT_ONLY,
        riskLevel: RISK_LEVELS.MEDIUM,
        catalogStatus: 'implemented',
        canImportDraft: true,
        canDryRun: true,
        canLivePilot: true,
        canCustomerPurchase: false,
        customerInputSchema: { fields: [{ key: 'quantity', type: 'number', required: true, min: 1 }] },
        providerPayloadSchema: {
            confirmed: true,
            endpoint: 'POST /gamekeys/order',
            body: { game_id: 'string', key_id: 'string', quantity: 'integer' },
        },
        expectedResponseSchema: {
            confirmed: true,
            codeCandidates: ['keys[]', 'gameKey', 'licenseKey', 'code', 'serial'],
        },
        storageStrategy: 'PROVIDER_DELIVERED_CODE_ENCRYPTED',
        customerDeliveryStrategy: 'CUSTOMER_REVEAL_NOT_IMPLEMENTED',
        requiredCapabilities: ['FAZERCARDS_ENABLED', 'FAZERCARDS_REAL_ORDERS_ENABLED', 'FAZERCARDS_CODE_DELIVERY_ENABLED', 'ProviderDeliveredCode encryption'],
        blockers: ['Customer key reveal is not implemented.'],
        warnings: ['Admin pilot only; never return plaintext keys in list/debug responses.'],
    }),
    TELEGRAM: Object.freeze({
        familyKey: 'TELEGRAM',
        displayName: 'Telegram',
        fulfillmentMode: FULFILLMENT_MODES.TELEGRAM_STARS_TOPUP,
        supportStage: SUPPORT_STAGES.IMPORT_READY,
        executionStage: EXECUTION_STAGES.NONE,
        riskLevel: RISK_LEVELS.MEDIUM,
        catalogStatus: 'catalog_only',
        canImportDraft: true,
        canDryRun: false,
        canLivePilot: false,
        canCustomerPurchase: false,
        customerInputSchema: {
            fields: [
                { key: 'telegram_username', type: 'text', required: true },
                { key: 'quantity_or_plan', type: 'text', required: true },
            ],
        },
        providerPayloadSchema: { confirmed: false, endpoint: null, body: 'UNCONFIRMED' },
        expectedResponseSchema: { confirmed: false },
        storageStrategy: 'ORDER_PROVIDER_METADATA_UNCONFIRMED',
        customerDeliveryStrategy: 'NO_CODE_DELIVERY_EXPECTED_UNCONFIRMED',
        requiredCapabilities: ['Official Telegram order endpoint/payload confirmation'],
        blockers: ['Provider order endpoint and payload shape are unconfirmed.'],
        warnings: ['Do not collect or send Telegram order data until the provider contract is confirmed.'],
    }),
    STEAM_TOPUP: Object.freeze({
        familyKey: 'STEAM_TOPUP',
        displayName: 'Steam Wallet Top-up',
        fulfillmentMode: FULFILLMENT_MODES.STEAM_TOPUP_WITH_LOGIN,
        supportStage: SUPPORT_STAGES.IMPORT_READY,
        executionStage: EXECUTION_STAGES.NONE,
        riskLevel: RISK_LEVELS.HIGH,
        catalogStatus: 'catalog_only',
        canImportDraft: true,
        canDryRun: false,
        canLivePilot: false,
        canCustomerPurchase: false,
        customerInputSchema: { fields: [] },
        providerPayloadSchema: { confirmed: false, endpoint: null, body: 'UNCONFIRMED' },
        expectedResponseSchema: { confirmed: false },
        storageStrategy: 'ORDER_PROVIDER_METADATA_UNCONFIRMED',
        customerDeliveryStrategy: 'NO_CODE_DELIVERY_EXPECTED_UNCONFIRMED',
        requiredCapabilities: ['Official Steam top-up input and execution contract confirmation'],
        blockers: ['Steam top-up execution contract is unconfirmed.', 'May involve account/login-like data.'],
        warnings: ['High risk; do not invent login/password fields.'],
    }),
    MANUAL_SERVICES: Object.freeze({
        familyKey: 'MANUAL_SERVICES',
        displayName: 'Manual Services',
        fulfillmentMode: FULFILLMENT_MODES.MANUAL_SERVICE,
        supportStage: SUPPORT_STAGES.IMPORT_READY,
        executionStage: EXECUTION_STAGES.NONE,
        riskLevel: RISK_LEVELS.HIGH,
        catalogStatus: 'catalog_only',
        canImportDraft: true,
        canDryRun: false,
        canLivePilot: false,
        canCustomerPurchase: false,
        customerInputSchema: {
            source: 'providerProduct.requiredFields or admin-defined orderFields',
            fields: [],
            dynamicRequiredFields: true,
        },
        providerPayloadSchema: { confirmed: false, endpoint: null, body: 'UNCONFIRMED' },
        expectedResponseSchema: { confirmed: false },
        storageStrategy: 'ORDER_MANUAL_WORKFLOW_UNIMPLEMENTED',
        customerDeliveryStrategy: 'MANUAL_ADMIN_WORKFLOW_NOT_IMPLEMENTED',
        requiredCapabilities: ['Manual workflow/chat execution design'],
        blockers: ['Manual service execution workflow is not implemented.'],
        warnings: ['Do not auto-execute manual services.'],
    }),
    STEAM_GIFTS: Object.freeze({
        familyKey: 'STEAM_GIFTS',
        displayName: 'Steam Gifts',
        fulfillmentMode: FULFILLMENT_MODES.STEAM_GIFT_INVITE,
        supportStage: SUPPORT_STAGES.DISABLED_UNAVAILABLE,
        executionStage: EXECUTION_STAGES.NONE,
        riskLevel: RISK_LEVELS.HIGH,
        catalogStatus: 'unavailable_404',
        canImportDraft: false,
        canDryRun: false,
        canLivePilot: false,
        canCustomerPurchase: false,
        customerInputSchema: { fields: [] },
        providerPayloadSchema: { confirmed: false, endpoint: null, body: 'UNAVAILABLE' },
        expectedResponseSchema: { confirmed: false },
        storageStrategy: 'NONE',
        customerDeliveryStrategy: 'NONE',
        requiredCapabilities: ['Working Steam Gifts catalog endpoint'],
        blockers: ['Production catalog endpoint returned HTTP 404.'],
        warnings: ['Family is disabled until discovery is reconfirmed.'],
    }),
});

const clone = (value) => JSON.parse(JSON.stringify(value));

const getContract = (familyKey) => CONTRACTS[asString(familyKey).toUpperCase()] || null;

const listContracts = () => Object.values(CONTRACTS).map(clone);

const getContractOrUnknown = (familyKey) => getContract(familyKey) || {
    familyKey: asString(familyKey || 'UNKNOWN').toUpperCase(),
    displayName: 'Unknown',
    fulfillmentMode: FULFILLMENT_MODES.UNKNOWN,
    supportStage: SUPPORT_STAGES.DISABLED_UNAVAILABLE,
    executionStage: EXECUTION_STAGES.NONE,
    riskLevel: RISK_LEVELS.HIGH,
    catalogStatus: 'unknown',
    canImportDraft: false,
    canDryRun: false,
    canLivePilot: false,
    canCustomerPurchase: false,
    customerInputSchema: { fields: [] },
    providerPayloadSchema: { confirmed: false, endpoint: null, body: 'UNCONFIRMED' },
    expectedResponseSchema: { confirmed: false },
    storageStrategy: 'NONE',
    customerDeliveryStrategy: 'NONE',
    requiredCapabilities: ['Confirmed family contract'],
    blockers: ['FazerCards family contract is unknown.'],
    warnings: ['No execution allowed for unknown family.'],
};

const getContractSummary = () => ({
    families: Object.fromEntries(Object.values(CONTRACTS).map((contract) => [
        contract.familyKey,
        {
            supportStage: contract.supportStage,
            executionStage: contract.executionStage,
            canImportDraft: contract.canImportDraft,
            canDryRun: contract.canDryRun,
            canLivePilot: contract.canLivePilot,
            canCustomerPurchase: contract.canCustomerPurchase,
            blockers: contract.blockers,
        },
    ])),
    nextBestExecutionOrder: ['GIFTCARDS', 'GAME_KEYS', 'TOPUPS', 'TELEGRAM', 'STEAM_TOPUP', 'MANUAL_SERVICES'],
});

const buildPayloadFromContract = ({ familyKey, providerProduct, fields = {}, quantity = 1 } = {}) => {
    const contract = getContractOrUnknown(familyKey);
    if (contract.familyKey === 'TOPUPS') return buildTopupPayload({ providerProduct, fields });
    if (contract.familyKey === 'GIFTCARDS') return buildGiftCardPayload({ providerProduct, quantity });
    if (contract.familyKey === 'GAME_KEYS') return buildGameKeyPayload({ providerProduct, quantity });
    return buildUnconfirmedPayload({ contract });
};

const parseResponseForFamily = (familyKey, data = {}) => {
    const normalized = asString(familyKey).toUpperCase();
    if (normalized === 'TOPUPS') return parseTopupResponse(data);
    if (normalized === 'GIFTCARDS') return parseGiftCardResponse(data);
    if (normalized === 'GAME_KEYS') return parseGameKeyResponse(data);
    if (normalized === 'TELEGRAM') return parseTelegramResponse(data);
    if (normalized === 'STEAM_TOPUP') return parseSteamTopupResponse(data);
    if (normalized === 'MANUAL_SERVICES') return parseManualServiceResponse(data);
    return parseUnconfirmedResponse(data, normalized || 'UNKNOWN');
};

const getMissingCapabilities = (contract = {}, checks = {}) => {
    const missing = [];
    const providerExecutionEnabled = checks.providerExecutionEnabled ?? checks.productExecutionEnabled;
    if (checks.fazerCardsEnabled === false) missing.push('FAZERCARDS_ENABLED');
    if (contract.canLivePilot && checks.globalRealOrdersEnabled === false) missing.push('FAZERCARDS_REAL_ORDERS_ENABLED');
    if (contract.canLivePilot && providerExecutionEnabled === false) missing.push('providerExecutionEnabled');
    if (contract.familyKey === 'TOPUPS' && checks.hasRequiredFields === false) missing.push('requiredFields');
    if (contract.familyKey === 'GIFTCARDS' || contract.familyKey === 'GAME_KEYS') {
        if (checks.codeDeliveryStorageReady === false) missing.push('ProviderDeliveredCode encryption');
    }
    return [...new Set(missing)];
};

module.exports = {
    SUPPORT_STAGES,
    EXECUTION_STAGES,
    RISK_LEVELS,
    PARSED_STATUSES,
    CONTRACT_CODES,
    getContract,
    getContractOrUnknown,
    listContracts,
    getContractSummary,
    buildPayloadFromContract,
    parseResponseForFamily,
    parseTopupResponse,
    parseGiftCardResponse,
    parseGameKeyResponse,
    parseTelegramResponse,
    parseSteamTopupResponse,
    parseManualServiceResponse,
    getMissingCapabilities,
    redactSecrets,
    extractDeliveredCodes,
};
