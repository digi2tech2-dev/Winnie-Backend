'use strict';

const { Setting } = require('../admin/setting.model');
const { BusinessRuleError } = require('../../shared/errors/AppError');

const PAYMENT_GROUPS_SETTING_KEY = 'paymentGroups';

const FIELD_TYPES = Object.freeze({
    TEXT: 'text',
    NUMBER: 'number',
    TEXTAREA: 'textarea',
    SELECT: 'select',
    IMAGE: 'image',
});

const SUPPORTED_FIELD_TYPES = new Set(Object.values(FIELD_TYPES));
const SAFE_FIELD_KEY = /^[A-Za-z0-9_-]+$/;

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeType = (type) => {
    const normalized = String(type || '').trim().toLowerCase();
    return normalized === 'file' ? FIELD_TYPES.IMAGE : normalized;
};

const parseJsonBodyField = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch (_err) {
        throw new BusinessRuleError('Invalid custom fields payload.', 'INVALID_CUSTOM_FIELDS_PAYLOAD');
    }
};

const booleanOrDefault = (value, defaultValue) => {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    if (String(value).trim().toLowerCase() === 'true') return true;
    if (String(value).trim().toLowerCase() === 'false') return false;
    throw new BusinessRuleError('customFields boolean values must be true or false.', 'INVALID_CUSTOM_FIELD_CONFIG');
};

const normalizeOptions = (options, fieldKey, type) => {
    if (options === undefined || options === null || options === '') {
        if (type === FIELD_TYPES.SELECT) {
            throw new BusinessRuleError(`customField '${fieldKey}' must define options for select fields.`, 'INVALID_CUSTOM_FIELD_CONFIG');
        }
        return [];
    }
    if (!Array.isArray(options)) {
        throw new BusinessRuleError(`customField '${fieldKey}' options must be an array.`, 'INVALID_CUSTOM_FIELD_CONFIG');
    }
    const normalized = [...new Set(options.map((option) => String(option || '').trim()).filter(Boolean))];
    if (type === FIELD_TYPES.SELECT && normalized.length === 0) {
        throw new BusinessRuleError(`customField '${fieldKey}' must define at least one select option.`, 'INVALID_CUSTOM_FIELD_CONFIG');
    }
    return normalized;
};

const normalizePaymentMethodCustomFields = (fields = [], { context = 'customFields' } = {}) => {
    if (fields === undefined || fields === null || fields === '') return [];
    if (!Array.isArray(fields)) {
        throw new BusinessRuleError(`${context} must be an array.`, 'INVALID_CUSTOM_FIELD_CONFIG');
    }

    const activeKeys = new Set();
    return fields.map((field, index) => {
        if (!field || typeof field !== 'object' || Array.isArray(field)) {
            throw new BusinessRuleError(`${context}[${index}] must be an object.`, 'INVALID_CUSTOM_FIELD_CONFIG');
        }

        const key = String(field.key || '').trim();
        const label = String(field.label || '').trim();
        const type = normalizeType(field.type);
        const isActive = booleanOrDefault(field.isActive, true);
        const required = booleanOrDefault(field.required, false);

        if (!key) throw new BusinessRuleError(`${context}[${index}].key is required.`, 'INVALID_CUSTOM_FIELD_CONFIG');
        if (!SAFE_FIELD_KEY.test(key)) {
            throw new BusinessRuleError(`${context}[${index}].key may contain only letters, numbers, underscores, and hyphens.`, 'INVALID_CUSTOM_FIELD_CONFIG');
        }
        if (!label) throw new BusinessRuleError(`${context}[${index}].label is required.`, 'INVALID_CUSTOM_FIELD_CONFIG');
        if (!SUPPORTED_FIELD_TYPES.has(type)) {
            throw new BusinessRuleError(`${context}[${index}].type is not supported.`, 'INVALID_CUSTOM_FIELD_CONFIG');
        }
        if (isActive) {
            const duplicateKey = key.toLowerCase();
            if (activeKeys.has(duplicateKey)) {
                throw new BusinessRuleError(`Duplicate active customField key '${key}' is not allowed within the same payment method.`, 'DUPLICATE_CUSTOM_FIELD_KEY');
            }
            activeKeys.add(duplicateKey);
        }

        const sortOrder = field.sortOrder === undefined || field.sortOrder === null || field.sortOrder === ''
            ? index
            : Number(field.sortOrder);
        if (!Number.isFinite(sortOrder)) {
            throw new BusinessRuleError(`${context}[${index}].sortOrder must be numeric.`, 'INVALID_CUSTOM_FIELD_CONFIG');
        }

        return {
            ...field,
            key,
            label,
            type,
            required,
            placeholder: field.placeholder === undefined || field.placeholder === null ? '' : String(field.placeholder),
            options: normalizeOptions(field.options, key, type),
            sortOrder,
            isActive,
        };
    });
};

const normalizePaymentGroupsSettingValue = (value) => {
    if (!Array.isArray(value)) {
        throw new BusinessRuleError('paymentGroups must be an array.', 'INVALID_PAYMENT_GROUPS');
    }

    return value.map((group, groupIndex) => {
        if (!group || typeof group !== 'object' || Array.isArray(group)) {
            throw new BusinessRuleError(`paymentGroups[${groupIndex}] must be an object.`, 'INVALID_PAYMENT_GROUPS');
        }
        const methods = Array.isArray(group.methods) ? group.methods : [];
        return {
            ...group,
            methods: methods.map((method, methodIndex) => {
                if (!method || typeof method !== 'object' || Array.isArray(method)) {
                    throw new BusinessRuleError(`paymentGroups[${groupIndex}].methods[${methodIndex}] must be an object.`, 'INVALID_PAYMENT_GROUPS');
                }
                if (method.customFields === undefined && method.customFieldConfig === undefined) return method;
                return {
                    ...method,
                    customFields: normalizePaymentMethodCustomFields(method.customFields || method.customFieldConfig || [], {
                        context: `paymentGroups[${groupIndex}].methods[${methodIndex}].customFields`,
                    }),
                };
            }),
        };
    });
};

const findConfiguredPaymentMethodById = async (paymentMethodId) => {
    const normalizedId = String(paymentMethodId || '').trim();
    if (!normalizedId) {
        throw new BusinessRuleError('paymentMethodId is required.', 'PAYMENT_METHOD_REQUIRED');
    }

    const setting = await Setting.findOne({ key: PAYMENT_GROUPS_SETTING_KEY }).lean();
    const groups = Array.isArray(setting?.value) ? setting.value : [];

    for (const group of groups) {
        const methods = Array.isArray(group?.methods) ? group.methods : [];
        const method = methods.find((candidate) => String(candidate?.id || candidate?._id || '').trim() === normalizedId);
        if (method) {
            return { method: { ...method, paymentMethodId: normalizedId }, group };
        }
    }

    throw new BusinessRuleError('Selected payment method was not found.', 'PAYMENT_METHOD_NOT_FOUND');
};

const fileMetadataFor = (file) => file ? {
    path: `uploads/deposits/${file.filename}`,
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
} : null;

const validateScalarValue = (field, rawValue) => {
    const missing = rawValue === undefined || rawValue === null || String(rawValue).trim() === '';
    if (missing) {
        if (field.required) {
            throw new BusinessRuleError(`Custom field '${field.label}' is required.`, 'CUSTOM_FIELD_REQUIRED');
        }
        return undefined;
    }

    if (field.type === FIELD_TYPES.NUMBER) {
        const numeric = Number(rawValue);
        if (!Number.isFinite(numeric)) {
            throw new BusinessRuleError(`Custom field '${field.label}' must be a number.`, 'INVALID_CUSTOM_FIELD_VALUE');
        }
        return numeric;
    }

    const value = String(rawValue).trim();
    if (field.type === FIELD_TYPES.SELECT && !field.options.includes(value)) {
        throw new BusinessRuleError(`Custom field '${field.label}' must be one of the configured options.`, 'INVALID_CUSTOM_FIELD_VALUE');
    }
    if ([FIELD_TYPES.TEXT, FIELD_TYPES.TEXTAREA, FIELD_TYPES.SELECT].includes(field.type) && value.length > 2000) {
        throw new BusinessRuleError(`Custom field '${field.label}' is too long.`, 'INVALID_CUSTOM_FIELD_VALUE');
    }
    return value;
};

const normalizeSubmittedCustomFields = ({ fieldsConfig = [], values = {}, files = {}, skipFileRequired = false } = {}) => {
    const config = normalizePaymentMethodCustomFields(fieldsConfig).filter((field) => field.isActive !== false)
        .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
    const submittedValues = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
    const submittedFiles = files && typeof files === 'object' && !Array.isArray(files) ? files : {};
    const customFieldValues = {};
    const customFieldFiles = {};

    for (const field of config) {
        if (field.type === FIELD_TYPES.IMAGE) {
            const file = submittedFiles[field.key];
            if (field.required && !skipFileRequired && !file) {
                throw new BusinessRuleError(`Custom field '${field.label}' file is required.`, 'CUSTOM_FIELD_FILE_REQUIRED');
            }
            if (file) customFieldFiles[field.key] = fileMetadataFor(file);
            continue;
        }

        const value = validateScalarValue(field, submittedValues[field.key]);
        if (value !== undefined) customFieldValues[field.key] = value;
    }

    return {
        customFieldSnapshot: config.map((field) => ({
            key: field.key,
            label: field.label,
            type: field.type,
            required: field.required,
            options: field.options || [],
            sortOrder: field.sortOrder || 0,
        })),
        customFieldValues,
        customFieldFiles,
    };
};

const mergeSubmittedCustomFieldValues = (body = {}) => {
    const fieldsObject = parseJsonBodyField(body.fields, {});
    const customFieldsArray = parseJsonBodyField(body.customFields, []);
    const merged = fieldsObject && typeof fieldsObject === 'object' && !Array.isArray(fieldsObject) ? { ...fieldsObject } : {};

    if (Array.isArray(customFieldsArray)) {
        customFieldsArray.forEach((field) => {
            const key = String(field?.key || '').trim();
            if (key && field.value !== undefined && merged[key] === undefined) {
                merged[key] = field.value;
            }
        });
    } else if (customFieldsArray && typeof customFieldsArray === 'object') {
        Object.assign(merged, customFieldsArray);
    }

    return merged;
};

module.exports = {
    FIELD_TYPES,
    PAYMENT_GROUPS_SETTING_KEY,
    escapeRegex,
    findConfiguredPaymentMethodById,
    mergeSubmittedCustomFieldValues,
    normalizePaymentGroupsSettingValue,
    normalizePaymentMethodCustomFields,
    normalizeSubmittedCustomFields,
};
