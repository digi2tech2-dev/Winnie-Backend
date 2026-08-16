'use strict';

const mongoose = require('mongoose');
const { PROVIDER_CODES } = require('../provider.constants');

const fazerCardsSteamGiftGameIndexSchema = new mongoose.Schema(
    {
        appid: {
            type: Number,
            required: true,
            unique: true,
            index: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
        },
        normalizedName: {
            type: String,
            required: true,
            trim: true,
            index: true,
        },
        provider: {
            type: String,
            enum: [PROVIDER_CODES.FAZER_CARDS],
            default: PROVIDER_CODES.FAZER_CARDS,
            index: true,
        },
        source: {
            type: String,
            enum: ['steam-gifts'],
            default: 'steam-gifts',
            index: true,
        },
        lastSeenAt: {
            type: Date,
            default: Date.now,
            index: true,
        },
        indexedAt: {
            type: Date,
            default: Date.now,
            index: true,
        },
        rawSanitized: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

fazerCardsSteamGiftGameIndexSchema.index({ provider: 1, normalizedName: 1 });
fazerCardsSteamGiftGameIndexSchema.index({ provider: 1, indexedAt: -1 });

const FazerCardsSteamGiftGameIndex = mongoose.model('FazerCardsSteamGiftGameIndex', fazerCardsSteamGiftGameIndexSchema);

module.exports = {
    FazerCardsSteamGiftGameIndex,
};
