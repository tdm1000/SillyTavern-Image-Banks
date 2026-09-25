// Bank + tag metadata. Lives entirely in localStorage, as specified.
// Images themselves live in SillyTavern's user image folders on disk.

export const LS_KEY = 'st-image-banks:store:v1';
const SAVE_DEBOUNCE_MS = 250;

let store = { version: 1, banks: {} };
let saveTimer = null;

export function loadStore() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object' && parsed.banks) {
            store = parsed;
            for (const bank of Object.values(store.banks)) {
                bank.images ??= {};
            }
        }
    } catch (err) {
        console.error('[image-banks] store load failed, starting fresh', err);
        store = { version: 1, banks: {} };
    }
    return store;
}

export function getStore() {
    return store;
}

export function saveStore({ immediate = false } = {}) {
    clearTimeout(saveTimer);
    if (immediate) {
        writeStore();
        return;
    }
    saveTimer = setTimeout(writeStore, SAVE_DEBOUNCE_MS);
}

function writeStore() {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify(store));
    } catch (err) {
        console.error('[image-banks] store save failed (localStorage full?)', err);
    }
}

export function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** Folder-safe name; also used as the default folder for a new bank. */
export function sanitizeFolder(name) {
    const cleaned = String(name ?? '')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/^\.+/, '_')
        .replace(/\s+/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/[_.]+$/, '')
        .slice(0, 48);
    return cleaned || `bank_${uid()}`;
}

/** Avoid two banks pointing at the same on-disk folder. */
export function uniqueFolder(base, selfId = null) {
    const taken = new Set(
        Object.values(store.banks)
            .filter(b => b.id !== selfId)
            .map(b => b.folder.toLowerCase()),
    );
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; i < 500; i++) {
        const candidate = `${base}_${i}`;
        if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${base}_${uid()}`;
}

export function getBank(bankId) {
    return store.banks[bankId] ?? null;
}

export function listBanks() {
    return Object.values(store.banks).sort((a, b) => a.name.localeCompare(b.name));
}

export function findBankByName(name) {
    const needle = String(name ?? '').trim().toLowerCase();
    if (!needle) return null;
    return listBanks().find(b => b.name.trim().toLowerCase() === needle) ?? null;
}

export function createBank(name) {
    const display = String(name ?? '').trim() || `Bank ${listBanks().length + 1}`;
    const id = uid();
    const folder = uniqueFolder(sanitizeFolder(display), id);
    store.banks[id] = {
        id,
        name: display,
        folder,
        createdAt: Date.now(),
        images: {},
    };
    saveStore({ immediate: true });
    return store.banks[id];
}

export function renameBank(bankId, newName) {
    const bank = getBank(bankId);
    if (!bank) return null;
    bank.name = String(newName ?? '').trim() || bank.name;
    saveStore({ immediate: true });
    return bank;
}

export function deleteBank(bankId) {
    const bank = getBank(bankId);
    if (!bank) return null;
    delete store.banks[bankId];
    const s = store.settingsSnapshot; // unused placeholder to keep shape stable
    saveStore({ immediate: true });
    return bank;
}

/** Reconcile stored tag entries against the actual folder contents. */
export function syncBankImages(bank, filenames) {
    if (!bank) return false;
    let changed = false;
    bank.images ??= {};
    const present = new Set(filenames);
    for (const file of filenames) {
        if (!bank.images[file]) {
            bank.images[file] = { tags: [], addedAt: Date.now() };
            changed = true;
        }
    }
    for (const file of Object.keys(bank.images)) {
        if (!present.has(file)) {
            delete bank.images[file];
            changed = true;
        }
    }
    if (changed) saveStore();
    return changed;
}

export function registerImage(bankId, filename) {
    const bank = getBank(bankId);
    if (!bank || !filename) return false;
    bank.images ??= {};
    if (bank.images[filename]) return false;
    bank.images[filename] = { tags: [], addedAt: Date.now() };
    saveStore();
    return true;
}

export function registerRemoteImage(bankId, key, url) {
    const bank = getBank(bankId);
    if (!bank || !key || !url) return false;
    bank.images ??= {};
    bank.images[key] = { tags: [], addedAt: Date.now(), url };
    saveStore();
    return true;
}

export function setImageMode(bankId, filename, mode, min = 2) {
    const bank = getBank(bankId);
    if (!bank) return;
    bank.images ??= {};
    bank.images[filename] ??= { tags: [], addedAt: Date.now() };
    const entry = bank.images[filename];
    if (mode === 'all' || mode === 'count') {
        entry.match = mode;
        if (mode === 'count') {
            entry.min = Math.max(2, Math.round(Number(min) || 2));
        } else {
            delete entry.min;
        }
    } else {
        delete entry.match; // 'any' is the default; keep the record clean
        delete entry.min;
    }
    saveStore();
}

export function setImageTags(bankId, filename, tags) {
    const bank = getBank(bankId);
    if (!bank) return;
    bank.images ??= {};
    bank.images[filename] ??= { tags: [], addedAt: Date.now() };
    bank.images[filename].tags = tags;
    saveStore();
}

export function getImageTags(bankId, filename) {
    return getBank(bankId)?.images?.[filename]?.tags ?? [];
}

export function removeImageMeta(bankId, filename) {
    const bank = getBank(bankId);
    if (!bank?.images?.[filename]) return;
    delete bank.images[filename];
    saveStore();
}

/**
 * Comma (or newline) separated tags.
 * Quotes protect commas inside a phrase; /slashes/ protect a regex tag.
 */
export function parseTags(input) {
    const str = String(input ?? '');
    const raw = [];
    let buf = '';
    let inQuote = false;
    let inRegex = false;

    for (const ch of str) {
        if (ch === '"') {
            inQuote = !inQuote;
            buf += ch;
            continue;
        }
        if (ch === '/' && !inQuote && !inRegex && buf.trim() === '') {
            inRegex = true;
            buf += ch;
            continue;
        }
        if (ch === '/' && inRegex) {
            inRegex = false;
            buf += ch;
            continue;
        }
        if ((ch === ',' || ch === '\n') && !inQuote && !inRegex) {
            raw.push(buf);
            buf = '';
            continue;
        }
        buf += ch;
    }
    raw.push(buf);

    const out = [];
    const seen = new Set();
    for (let tag of raw) {
        tag = tag.trim();
        if (tag.length > 1 && tag.startsWith('"') && tag.endsWith('"')) {
            tag = tag.slice(1, -1).trim();
        }
        if (!tag) continue;
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
    }
    return out;
}

export function tagsToString(tags) {
    return (tags ?? []).join(', ');
}
