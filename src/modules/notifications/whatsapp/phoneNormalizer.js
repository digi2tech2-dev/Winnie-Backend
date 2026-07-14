'use strict';

const config = require('../../../config/config');
const { ValidationError } = require('../../../shared/errors/AppError');

const normalizePhoneNumber = (value, { defaultCountryCode = config.openwa.defaultCountryCode } = {}) => {
    const raw = String(value || '').trim();
    if (!raw) {
        throw new ValidationError('WhatsApp phone number is required.', [{ field: 'phone', message: 'Phone is required' }]);
    }

    if (!/^[+\d\s().-]+$/.test(raw)) {
        throw new ValidationError('WhatsApp phone contains invalid characters.', [{ field: 'phone', message: 'Phone contains invalid characters' }]);
    }

    let digits = raw.replace(/\D/g, '');
    const countryCode = String(defaultCountryCode || '').replace(/\D/g, '');

    if (raw.startsWith('+')) {
        digits = raw.replace(/\D/g, '');
    } else if (digits.startsWith('00')) {
        digits = digits.slice(2);
    } else if (digits.startsWith('0')) {
        if (!countryCode) {
            throw new ValidationError('Default country code is not configured.', [{ field: 'phone', message: 'Default country code is not configured' }]);
        }
        digits = `${countryCode}${digits.slice(1)}`;
    }

    if (!/^\d{8,15}$/.test(digits)) {
        throw new ValidationError('WhatsApp phone must include a valid country code and 8 to 15 digits.', [{ field: 'phone', message: 'Invalid WhatsApp phone number' }]);
    }

    return {
        phone: digits,
        chatId: `${digits}@c.us`,
    };
};

module.exports = { normalizePhoneNumber };
