'use strict';

const MIN_PREFIX_LENGTH = 2;

const normalizeSearchValue = (value) => String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase();

const unique = (values) => [...new Set(values.filter(Boolean))];

const tokenize = (value) => normalizeSearchValue(value)
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter(Boolean);

const expandPrefixes = (tokens) => unique(tokens.flatMap((token) => (
    token.length < MIN_PREFIX_LENGTH
        ? [token]
        : Array.from({ length: token.length - MIN_PREFIX_LENGTH + 1 }, (_, index) => token.slice(0, index + MIN_PREFIX_LENGTH))
)));

const buildPhrases = (tokens) => unique(tokens.flatMap((_, start) => (
    Array.from({ length: tokens.length - start - 1 }, (_, offset) => tokens.slice(start, start + offset + 2).join(' '))
)));

const getRawIdentifierValues = (rawPayload = {}) => [
    rawPayload.product_id,
    rawPayload.productId,
    rawPayload.sku_id,
    rawPayload.skuId,
    rawPayload.package_id,
    rawPayload.packageId,
    rawPayload.game_id,
    rawPayload.gameId,
    rawPayload.service_id,
    rawPayload.serviceId,
    rawPayload.external_product_id,
    rawPayload.externalProductId,
    rawPayload.code,
    rawPayload.sku,
    rawPayload.service,
];

const buildProviderProductSearchFields = ({
    rawName,
    translatedName,
    externalProductId,
    offerId,
    offerName,
    rawPayload,
} = {}) => {
    const names = [rawName, translatedName, offerName];
    const nameTokens = unique(names.flatMap(tokenize));
    const identifierValues = [externalProductId, offerId, ...getRawIdentifierValues(rawPayload || {})];
    const identifierTokens = unique(identifierValues.flatMap((value) => [
        normalizeSearchValue(value),
        ...tokenize(value),
    ]));

    const searchNamePrefixes = expandPrefixes(nameTokens);
    const searchNamePhrases = buildPhrases(nameTokens);
    return {
        searchNamePrefixes,
        searchNamePhrases,
        searchIdentifiers: identifierTokens,
        searchLookup: unique([...identifierTokens, ...searchNamePrefixes, ...searchNamePhrases]),
    };
};

const buildProviderProductSearchFilter = (search) => {
    const normalized = normalizeSearchValue(search);
    if (!normalized) return null;

    return { searchLookup: normalized };
};

module.exports = {
    buildProviderProductSearchFields,
    buildProviderProductSearchFilter,
    normalizeSearchValue,
};
