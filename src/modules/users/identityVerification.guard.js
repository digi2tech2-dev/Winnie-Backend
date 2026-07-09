'use strict';

const { IdentityVerificationRequiredError } = require('../../shared/errors/AppError');

const SUPPORT = Object.freeze({
    type: 'whatsapp',
    phone: '+971527715868',
    url: 'https://wa.me/971527715868',
    prefilledUrl: 'https://wa.me/971527715868?text=Hello%20Winnie%20Support%2C%20I%20need%20to%20verify%20my%20identity.',
});

const assertIdentityVerificationNotRequired = (user) => {
    if (user?.identityVerificationRequired === true) {
        const error = new IdentityVerificationRequiredError();
        error.support = SUPPORT;
        throw error;
    }
};

module.exports = {
    SUPPORT,
    assertIdentityVerificationNotRequired,
};
