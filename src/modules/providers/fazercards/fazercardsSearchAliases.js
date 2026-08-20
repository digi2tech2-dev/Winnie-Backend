'use strict';

const SEARCH_ALIAS_GROUPS = Object.freeze([
    [
        'pubg',
        'pubgm',
        'pubg mobile',
        'playerunknown',
        'player unknown',
        'ببجي',
        'ببجى',
        'uc',
    ],
    [
        'free fire',
        'freefire',
        'فري فاير',
        'diamonds',
        'diamond',
    ],
    [
        'telegram',
        'تليجرام',
        'تلجرام',
        'premium',
    ],
]);

const normalizeArabicVariants = (value) => value
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ؤئ]/g, 'ء')
    .replace(/[\u064B-\u065F\u0670]/g, '');

const normalizeSearchTerm = (value) => normalizeArabicVariants(String(value || '')
    .normalize('NFKC')
    .toLowerCase())
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const aliasIndex = SEARCH_ALIAS_GROUPS.reduce((index, group) => {
    const normalizedGroup = [...new Set(group.map(normalizeSearchTerm).filter(Boolean))];
    for (const alias of normalizedGroup) {
        index.set(alias, normalizedGroup);
    }
    return index;
}, new Map());

const expandFazerCardsSearchTerms = (search) => {
    const raw = String(search || '').trim();
    const normalized = normalizeSearchTerm(raw);
    if (!raw && !normalized) return [];

    const terms = new Set([raw, normalized].filter(Boolean));
    const directAliases = aliasIndex.get(normalized) || [];
    directAliases.forEach((term) => terms.add(term));

    for (const [alias, group] of aliasIndex.entries()) {
        if (normalized.includes(alias) || alias.includes(normalized)) {
            group.forEach((term) => terms.add(term));
        }
    }

    return [...terms].filter(Boolean);
};

module.exports = {
    SEARCH_ALIAS_GROUPS,
    expandFazerCardsSearchTerms,
    normalizeSearchTerm,
};
