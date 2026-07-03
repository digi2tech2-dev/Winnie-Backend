'use strict';

const mongoose = require('mongoose');

/**
 * Backward-compatible transaction types.
 *
 * Keep these stable for existing API consumers and filters. Newer business
 * semantics live in semanticType below.
 */
const TRANSACTION_TYPES = Object.freeze({
    CREDIT: 'CREDIT',
    DEBIT: 'DEBIT',
    REFUND: 'REFUND',
    DEBT_ADJUSTMENT: 'DEBT_ADJUSTMENT',
});

/**
 * Explicit ledger event taxonomy.
 *
 * Some values are active now; card/referral values are reserved so future
 * modules can write canonical ledger events without another schema change.
 */
const LEDGER_TRANSACTION_TYPES = Object.freeze({
    CREDIT: 'CREDIT',
    DEBIT: 'DEBIT',
    REFUND: 'REFUND',
    DEBT_ADJUSTMENT: 'DEBT_ADJUSTMENT',
    DEPOSIT_APPROVED: 'DEPOSIT_APPROVED',
    ORDER_DEBIT: 'ORDER_DEBIT',
    ORDER_REFUND: 'ORDER_REFUND',
    ADMIN_ADJUSTMENT: 'ADMIN_ADJUSTMENT',
    CARD_PAYMENT_SUCCESS: 'CARD_PAYMENT_SUCCESS',
    CARD_PAYMENT_FAILED: 'CARD_PAYMENT_FAILED',
    REFERRAL_COMMISSION: 'REFERRAL_COMMISSION',
    REFERRAL_REVERSAL: 'REFERRAL_REVERSAL',
});

const TRANSACTION_DIRECTIONS = Object.freeze({
    CREDIT: 'CREDIT',
    DEBIT: 'DEBIT',
    NEUTRAL: 'NEUTRAL',
});

const TRANSACTION_SOURCE_TYPES = Object.freeze({
    ORDER: 'ORDER',
    DEPOSIT: 'DEPOSIT',
    PAYMENT: 'PAYMENT',
    ADMIN_ADJUSTMENT: 'ADMIN_ADJUSTMENT',
    CARD_PAYMENT: 'CARD_PAYMENT',
    REFERRAL: 'REFERRAL',
    DEBT_ADJUSTMENT: 'DEBT_ADJUSTMENT',
    WALLET: 'WALLET',
    SYSTEM: 'SYSTEM',
});

const DEFAULT_SEMANTIC_TYPE_BY_TYPE = Object.freeze({
    [TRANSACTION_TYPES.CREDIT]: LEDGER_TRANSACTION_TYPES.CREDIT,
    [TRANSACTION_TYPES.DEBIT]: LEDGER_TRANSACTION_TYPES.DEBIT,
    [TRANSACTION_TYPES.REFUND]: LEDGER_TRANSACTION_TYPES.REFUND,
    [TRANSACTION_TYPES.DEBT_ADJUSTMENT]: LEDGER_TRANSACTION_TYPES.DEBT_ADJUSTMENT,
});

const DEFAULT_DIRECTION_BY_TYPE = Object.freeze({
    [TRANSACTION_TYPES.CREDIT]: TRANSACTION_DIRECTIONS.CREDIT,
    [TRANSACTION_TYPES.DEBIT]: TRANSACTION_DIRECTIONS.DEBIT,
    [TRANSACTION_TYPES.REFUND]: TRANSACTION_DIRECTIONS.CREDIT,
    [TRANSACTION_TYPES.DEBT_ADJUSTMENT]: TRANSACTION_DIRECTIONS.NEUTRAL,
});

/**
 * Transaction status values.
 */
const TRANSACTION_STATUS = Object.freeze({
    PENDING: 'PENDING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
});

const walletTransactionSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'User ID is required'],
            index: true,
        },

        type: {
            type: String,
            enum: Object.values(TRANSACTION_TYPES),
            required: [true, 'Transaction type is required'],
        },

        semanticType: {
            type: String,
            enum: Object.values(LEDGER_TRANSACTION_TYPES),
            default() {
                return DEFAULT_SEMANTIC_TYPE_BY_TYPE[this.type] || this.type;
            },
            index: true,
        },

        sourceType: {
            type: String,
            enum: Object.values(TRANSACTION_SOURCE_TYPES),
            default: undefined,
            index: true,
        },

        sourceId: {
            type: mongoose.Schema.Types.ObjectId,
            default: null,
            index: true,
        },

        direction: {
            type: String,
            enum: Object.values(TRANSACTION_DIRECTIONS),
            default() {
                return DEFAULT_DIRECTION_BY_TYPE[this.type] || TRANSACTION_DIRECTIONS.NEUTRAL;
            },
            index: true,
        },

        amount: {
            type: Number,
            required: [true, 'Amount is required'],
            min: [0.01, 'Amount must be greater than 0'],
        },

        balanceBefore: {
            type: Number,
            required: [true, 'Balance before is required'],
        },

        balanceAfter: {
            type: Number,
            required: [true, 'Balance after is required'],
        },

        reference: {
            // Legacy reference field retained for existing API responses.
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Order',
            default: null,
        },

        currency: {
            type: String,
            trim: true,
            uppercase: true,
            minlength: [3, 'Currency must be a 3-letter code'],
            maxlength: [3, 'Currency must be a 3-letter code'],
            default: 'USD',
            index: true,
        },

        status: {
            type: String,
            enum: Object.values(TRANSACTION_STATUS),
            default: TRANSACTION_STATUS.COMPLETED,
        },

        description: {
            type: String,
            trim: true,
            maxlength: 255,
        },

        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: undefined,
        },

        idempotencyKey: {
            type: String,
            trim: true,
            default: undefined,
        },

        actorId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },

        actorRole: {
            type: String,
            trim: true,
            default: undefined,
        },
    },
    {
        timestamps: true,
    }
);

walletTransactionSchema.pre('validate', function setLedgerDefaults(next) {
    if (!this.semanticType) {
        this.semanticType = DEFAULT_SEMANTIC_TYPE_BY_TYPE[this.type] || this.type;
    }
    if (!this.direction) {
        this.direction = DEFAULT_DIRECTION_BY_TYPE[this.type] || TRANSACTION_DIRECTIONS.NEUTRAL;
    }
    if (!this.sourceId && this.reference) {
        this.sourceId = this.reference;
    }
    next();
});

// Compound index for efficient user transaction history queries
walletTransactionSchema.index({ userId: 1, createdAt: -1 });
walletTransactionSchema.index({ userId: 1, semanticType: 1, createdAt: -1 });
walletTransactionSchema.index({ reference: 1 });
walletTransactionSchema.index({ sourceType: 1, sourceId: 1 });
walletTransactionSchema.index(
    { idempotencyKey: 1 },
    {
        unique: true,
        partialFilterExpression: { idempotencyKey: { $type: 'string' } },
    }
);

const WalletTransaction = mongoose.model('WalletTransaction', walletTransactionSchema);

module.exports = {
    WalletTransaction,
    TRANSACTION_TYPES,
    LEDGER_TRANSACTION_TYPES,
    TRANSACTION_DIRECTIONS,
    TRANSACTION_SOURCE_TYPES,
    TRANSACTION_STATUS,
};
