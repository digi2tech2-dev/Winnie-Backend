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
    CONTROLLED_LIVE_CANDIDATE: 'CONTROLLED_LIVE_CANDIDATE',
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

const SUPPORTED_AUTO_PROVIDER_FAMILIES = Object.freeze([
    'TOPUPS',
    'GIFTCARDS',
    'GAME_KEYS',
    'TELEGRAM',
    'STEAM_TOPUP',
    'STEAM_GIFTS',
    'MANUAL_SERVICES',
]);
const BULK_AUTO_PROVIDER_FAMILIES = new Set(SUPPORTED_AUTO_PROVIDER_FAMILIES);
const CONTROLLED_AUTO_PROVIDER_FAMILIES = new Set(SUPPORTED_AUTO_PROVIDER_FAMILIES);
const MANUAL_FULFILLMENT_FAMILIES = new Set(['MANUAL_SERVICES']);
const DISABLED_FAMILIES = new Set([]);
const CODE_DELIVERY_FAMILIES = new Set(['GIFTCARDS', 'GAME_KEYS']);
const CUSTOMER_FIELD_REQUIRED_FAMILIES = new Set(['TOPUPS', 'TELEGRAM', 'STEAM_TOPUP', 'STEAM_GIFTS', 'MANUAL_SERVICES']);
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
    if (normalizedFamilyKey === 'STEAM_GIFTS') suggestions.push('invite_url', 'steam_invite_url');
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

const parsePositiveInteger = (value, fallback = null) => {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parsePositiveNumber = (value, fallback = null) => {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const getFieldValue = (fields = {}, keys = []) => {
    const source = fields && typeof fields === 'object' ? fields : {};
    for (const key of keys) {
        if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
            return source[key];
        }
    }
    return undefined;
};

const getTelegramProductKind = (providerProduct = {}) => {
    const raw = providerProduct.rawPayload || {};
    const fulfillmentMode = asString(providerProduct.fulfillmentMode).toUpperCase();
    const external = asString(providerProduct.externalProductId).toUpperCase();
    const offerId = asString(providerProduct.offerId).toLowerCase();
    const kind = asString(firstValue(raw.kind, raw.response?.kind, raw.type, '')).toLowerCase();
    if (
        fulfillmentMode === FULFILLMENT_MODES.TELEGRAM_PREMIUM
        || kind.includes('premium')
        || external.includes(':PREMIUM')
        || offerId.includes('premium')
    ) return 'premium';
    if (
        fulfillmentMode === FULFILLMENT_MODES.TELEGRAM_STARS_TOPUP
        || kind.includes('stars')
        || external.includes(':STARS')
        || offerId === 'stars'
    ) return 'stars';
    return null;
};

const extractTelegramIdentifiers = (providerProduct = {}) => {
    const raw = providerProduct.rawPayload || {};
    const externalParts = extractExternalParts(providerProduct.externalProductId, 'FAZER_TELEGRAM:');
    const kind = getTelegramProductKind(providerProduct);
    const rawMonths = firstValue(
        raw.plan?.months,
        raw.months,
        providerProduct.months,
        asString(providerProduct.offerId).match(/premium[_:-]?(\d+)/i)?.[1],
        externalParts[1]
    );
    return {
        kind,
        months: parsePositiveInteger(rawMonths, null),
        externalKind: asString(externalParts[0]).toUpperCase() || null,
    };
};

const extractSteamTopupIdentifiers = (providerProduct = {}) => {
    const raw = providerProduct.rawPayload || {};
    const rate = raw.rate && typeof raw.rate === 'object' ? raw.rate : {};
    const externalParts = extractExternalParts(providerProduct.externalProductId, 'FAZER_STEAM_TOPUP:');
    const currency = asString(firstValue(
        raw.currency,
        raw.steamCurrency,
        raw.rateCurrency,
        rate.currency,
        rate.code,
        providerProduct.offerId,
        externalParts[0]
    )).toUpperCase();
    const amount = parsePositiveNumber(firstValue(
        raw.amount,
        raw.steamAmount,
        raw.walletAmount,
        raw.topupAmount,
        rate.amount,
        rate.steamAmount,
        rate.walletAmount,
        rate.value
    ), null);
    return { currency, amount };
};

const extractSteamGiftIdentifiers = (providerProduct = {}) => {
    const raw = providerProduct.rawPayload || {};
    const externalParts = extractExternalParts(providerProduct.externalProductId, 'FAZER_STEAM_GIFT:');
    return {
        appId: asString(firstValue(
            providerProduct.category,
            raw.game?.appid,
            raw.game?.app_id,
            raw.appid,
            raw.app_id,
            externalParts[0]
        )),
        subId: asString(firstValue(
            providerProduct.offerId,
            raw.offer?.sub_id,
            raw.offer?.subId,
            raw.sub_id,
            raw.subId,
            externalParts[1]
        )),
        region: asString(firstValue(
            providerProduct.region,
            raw.region?.region,
            raw.region,
            externalParts[2]
        )),
    };
};

const extractManualServiceIdentifiers = (providerProduct = {}) => {
    const raw = providerProduct.rawPayload || {};
    const externalParts = extractExternalParts(providerProduct.externalProductId, 'FAZER_MANUAL_SERVICE:');
    return {
        manualServiceId: asString(firstValue(
            providerProduct.category,
            raw.category?.manual_service_id,
            raw.category?.manualServiceId,
            raw.category?.id,
            raw.manual_service_id,
            raw.manualServiceId,
            externalParts[0]
        )),
        productId: asString(firstValue(
            providerProduct.offerId,
            raw.offer?.product_id,
            raw.offer?.productId,
            raw.offer?.id,
            raw.product_id,
            raw.productId,
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

const buildTelegramPayload = ({ providerProduct, fields = {}, quantity = 1 } = {}) => {
    const telegramUsername = asString(getFieldValue(fields, [
        'telegram_username',
        'telegramUsername',
        'username',
        'telegram',
    ]));
    if (!telegramUsername) {
        return buildContractError('Telegram username is required.', CONTRACT_CODES.CUSTOMER_INPUT_MISSING, {
            missing: ['telegram_username'],
        });
    }

    const identifiers = extractTelegramIdentifiers(providerProduct);
    if (identifiers.kind === 'stars') {
        const starsQuantity = parsePositiveInteger(firstValue(
            fields.quantity,
            fields.amount,
            fields.stars,
            quantity
        ), null);
        if (starsQuantity === null || starsQuantity < 50 || starsQuantity > 10000) {
            return buildContractError('Telegram Stars quantity must be between 50 and 10000.', 'TELEGRAM_STARS_QUANTITY_INVALID', {
                min: 50,
                max: 10000,
            });
        }
        return {
            success: true,
            wouldCall: 'POST /telegram/stars/buy',
            payload: {
                telegram_username: telegramUsername,
                quantity: starsQuantity,
            },
            requiredFields: [{ key: 'telegram_username', label: 'Telegram Username', type: 'text', required: true }],
        };
    }

    if (identifiers.kind === 'premium') {
        const months = parsePositiveInteger(firstValue(fields.months, identifiers.months), null);
        if (![3, 6, 12].includes(months)) {
            return buildContractError('Telegram Premium months must be one of 3, 6, or 12.', 'TELEGRAM_PREMIUM_MONTHS_INVALID', {
                allowed: [3, 6, 12],
            });
        }
        return {
            success: true,
            wouldCall: 'POST /telegram/premium/buy',
            payload: {
                telegram_username: telegramUsername,
                months,
            },
            requiredFields: [{ key: 'telegram_username', label: 'Telegram Username', type: 'text', required: true }],
        };
    }

    return buildContractError('Telegram product kind must be stars or premium.', CONTRACT_CODES.PAYLOAD_IDENTIFIER_MISSING, {
        missing: ['telegram_product_kind'],
    });
};

const buildSteamTopupPayload = ({ providerProduct, fields = {} } = {}) => {
    const steamLogin = asString(getFieldValue(fields, [
        'steamLogin',
        'steam_login',
        'steam_username',
        'steamUsername',
        'steam_profile',
        'steamProfile',
    ]));
    if (!steamLogin) {
        return buildContractError('Steam Login is required.', CONTRACT_CODES.CUSTOMER_INPUT_MISSING, {
            missing: ['steamLogin'],
        });
    }

    const identifiers = extractSteamTopupIdentifiers(providerProduct);
    const missing = [
        !identifiers.currency ? 'currency' : null,
        !identifiers.amount ? 'amount' : null,
    ].filter(Boolean);
    if (missing.length) {
        return buildContractError('Steam top-up currency and amount are required.', CONTRACT_CODES.PAYLOAD_IDENTIFIER_MISSING, {
            missing,
        });
    }

    return {
        success: true,
        wouldCall: 'POST /steam-topup/order',
        precheckWouldCall: 'POST /steam-topup/check-login',
        payload: {
            steamLogin,
            currency: identifiers.currency,
            amount: identifiers.amount,
        },
        requiredFields: [{ key: 'steamLogin', label: 'Steam Login', type: 'text', required: true }],
    };
};

const isSteamInviteUrl = (value) => {
    const normalized = asString(value);
    if (!normalized) return false;
    return /^https?:\/\/s\.team\/p\/\S+/i.test(normalized)
        || /^s\.team\/p\/\S+/i.test(normalized);
};

const buildSteamGiftPayload = ({ providerProduct, fields = {} } = {}) => {
    const inviteUrl = asString(getFieldValue(fields, [
        'invite_url',
        'steam_invite_url',
        'steamInviteUrl',
        'inviteUrl',
    ]));
    if (!inviteUrl) {
        return buildContractError('Steam invite URL is required.', CONTRACT_CODES.CUSTOMER_INPUT_MISSING, {
            missing: ['invite_url'],
        });
    }
    if (!isSteamInviteUrl(inviteUrl)) {
        return buildContractError('Steam invite URL must use a Steam invite link.', 'STEAM_GIFT_INVITE_URL_INVALID', {
            missing: ['invite_url'],
        });
    }

    const identifiers = extractSteamGiftIdentifiers(providerProduct);
    const missing = [
        !identifiers.appId ? 'app_id' : null,
        !identifiers.subId ? 'sub_id' : null,
        !identifiers.region ? 'region' : null,
    ].filter(Boolean);
    if (missing.length) {
        return buildContractError('Steam gift app_id, sub_id, and region are required.', CONTRACT_CODES.PAYLOAD_IDENTIFIER_MISSING, {
            missing,
        });
    }

    return {
        success: true,
        wouldCall: 'POST /steam-gifts/order',
        payload: {
            invite_url: inviteUrl,
            sub_id: identifiers.subId,
            app_id: identifiers.appId,
            region: identifiers.region,
        },
        requiredFields: [{ key: 'invite_url', label: 'رابط دعوة Steam', type: 'text', required: true }],
    };
};

const buildManualServicePayload = ({ providerProduct, fields = {} } = {}) => {
    const identifiers = extractManualServiceIdentifiers(providerProduct);
    const missing = [
        !identifiers.manualServiceId ? 'manual_service_id' : null,
        !identifiers.productId ? 'product_id' : null,
    ].filter(Boolean);
    if (missing.length) {
        return buildContractError('Manual service identifiers are required.', CONTRACT_CODES.PAYLOAD_IDENTIFIER_MISSING, {
            missing,
        });
    }

    const requiredFields = normalizeRequiredFields(providerProduct?.requiredFields);
    if (requiredFields.length === 0) {
        return buildContractError('Manual service customer fields must be confirmed before provider order payload can be built.', CONTRACT_CODES.CONTRACT_UNCONFIRMED, {
            missing: ['requiredFields'],
        });
    }

    const built = buildFieldPayload(fields, requiredFields);
    if (built.missing.length) {
        return buildContractError(`Missing FazerCards manual service field(s): ${built.missing.join(', ')}.`, CONTRACT_CODES.CUSTOMER_INPUT_MISSING, {
            missing: built.missing,
        });
    }

    return {
        success: true,
        wouldCall: 'POST /manual-services/order',
        payload: {
            manual_service_id: identifiers.manualServiceId,
            product_id: identifiers.productId,
            fields: built.payload,
        },
        requiredFields: built.fields,
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

const parseTelegramResponse = (data = {}) => parseProviderOrderResponse(data);
const parseSteamTopupResponse = (data = {}) => parseProviderOrderResponse(data);
const parseSteamGiftResponse = (data = {}) => parseProviderOrderResponse(data);
const parseManualServiceResponse = (data = {}) => parseProviderOrderResponse(data);

const CONTRACTS = Object.freeze({
    TOPUPS: Object.freeze({
        familyKey: 'TOPUPS',
        displayName: 'Top-ups',
        mode: 'TOPUP_WITH_FIELDS',
        fulfillmentMode: FULFILLMENT_MODES.TOPUP_WITH_FIELDS,
        supportStage: SUPPORT_STAGES.PILOT_READY,
        executionStage: EXECUTION_STAGES.CUSTOMER_FLOW_READY_BUT_GATED,
        riskLevel: RISK_LEVELS.MEDIUM,
        catalogStatus: 'implemented',
        providerEndpoints: {
            catalog: ['GET /topups', 'GET /topups/offers'],
            order: 'POST /topups/order',
            status: 'GET /orders/{orderId}',
            webhooks: ['order.status_changed', 'order.completed', 'order.failed', 'order.refunded'],
        },
        requiredProviderIdentifiers: ['category_id', 'offer_id'],
        requiredCustomerFields: 'dynamic providerProduct.requiredFields',
        codeDelivery: false,
        async: true,
        statusWebhookBehavior: 'Generic FazerCards status sync/webhooks update local order; unknown status moves to manual review with no blind refund.',
        autoProviderAllowed: true,
        bulkAutoProviderAllowed: true,
        readinessReason: 'Payload, response parsing, status sync, webhooks, idempotency, balance preflight, and guards are implemented; still requires controlled real target validation.',
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
        mode: 'CODE_DELIVERY',
        fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
        supportStage: SUPPORT_STAGES.PILOT_READY,
        executionStage: EXECUTION_STAGES.CUSTOMER_FLOW_READY_BUT_GATED,
        riskLevel: RISK_LEVELS.MEDIUM,
        catalogStatus: 'implemented',
        providerEndpoints: {
            catalog: ['GET /giftcards', 'GET /giftcards/cards'],
            order: 'POST /giftcards/order',
            status: 'GET /orders/{orderId}',
            webhooks: ['order.status_changed', 'order.completed', 'order.failed', 'order.refunded'],
        },
        requiredProviderIdentifiers: ['category_id', 'card_id'],
        requiredCustomerFields: ['quantity'],
        codeDelivery: true,
        async: true,
        statusWebhookBehavior: 'Completed only after encrypted code/card/pin/serial is recognized and stored; missing code payload requires manual review.',
        autoProviderAllowed: true,
        bulkAutoProviderAllowed: true,
        readinessReason: 'Catalog, payload, encrypted delivery storage, reveal endpoint, status sync, webhooks, and no-plaintext safeguards are implemented.',
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
        mode: 'CODE_DELIVERY',
        fulfillmentMode: FULFILLMENT_MODES.CODE_DELIVERY,
        supportStage: SUPPORT_STAGES.PILOT_READY,
        executionStage: EXECUTION_STAGES.CUSTOMER_FLOW_READY_BUT_GATED,
        riskLevel: RISK_LEVELS.MEDIUM,
        catalogStatus: 'implemented',
        providerEndpoints: {
            catalog: ['GET /gamekeys', 'GET /gamekeys/keys'],
            order: 'POST /gamekeys/order',
            status: 'GET /orders/{orderId}',
            webhooks: ['order.status_changed', 'order.completed', 'order.failed', 'order.refunded'],
            optional: ['GET /gamekeys/region-restriction'],
        },
        requiredProviderIdentifiers: ['game_id', 'key_id'],
        requiredCustomerFields: ['quantity'],
        codeDelivery: true,
        async: true,
        statusWebhookBehavior: 'Completed only after encrypted key/code/license/serial is recognized and stored; missing key payload requires manual review.',
        autoProviderAllowed: true,
        bulkAutoProviderAllowed: true,
        readinessReason: 'Catalog, payload, encrypted key storage, reveal endpoint, status sync, webhooks, and no-plaintext safeguards are implemented. Region endpoint remains optional/not wired.',
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
        mode: 'TELEGRAM_STARS_OR_PREMIUM',
        fulfillmentMode: FULFILLMENT_MODES.TELEGRAM_STARS_TOPUP,
        supportStage: SUPPORT_STAGES.DRY_RUN_READY,
        executionStage: EXECUTION_STAGES.CONTROLLED_LIVE_CANDIDATE,
        riskLevel: RISK_LEVELS.MEDIUM,
        catalogStatus: 'implemented',
        providerEndpoints: {
            catalog: ['GET /telegram/stars', 'GET /telegram/premium'],
            order: ['POST /telegram/stars/buy', 'POST /telegram/premium/buy'],
            status: 'GET /orders/{orderId}',
            webhooks: ['order.status_changed', 'order.completed', 'order.failed', 'order.refunded'],
        },
        requiredProviderIdentifiers: ['telegram product kind: stars or premium months'],
        requiredCustomerFields: ['telegram_username', 'quantity for stars', 'months for premium'],
        codeDelivery: false,
        async: true,
        statusWebhookBehavior: 'Generic status sync/webhooks can update Telegram orders; no code delivery expected. Unknown status requires review and no blind refund.',
        autoProviderAllowed: true,
        bulkAutoProviderAllowed: true,
        readinessReason: 'Telegram can be enabled for gated AUTO_PROVIDER only when product/customer fields, payload, status sync, webhooks, and provider gates pass readiness.',
        canImportDraft: true,
        canDryRun: true,
        canLivePilot: true,
        canCustomerPurchase: true,
        customerInputSchema: {
            fields: [
                { key: 'telegram_username', type: 'text', required: true },
                { key: 'quantity', type: 'number', required: true, min: 50, max: 10000, mode: 'TELEGRAM_STARS' },
                { key: 'months', type: 'number', required: true, allowed: [3, 6, 12], mode: 'TELEGRAM_PREMIUM' },
            ],
        },
        providerPayloadSchema: {
            confirmed: true,
            endpoints: ['POST /telegram/stars/buy', 'POST /telegram/premium/buy'],
            bodies: {
                TELEGRAM_STARS: { telegram_username: 'string', quantity: 'integer 50..10000' },
                TELEGRAM_PREMIUM: { telegram_username: 'string', months: 'integer one of 3,6,12' },
            },
            async: true,
        },
        expectedResponseSchema: {
            confirmed: true,
            providerOrderIdPaths: ['order.id', 'order.order_id', 'data.id', 'data.order_id', 'id', 'order_id'],
            statusPaths: ['order.status', 'data.status', 'status', 'state'],
        },
        storageStrategy: 'ORDER_PROVIDER_METADATA',
        customerDeliveryStrategy: 'NO_CODE_DELIVERY_STATUS_ONLY',
        requiredCapabilities: ['FAZERCARDS_ENABLED', 'FAZERCARDS_REAL_ORDERS_ENABLED', 'webhook/status sync'],
        blockers: ['Requires readiness checks, environment gates, and asynchronous status/webhook confirmation before any real provider order.'],
        warnings: ['Telegram provider fulfillment is asynchronous. Balance is debited by FazerCards immediately after a real buy request.'],
    }),
    STEAM_TOPUP: Object.freeze({
        familyKey: 'STEAM_TOPUP',
        displayName: 'Steam Wallet Top-up',
        mode: 'STEAM_TOPUP_WITH_LOGIN',
        fulfillmentMode: FULFILLMENT_MODES.STEAM_TOPUP_WITH_LOGIN,
        supportStage: SUPPORT_STAGES.DRY_RUN_READY,
        executionStage: EXECUTION_STAGES.CONTROLLED_LIVE_CANDIDATE,
        riskLevel: RISK_LEVELS.HIGH,
        catalogStatus: 'implemented',
        providerEndpoints: {
            catalog: ['GET /steam-topup/rates'],
            precheck: 'POST /steam-topup/check-login',
            order: 'POST /steam-topup/order',
            status: 'GET /orders/{orderId}',
            webhooks: ['order.status_changed', 'order.completed', 'order.failed', 'order.refunded'],
        },
        requiredProviderIdentifiers: ['currency', 'amount'],
        requiredCustomerFields: ['steamLogin'],
        codeDelivery: false,
        async: true,
        statusWebhookBehavior: 'Generic status sync/webhooks can update Steam top-up orders; check-login must pass before any future real provider order.',
        autoProviderAllowed: true,
        bulkAutoProviderAllowed: true,
        readinessReason: 'Steam top-up can be enabled for gated AUTO_PROVIDER only when steamLogin field, currency/amount metadata, check-login preflight, status sync, webhooks, and provider gates pass readiness.',
        canImportDraft: true,
        canDryRun: true,
        canLivePilot: true,
        canCustomerPurchase: true,
        customerInputSchema: {
            fields: [{ key: 'steamLogin', type: 'text', required: true }],
        },
        providerPayloadSchema: {
            confirmed: true,
            precheckEndpoint: 'POST /steam-topup/check-login',
            endpoint: 'POST /steam-topup/order',
            body: { steamLogin: 'string', currency: 'string', amount: 'number' },
            async: true,
        },
        expectedResponseSchema: {
            confirmed: true,
            providerOrderIdPaths: ['order.id', 'order.order_id', 'data.id', 'data.order_id', 'id', 'order_id'],
            statusPaths: ['order.status', 'data.status', 'status', 'state'],
        },
        storageStrategy: 'ORDER_PROVIDER_METADATA',
        customerDeliveryStrategy: 'NO_CODE_DELIVERY_STATUS_ONLY',
        requiredCapabilities: ['FAZERCARDS_ENABLED', 'FAZERCARDS_REAL_ORDERS_ENABLED', 'steam-topup check-login preflight', 'webhook/status sync'],
        blockers: ['High-risk flow requires check-login preflight, readiness checks, environment gates, and status/webhook confirmation before any real provider order.'],
        warnings: ['High risk: wrong Steam login can deliver value to the wrong recipient. check-login must pass before any real provider order.'],
    }),
    MANUAL_SERVICES: Object.freeze({
        familyKey: 'MANUAL_SERVICES',
        displayName: 'Manual Services',
        mode: 'MANUAL_SERVICE_PROVIDER_ORDER',
        fulfillmentMode: FULFILLMENT_MODES.MANUAL_SERVICE,
        supportStage: SUPPORT_STAGES.DRY_RUN_READY,
        executionStage: EXECUTION_STAGES.CUSTOMER_FLOW_READY_BUT_GATED,
        riskLevel: RISK_LEVELS.HIGH,
        catalogStatus: 'implemented',
        providerEndpoints: {
            catalog: ['GET /manual-services', 'GET /manual-services/{manualServiceId}/offers'],
            order: 'POST /manual-services/order',
            chat: ['GET /manual-services/orders/{orderId}/chat', 'POST /manual-services/orders/{orderId}/chat'],
            status: 'GET /orders/{orderId}',
            webhooks: ['order.status_changed', 'manual_service.chat.message', 'manual_service.chat.waiting_reply'],
        },
        requiredProviderIdentifiers: ['manual_service_id', 'product_id'],
        requiredCustomerFields: 'dynamic providerProduct.requiredFields or admin-defined orderFields',
        codeDelivery: false,
        async: true,
        statusWebhookBehavior: 'Generic status sync/webhooks update order status; manual-service chat webhooks append safe admin notes only.',
        autoProviderAllowed: true,
        bulkAutoProviderAllowed: true,
        readinessReason: 'Manual Services can be enabled for gated AUTO_PROVIDER only when provider identifiers, customer fields, message-only chat/status handling, and provider gates pass readiness.',
        canImportDraft: true,
        canDryRun: true,
        canLivePilot: true,
        canCustomerPurchase: true,
        customerInputSchema: {
            source: 'providerProduct.requiredFields or admin-defined orderFields',
            fields: [],
            dynamicRequiredFields: true,
        },
        providerPayloadSchema: {
            confirmed: true,
            endpoint: 'POST /manual-services/order',
            body: { manual_service_id: 'string', product_id: 'string', fields: 'object<string,string>' },
            chatEndpoints: ['GET /manual-services/orders/{orderId}/chat', 'POST /manual-services/orders/{orderId}/chat'],
            attachmentUpload: 'NEEDS_VERIFY',
        },
        expectedResponseSchema: {
            confirmed: true,
            providerOrderIdPaths: ['order.id', 'order.order_id', 'data.id', 'data.order_id', 'id', 'order_id'],
            statusPaths: ['order.status', 'data.status', 'status', 'state'],
        },
        storageStrategy: 'ORDER_PROVIDER_METADATA_AND_ADMIN_NOTES',
        customerDeliveryStrategy: 'ADMIN_MANAGED_MANUAL_WORKFLOW',
        requiredCapabilities: ['FAZERCARDS_ENABLED', 'FAZERCARDS_REAL_ORDERS_ENABLED', 'manual service fields', 'manual service chat admin workflow'],
        blockers: ['Attachment chat/upload support remains NEEDS_VERIFY and is not required for basic provider order automation unless a provider offer requires attachments.'],
        warnings: ['Provider-side manual service orders are asynchronous. Message-only chat diagnostics are supported; attachment handling remains NEEDS_VERIFY.'],
    }),
    STEAM_GIFTS: Object.freeze({
        familyKey: 'STEAM_GIFTS',
        displayName: 'Steam Gifts',
        mode: 'STEAM_GIFT',
        fulfillmentMode: FULFILLMENT_MODES.STEAM_GIFT_INVITE,
        supportStage: SUPPORT_STAGES.PILOT_READY,
        executionStage: EXECUTION_STAGES.CONTROLLED_LIVE_CANDIDATE,
        riskLevel: RISK_LEVELS.HIGH,
        catalogStatus: 'ACCESS_CONFIRMED_READ_ONLY',
        accessStage: 'ACCESS_CONFIRMED_READ_ONLY',
        providerEndpoints: {
            catalog: ['GET /steam-gifts/games', 'GET /steam-gifts/games/{appid}'],
            order: 'POST /steam-gifts/order',
            status: 'GET /orders/{orderId}',
            webhooks: ['order.status_changed', 'order.completed', 'order.failed', 'order.refunded'],
        },
        requiredProviderIdentifiers: ['app_id', 'sub_id', 'region'],
        requiredCustomerFields: ['invite_url'],
        codeDelivery: false,
        async: true,
        statusWebhookBehavior: 'Generic FazerCards status sync/webhooks update local order; completed finishes, failed/refunded refund once, unknown requires review with no blind refund.',
        autoProviderAllowed: true,
        bulkAutoProviderAllowed: true,
        readinessReason: 'Steam Gifts can be enabled for gated AUTO_PROVIDER only after explicit appid/offer-region import, invite URL field readiness, and provider gates pass readiness; broad catalog sync remains disabled.',
        canImportDraft: true,
        canDryRun: true,
        canLivePilot: true,
        canCustomerPurchase: true,
        customerInputSchema: {
            fields: [{ key: 'invite_url', label: 'رابط دعوة Steam', type: 'text', required: true }],
        },
        providerPayloadSchema: {
            confirmed: true,
            access: 'ACCESS_CONFIRMED_READ_ONLY',
            endpoint: 'POST /steam-gifts/order',
            body: { invite_url: 'string', sub_id: 'string', app_id: 'string', region: 'string' },
        },
        expectedResponseSchema: {
            confirmed: true,
            providerOrderIdPaths: ['order.id', 'order.order_id', 'data.id', 'data.order_id', 'id', 'order_id'],
            statusPaths: ['order.status', 'data.status', 'status', 'state'],
        },
        storageStrategy: 'ORDER_PROVIDER_METADATA',
        customerDeliveryStrategy: 'NO_CODE_DELIVERY_STATUS_ONLY',
        requiredCapabilities: ['FAZERCARDS_ENABLED', 'FAZERCARDS_REAL_ORDERS_ENABLED', 'providerExecutionEnabled', 'invite_url customer field', 'appid/sub_id/region metadata'],
        blockers: ['Broad catalog sync remains disabled; only explicit appid/on-demand imported products can pass readiness.'],
        warnings: ['Steam Gifts catalog is huge; sync only an explicit appid and selected offer/region.', 'No live Steam Gift order validation has been completed yet.'],
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
    nextBestExecutionOrder: ['GIFTCARDS', 'GAME_KEYS', 'TOPUPS', 'TELEGRAM', 'STEAM_TOPUP', 'STEAM_GIFTS', 'MANUAL_SERVICES'],
});

const normalizeFamilyKey = (familyKey) => asString(familyKey).toUpperCase();

const getAllowedExecutionModes = (familyKey) => {
    const normalized = normalizeFamilyKey(familyKey);
    if (CONTROLLED_AUTO_PROVIDER_FAMILIES.has(normalized)) {
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
    if (BULK_AUTO_PROVIDER_FAMILIES.has(normalized)) return PROVIDER_EXECUTION_MODES.AUTO_PROVIDER;
    if (CONTROLLED_AUTO_PROVIDER_FAMILIES.has(normalized)) return PROVIDER_EXECUTION_MODES.MANUAL_FULFILLMENT;
    if (MANUAL_FULFILLMENT_FAMILIES.has(normalized)) return PROVIDER_EXECUTION_MODES.MANUAL_FULFILLMENT;
    return PROVIDER_EXECUTION_MODES.DISABLED;
};

const canAutoExecuteFamily = (familyKey) => CONTROLLED_AUTO_PROVIDER_FAMILIES.has(normalizeFamilyKey(familyKey));
const canBulkAutoExecuteFamily = (familyKey) => BULK_AUTO_PROVIDER_FAMILIES.has(normalizeFamilyKey(familyKey));

const getAutoProviderIdentifiers = (familyKey, providerProduct = {}) => {
    const normalized = normalizeFamilyKey(familyKey || providerProduct?.familyKey);
    if (normalized === 'TOPUPS') return extractTopupIdentifiers(providerProduct);
    if (normalized === 'GIFTCARDS') return extractGiftCardIdentifiers(providerProduct);
    if (normalized === 'GAME_KEYS') return extractGameKeyIdentifiers(providerProduct);
    if (normalized === 'TELEGRAM') return extractTelegramIdentifiers(providerProduct);
    if (normalized === 'STEAM_TOPUP') return extractSteamTopupIdentifiers(providerProduct);
    if (normalized === 'STEAM_GIFTS') return extractSteamGiftIdentifiers(providerProduct);
    if (normalized === 'MANUAL_SERVICES') return extractManualServiceIdentifiers(providerProduct);
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
        const rawCost = firstValue(providerProduct.costPrice, providerProduct.rawPrice);
        const cost = Number(rawCost);
        if (rawCost === undefined || rawCost === null || rawCost === '' || !Number.isFinite(cost) || cost <= 0) {
            errors.push({
                code: 'AUTO_PROVIDER_PROVIDER_COST_INVALID',
                message: 'Auto provider execution requires a valid positive provider cost.',
            });
        }
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
    } else if (normalizedFamilyKey === 'TELEGRAM') {
        const requiredFields = normalizeCustomerFieldDefinitions(product, providerProduct)
            .filter((field) => field.isActive !== false && field.required !== false);
        const hasTelegramUsername = requiredFields.some((field) => fieldMatches(field, /telegram[_\s-]?username|telegram|username/i));
        if (!identifiers.kind) errors.push({ code: 'AUTO_PROVIDER_TELEGRAM_KIND_MISSING', message: 'Telegram auto provider execution requires a stars or premium product kind.' });
        if (identifiers.kind === 'premium' && ![3, 6, 12].includes(identifiers.months)) {
            errors.push({ code: 'AUTO_PROVIDER_TELEGRAM_PREMIUM_MONTHS_INVALID', message: 'Telegram Premium auto provider execution requires months to be one of 3, 6, or 12.' });
        }
        if (!hasTelegramUsername) {
            errors.push({
                code: 'AUTO_PROVIDER_TELEGRAM_USERNAME_FIELD_MISSING',
                message: 'Telegram auto provider execution requires a telegram_username customer field.',
            });
        }
    } else if (normalizedFamilyKey === 'STEAM_TOPUP') {
        const requiredFields = normalizeCustomerFieldDefinitions(product, providerProduct)
            .filter((field) => field.isActive !== false && field.required !== false);
        const hasSteamLogin = requiredFields.some((field) => fieldMatches(field, /steam[_\s-]?login|steam[_\s-]?username|steam[_\s-]?profile/i));
        if (!identifiers.currency) errors.push({ code: 'AUTO_PROVIDER_STEAM_TOPUP_CURRENCY_MISSING', message: 'Steam top-up auto provider execution requires currency metadata.' });
        if (!identifiers.amount) errors.push({ code: 'AUTO_PROVIDER_STEAM_TOPUP_AMOUNT_MISSING', message: 'Steam top-up auto provider execution requires a positive amount metadata value.' });
        if (!hasSteamLogin) {
            errors.push({
                code: 'AUTO_PROVIDER_STEAM_LOGIN_FIELD_MISSING',
                message: 'Steam top-up auto provider execution requires a steamLogin customer field.',
            });
        }
    } else if (normalizedFamilyKey === 'STEAM_GIFTS') {
        const requiredFields = normalizeCustomerFieldDefinitions(product, providerProduct)
            .filter((field) => field.isActive !== false && field.required !== false);
        const hasInviteUrl = requiredFields.some((field) => fieldMatches(field, /invite[_\s-]?url|steam[_\s-]?invite/i));
        if (!identifiers.appId) errors.push({ code: 'AUTO_PROVIDER_STEAM_GIFT_APP_ID_MISSING', message: 'Steam Gift auto provider execution requires app_id.' });
        if (!identifiers.subId) errors.push({ code: 'AUTO_PROVIDER_STEAM_GIFT_SUB_ID_MISSING', message: 'Steam Gift auto provider execution requires sub_id.' });
        if (!identifiers.region) errors.push({ code: 'AUTO_PROVIDER_STEAM_GIFT_REGION_MISSING', message: 'Steam Gift auto provider execution requires region.' });
        if (!hasInviteUrl) {
            errors.push({
                code: 'AUTO_PROVIDER_STEAM_GIFT_INVITE_FIELD_MISSING',
                message: 'Steam Gift auto provider execution requires an invite_url customer field.',
            });
        }
    } else if (normalizedFamilyKey === 'MANUAL_SERVICES') {
        const requiredFields = normalizeCustomerFieldDefinitions(product, providerProduct)
            .filter((field) => field.isActive !== false && field.required !== false);
        if (!identifiers.manualServiceId) errors.push({ code: 'AUTO_PROVIDER_MANUAL_SERVICE_ID_MISSING', message: 'Manual Service auto provider execution requires manual_service_id.' });
        if (!identifiers.productId) errors.push({ code: 'AUTO_PROVIDER_MANUAL_SERVICE_PRODUCT_ID_MISSING', message: 'Manual Service auto provider execution requires product_id.' });
        if (requiredFields.length === 0) {
            errors.push({
                code: 'AUTO_PROVIDER_MANUAL_SERVICE_FIELDS_MISSING',
                message: 'Manual Service auto provider execution requires customer fields copied from the provider offer or configured by admin.',
            });
        }
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
    if (contract.familyKey === 'TELEGRAM') return buildTelegramPayload({ providerProduct, fields, quantity });
    if (contract.familyKey === 'STEAM_TOPUP') return buildSteamTopupPayload({ providerProduct, fields });
    if (contract.familyKey === 'STEAM_GIFTS') return buildSteamGiftPayload({ providerProduct, fields });
    if (contract.familyKey === 'MANUAL_SERVICES') return buildManualServicePayload({ providerProduct, fields });
    return buildUnconfirmedPayload({ contract });
};

const parseResponseForFamily = (familyKey, data = {}) => {
    const normalized = asString(familyKey).toUpperCase();
    if (normalized === 'TOPUPS') return parseTopupResponse(data);
    if (normalized === 'GIFTCARDS') return parseGiftCardResponse(data);
    if (normalized === 'GAME_KEYS') return parseGameKeyResponse(data);
    if (normalized === 'TELEGRAM') return parseTelegramResponse(data);
    if (normalized === 'STEAM_TOPUP') return parseSteamTopupResponse(data);
    if (normalized === 'STEAM_GIFTS') return parseSteamGiftResponse(data);
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
    if (contract.familyKey === 'STEAM_GIFTS') {
        if (checks.hasSteamGiftAppId === false) missing.push('app_id');
        if (checks.hasSteamGiftSubId === false) missing.push('sub_id');
        if (checks.hasSteamGiftRegion === false) missing.push('region');
        if (checks.hasSteamGiftInviteField === false) missing.push('invite_url customer field');
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
    canBulkAutoExecuteFamily,
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
    parseSteamGiftResponse,
    parseManualServiceResponse,
    extractTelegramIdentifiers,
    extractSteamTopupIdentifiers,
    extractSteamGiftIdentifiers,
    extractManualServiceIdentifiers,
    getMissingCapabilities,
    normalizeCustomerFieldDefinitions,
    validateManualCustomerFieldsForProduct,
    redactSecrets,
    extractDeliveredCodes,
};
