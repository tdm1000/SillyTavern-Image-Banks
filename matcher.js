// Tag compilation and random selection.

const regexCache = new Map();

function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A tag is either a literal phrase (spaces match any whitespace) or a raw
 * /regex/flags tag. `wholeWord` adds unicode-aware lookarounds around
 * alphanumeric tags so "cat" does not match "concatenate".
 */
export function buildTagRegex(tag, wholeWord = true) {
    const clean = String(tag ?? '').trim();
    if (!clean) return null;
    const key = `${wholeWord ? 'w' : 'l'}\u0000${clean}`;
    if (regexCache.has(key)) return regexCache.get(key);

    let re = null;
    try {
        if (clean.length > 2 && clean.startsWith('/') && clean.lastIndexOf('/') > 0) {
            const end = clean.lastIndexOf('/');
            let flags = clean.slice(end + 1).replace(/[^imsu]/g, '');
            if (!flags.includes('i')) flags += 'i';
            if (!flags.includes('u')) flags += 'u';
            re = new RegExp(clean.slice(1, end), flags);
        } else {
            const body = escapeRegex(clean).replace(/\s+/g, '\\s+');
            const bounded = wholeWord
                && /^[\p{L}\p{N}]/u.test(clean)
                && /[\p{L}\p{N}]$/u.test(clean);
            re = bounded
                ? new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu')
                : new RegExp(body, 'iu');
        }
    } catch (err) {
        console.warn('[image-banks] invalid tag, ignoring:', clean, err.message);
        re = null;
    }
    regexCache.set(key, re);
    return re;
}

export function clearTagCache() {
    regexCache.clear();
}

/**
 * entries: [{ file, tags: string[] }]
 * returns [{ file, tags: matchedTags, score }] sorted by score desc
 */
/** Split prose into sentence-ish chunks. Cheap heuristic, no NLP. */
function splitSentences(text) {
    return text.split(/(?<=[.!?…])\s+|\n+/).map(s => s.trim()).filter(Boolean);
}

/** Every match index of one tag in the text. */
function tagPositions(tag, text, wholeWord) {
    const base = buildTagRegex(tag, wholeWord);
    if (!base) return [];
    const global = new RegExp(base.source, `${base.flags.replace('g', '')}g`);
    const positions = [];
    let match;
    while ((match = global.exec(text)) !== null) {
        positions.push(match.index);
        if (match[0] === '') global.lastIndex++; // zero-length guard
    }
    return positions;
}

/** Most distinct tags co-occurring inside `windowSize` characters. */
function bestWindow(tags, text, wholeWord, windowSize) {
    const points = [];
    for (const tag of tags) {
        for (const pos of tagPositions(tag, text, wholeWord)) points.push({ pos, tag });
    }
    if (!points.length) return { count: 0, tags: [] };
    points.sort((a, b) => a.pos - b.pos);

    let best = { count: 0, tags: [] };
    for (let i = 0; i < points.length; i++) {
        const start = points[i].pos;
        const seen = new Set();
        for (let j = i; j < points.length && points[j].pos - start <= windowSize; j++) {
            seen.add(points[j].tag);
        }
        if (seen.size > best.count) best = { count: seen.size, tags: [...seen] };
    }
    return best;
}

/** Most tags present in any single sentence. */
function bestSentence(tags, sentences, wholeWord) {
    let best = { count: 0, tags: [] };
    for (const sentence of sentences) {
        const found = tags.filter(tag => {
            const re = buildTagRegex(tag, wholeWord);
            return re && re.test(sentence);
        });
        if (found.length > best.count) best = { count: found.length, tags: found };
    }
    return best;
}

/** How many tags appear anywhere in the text. */
function countInMessage(tags, text, wholeWord) {
    const found = tags.filter(tag => {
        const re = buildTagRegex(tag, wholeWord);
        return re && re.test(text);
    });
    return { count: found.length, tags: found };
}

/** How many tags an image's mode demands. */
function requiredCount(entry, tagCount) {
    const mode = entry.match ?? 'any';
    if (mode === 'all') return tagCount;
    if (mode === 'count') return Math.min(Math.max(1, entry.min ?? 2), tagCount);
    return 1;
}

/**
 * entries: [{ file, tags, match, min }]
 * scope: 'message' (default) | 'sentence' | 'proximity'
 * returns [{ file, tags: matchedTags, score }] sorted by score desc
 */
export function findMatches(text, entries, { wholeWord = true, scope = 'message', windowSize = 40 } = {}) {
    const results = [];
    if (!text) return results;
    const sentences = scope === 'sentence' ? splitSentences(text) : null;

    for (const entry of entries) {
        const tags = entry.tags ?? [];
        if (!tags.length) continue;

        const required = requiredCount(entry, tags.length);
        let best;

        // One tag needed: no binding to do, so the cheap whole-text test is
        // exactly equivalent. This is what keeps single-tag images unchanged.
        if (required <= 1) {
            best = countInMessage(tags, text, wholeWord);
        } else if (scope === 'sentence') {
            best = bestSentence(tags, sentences, wholeWord);
        } else if (scope === 'proximity') {
            best = bestWindow(tags, text, wholeWord, windowSize);
        } else {
            best = countInMessage(tags, text, wholeWord);
        }

        if (best.count < required) continue;
        results.push({ file: entry.file, tags: best.tags, score: best.count });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
}

/**
 * Random pick from `pool`, skipping anything in `excluded` unless that would
 * leave too few options (then the exclusion is relaxed).
 */
export function pickRandom(pool, count, excluded = new Set()) {
    const picks = [];
    if (!pool?.length || count <= 0) return picks;
    let available = pool.filter(item => !excluded.has(item.file));
    if (available.length < count) available = pool.slice();
    while (picks.length < count && available.length) {
        const index = Math.floor(Math.random() * available.length);
        picks.push(available.splice(index, 1)[0]);
    }
    return picks;
}

/** Stable key describing "the set of tags that caused this match". */
function tagSignature(tags) {
    return [...tags].map(tag => tag.toLowerCase()).sort().join('\u0000');
}

/**
 * Identically-matched images are variants of each other, so show at most one.
 * Prefers a variant that hasn't been used recently.
 * matches: [{ file, tags: matchedTags, score }]
 */
export function collapseVariants(matches, excluded = new Set()) {
    const groups = new Map();
    for (const match of matches) {
        const key = tagSignature(match.tags);
        const group = groups.get(key);
        if (group) {
            group.push(match);
        } else {
            groups.set(key, [match]);
        }
    }
    return [...groups.values()].map(group => {
        const fresh = group.filter(match => !excluded.has(match.file));
        const from = fresh.length ? fresh : group;
        return from[Math.floor(Math.random() * from.length)];
    });
}
