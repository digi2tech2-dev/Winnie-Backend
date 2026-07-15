'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('../../config/config');

/**
 * User roles enum — single source of truth.
 */
const ROLES = Object.freeze({
    ADMIN: 'ADMIN',
    SUPERVISOR: 'SUPERVISOR',
    CUSTOMER: 'CUSTOMER',
});

/**
 * User status lifecycle enum.
 *
 * PENDING  → registered, awaiting email verification (default)
 * ACTIVE   → email verified or manually activated; full platform access
 * REJECTED → denied by admin; cannot log in
 *
 * Transitions allowed:
 *   PENDING  → ACTIVE    (email verification or admin activation)
 *   PENDING  → REJECTED  (admin rejection)
 *   ACTIVE   → REJECTED  (admin revoke)
 *   REJECTED → ACTIVE    (admin re-approve)
 */
const USER_STATUS = Object.freeze({
    PENDING: 'PENDING',
    ACTIVE: 'ACTIVE',
    REJECTED: 'REJECTED',
});

const SUB_AGENT_STATUS = Object.freeze({
    NONE: 'NONE',
    PENDING: 'PENDING',
    ACTIVE: 'ACTIVE',
    REJECTED: 'REJECTED',
});

const DEFAULT_WHATSAPP_EVENT_PREFERENCES = Object.freeze({
    walletTopupCompleted: true,
    manualDepositApproved: true,
    manualDepositRejected: true,
    orderCreated: true,
    orderCompleted: true,
    orderFailed: true,
    identityVerificationRequired: true,
    securityAlerts: true,
});

const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERRAL_CODE_LENGTH = 8;

const generateReferralCodeCandidate = () => {
    let code = 'K';
    for (let i = 0; i < REFERRAL_CODE_LENGTH - 1; i += 1) {
        code += REFERRAL_CODE_ALPHABET[crypto.randomInt(0, REFERRAL_CODE_ALPHABET.length)];
    }
    return code;
};

const userSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Name is required'],
            trim: true,
            minlength: [2, 'Name must be at least 2 characters'],
            maxlength: [100, 'Name cannot exceed 100 characters'],
        },

        email: {
            type: String,
            required: [true, 'Email is required'],
            unique: true,
            lowercase: true,
            trim: true,
            match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
        },

        username: {
            type: String,
            lowercase: true,
            trim: true,
            maxlength: [100, 'Username cannot exceed 100 characters'],
            default: null,
        },

        phone: {
            type: String,
            trim: true,
            maxlength: [30, 'Phone cannot exceed 30 characters'],
            default: null,
        },

        country: {
            type: String,
            trim: true,
            maxlength: [100, 'Country cannot exceed 100 characters'],
            default: null,
        },

        password: {
            type: String,
            // Not required for OAuth users (Google sign-in never sets a password)
            minlength: [8, 'Password must be at least 8 characters'],
            select: false, // Never return password in queries by default
        },

        // ── OAuth ────────────────────────────────────────────────────────────
        /**
         * Google OAuth sub (subject identifier).
         * Null for email/password accounts.
         * Used by the Google passport strategy to find/link accounts.
         */
        googleId: {
            type: String,
            unique: true,
            sparse: true,   // only indexes documents where googleId is set
            // NOTE: no default — absent field is what sparse indexes expect
        },

        // ── Email Verification ────────────────────────────────────────────────
        /**
         * true  — user has clicked the verification link
         * false — fresh email/password registration (default)
         * Google OAuth users are auto-verified (set to true at creation).
         */
        verified: {
            type: Boolean,
            default: false,
        },

        /**
         * SHA-256 hash of the raw token sent in the verification email.
         * Raw token is NEVER stored here — only the hash.
         * Null once verified.
         */
        emailVerificationToken: {
            type: String,
            select: false,
            default: null,
        },

        /** Token expires 24 hours after issuance. */
        emailVerificationExpires: {
            type: Date,
            select: false,
            default: null,
        },

        twoFactorOtp: {
            type: String,
            select: false,
            default: null,
        },

        twoFactorOtpExpires: {
            type: Date,
            select: false,
            default: null,
        },

        twoFactorTempToken: {
            type: String,
            select: false,
            default: null,
        },

        twoFactorTempTokenExpires: {
            type: Date,
            select: false,
            default: null,
        },

        isTwoFactorEnabled: {
            type: Boolean,
            default: false,
        },

        role: {
            type: String,
            enum: Object.values(ROLES),
            default: ROLES.CUSTOMER,
        },

        isApiEnabled: {
            type: Boolean,
            default: false,
        },

        apiToken: {
            type: String,
            trim: true,
            default: null,
            select: false,
            index: true,
        },

        permissions: {
            type: [String],
            default: [],
            set: (permissions) => {
                if (!Array.isArray(permissions)) return [];
                return [...new Set(
                    permissions
                        .map((permission) => String(permission || '').trim())
                        .filter(Boolean)
                )];
            },
        },

        // ── Activation Lifecycle ─────────────────────────────────────────────
        /**
         * status governs platform access.
         * New registrations default to PENDING until email verification.
         * Administrators can still reject, deactivate, and reactivate users.
         *
         * Backwards-compatibility: the `isActive` virtual below delegates to
         * this field so any code that already reads `user.isActive` continues
         * to work without modification.
         */
        status: {
            type: String,
            enum: {
                values: Object.values(USER_STATUS),
                message: 'status must be PENDING, ACTIVE, or REJECTED',
            },
            default: USER_STATUS.PENDING,
            index: true,
        },

        /** Admin who manually activated the account (null for email activation). */
        approvedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },

        approvedAt: {
            type: Date,
            default: null,
        },

        /** Admin who rejected the account (null until rejected). */
        rejectedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },

        rejectedAt: {
            type: Date,
            default: null,
        },

        // ── Pricing Group ────────────────────────────────────────────────────
        groupId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Group',
            default: null,
        },

        isSubAgent: {
            type: Boolean,
            default: false,
            index: true,
        },

        subAgentStatus: {
            type: String,
            enum: Object.values(SUB_AGENT_STATUS),
            default: SUB_AGENT_STATUS.NONE,
            index: true,
        },

        subAgentApprovedAt: {
            type: Date,
            default: null,
        },

        subAgentApprovedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },

        // ── Wallet ───────────────────────────────────────────────────────────
        /**
         * User's wallet balance in their local currency.
         * CAN be negative when a user spends against their creditLimit.
         * Minimum effective balance = -(creditLimit).
         */
        walletBalance: {
            type: Number,
            default: 0,
        },

        creditLimit: {
            type: Number,
            default: 0,
            min: [0, 'Credit limit cannot be negative'],
        },

        /**
         * creditUsed: the amount of the credit line currently drawn.
         *
         * Real spendable formula:
         *   available = walletBalance + (creditLimit - creditUsed)
         *
         * On order creation:
         *   - wallet is used first
         *   - remaining goes against credit → creditUsed increases
         *
         * On refund:
         *   - creditUsed decreases first (credit is "returned")
         *   - then walletBalance is restored
         */
        creditUsed: {
            type: Number,
            default: 0,
            min: [0, 'Credit used cannot be negative'],
        },

        // ── Currency ──────────────────────────────────────────────────────────
        /**
         * The ISO 4217 currency code for this user's wallet.
         * Wallet balances, order charges, and refunds are all denominated in this currency.
         * Products are priced in USD internally; the currency converter applies
         * the platform exchange rate at order creation time.
         *
         * Default: "USD" — no conversion needed.
         */
        currency: {
            type: String,
            uppercase: true,
            trim: true,
            default: 'USD',
            match: [/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code (e.g. USD, SAR)'],
        },

        profileCompletedAt: {
            type: Date,
            default: null,
        },

        // ── Identity Verification Hold ────────────────────────────────────────
        /**
         * Admin-controlled support hold. Users can still authenticate and view
         * their account, but sensitive financial/product actions are blocked
         * while this flag is active.
         */
        identityVerificationRequired: {
            type: Boolean,
            default: false,
            index: true,
        },

        identityVerificationReason: {
            type: String,
            trim: true,
            maxlength: [500, 'Identity verification reason cannot exceed 500 characters'],
            default: null,
        },

        identityVerificationRequestedAt: {
            type: Date,
            default: null,
        },

        identityVerificationRequestedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },

        identityVerificationClearedAt: {
            type: Date,
            default: null,
        },

        identityVerificationClearedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },

        blockedAt: {
            type: Date,
            default: null,
            index: true,
        },

        blockedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },

        blockReason: {
            type: String,
            trim: true,
            maxlength: [500, 'Block reason cannot exceed 500 characters'],
            default: null,
        },

        // ── Avatar ───────────────────────────────────────────────────────────
        /**
         * URL to the user's profile picture.
         * Can be an absolute URL (external host) or a relative path (local uploads).
         */
        avatar: {
            type: String,
            trim: true,
            default: null,
        },

        referralCode: {
            type: String,
            uppercase: true,
            trim: true,
            default: null,
        },

        whatsappNotifications: {
            enabled: { type: Boolean, default: false },
            phone: { type: String, trim: true, default: null, maxlength: 30 },
            phoneVerified: { type: Boolean, default: false },
            verifiedAt: { type: Date, default: null },
            verificationCodeHash: { type: String, default: null },
            verificationCodeExpiresAt: { type: Date, default: null },
            lastVerificationSentAt: { type: Date, default: null },
            lastTestSentAt: { type: Date, default: null },
            eventPreferences: {
                walletTopupCompleted: { type: Boolean, default: true },
                manualDepositApproved: { type: Boolean, default: true },
                manualDepositRejected: { type: Boolean, default: true },
                orderCreated: { type: Boolean, default: true },
                orderCompleted: { type: Boolean, default: true },
                orderFailed: { type: Boolean, default: true },
                identityVerificationRequired: { type: Boolean, default: true },
                securityAlerts: { type: Boolean, default: true },
            },
        },

        // Placeholder only. Referral commissions are intentionally Phase 2 work.
        referredBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },

        /** Soft-delete timestamp. Null = not deleted. */
        deletedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
    }
);

// ─── Indexes ────────────────────────────────────────────────────────────────
// Note: email already has a unique index from unique:true in the field definition
userSchema.index({ role: 1 });
userSchema.index({ permissions: 1 });
userSchema.index({ groupId: 1 });
userSchema.index({ deletedAt: 1 }, { sparse: true });  // fast filter for non-deleted users
userSchema.index(
    { username: 1 },
    { unique: true, partialFilterExpression: { username: { $type: 'string' } } }
);
userSchema.index(
    { referralCode: 1 },
    { unique: true, partialFilterExpression: { referralCode: { $type: 'string' } } }
);
// status index defined inline above

// ─── Virtuals ────────────────────────────────────────────────────────────────

/**
 * Backwards-compatibility shim.
 * Any code that reads `user.isActive` continues to work correctly.
 * Source of truth is now `status`.
 */
userSchema.virtual('isActive').get(function () {
    return this.status === USER_STATUS.ACTIVE;
});

userSchema.virtual('isBlocked').get(function () {
    return Boolean(this.blockedAt);
});

userSchema.virtual('displayStatus').get(function () {
    if (this.deletedAt) return 'DELETED';
    if (this.blockedAt) return 'BLOCKED';
    return this.status;
});

userSchema.virtual('needsProfileCompletion').get(function () {
    const { needsGoogleProfileCompletion } = require('./googleOnboarding');
    return needsGoogleProfileCompletion(this);
});

/**
 * Total spendable amount = wallet balance + credit limit.
 * This is the maximum amount the user can spend in a single order.
 * walletBalance may be negative (up to -creditLimit) after credit usage.
 */
userSchema.virtual('availableBalance').get(function () {
    const balance = this.walletBalance || 0;
    const credit = this.creditLimit || 0;
    return parseFloat((balance + credit).toFixed(2));
});

/** How much credit remains available (undrawn). */
userSchema.virtual('availableCredit').get(function () {
    return parseFloat((this.creditLimit - this.creditUsed).toFixed(2));
});

// ─── Pre-save Hook: Hash Password ────────────────────────────────────────────
userSchema.pre('validate', async function assignReferralCode(next) {
    if (this.referralCode) {
        this.referralCode = String(this.referralCode).trim().toUpperCase();
        return next();
    }

    try {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const referralCode = generateReferralCodeCandidate();
            const exists = await this.constructor.exists({ referralCode });
            if (!exists) {
                this.referralCode = referralCode;
                return next();
            }
        }
        return next(new Error('Unable to generate a unique referral code.'));
    } catch (err) {
        return next(err);
    }
});

userSchema.pre('save', async function (next) {
    // Skip if no password set (OAuth users) or password not modified
    if (!this.password || !this.isModified('password')) return next();
    this.password = await bcrypt.hash(this.password, config.bcrypt.rounds);
    next();
});

// ─── Instance Methods ─────────────────────────────────────────────────────────
userSchema.methods.comparePassword = async function (candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

/**
 * Strip sensitive fields when serializing.
 */
userSchema.methods.toSafeObject = function () {
    const obj = this.toObject();
    delete obj.password;
    delete obj.emailVerificationToken;
    delete obj.emailVerificationExpires;
    delete obj.twoFactorOtp;
    delete obj.twoFactorOtpExpires;
    delete obj.twoFactorTempToken;
    delete obj.twoFactorTempTokenExpires;
    delete obj.apiToken;
    if (obj.whatsappNotifications) {
        delete obj.whatsappNotifications.verificationCodeHash;
        delete obj.whatsappNotifications.verificationCodeExpiresAt;
    }
    delete obj.identityVerificationRequestedBy;
    delete obj.identityVerificationClearedBy;
    return obj;
};

const User = mongoose.model('User', userSchema);

module.exports = { User, ROLES, USER_STATUS, SUB_AGENT_STATUS };
module.exports.User = User; // CommonJS default export convenience
module.exports.DEFAULT_WHATSAPP_EVENT_PREFERENCES = DEFAULT_WHATSAPP_EVENT_PREFERENCES;
