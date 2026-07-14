'use strict';

const mongoose = require('mongoose');

const providerBalanceSnapshotSchema = new mongoose.Schema(
    {
        providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', default: null },
        providerName: { type: String, trim: true, default: '' },
        source: {
            type: String,
            enum: ['api', 'manual', 'unavailable', 'error'],
            default: 'unavailable',
        },
        balance: { type: Number, default: null },
        currency: { type: String, trim: true, uppercase: true, default: null },
        usdEquivalent: { type: Number, default: null },
        fetchedAt: { type: Date, default: null },
        enteredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        apiStatus: { type: String, trim: true, default: null },
        note: { type: String, trim: true, default: null },
    },
    { _id: false }
);

const walletBalanceSnapshotSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        name: { type: String, trim: true, default: '' },
        email: { type: String, trim: true, default: '' },
        phone: { type: String, trim: true, default: '' },
        status: { type: String, trim: true, default: '' },
        groupName: { type: String, trim: true, default: '' },
        currency: { type: String, trim: true, uppercase: true, default: 'USD' },
        balance: { type: Number, default: 0 },
        usdEquivalent: { type: Number, default: null },
        lastWalletTransactionAt: { type: Date, default: null },
    },
    { _id: false }
);

const financialDailyCloseSchema = new mongoose.Schema(
    {
        date: {
            type: String,
            required: true,
            match: [/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'],
            index: true,
        },
        timezone: { type: String, required: true, trim: true, index: true },
        dayStartUtc: { type: Date, required: true },
        dayEndUtc: { type: Date, required: true },
        closedAt: { type: Date, required: true },
        closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        reportVersion: { type: Number, required: true, default: 1 },
        summary: { type: mongoose.Schema.Types.Mixed, default: {} },
        walletBalanceSnapshots: { type: [walletBalanceSnapshotSchema], default: [] },
        providerBalanceSnapshots: { type: [providerBalanceSnapshotSchema], default: [] },
        warnings: { type: [String], default: [] },
        notes: { type: [String], default: [] },
    },
    { timestamps: true }
);

financialDailyCloseSchema.index({ date: 1, timezone: 1 }, { unique: true });

const FinancialDailyClose = mongoose.model('FinancialDailyClose', financialDailyCloseSchema);

module.exports = { FinancialDailyClose };
