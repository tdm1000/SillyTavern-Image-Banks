// Runtime layer: scans rendered messages, matches tags, injects images.

import {
    ctx, getSettings, onSettingsChanged, currentChar, isCharDisabled,
} from './settings.js';
import { loadStore, getStore, getBank, findBankByName, saveStore } from './store.js';
import { getBankFiles, invalidateBankFiles, userImageUrl } from './st-api.js';
import { findMatches, pickRandom, collapseVariants } from './matcher.js';
import { UI } from './ui.js';

const RECENT_MAX = 12;
const RENDER_DELAY_MS = 40;

const usedByChat = new Map(); // `${chatId}:${bankId}` -> string[]
let runtimeReady = false;

function log(...args) {
    console.log('[image-banks]', ...args);
}

/* ------------------------------------------------------------- runtime */

function isEligible(messageId, chatLength) {
    const depth = Math.max(1, Number(getSettings().depth) || 2);
    return messageId >= chatLength - depth;
}

function scanText(chat, messageId) {
    const s = getSettings();
    const parts = [];
    const from = s.includePreviousMessage ? Math.max(0, messageId - 1) : messageId;
    for (let i = from; i <= messageId; i++) {
        const mes = chat[i]?.mes;
        if (typeof mes === 'string') parts.push(mes);
    }
    return parts.join('\n');
}

function recentKey(bankId) {
    const chatId = ctx().chatId ?? 'unknown';
    return `${chatId}:${bankId}`;
}

function recentFor(bankId) {
    return new Set(usedByChat.get(recentKey(bankId)) ?? []);
}

function remember(bankId, picks) {
    const key = recentKey(bankId);
    const list = usedByChat.get(key) ?? [];
    for (const pick of picks) list.push(pick.file);
    while (list.length > RECENT_MAX) list.shift();
    usedByChat.set(key, list);
}

/** Explicit assignment wins; otherwise match the bank name to the character. */
function resolveBank(char) {
    const settings = getSettings();
    const explicit = settings.assignedBankByChar?.[char.key];
    if (explicit && getBank(explicit)) return getBank(explicit);
    if (settings.autoAttachByName && char.name) return findBankByName(char.name);
    return null;
}

async function choosePicks(messageId, chat) {
    const settings = getSettings();
    const store = getStore();
    const char = currentChar();
    const bank = char.isGroup ? null : resolveBank(char);

    if (!bank) {
        // Global bank: only reachable when no character bank is bound, per spec.
        const global = settings.globalEnabled ? getBank(settings.globalBankId) : null;
        if (!global) return [];
        if (Math.random() * 100 >= Math.max(0, Math.min(100, Number(settings.globalChance) || 0))) return [];
        const files = await getBankFiles(global);
        if (!files.length) return [];
        const picks = pickRandom(files.map(file => ({ file })), 1, settings.avoidRepeat ? recentFor(global.id) : new Set());
        remember(global.id, picks);
        return picks.map(pick => ({
            bankId: global.id,
            folder: global.folder,
            file: pick.file,
            tags: [],
            url: getStore().banks[global.id]?.images?.[pick.file]?.url ?? null,
        }));
    }

    const files = await getBankFiles(bank);
    if (!files.length) return [];

    const meta = store.banks[bank.id];
    const entries = files.map(file => ({
        file,
        tags: meta?.images?.[file]?.tags ?? [],
        match: meta?.images?.[file]?.match ?? 'any',
        min: meta?.images?.[file]?.min ?? 2,
    }));
    const matches = findMatches(scanText(chat, messageId), entries, { wholeWord: settings.wholeWord });
    if (!matches.length) return [];

    const count = settings.oncePerMessage ? 1 : Math.max(1, Number(settings.maxPerMessage) || 1);
    const excluded = settings.avoidRepeat ? recentFor(bank.id) : new Set();

    // Picking more than one image: treat identically-tagged images as variants
    // of each other and show at most one of them.
    const candidates = count > 1 ? collapseVariants(matches, excluded) : matches;

    const picks = pickRandom(candidates, count, excluded);
    remember(bank.id, picks);
    return picks.map(pick => ({
        bankId: bank.id,
        folder: bank.folder,
        file: pick.file,
        tags: pick.tags,
        url: meta?.images?.[pick.file]?.url ?? null,
    }));
}

/* ------------------------------------------------------- message plumbing */

function attachmentsHost(messageId) {
    return document
        .querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`)
        ?? document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
}

function storedPicks(message) {
    const swipe = message?.swipe_id ?? 0;
    const all = message?.extra?.imageBanks;
    if (!all || !Array.isArray(all[swipe])) return null;
    return all[swipe];
}

function storePicks(message, picks) {
    const swipe = message.swipe_id ?? 0;
    message.extra ??= {};
    message.extra.imageBanks ??= {};
    message.extra.imageBanks[swipe] = picks;
    try {
        ctx().saveChat?.();
    } catch (err) {
        console.warn('[image-banks] saveChat failed', err);
    }
}

function renderAttachments(messageId, picks) {
    const host = attachmentsHost(messageId);
    if (!host) return false;
    host.querySelector('.imgbank-attachments')?.remove();
    if (!picks?.length) return true;

    const wrap = document.createElement('div');
    wrap.className = 'imgbank-attachments';
    for (const pick of picks) {
        const img = document.createElement('img');
        img.className = 'imgbank-msg-image';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = pick.url ?? userImageUrl(pick.folder, pick.file);
        img.alt = (pick.tags ?? []).join(', ') || pick.file;
        img.title = (pick.tags ?? []).join(', ') || pick.file;
        img.dataset.bankId = pick.bankId;
        img.dataset.file = pick.file;
        img.addEventListener('error', () => img.classList.add('imgbank-broken'), { once: true });
        img.addEventListener('click', () => UI.openZoomForImage({ bankId: pick.bankId, file: pick.file }));
        wrap.appendChild(img);
    }
    host.appendChild(wrap);
    return true;
}

function removeAllAttachments() {
    for (const el of document.querySelectorAll('.imgbank-attachments')) el.remove();
}

async function processMessage(messageId, { retry = true } = {}) {
    const settings = getSettings();
    if (!settings.enabled) return;

    const chat = ctx().chat;
    if (!Array.isArray(chat)) return;
    const id = Number(messageId);
    if (!Number.isInteger(id) || id < 0 || id >= chat.length) return;

    const char = currentChar();
    if (isCharDisabled(char.key)) {
        document.querySelector(`.mes[mesid="${id}"] .imgbank-attachments`)?.remove();
        return;
    }

    const message = chat[id];
    if (message.is_user) {
        // Character messages only — also clears anything injected by an older build.
        document.querySelector(`.mes[mesid="${id}"] .imgbank-attachments`)?.remove();
        return;
    }
    let picks = storedPicks(message);
    if (picks === null && isEligible(id, chat.length)) {
        picks = await choosePicks(id, chat);
        storePicks(message, picks);
    }
    const rendered = renderAttachments(id, picks ?? []);
    if (!rendered && retry) {
        setTimeout(() => processMessage(id, { retry: false }), RENDER_DELAY_MS);
    }
}

/** Wipe cached picks in the trailing window and rebuild (used on setting changes). */
async function reprocessChat() {
    const settings = getSettings();
    if (!settings.enabled) {
        removeAllAttachments();
        return;
    }
    const chat = ctx().chat;
    if (!Array.isArray(chat)) return;

    usedByChat.clear();
    const start = Math.max(0, chat.length - Math.max(1, Number(settings.depth) || 2));
    for (let i = start; i < chat.length; i++) {
        const message = chat[i];
        const swipe = message?.swipe_id ?? 0;
        if (message?.extra?.imageBanks?.[swipe] !== undefined) {
            delete message.extra.imageBanks[swipe];
            if (!Object.keys(message.extra.imageBanks).length) delete message.extra.imageBanks;
        }
        document.querySelector(`.mes[mesid="${i}"] .imgbank-attachments`)?.remove();
    }
    for (let i = start; i < chat.length; i++) {
        await processMessage(i, { retry: false });
    }
}

let reprocessTimer = null;
function scheduleReprocess() {
    clearTimeout(reprocessTimer);
    reprocessTimer = setTimeout(() => { reprocessChat().catch(err => console.error(err)); }, 250);
}

/* ------------------------------------------------------------- lifecycle */

async function waitForContext(timeoutMs = 15_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const c = ctx();
        if (c.eventSource && c.eventTypes) return c;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    return ctx();
}

async function init() {
    if (runtimeReady) return;
    const c = await waitForContext();
    if (!c.eventTypes || !c.eventSource) {
        console.error('[image-banks] SillyTavern context unavailable; extension disabled.');
        return;
    }

    loadStore();
    UI.mount({ onImageClick: null });
    const { eventSource, eventTypes } = c;

    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, id => {
        processMessage(id).catch(err => console.error('[image-banks]', err));
    });
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, id => {
        processMessage(id).catch(err => console.error('[image-banks]', err));
    });
    eventSource.on(eventTypes.MESSAGE_SWIPED, id => {
        setTimeout(() => processMessage(id).catch(err => console.error('[image-banks]', err)), RENDER_DELAY_MS);
    });
    eventSource.on(eventTypes.MESSAGE_UPDATED, id => {
        processMessage(id, { retry: false }).catch(err => console.error('[image-banks]', err));
    });
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        usedByChat.clear();
        invalidateBankFiles();
        UI.refreshSettingsUi();
        scheduleReprocess();
    });
    eventSource.on(eventTypes.CHARACTER_CHANGED, () => UI.refreshSettingsUi());

    onSettingsChanged(() => {
        UI.applyQuickButton();
        scheduleReprocess();
    });

    // Re-evaluate the visible window once the chat is on screen.
    setTimeout(() => scheduleReprocess(), 500);
    runtimeReady = true;
    log('ready');
}

jQuery(async () => {
    try {
        await init();
    } catch (err) {
        console.error('[image-banks] init failed', err);
    }
});
