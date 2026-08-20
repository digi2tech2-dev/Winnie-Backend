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

const isShortSearchTerm = (term) => normalizeSearchTerm(term).replace(/\s+/g, '').length <= 3;

const buildFazerCardsSearchTermSpecs = (search) => {
    const raw = String(search || '').trim();
    const normalized = normalizeSearchTerm(raw);
    if (!raw && !normalized) return [];

    const specs = new Map();
    const addTerm = (term, reason = 'alias') => {
        const normalizedTerm = normalizeSearchTerm(term);
        if (!normalizedTerm) return;
        const key = normalizedTerm;
        const existing = specs.get(key) || {
            direct: false,
            pattern: term,
            raw: term,
            reason,
            short: isShortSearchTerm(normalizedTerm),
            supportingOnly: false,
            term: normalizedTerm,
        };
        const wasDirect = existing.direct;
        existing.direct = existing.direct || reason === 'direct';
        if (reason === 'direct' && !wasDirect) existing.pattern = term;
        existing.reason = existing.direct ? 'direct' : existing.reason;
        existing.raw = existing.raw || term;
        specs.set(key, existing);
    };

    addTerm(raw, 'direct');
    addTerm(normalized, 'direct');

    const directAliases = aliasIndex.get(normalized) || [];
    directAliases.forEach((term) => addTerm(term, 'alias'));

    for (const [alias, group] of aliasIndex.entries()) {
        if (normalized.includes(alias) || alias.includes(normalized)) {
            group.forEach((term) => addTerm(term, 'alias'));
        }
    }

    return [...specs.values()].map((spec) => ({
        ...spec,
        supportingOnly: spec.short && !spec.direct && !isShortSearchTerm(normalized),
    }));
};

const expandFazerCardsSearchTerms = (search) => {
    return buildFazerCardsSearchTermSpecs(search).map((spec) => spec.term);
};

module.exports = {
    SEARCH_ALIAS_GROUPS,
    buildFazerCardsSearchTermSpecs,
    expandFazerCardsSearchTerms,
    isShortSearchTerm,
    normalizeSearchTerm,
};
