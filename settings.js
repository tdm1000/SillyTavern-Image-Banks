// Settings schema, character identity helpers, and a tiny change bus so the UI
// can notify the runtime layer without a circular import.

export const DEFAULT_SETTINGS = {
    enabled: true,
    quickButton: true,
    autoAttachByName: true,
    depth: 2,
    includePreviousMessage: false,
    oncePerMessage: true,
    maxPerMessage: 1,
    wholeWord: true,
    tagScope: 'message',        // 'message' | 'sentence' | 'proximity'
    tagScopeWindow: 40,         // characters, only used by 'proximity'
    avoidRepeat: true,
    pageSize: 24,
    globalBankId: null,
    globalEnabled: false,
    globalChance: 10,
    assignedBankByChar: {},
    disabledChars: {},
};

export function ctx() {
    try {
        return window.SillyTavern?.getContext?.() ?? {};
    } catch (err) {
        console.warn('[image-banks] getContext() failed', err);
        return {};
    }
}

let fallbackSettings = null;

export function getSettings() {
    const c = ctx();
    if (!c.extensionSettings) {
        // Very old / unusual builds: keep working in-memory so the UI isn't dead.
        fallbackSettings ??= structuredClone(DEFAULT_SETTINGS);
        return fallbackSettings;
    }
    c.extensionSettings.imageBanks ??= structuredClone(DEFAULT_SETTINGS);
    const s = c.extensionSettings.imageBanks;
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[key] === undefined) s[key] = structuredClone(value);
    }
    return s;
}

const listeners = new Set();

export function onSettingsChanged(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Persist to settings.json and notify the runtime layer. */
export function persistSettings() {
    try {
        ctx().saveSettingsDebounced?.();
    } catch (err) {
        console.warn('[image-banks] saveSettingsDebounced failed', err);
    }
    for (const fn of listeners) {
        try {
            fn();
        } catch (err) {
            console.error('[image-banks] settings listener failed', err);
        }
    }
}

/** Stable key for the active character (avatar filename) or group. */
export function currentChar() {
    const c = ctx();
    if (c.groupId) {
        const group = (c.groups ?? []).find(g => g.id === c.groupId);
        return { key: `group:${c.groupId}`, name: group?.name ?? 'Group', isGroup: true };
    }
    const character = c.characters?.[c.characterId];
    if (character) {
        return { key: character.avatar || `char:${character.name}`, name: character.name, isGroup: false };
    }
    return { key: 'unknown', name: '', isGroup: false };
}

export function getAssignedBankId(charKey = currentChar().key) {
    return getSettings().assignedBankByChar?.[charKey] ?? null;
}

export function setAssignedBankId(bankId, charKey = currentChar().key) {
    const s = getSettings();
    s.assignedBankByChar ??= {};
    if (bankId) {
        s.assignedBankByChar[charKey] = bankId;
    } else {
        delete s.assignedBankByChar[charKey];
    }
    persistSettings();
}

export function isCharDisabled(charKey = currentChar().key) {
    return !!getSettings().disabledChars?.[charKey];
}

export function setCharDisabled(disabled, charKey = currentChar().key) {
    const s = getSettings();
    s.disabledChars ??= {};
    if (disabled) {
        s.disabledChars[charKey] = true;
    } else {
        delete s.disabledChars[charKey];
    }
    persistSettings();
}
