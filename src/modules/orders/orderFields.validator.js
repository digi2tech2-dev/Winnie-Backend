'use strict';

/**
 * orderFields.validator.js
 *
 * Pure utility — no DB access.
 *
 * Validates a customer-supplied `orderFieldsValues` map against a product's
 * `orderFields` definition, and returns the immutable snapshot to persist on
 * the Order document.
 *
 * Rules enforced:
 *   1. Unknown keys (not in product.orderFields) → rejected
 *   2. Required active fields with missing / blank values → rejected
 *   3. Type coercion / validation per field type:
 *        text     → string (non-empty)
 *        textarea → string (non-empty)
 *        number   → numeric (coerced via parseFloat), optional min/max bounds
 *        url      → string matching URL format (requires http/https)
 *        select   → must be one of field.options
 *   4. Inactive fields are completely ignored (skipped for both validation and snapshot)
 *
 * @module orderFields.validator
 */

const Joi = require('joi');
const { BusinessRuleError, ValidationError } = require('../../shared/errors/AppError');

/** Field types recognised by the platform. */
const FIELD_TYPES = Object.freeze({
    TEXT: 'text',
    TEXTAREA: 'textarea',
    NUMBER: 'number',
    SELECT: 'select',
    URL: 'url',
    // Future-ready (accepted without special backend validation for now)
    EMAIL: 'email',
    TEL: 'tel',
    DATE: 'date',
});

const DYNAMIC_FIELD_TYPES = Object.freeze({
    TEXT: 'text',
    TEXTAREA: 'textarea',
    NUMBER: 'number',
    EMAIL: 'email',
    TEL: 'tel',
    URL: 'url',
    DATE: 'date',
    SELECT: 'select',
});

// Loose but practical URL regex: requires http(s):// prefix.
const URL_REGEX = /^https?:\/\/.+\..+/i;

/**
 * validateOrderFields(orderFields, orderFieldsValues)
 *
 * @param {Array}  orderFields        - product.orderFields (already filtered from DB)
 * @param {Object} orderFieldsValues  - customer-supplied key→value map (may be undefined/null)
 *
 * @returns {{
 *   values: Object,
 *   fieldsSnapshot: Array<{ key, label, type, options? }>
 * }}
 *
 * @throws {BusinessRuleError} with code 'INVALID_ORDER_FIELDS' on any violation
 */
const validateOrderFields = (orderFields = [], orderFieldsValues = {}) => {
    // Normalise input: treat missing body field as empty object
    const submitted = (orderFieldsValues && typeof orderFieldsValues === 'object')
        ? orderFieldsValues
        : {};

    // Active fields only — inactive fields are invisible to customers
    const activeFields = orderFields.filter((f) => f.isActive !== false);

    // ── Build a lookup for fast access ───────────────────────────────────────
    const fieldByKey = new Map(activeFields.map((f) => [f.key, f]));

    // ── 1. Reject unknown keys ────────────────────────────────────────────────
    const allowedKeys = new Set(fieldByKey.keys());
    const unknownKeys = Object.keys(submitted).filter((k) => !allowedKeys.has(k));
    if (unknownKeys.length > 0) {
        throw new BusinessRuleError(
            `Unknown order field(s): ${unknownKeys.map((k) => `'${k}'`).join(', ')}.`,
            'INVALID_ORDER_FIELDS'
        );
    }

    const validatedValues = {};
    const errors = [];

    for (const field of activeFields) {
        const { key, label, type, required, options, min, max } = field;
        const raw = submitted[key];

        // ── 2. Required check ─────────────────────────────────────────────────
        const isMissing = raw === undefined || raw === null || raw === '';
        if (required && isMissing) {
            errors.push(`'${label}' is required.`);
            continue;
        }

        // Optional field that was simply not supplied — skip validation
        if (isMissing) continue;

        // ── 3. Type validation ────────────────────────────────────────────────
        switch (type) {
            case FIELD_TYPES.TEXT:
            case FIELD_TYPES.TEXTAREA:
            case FIELD_TYPES.EMAIL:
            case FIELD_TYPES.TEL:
            case FIELD_TYPES.DATE: {
                if (typeof raw !== 'string' || raw.trim() === '') {
                    errors.push(`'${label}' must be a non-empty string.`);
                    continue;
                }
                validatedValues[key] = raw.trim();
                break;
            }

            case FIELD_TYPES.URL: {
                if (typeof raw !== 'string' || raw.trim() === '') {
                    errors.push(`'${label}' must be a non-empty URL string.`);
                    continue;
                }
                const trimmedUrl = raw.trim();
                if (!URL_REGEX.test(trimmedUrl)) {
                    errors.push(`'${label}' must be a valid URL (e.g. https://example.com).`);
                    continue;
                }
                validatedValues[key] = trimmedUrl;
                break;
            }

            case FIELD_TYPES.NUMBER: {
                const num = typeof raw === 'number' ? raw : parseFloat(raw);
                if (isNaN(num)) {
                    errors.push(`'${label}' must be a valid number.`);
                    continue;
                }
                // Enforce min / max bounds when set on the field definition
                if (min !== null && min !== undefined && num < min) {
                    errors.push(`'${label}' must be at least ${min}.`);
                    continue;
                }
                if (max !== null && max !== undefined && num > max) {
                    errors.push(`'${label}' must be at most ${max}.`);
                    continue;
                }
                validatedValues[key] = num;
                break;
            }

            case FIELD_TYPES.SELECT: {
                const opts = Array.isArray(options) ? options : [];
                if (!opts.includes(raw)) {
                    const allowed = opts.length
                        ? opts.map((o) => `'${o}'`).join(', ')
                        : '(none defined)';
                    errors.push(`'${label}' must be one of: ${allowed}.`);
                    continue;
                }
                validatedValues[key] = raw;
                break;
            }

            default: {
                // Unknown type — accept value as-is (forward compatibility)
                validatedValues[key] = raw;
            }
        }
    }

    if (errors.length > 0) {
        throw new BusinessRuleError(
            `Order field validation failed: ${errors.join(' ')}`,
            'INVALID_ORDER_FIELDS'
        );
    }

    // ── 4. Build immutable fields snapshot ───────────────────────────────────
    // Only include fields that are active. The subset stored on the order
    // contains only the data the customer needs to understand their submission.
    const fieldsSnapshot = activeFields.map((f) => {
        const snap = {
            key: f.key,
            label: f.label,
            type: f.type,
        };
        if (f.type === FIELD_TYPES.SELECT && Array.isArray(f.options)) {
            snap.options = f.options;
        }
        if (f.placeholder) snap.placeholder = f.placeholder;
        // Persist min/max in snapshot so historical context is preserved
        if (f.type === FIELD_TYPES.NUMBER) {
            if (f.min !== null && f.min !== undefined) snap.min = f.min;
            if (f.max !== null && f.max !== undefined) snap.max = f.max;
        }
        return snap;
    });

    return { values: validatedValues, fieldsSnapshot };
};

const normalizeDynamicField = (field) => ({
    name: String(field.name || '').trim().toLowerCase(),
    label: String(field.label || '').trim(),
    type: field.type,
    required: field.required !== false,
    options: Array.isArray(field.options)
        ? [...new Set(field.options.map((option) => String(option || '').trim()).filter(Boolean))]
        : [],
    min: field.min ?? null,
    max: field.max ?? null,
    isActive: field.isActive !== false,
});

const buildDynamicFieldRule = (field) => {
    let rule;

    switch (field.type) {
        case DYNAMIC_FIELD_TYPES.NUMBER:
            rule = Joi.number();
            if (field.min !== null && field.min !== undefined) rule = rule.min(field.min);
            if (field.max !== null && field.max !== undefined) rule = rule.max(field.max);
            break;

        case DYNAMIC_FIELD_TYPES.EMAIL:
            rule = Joi.string().trim().email({ tlds: { allow: false } });
            break;

        case DYNAMIC_FIELD_TYPES.URL:
            rule = Joi.string().trim().uri({ scheme: ['http', 'https'] });
            break;

        case DYNAMIC_FIELD_TYPES.DATE:
            rule = Joi.date().iso();
            break;

        case DYNAMIC_FIELD_TYPES.SELECT:
            rule = Joi.string().trim().valid(...field.options);
            break;

        case DYNAMIC_FIELD_TYPES.TEXT:
        case DYNAMIC_FIELD_TYPES.TEXTAREA:
        case DYNAMIC_FIELD_TYPES.TEL:
        default:
            rule = Joi.string().trim();
            break;
    }

    if (field.required) {
        return rule.required().messages({
            'any.required': `'${field.label || field.name}' is required.`,
            'string.empty': `'${field.label || field.name}' is required.`,
            'any.only': `'${field.label || field.name}' must be one of: ${field.options.join(', ')}.`,
        });
    }

    return rule.optional().allow(null, '');
};

const validateDynamicFields = (dynamicFields = [], submittedValues = {}) => {
    const submitted = submittedValues && typeof submittedValues === 'object' && !Array.isArray(submittedValues)
        ? submittedValues
        : {};

    const activeFields = dynamicFields
        .map(normalizeDynamicField)
        .filter((field) => field.isActive !== false);

    const schemaShape = {};
    for (const field of activeFields) {
        if (!field.name) {
            throw new ValidationError('Dynamic field validation failed.', [
                { field: 'dynamicFields.name', message: 'Dynamic field name is required.' },
            ]);
        }

        schemaShape[field.name] = buildDynamicFieldRule(field);
    }

    const schema = Joi.object(schemaShape).unknown(false);
    const { value, error } = schema.validate(submitted, {
        abortEarly: false,
        convert: true,
        stripUnknown: false,
    });

    if (error) {
        throw new ValidationError(
            'Dynamic field validation failed.',
            error.details.map((detail) => ({
                field: detail.path.join('.'),
                message: detail.message.replace(/"/g, "'"),
            }))
        );
    }

    const values = { ...value };
    for (const field of activeFields) {
        if (!field.required && (values[field.name] === '' || values[field.name] === null)) {
            delete values[field.name];
        }
    }

    const fieldsSnapshot = activeFields.map((field) => ({
        name: field.name,
        label: field.label,
        type: field.type,
        required: field.required,
        options: [...field.options],
        min: field.min,
        max: field.max,
        isActive: field.isActive,
    }));

    return { values, fieldsSnapshot };
};

/**
 * applyProviderMapping(values, providerMapping)
 *
 * Translates internal field keys → provider parameter names.
 *
 * Used by the fulfillment engine before calling provider.placeOrder().
 * Keys not present in the mapping are passed through unchanged.
 *
 * @param {Object}           values          - validated customerInput.values
 * @param {Map|Object|null}  providerMapping - product.providerMapping (Mongoose Map or plain obj)
 * @returns {Object} - new object with translated keys; original is never mutated
 *
 * @example
 *   applyProviderMapping({ player_id: '123', server: 'EU' }, { player_id: 'link' })
 *   // → { link: '123', server: 'EU' }
 */
const applyProviderMapping = (values, providerMapping) => {
    if (!values || typeof values !== 'object') return {};
    if (!providerMapping) return { ...values };

    // Support both Mongoose Map (with .get()) and plain objects
    const getMapping = providerMapping instanceof Map
        ? (k) => providerMapping.get(k)
        : (k) => (providerMapping[k]);

    const mapped = {};
    for (const [key, value] of Object.entries(values)) {
        const providerKey = getMapping(key);
        mapped[providerKey || key] = value;
    }
    return mapped;
};

module.exports = {
    validateOrderFields,
    validateDynamicFields,
    applyProviderMapping,
    FIELD_TYPES,
    DYNAMIC_FIELD_TYPES,
};
