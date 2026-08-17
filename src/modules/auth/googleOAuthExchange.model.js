'use strict';

const mongoose = require('mongoose');

const googleOAuthExchangeSchema = new mongoose.Schema(
    {
        codeHash: {
            type: String,
            required: true,
            unique: true,
        },
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        expiresAt: {
            type: Date,
            required: true,
            index: { expires: 0 },
        },
        consumedAt: {
            type: Date,
            default: null,
        },
    },
    { timestamps: true }
);

const GoogleOAuthExchange = mongoose.model('GoogleOAuthExchange', googleOAuthExchangeSchema);

module.exports = { GoogleOAuthExchange };
