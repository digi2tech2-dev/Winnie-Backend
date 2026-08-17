'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../../config/config');
const {
    AuthorizationError,
    BusinessRuleError,
    NotFoundError,
} = require('../errors/AppError');

const uploadsRoot = path.resolve(__dirname, '..', '..', '..', 'uploads');
const API_PATH = '/api/secure-uploads/file';
const SENSITIVE_UPLOAD_CATEGORIES = Object.freeze({
    deposits: path.resolve(uploadsRoot, 'deposits'),
    'sub-agent-requests': path.resolve(uploadsRoot, 'sub-agent-requests'),
});

const IMAGE_TYPES = Object.freeze({
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
});

const OTHER_TYPES = Object.freeze({
    '.pdf': 'application/pdf',
});

const base64UrlJson = (payload) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

const getSigningSecret = () => {
    const secret = config.secureUploads?.signingSecret || config.jwt?.secret;
    if (!secret) {
        throw new BusinessRuleError('Secure upload signing secret is not configured.', 'SECURE_UPLOAD_SECRET_MISSING');
    }
    return secret;
};

const signPayload = (payload) => crypto
    .createHmac('sha256', getSigningSecret())
    .update(payload)
    .digest('base64url');

const constantTimeEquals = (left, right) => {
    const leftBuffer = Buffer.from(String(left || ''), 'utf8');
    const rightBuffer = Buffer.from(String(right || ''), 'utf8');
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const decodePath = (value) => {
    try {
        return decodeURIComponent(value);
    } catch (_) {
        throw new BusinessRuleError('Invalid upload path.', 'INVALID_UPLOAD_PATH');
    }
};

const normalizeSensitiveUploadPath = (rawPath) => {
    const input = String(rawPath || '').trim();
    if (!input) throw new BusinessRuleError('Upload path is required.', 'UPLOAD_PATH_REQUIRED');

    const decoded = decodePath(input).replace(/\\/g, '/').replace(/^\/+/, '');
    if (decoded.includes('\0') || /^[a-zA-Z]:/.test(decoded) || path.isAbsolute(decoded)) {
        throw new BusinessRuleError('Invalid upload path.', 'INVALID_UPLOAD_PATH');
    }

    const segments = decoded.split('/').filter(Boolean);
    if (segments.length !== 3 || segments[0] !== 'uploads' || segments.some((segment) => segment === '..' || segment === '.')) {
        throw new BusinessRuleError('Invalid upload path.', 'INVALID_UPLOAD_PATH');
    }

    const category = segments[1];
    const filename = segments[2];
    const categoryRoot = SENSITIVE_UPLOAD_CATEGORIES[category];
    if (!categoryRoot) {
        throw new BusinessRuleError('Unknown sensitive upload category.', 'UNKNOWN_UPLOAD_CATEGORY');
    }

    const absolutePath = path.resolve(categoryRoot, filename);
    const relativePath = `uploads/${category}/${filename}`;
    if (!absolutePath.startsWith(`${categoryRoot}${path.sep}`)) {
        throw new BusinessRuleError('Invalid upload path.', 'INVALID_UPLOAD_PATH');
    }

    return {
        absolutePath,
        category,
        categoryRoot,
        filename,
        relativePath,
    };
};

const createSignedUploadUrl = (rawPath, { baseUrl = '', ttlSeconds } = {}) => {
    const normalized = normalizeSensitiveUploadPath(rawPath);
    const safeTtl = Math.max(60, Math.min(parseInt(ttlSeconds || config.secureUploads.urlTtlSeconds, 10) || 600, 900));
    const expiresAt = Date.now() + safeTtl * 1000;
    const payload = base64UrlJson({ p: normalized.relativePath, e: expiresAt });
    const signature = signPayload(payload);
    const prefix = String(baseUrl || '').replace(/\/+$/, '');

    return {
        url: `${prefix}${API_PATH}?payload=${encodeURIComponent(payload)}&signature=${encodeURIComponent(signature)}`,
        expiresAt: new Date(expiresAt).toISOString(),
        expiresIn: safeTtl,
    };
};

const verifySignedUpload = ({ payload, signature } = {}) => {
    if (!payload || !signature || !constantTimeEquals(signPayload(payload), signature)) {
        throw new AuthorizationError('Invalid secure upload signature.');
    }

    let decoded;
    try {
        decoded = JSON.parse(Buffer.from(String(payload), 'base64url').toString('utf8'));
    } catch (_) {
        throw new AuthorizationError('Invalid secure upload payload.');
    }

    if (!decoded?.p || !decoded?.e || Number(decoded.e) < Date.now()) {
        throw new AuthorizationError('Secure upload link has expired.');
    }

    const normalized = normalizeSensitiveUploadPath(decoded.p);
    if (!fs.existsSync(normalized.absolutePath)) {
        throw new NotFoundError('Upload file');
    }

    return normalized;
};

const getContentType = (filename) => {
    const ext = path.extname(filename).toLowerCase();
    return IMAGE_TYPES[ext] || OTHER_TYPES[ext] || 'application/octet-stream';
};

const isInlineContent = (filename) => {
    const ext = path.extname(filename).toLowerCase();
    return Boolean(IMAGE_TYPES[ext] || ext === '.pdf');
};

module.exports = {
    API_PATH,
    SENSITIVE_UPLOAD_CATEGORIES,
    createSignedUploadUrl,
    getContentType,
    isInlineContent,
    normalizeSensitiveUploadPath,
    verifySignedUpload,
};
