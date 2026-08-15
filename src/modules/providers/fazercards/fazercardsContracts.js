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

const PROVIDER_EXECUTION_MODES = Object.freeze({
    AUTO_PROVIDER: 'AUTO_PROVIDER',
    MANUAL_FULFILLMENT: 'MANUAL_FULFILLMENT',
    DISABLED: 'DISABLED',
});

const AUTO_PROVIDER_FAMILIES = new Set(['TOPUPS', 'GIFTCARDS', 'GAME_KEYS']);
const MANUAL_FULFILLMENT_FAMILIES = new Set(['TELEGRAM', 'STEAM_TOPUP', 'MANUAL_SERVICES']);
const DISABLED_FAMILIES = new Set(['STEAM_GIFTS']);
const CODE_DELIVERY_FAMILIES = new Set(['GIFTCARDS', 'GAME_KEYS']);
const CUSTOMER_FIELD_REQUIRED_FAMILIES = new Set(['TOPUPS', 'TELEGRAM', 'STEAM_TOPUP', 'MANUAL_SERVICES']);
const LOGIN_LIKE_PRODUCT_PATTERN = /\b(via\s+login|login|username|account)\b/i;
const CUSTOMER_LOGIN_FIELD_PATTERN = /(login|username|user[_\s-]?name|account|user[_\s-]?id|player[_\s-]?id|uid|profile|roblox)/i;

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

const normalizeCustomerFieldDefinitions = (product = {}, providerProduct = {}) => {
    const sources = [
        { fields: product?.orderFields, source: 'product.orderFields', keyProp: 'key' },
        { fields: product?.dynamicFields, source: 'product.dynamicFields', keyProp: 'name' },
        { fields: product?.requiredFields, source: 'product.requiredFields', keyProp: 'key' },
        { fields: providerProduct?.requiredFields, source: 'providerProduct.requiredFields', keyProp: 'key' },
    ];

    const seen = new Set();
    const normalized = [];
    for (const { fields, source, keyProp } of sources) {
        for (const field of Array.isArray(fields) ? fields : []) {
            const key = getRequiredFieldKey(
                typeof field === 'string'
                    ? field
                    : { ...field, key: field?.[keyProp] || field?.key || field?.name }
            );
            const label = typeof field === 'string'
                ? key
                : asString(firstValue(field?.label, field?.title, field?.name, field?.key), key);
            if (!key && !label) continue;
            const identity = `${source}:${key || label}`;
            if (seen.has(identity)) continue;
            seen.add(identity);
            normalized.push({
                key,
                label,
                type: typeof field === 'string' ? 'text' : asString(field?.type, 'text'),
                required: typeof field === 'string' ? true : field?.required !== false,
                isActive: typeof field === 'string' ? true : field?.isActive !== false && field?.active !== false,
                source,
            });
        }
    }

    return normalized;
};

const fieldMatches = (field, pattern) => pattern.test(`${field.key || ''} ${field.label || ''}`);

const productLooksLoginBased = (product = {}, providerProduct = {}) => (
    [
        product?.name,
        product?.externalProductId,
        product?.providerOfferName,
        product?.providerCategoryName,
        providerProduct?.rawName,
        providerProduct?.name,
        providerProduct?.externalProductId,
        providerProduct?.offerName,
        providerProduct?.categoryName,
    ].some((value) => LOGIN_LIKE_PRODUCT_PATTERN.test(asString(value)))
);

const validateManualCustomerFieldsForProduct = ({
    product = {},
    providerProduct = {},
    familyKey,
    fulfillmentMode,
    providerExecutionMode,
} = {}) => {
    const normalizedFamilyKey = normalizeFamilyKey(familyKey || product?.familyKey || providerProduct?.familyKey);
    const normalizedFulfillmentMode = asString(fulfillmentMode || product?.fulfillmentMode || providerProduct?.fulfillmentMode).toUpperCase();
    const normalizedMode = asString(
        providerExecutionMode || product?.providerExecutionMode || getDefaultExecutionMode(normalizedFamilyKey)
    ).toUpperCase();
    const fields = normalizeCustomerFieldDefinitions(product, providerProduct);
    const requiredFields = fields.filter((field) => field.isActive !== false && field.required !== false);
    const loginLikeProduct = productLooksLoginBased(product, providerProduct);
    const hasAnyRequiredField = requiredFields.length > 0;
    const hasLoginField = requiredFields.some((field) => fieldMatches(field, CUSTOMER_LOGIN_FIELD_PATTERN));
    const suggestions = [];

    if (normalizedMode !== PROVIDER_EXECUTION_MODES.MANUAL_FULFILLMENT) {
        return { ok: true, required: false, fields, requiredFields, suggestions };
    }
    if (normalizedFulfillmentMode === FULFILLMENT_MODES.CODE_DELIVERY || CODE_DELIVERY_FAMILIES.has(normalizedFamilyKey)) {
        return { ok: true, required: false, fields, requiredFields, suggestions };
    }
    if (!CUSTOMER_FIELD_REQUIRED_FAMILIES.has(normalizedFamilyKey) && !loginLikeProduct) {
        return { ok: true, required: false, fields, requiredFields, suggestions };
    }

    if (normalizedFamilyKey === 'TELEGRAM') suggestions.push('telegram_username');
    if (normalizedFamilyKey === 'STEAM_TOPUP') suggestions.push('steam_login', 'steam_profile', 'steam_username');
    if (loginLikeProduct) suggestions.push('account_username', 'login');
    if (normalizedFamilyKey === 'MANUAL_SERVICES') suggestions.push('account_username');
    if (normalizedFamilyKey === 'TOPUPS') suggestions.push('user_id', 'account_id', 'player_id');

    if (!hasAnyRequiredField) {
        return {
            ok: false,
            required: true,
            code: 'MANUAL_PRODUCT_REQUIRES_CUSTOMER_FIELDS',
            message: 'Manual fulfillment products require customer input fields before launch.',
            reason: 'manual fulfillment requires customer fields',
            fields,
            requiredFields,
            suggestions: [...new Set(suggestions)],
        };
    }

    if (loginLikeProduct && !hasLoginField) {
        return {
            ok: false,
            required: true,
            code: 'MANUAL_PRODUCT_REQUIRES_CUSTOMER_FIELDS',
            message: 'Login-based manual fulfillment products require a login, username, account, or profile field.',
            reason: 'manual fulfillment requires login/account customer field',
            fields,
            requiredFields,
            suggestions: [...new Set(suggestions)],
        };
    }

    return {
        ok: true,
        required: true,
        fields,
        requiredFields,
        suggestions: [...new Set(suggestions)],
    };
};

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
    if (['completed', 'complete', 'success', 'succeeded', 'fulfilled'].includes(normalized)) {
        return { status: PARSED_STATUSES.COMPLETED, providerStatus: 'Completed', known: true, terminalFailure: false };
    }
    if (['processing', 'pending', 'in_progress', 'in progress', 'inprogress', 'created', 'accepted'].includes(normalized)) {
        return { status: PARSED_STATUSES.PROCESSING, providerStatus: 'Pending', known: true, terminalFailure: false };
    }
    if (['failed', 'error', 'cancelled', 'canceled', 'rejected', 'refunded'].includes(normalized)) {
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

const SECRET_KEY_PATTERN = /(^|_)(code|pin|serial|voucher|license|claim|activation|gift|redemption|access)(_|$)|cardcode|card_code|cardnumber|card_number|card_no|pincode|pin_code|serialnumber|serial_number|key_value|game_key|giftcode|gift_code|gift_card|activationcode|activation_code|redemptioncode|redemption_code|licensekey|license_key/i;
const CODE_COLLECTION_PATTERN = /^(codes|keys|cards|vouchers|giftcodes|gift_codes|activationcodes|activation_codes|licensekeys|license_keys|items)$/i;
const TRUSTED_STRING_CODE_COLLECTION_PATTERN = /^(codes|keys|cards|vouchers|giftcodes|gift_codes|activationcodes|activation_codes|licensekeys|license_keys)$/i;
const IDENTIFIER_VALUE_KEYS = [
    'id',
    'order_id',
    'orderId',
    'providerOrderId',
    'provider_order_id',
    'category_id',
    'categoryId',
    'card_id',
    'cardId',
    'key_id',
    'keyId',
    'game_id',
    'gameId',
    'offer_id',
    'offerId',
];

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

const getIdentifierValues = (obj = {}) => new Set(
    IDENTIFIER_VALUE_KEYS
        .map((key) => asString(obj?.[key]))
        .filter(Boolean)
);

const isIdentifierValue = (candidate, obj = {}) => {
    const value = asString(candidate);
    return value && getIdentifierValues(obj).has(value);
};

const safeSecretValue = (candidate, obj = {}) => {
    if (candidate === undefined || candidate === null || candidate === '') return null;
    if (isIdentifierValue(candidate, obj)) return null;
    return String(candidate);
};

const getCodeValueFromObject = (obj = {}, parentKey = '') => {
    const code = firstValue(
        obj.code,
        obj.cardCode,
        obj.card_code,
        obj.giftCode,
        obj.gift_code,
        obj.activationCode,
        obj.activation_code,
        obj.redemptionCode,
        obj.redemption_code,
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
    const safeCode = safeSecretValue(code, obj);
    if (safeCode) return safeCode;
    if (typeof obj.key === 'string' && !obj.key_id && !obj.keyId) return safeSecretValue(obj.key, obj);
    if (typeof obj.value === 'string' && TRUSTED_STRING_CODE_COLLECTION_PATTERN.test(parentKey)) {
        return safeSecretValue(obj.value, obj);
    }
    return null;
};

const getPinValueFromObject = (obj = {}) => safeSecretValue(firstValue(
    obj.pin,
    obj.pinCode,
    obj.pin_code,
    obj.pinNumber,
    obj.pin_number,
    null
), obj);

const getSerialValueFromObject = (obj = {}) => safeSecretValue(firstValue(
    obj.serial,
    obj.serialNumber,
    obj.serial_number,
    obj.cardNumber,
    obj.card_number,
    obj.cardNo,
    obj.card_no,
    null
), obj);

const extractDeliveredCodes = (value, parentKey = '') => {
    const found = [];
    const visit = (node, key = '') => {
        if (node === null || node === undefined) return;
        if (typeof node === 'string') {
            if (TRUSTED_STRING_CODE_COLLECTION_PATTERN.test(key)) {
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
        const pin = getPinValueFromObject(node);
        const serial = getSerialValueFromObject(node);
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
    const status = hasRecognizedCodePayload && parsed.status !== PARSED_STATUSES.FAILED
        ? PARSED_STATUSES.COMPLETED
        : parsed.status === PARSED_STATUSES.COMPLETED && !hasRecognizedCodePayload
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
        canCustomerPurchase: true,
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
        warnings: ['Auto execution is gated by environment and product-level provider execution settings.'],
    }),
    GIFTCARDS: Object.freeze({
        familyKey: 'GIFTCARDS',
        displayName: 'Gift Cards',
        fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
        supportStage: SUPPORT_STAGES.PILOT_READY,
        executionStage: EXECUTION_STAGES.CUSTOMER_FLOW_READY_BUT_GATED,
        riskLevel: RISK_LEVELS.MEDIUM,
        catalogStatus: 'implemented',
        canImportDraft: true,
        canDryRun: true,
        canLivePilot: true,
        canCustomerPurchase: true,
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
        customerDeliveryStrategy: 'CUSTOMER_REVEAL_AFTER_COMPLETED_ORDER',
        requiredCapabilities: ['FAZERCARDS_ENABLED', 'FAZERCARDS_REAL_ORDERS_ENABLED', 'FAZERCARDS_CODE_DELIVERY_ENABLED', 'ProviderDeliveredCode encryption'],
        blockers: [],
        warnings: ['Auto execution is gated by environment and product-level provider execution settings. Never return plaintext codes in list/debug responses.'],
    }),
    GAME_KEYS: Object.freeze({
        familyKey: 'GAME_KEYS',
        displayName: 'Game Keys',
        fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
        supportStage: SUPPORT_STAGES.PILOT_READY,
        executionStage: EXECUTION_STAGES.CUSTOMER_FLOW_READY_BUT_GATED,
        riskLevel: RISK_LEVELS.MEDIUM,
        catalogStatus: 'implemented',
        canImportDraft: true,
        canDryRun: true,
        canLivePilot: true,
        canCustomerPurchase: true,
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
        customerDeliveryStrategy: 'CUSTOMER_REVEAL_AFTER_COMPLETED_ORDER',
        requiredCapabilities: ['FAZERCARDS_ENABLED', 'FAZERCARDS_REAL_ORDERS_ENABLED', 'FAZERCARDS_CODE_DELIVERY_ENABLED', 'ProviderDeliveredCode encryption'],
        blockers: [],
        warnings: ['Auto execution is gated by environment and product-level provider execution settings. Never return plaintext keys in list/debug responses.'],
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
        canCustomerPurchase: true,
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
        blockers: ['Provider order endpoint and payload shape are unconfirmed for auto execution.'],
        warnings: ['Customer orders are allowed only through manual fulfillment. Do not send Telegram order data to FazerCards until the provider contract is confirmed.'],
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
        canCustomerPurchase: true,
        customerInputSchema: { fields: [] },
        providerPayloadSchema: { confirmed: false, endpoint: null, body: 'UNCONFIRMED' },
        expectedResponseSchema: { confirmed: false },
        storageStrategy: 'ORDER_PROVIDER_METADATA_UNCONFIRMED',
        customerDeliveryStrategy: 'NO_CODE_DELIVERY_EXPECTED_UNCONFIRMED',
        requiredCapabilities: ['Official Steam top-up input and execution contract confirmation'],
        blockers: ['Steam top-up execution contract is unconfirmed.', 'May involve account/login-like data.'],
        warnings: ['Customer orders are allowed only through manual fulfillment. High risk; do not invent login/password fields.'],
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
        canCustomerPurchase: true,
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
        blockers: ['Manual service auto-execution workflow is not implemented.'],
        warnings: ['Customer orders are allowed only through manual fulfillment.'],
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

const normalizeFamilyKey = (familyKey) => asString(familyKey).toUpperCase();

const getAllowedExecutionModes = (familyKey) => {
    const normalized = normalizeFamilyKey(familyKey);
    if (AUTO_PROVIDER_FAMILIES.has(normalized)) {
        return [PROVIDER_EXECUTION_MODES.AUTO_PROVIDER, PROVIDER_EXECUTION_MODES.MANUAL_FULFILLMENT];
    }
    if (MANUAL_FULFILLMENT_FAMILIES.has(normalized)) {
        return [PROVIDER_EXECUTION_MODES.MANUAL_FULFILLMENT];
    }
    if (DISABLED_FAMILIES.has(normalized)) {
        return [PROVIDER_EXECUTION_MODES.DISABLED];
    }
    return [PROVIDER_EXECUTION_MODES.DISABLED];
};

const getDefaultExecutionMode = (familyKey) => {
    const normalized = normalizeFamilyKey(familyKey);
    if (AUTO_PROVIDER_FAMILIES.has(normalized)) return PROVIDER_EXECUTION_MODES.AUTO_PROVIDER;
    if (MANUAL_FULFILLMENT_FAMILIES.has(normalized)) return PROVIDER_EXECUTION_MODES.MANUAL_FULFILLMENT;
    return PROVIDER_EXECUTION_MODES.DISABLED;
};

const canAutoExecuteFamily = (familyKey) => AUTO_PROVIDER_FAMILIES.has(normalizeFamilyKey(familyKey));

const getAutoProviderIdentifiers = (familyKey, providerProduct = {}) => {
    const normalized = normalizeFamilyKey(familyKey || providerProduct?.familyKey);
    if (normalized === 'TOPUPS') return extractTopupIdentifiers(providerProduct);
    if (normalized === 'GIFTCARDS') return extractGiftCardIdentifiers(providerProduct);
    if (normalized === 'GAME_KEYS') return extractGameKeyIdentifiers(providerProduct);
    return {};
};

const validateCodeDeliveryQuantityRules = (product = {}, providerProduct = {}) => {
    const errors = [];
    const minQty = Number(providerProduct.minQty ?? product.minQty ?? 1);
    const maxQty = Number(providerProduct.maxQty ?? product.maxQty ?? 9999);
    const stock = Number(providerProduct.stock);
    if (!Number.isFinite(minQty) || minQty < 1 || !Number.isFinite(maxQty) || maxQty < minQty) {
        errors.push({
            code: 'AUTO_PROVIDER_QUANTITY_RULES_INVALID',
            message: 'Code-delivery auto provider execution requires valid min/max quantity rules.',
        });
    }
    if (providerProduct.stock !== undefined && providerProduct.stock !== null && providerProduct.stock !== '' && Number.isFinite(stock) && stock < minQty) {
        errors.push({
            code: 'AUTO_PROVIDER_STOCK_INSUFFICIENT',
            message: 'Code-delivery auto provider execution requires enough provider stock for the minimum quantity.',
        });
    }
    return errors;
};

const validateAutoProviderReadinessForProduct = ({
    product = {},
    providerProduct = {},
    familyKey,
    requireCustomerVisible = true,
} = {}) => {
    const normalizedFamilyKey = normalizeFamilyKey(familyKey || product?.familyKey || providerProduct?.familyKey);
    const errors = [];
    const identifiers = getAutoProviderIdentifiers(normalizedFamilyKey, providerProduct);
    const productStatus = asString(product?.status).toLowerCase();

    if (!canAutoExecuteFamily(normalizedFamilyKey)) {
        errors.push({
            code: 'CONTRACT_AUTO_EXECUTION_NOT_ALLOWED',
            message: 'Auto provider execution is not allowed for this FazerCards family contract.',
        });
    }
    if (requireCustomerVisible) {
        if (product?.isActive !== true) errors.push({ code: 'AUTO_PROVIDER_REQUIRES_ACTIVE_PRODUCT', message: 'Auto provider execution requires an active product.' });
        if (product?.visibleInStore === false) errors.push({ code: 'AUTO_PROVIDER_REQUIRES_VISIBLE_PRODUCT', message: 'Auto provider execution requires a customer-visible product.' });
        if (productStatus !== 'available') errors.push({ code: 'AUTO_PROVIDER_REQUIRES_AVAILABLE_PRODUCT', message: 'Auto provider execution requires status=available.' });
        if (product?.customerPurchaseEnabled !== true) errors.push({ code: 'AUTO_PROVIDER_REQUIRES_CUSTOMER_PURCHASE_ENABLED', message: 'Auto provider execution requires customerPurchaseEnabled=true.' });
    }
    if (!providerProduct) {
        errors.push({ code: 'AUTO_PROVIDER_REQUIRES_PROVIDER_PRODUCT', message: 'Auto provider execution requires a linked FazerCards ProviderProduct.' });
    } else {
        if (providerProduct.isSupported !== true) errors.push({ code: 'AUTO_PROVIDER_REQUIRES_SUPPORTED_PROVIDER_PRODUCT', message: 'Auto provider execution requires a supported ProviderProduct.' });
        if (providerProduct.isBlocked === true) errors.push({ code: 'AUTO_PROVIDER_REQUIRES_UNBLOCKED_PROVIDER_PRODUCT', message: 'Auto provider execution requires an unblocked ProviderProduct.' });
        if (providerProduct.executionBlocked === true) errors.push({ code: 'AUTO_PROVIDER_REQUIRES_EXECUTION_UNBLOCKED', message: 'Auto provider execution is blocked for this ProviderProduct.' });
    }

    if (normalizedFamilyKey === 'TOPUPS') {
        if (!identifiers.categoryId) errors.push({ code: 'AUTO_PROVIDER_TOPUP_CATEGORY_ID_MISSING', message: 'Top-up auto provider execution requires category_id.' });
        if (!identifiers.offerId) errors.push({ code: 'AUTO_PROVIDER_TOPUP_OFFER_ID_MISSING', message: 'Top-up auto provider execution requires offer_id.' });
        const requiredFields = normalizeCustomerFieldDefinitions(product, providerProduct)
            .filter((field) => field.isActive !== false && field.required !== false);
        if (requiredFields.length === 0) {
            errors.push({
                code: 'AUTO_PROVIDER_REQUIRES_CUSTOMER_FIELDS',
                message: 'Top-up auto provider execution requires customer input fields.',
            });
        }
    } else if (normalizedFamilyKey === 'GIFTCARDS') {
        if (!identifiers.categoryId) errors.push({ code: 'AUTO_PROVIDER_GIFTCARD_CATEGORY_ID_MISSING', message: 'Gift-card auto provider execution requires category_id.' });
        if (!identifiers.cardId) errors.push({ code: 'AUTO_PROVIDER_GIFTCARD_CARD_ID_MISSING', message: 'Gift-card auto provider execution requires card_id.' });
        errors.push(...validateCodeDeliveryQuantityRules(product, providerProduct));
    } else if (normalizedFamilyKey === 'GAME_KEYS') {
        if (!identifiers.gameId) errors.push({ code: 'AUTO_PROVIDER_GAMEKEY_GAME_ID_MISSING', message: 'Game-key auto provider execution requires game_id.' });
        if (!identifiers.keyId) errors.push({ code: 'AUTO_PROVIDER_GAMEKEY_KEY_ID_MISSING', message: 'Game-key auto provider execution requires key_id.' });
        errors.push(...validateCodeDeliveryQuantityRules(product, providerProduct));
    }

    return {
        ok: errors.length === 0,
        familyKey: normalizedFamilyKey,
        identifiers,
        errors,
    };
};

const validateExecutionModeForFamily = (familyKey, mode) => {
    const normalized = normalizeFamilyKey(familyKey);
    const requestedMode = asString(mode || getDefaultExecutionMode(normalized)).toUpperCase();
    const allowedModes = getAllowedExecutionModes(normalized);
    if (!allowedModes.includes(requestedMode)) {
        if (DISABLED_FAMILIES.has(normalized)) {
            return {
                ok: false,
                code: 'FAMILY_DISABLED_UNAVAILABLE',
                message: 'This FazerCards family is currently unavailable.',
                allowedModes,
            };
        }
        return {
            ok: false,
            code: requestedMode === PROVIDER_EXECUTION_MODES.AUTO_PROVIDER
                ? 'CONTRACT_AUTO_EXECUTION_NOT_ALLOWED'
                : 'CUSTOMER_PURCHASE_NOT_ALLOWED',
            message: requestedMode === PROVIDER_EXECUTION_MODES.AUTO_PROVIDER
                ? 'Auto provider execution is not allowed for this FazerCards family contract.'
                : 'Customer purchase is not allowed for this FazerCards family contract.',
            allowedModes,
        };
    }

    return {
        ok: true,
        mode: requestedMode,
        allowedModes,
    };
};

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
    PROVIDER_EXECUTION_MODES,
    getContract,
    getContractOrUnknown,
    listContracts,
    getContractSummary,
    getAllowedExecutionModes,
    getDefaultExecutionMode,
    canAutoExecuteFamily,
    getAutoProviderIdentifiers,
    validateAutoProviderReadinessForProduct,
    validateExecutionModeForFamily,
    buildPayloadFromContract,
    parseResponseForFamily,
    parseTopupResponse,
    parseGiftCardResponse,
    parseGameKeyResponse,
    parseTelegramResponse,
    parseSteamTopupResponse,
    parseManualServiceResponse,
    getMissingCapabilities,
    normalizeCustomerFieldDefinitions,
    validateManualCustomerFieldsForProduct,
    redactSecrets,
    extractDeliveredCodes,
};
