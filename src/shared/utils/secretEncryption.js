'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_ENV_VAR = 'PROVIDER_CREDENTIALS_KEY';
const VERSION_PREFIX = 'enc:v1';
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const KEY_LENGTH_BYTES = 32;

const isEncryptedSecret = (value) => (
    typeof value === 'string'
    && value.startsWith(`${VERSION_PREFIX}:`)
);

const parseBase64Key = (raw) => {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
    const key = Buffer.from(raw, 'base64');
    return key.length === KEY_LENGTH_BYTES ? key : null;
};

const parseHexKey = (raw) => {
    if (!/^[a-f0-9]{64}$/i.test(raw)) return null;
    const key = Buffer.from(raw, 'hex');
    return key.length === KEY_LENGTH_BYTES ? key : null;
};

const getEncryptionKey = () => {
    const raw = String(process.env[KEY_ENV_VAR] || '').trim();
    if (!raw) {
        throw new Error(`${KEY_ENV_VAR} is required to store or use provider credentials.`);
    }

    const key = parseBase64Key(raw) || parseHexKey(raw);
    if (!key) {
        throw new Error(`${KEY_ENV_VAR} must be a 32-byte AES key encoded as base64 or 64-character hex.`);
    }

    return key;
};

const encryptSecret = (plainText) => {
    if (plainText === null || plainText === undefined) return plainText;

    const value = String(plainText);
    if (!value) return value;
    if (isEncryptedSecret(value)) {
        decryptSecret(value);
        return value;
    }

    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH_BYTES });
    const ciphertext = Buffer.concat([
        cipher.update(value, 'utf8'),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return [
        VERSION_PREFIX,
        iv.toString('base64'),
        tag.toString('base64'),
        ciphertext.toString('base64'),
    ].join(':');
};

const decryptSecret = (encryptedValue) => {
    if (!isEncryptedSecret(encryptedValue)) {
        throw new Error('Encrypted secret must use the enc:v1 format.');
    }

    const parts = encryptedValue.split(':');
    if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== VERSION_PREFIX) {
        throw new Error('Encrypted secret format is invalid.');
    }

    const [, , ivBase64, tagBase64, ciphertextBase64] = parts;
    const iv = Buffer.from(ivBase64, 'base64');
    const tag = Buffer.from(tagBase64, 'base64');
    const ciphertext = Buffer.from(ciphertextBase64, 'base64');

    if (iv.length !== IV_LENGTH_BYTES || tag.length !== AUTH_TAG_LENGTH_BYTES || ciphertext.length === 0) {
        throw new Error('Encrypted secret payload is invalid.');
    }

    try {
        const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv, { authTagLength: AUTH_TAG_LENGTH_BYTES });
        decipher.setAuthTag(tag);
        return Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
        ]).toString('utf8');
    } catch (_) {
        throw new Error('Encrypted secret could not be decrypted.');
    }
};

const hasSecretValue = (value) => (
    value !== null
    && value !== undefined
    && String(value).trim().length > 0
);

const getProviderCredential = (storedValue) => {
    if (!hasSecretValue(storedValue)) return null;

    const value = String(storedValue).trim();
    getEncryptionKey();

    return isEncryptedSecret(value)
        ? decryptSecret(value)
        : value;
};

const maskSecret = (value) => (hasSecretValue(value) ? '[REDACTED]' : null);

const redactSecretText = (value) => {
    if (value === null || value === undefined) return value;

    return String(value)
        .replace(
            /\b(api[-_\s]?token|api[-_\s]?key|token|secret|password|credential|authorization)(\s*[:=]\s*)([^,\s"'}]+)/gi,
            '$1$2[REDACTED]'
        )
        .replace(/enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+/g, '[REDACTED_ENCRYPTED_SECRET]');
};

module.exports = {
    ALGORITHM,
    KEY_ENV_VAR,
    VERSION_PREFIX,
    encryptSecret,
    decryptSecret,
    getProviderCredential,
    hasSecretValue,
    isEncryptedSecret,
    maskSecret,
    redactSecretText,
};
