// All user-facing surfaces: settings drawer, top-bar quick button,
// bank manager (thumbnail grid + pager), and the zoom/tag editor.

import {
    getSettings, persistSettings, currentChar,
    getAssignedBankId, setAssignedBankId, isCharDisabled, setCharDisabled,
    ctx,
} from './settings.js';
import {
    getStore, getBank, listBanks, createBank, renameBank, deleteBank, registerImage, registerRemoteImage,
    parseTags, tagsToString, setImageTags, setImageMode, removeImageMeta, saveStore,
} from './store.js';
import {
    getBankFiles, invalidateBankFiles, uploadImage, deleteImage,
    userImageUrl, sanitizeFilename, uniqueFilename, fetchUrlAsFile, listBankFiles,
} from './st-api.js';

const SETTINGS_HTML = `
<div id="imgbank_settings" class="imgbank-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Image Banks</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="checkbox_label"><input type="checkbox" id="imgbank_enabled"><span>Enable Image Banks</span></label>
      <label class="checkbox_label"><input type="checkbox" id="imgbank_quickbutton"><span>Show quick button in top bar</span></label>
      <label class="checkbox_label"><input type="checkbox" id="imgbank_autoattach"><span>Auto-attach bank by character name</span></label>

      <label for="imgbank_depth">Scan depth (recent messages)</label>
      <input type="number" id="imgbank_depth" min="1" max="50" step="1" class="text_pole">

      <label for="imgbank_max">Max images per message</label>
      <input type="number" id="imgbank_max" min="1" max="10" step="1" class="text_pole">
      <label class="checkbox_label"><input type="checkbox" id="imgbank_once"><span>Only show once per message (overrides max)</span></label>

      <label class="checkbox_label"><input type="checkbox" id="imgbank_wholeword"><span>Whole-word tag matching</span></label>
      <label class="checkbox_label"><input type="checkbox" id="imgbank_norepeat"><span>Avoid repeating the same image in a chat</span></label>

      <label for="imgbank_tagscope">Tag scope (for AND / 2+ images)</label>
      <select id="imgbank_tagscope" class="text_pole">
      <option value="message">Whole message</option>
      <option value="sentence">Same sentence</option>
      <option value="proximity">Nearby (window)</option>
      </select>
      <label for="imgbank_scopewindow">Window size (characters)</label>
      <input type="number" id="imgbank_scopewindow" min="10" max="400" step="5" class="text_pole">

      <hr>
      <label for="imgbank_globalbank">Global bank (percent chance, no tags)</label>
      <select id="imgbank_globalbank" class="text_pole"></select>
      <label class="checkbox_label"><input type="checkbox" id="imgbank_globalenabled"><span>Enable global bank</span></label>
      <input type="number" id="imgbank_chance" min="0" max="100" step="1" class="text_pole" placeholder="Chance %">
      <small id="imgbank_globalnote" class="imgbank-note"></small>

      <hr>
      <b id="imgbank_charname" class="imgbank-charname"></b>
      <label class="checkbox_label"><input type="checkbox" id="imgbank_charenabled"><span>Enabled for this character</span></label>
      <label for="imgbank_charassign">Bank assigned to this character</label>
      <select id="imgbank_charassign" class="text_pole"></select>

      <label for="imgbank_pagesize">Thumbnails per page</label>
      <input type="number" id="imgbank_pagesize" min="6" max="200" step="1" class="text_pole">

      <div class="menu_button menu_button_icon" id="imgbank_open">
        <i class="fa-solid fa-images"></i><span>Open bank manager</span>
      </div>
    </div>
  </div>
</div>`;

const OVERLAY_HTML = `
<div id="imgbank_overlay" class="imgbank-overlay" hidden>
  <div class="imgbank-panel">
    <div class="imgbank-toolbar">
      <select id="imgbank_bank_select" class="text_pole"></select>
      <button type="button" class="menu_button" id="imgbank_new"><i class="fa-solid fa-plus"></i><span>New</span></button>
      <button type="button" class="menu_button" id="imgbank_rename"><i class="fa-solid fa-pen"></i><span>Rename</span></button>
      <button type="button" class="menu_button" id="imgbank_upload_files"><i class="fa-solid fa-file-arrow-up"></i><span>Upload files</span></button>
      <button type="button" class="menu_button" id="imgbank_import_files"><i class="fa-solid fa-file-import"></i><span>Import folder</span></button>
      <button type="button" class="menu_button" id="imgbank_add_url"><i class="fa-solid fa-link"></i><span>From URL</span></button>
      <button type="button" class="menu_button" id="imgbank_refresh"><i class="fa-solid fa-rotate"></i></button>
      <button type="button" class="menu_button" id="imgbank_delete_bank"><i class="fa-solid fa-trash"></i></button>
      <button type="button" class="menu_button imgbank-close" id="imgbank_close"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="imgbank-grid" id="imgbank_grid"></div>
    <div class="imgbank-pager">
      <button type="button" class="menu_button imgbank-pager-btn" id="imgbank_prev">❮</button>
      <span id="imgbank_pageinfo">0 / 0</span>
      <button type="button" class="menu_button imgbank-pager-btn" id="imgbank_next">❯</button>
    </div>
    <input type="file" id="imgbank_file_input" accept="image/*" multiple hidden>
    <input type="file" id="imgbank_dir_input" webkitdirectory directory multiple hidden>
  </div>

  <div class="imgbank-zoom" id="imgbank_zoom" hidden>
    <div class="imgbank-zoom-top">
      <button type="button" class="menu_button" id="imgbank_zoom_back"><i class="fa-solid fa-arrow-left"></i></button>
      <span id="imgbank_zoom_name" class="imgbank-zoom-name"></span>
      <button type="button" class="menu_button" id="imgbank_zoom_delete"><i class="fa-solid fa-trash"></i></button>
    </div>
    <div class="imgbank-zoom-stage">
      <button type="button" class="menu_button imgbank-nav" id="imgbank_zoom_prev">❮</button>
      <img id="imgbank_zoom_img" alt="Tap to go back">
      <button type="button" class="menu_button imgbank-nav" id="imgbank_zoom_next">❯</button>
    </div>
    <div class="imgbank-zoom-tags">
    <input type="text" id="imgbank_zoom_tags" class="text_pole" placeholder="tag one, tag two, /regex/i">
    <button type="button" class="menu_button imgbank-mode" id="imgbank_zoom_mode">OR</button>
    <span id="imgbank_zoom_saved" class="imgbank-saved"></span>
    </div>
  </div>
</div>`;

const state = {
    mounted: false,
    bankId: null,
    files: [],
    page: 1,
    zoomIndex: -1,
    tagTimer: null,
    savedTimer: null,
};

let onPickImage = null;

export const UI = {
    mount({ onImageClick } = {}) {
        if (state.mounted) return;
        onPickImage = onImageClick ?? null;
        document.body.insertAdjacentHTML('beforeend', OVERLAY_HTML);
        document
            .querySelector('#extensions_settings2, #extensions_settings')
            ?.insertAdjacentHTML('beforeend', SETTINGS_HTML);
        wireSettingsPanel();
        wireOverlay();
        refreshSettingsUi();
        applyQuickButton();
        state.mounted = true;
    },

    refreshSettingsUi,
    applyQuickButton,
    openManager,
    openBank,
    async openZoomForImage({ bankId, file }) {
        await openManager();
        if (state.bankId !== bankId) await openBank(bankId);
        const index = state.files.indexOf(file);
        if (index >= 0) openZoom(index);
    },
};

/* ------------------------------------------------------------------ helpers */

function notify(message, type = 'info') {
    const toastr = globalThis.toastr;
    if (toastr?.[type]) {
        toastr[type](message, 'Image Banks');
    } else if (type === 'error') {
        console.error('[image-banks]', message);
    } else {
        console.log('[image-banks]', message);
    }
}

function uiPrompt({ title, value = '', okText = 'OK', withInput = true }) {
    return new Promise(resolve => {
        const host = document.createElement('div');
        host.className = 'imgbank-prompt';
        host.innerHTML = `
          <div class="imgbank-prompt-box">
            <div class="imgbank-prompt-title"></div>
            ${withInput ? '<input type="text" class="text_pole imgbank-prompt-input">' : ''}
            <div class="imgbank-prompt-actions">
              <button type="button" class="menu_button imgbank-prompt-cancel">Cancel</button>
              <button type="button" class="menu_button imgbank-prompt-ok"></button>
            </div>
          </div>`;
        host.querySelector('.imgbank-prompt-title').textContent = title;
        host.querySelector('.imgbank-prompt-ok').textContent = okText;
        const input = host.querySelector('.imgbank-prompt-input');
        if (input) input.value = value;
        document.body.appendChild(host);
        input?.focus();
        input?.select();

        const done = result => {
            host.remove();
            resolve(result);
        };
        host.querySelector('.imgbank-prompt-ok').addEventListener('click', () => done(input ? input.value : true));
        host.querySelector('.imgbank-prompt-cancel').addEventListener('click', () => done(null));
        input?.addEventListener('keydown', ev => {
            if (ev.key === 'Enter') done(input.value);
            if (ev.key === 'Escape') done(null);
        });
        host.addEventListener('click', ev => {
            if (ev.target === host) done(null);
        });
    });
}

/* ------------------------------------------------------- settings panel */

function setValue(selector, value) {
    const el = document.querySelector(selector);
    if (!el) return;
    if (el.type === 'checkbox') {
        el.checked = !!value;
    } else {
        el.value = value ?? '';
    }
}

function bankOptions(includeEmpty = true) {
    const banks = listBanks();
    const options = includeEmpty
        ? [`<option value="">— none —</option>`]
        : [];
    for (const bank of banks) {
        options.push(`<option value="${bank.id}"></option>`);
    }
    const html = options.join('');
    return { html, banks };
}

function fillSelect(selector, selectedId, includeEmpty = true) {
    const el = document.querySelector(selector);
    if (!el) return;
    const banks = listBanks();
    el.innerHTML = '';
    if (includeEmpty) {
        el.append(new Option('— none —', ''));
    }
    for (const bank of banks) {
        el.append(new Option(`${bank.name} (${bank.folder})`, bank.id));
    }
    el.value = banks.some(b => b.id === selectedId) ? selectedId : '';
}

function refreshSettingsUi() {
    const s = getSettings();
    setValue('#imgbank_enabled', s.enabled);
    setValue('#imgbank_quickbutton', s.quickButton);
    setValue('#imgbank_autoattach', s.autoAttachByName);
    setValue('#imgbank_depth', s.depth);
    setValue('#imgbank_max', s.maxPerMessage);
    setValue('#imgbank_once', s.oncePerMessage);
    setValue('#imgbank_wholeword', s.wholeWord);
    setValue('#imgbank_norepeat', s.avoidRepeat);
    setValue('#imgbank_pagesize', s.pageSize);
    setValue('#imgbank_globalenabled', s.globalEnabled);
    setValue('#imgbank_chance', s.globalChance);
    fillSelect('#imgbank_globalbank', s.globalBankId);
    setValue('#imgbank_tagscope', s.tagScope ?? 'message');
    setValue('#imgbank_scopewindow', s.tagScopeWindow ?? 40);
    const windowInput = document.querySelector('#imgbank_scopewindow');
    if (windowInput) windowInput.disabled = (s.tagScope ?? 'message') !== 'proximity';

    const char = currentChar();
    const nameEl = document.querySelector('#imgbank_charname');
    if (nameEl) nameEl.textContent = char.name ? `Character: ${char.name}` : 'Character: (none)';
    setValue('#imgbank_charenabled', !isCharDisabled(char.key));
    fillSelect('#imgbank_charassign', getAssignedBankId(char.key));

    // Global bank is meaningless while a character bank is bound.
    const bound = resolveBoundBankId();
    const globalNote = document.querySelector('#imgbank_globalnote');
    if (globalNote) {
        globalNote.textContent = bound
            ? 'Global bank is disabled while a character bank is selected.'
            : 'Used only when no character bank is selected.';
    }
    for (const id of ['#imgbank_globalbank', '#imgbank_globalenabled', '#imgbank_chance']) {
        const el = document.querySelector(id);
        if (el) el.disabled = !!bound;
    }
}

function resolveBoundBankId() {
    const char = currentChar();
    const explicit = getAssignedBankId(char.key);
    if (explicit && getBank(explicit)) return explicit;
    const s = getSettings();
    if (s.autoAttachByName && char.name) {
        const match = listBanks().find(b => b.name.trim().toLowerCase() === char.name.trim().toLowerCase());
        if (match) return match.id;
    }
    return null;
}

function wireSettingsPanel() {
    const bindCheckbox = (selector, key, after) => {
        document.querySelector('#imgbank_tagscope')?.addEventListener('change', ev => {
            getSettings().tagScope = ev.target.value;
            persistSettings();
            refreshSettingsUi();
        });
    };
    const bindNumber = (selector, key, { min = 1, max = 100 } = {}) => {
        document.querySelector(selector)?.addEventListener('change', ev => {
            const raw = Number(ev.target.value);
            const value = Number.isFinite(raw) ? Math.min(max, Math.max(min, Math.round(raw))) : min;
            getSettings()[key] = value;
            ev.target.value = value;
            persistSettings();
        });
    };

    bindCheckbox('#imgbank_enabled', 'enabled');
    bindCheckbox('#imgbank_quickbutton', 'quickButton', applyQuickButton);
    bindCheckbox('#imgbank_autoattach', 'autoAttachByName', refreshSettingsUi);
    bindCheckbox('#imgbank_once', 'oncePerMessage');
    bindCheckbox('#imgbank_wholeword', 'wholeWord');
    bindCheckbox('#imgbank_norepeat', 'avoidRepeat');
    bindCheckbox('#imgbank_globalenabled', 'globalEnabled');

    bindNumber('#imgbank_depth', 'depth', { min: 1, max: 50 });
    bindNumber('#imgbank_max', 'maxPerMessage', { min: 1, max: 10 });
    bindNumber('#imgbank_pagesize', 'pageSize', { min: 6, max: 200 });
    bindNumber('#imgbank_chance', 'globalChance', { min: 0, max: 100 });
    bindNumber('#imgbank_scopewindow', 'tagScopeWindow', { min: 10, max: 400 });

    document.querySelector('#imgbank_globalbank')?.addEventListener('change', ev => {
        getSettings().globalBankId = ev.target.value || null;
        persistSettings();
    });

    document.querySelector('#imgbank_charassign')?.addEventListener('change', ev => {
        setAssignedBankId(ev.target.value || null);
        refreshSettingsUi();
    });

    document.querySelector('#imgbank_charenabled')?.addEventListener('change', ev => {
        setCharDisabled(!ev.target.checked);
    });

    document.querySelector('#imgbank_open')?.addEventListener('click', () => openManager());
}

/* ------------------------------------------------------------- quick button */

function applyQuickButton() {
    const existing = document.querySelector('#imgbank_quick_button');
    const wanted = getSettings().quickButton;
    if (wanted && !existing) {
        const button = document.createElement('div');
        button.id = 'imgbank_quick_button';
        button.className = 'list-group-item flex-container flexGap5 interactable';
        button.tabIndex = 0;
        button.setAttribute('role', 'button');
        button.innerHTML = '<div class="fa-solid fa-images extensionsMenuExtensionButton"></div><span>Image Banks</span>';
        button.addEventListener('click', () => openManager());
        document.querySelector('#extensionsMenu')?.appendChild(button);
    } else if (!wanted && existing) {
        existing.remove();
    }
}

/* ------------------------------------------------------------ bank manager */

function syncVisualHeight() {
    const overlay = document.querySelector('#imgbank_overlay');
    if (!overlay) return;
    const vv = window.visualViewport;
    if (!vv) return;
    overlay.style.height = `${vv.height}px`;
    overlay.style.top = `${vv.offsetTop}px`;
}

function wireOverlay() {
    const q = id => document.querySelector(id);
    q('#imgbank_close')?.addEventListener('click', closeManager);
    q('#imgbank_new')?.addEventListener('click', async () => {
        const name = await uiPrompt({ title: 'New image bank name', value: '', okText: 'Create' });
        if (!name) return;
        const bank = createBank(name);
        invalidateBankFiles();
        refreshSettingsUi();
        await openBank(bank.id);
    });
    q('#imgbank_rename')?.addEventListener('click', async () => {
        const bank = getBank(state.bankId);
        if (!bank) return;
        const name = await uiPrompt({ title: 'Rename bank', value: bank.name, okText: 'Rename' });
        if (!name || name === bank.name) return;
        renameBank(bank.id, name);
        refreshSettingsUi();
        await openBank(bank.id);
        notify('Renamed. The folder on disk keeps its original name so existing images stay put.');
    });
    q('#imgbank_refresh')?.addEventListener('click', () => openBank(state.bankId, { force: true }));
    q('#imgbank_delete_bank')?.addEventListener('click', async () => {
        const bank = getBank(state.bankId);
        if (!bank) return;
        const ok = await uiPrompt({
            title: `Delete bank "${bank.name}"? Images on disk are kept.`,
            okText: 'Delete',
            withInput: false,
        });
        if (!ok) return;
        deleteBank(bank.id);
        invalidateBankFiles();
        refreshSettingsUi();
        state.bankId = null;
        state.files = [];
        await openManager();
    });

    q('#imgbank_bank_select')?.addEventListener('change', ev => {
        if (ev.target.value) openBank(ev.target.value);
    });

    q('#imgbank_prev')?.addEventListener('click', () => flipPage(-1));
    q('#imgbank_next')?.addEventListener('click', () => flipPage(1));

    q('#imgbank_import_files')?.addEventListener('click', () => ensureBank().then(bank => bank && q('#imgbank_dir_input')?.click()));
    q('#imgbank_upload_files')?.addEventListener('click', () => q('#imgbank_file_input')?.click());
    q('#imgbank_add_url')?.addEventListener('click', addFromUrl);

    const readPicker = ev => {
        // Snapshot the FileList and clear the input *before* the async work:
        // otherwise re-picking the same file fires no change event.
        const files = [...(ev.target.files ?? [])];
        ev.target.value = '';
        handleUploads(files);
    };
    q('#imgbank_file_input')?.addEventListener('change', readPicker);
    q('#imgbank_dir_input')?.addEventListener('change', readPicker);
    q('#imgbank_import_st')?.addEventListener('click', importFromServerFolder);

    q('#imgbank_zoom_mode')?.addEventListener('click', toggleZoomMode);
    q('#imgbank_zoom_back')?.addEventListener('click', closeZoom);
    q('#imgbank_zoom_img')?.addEventListener('click', closeZoom); // tap image = go back
    q('#imgbank_zoom_prev')?.addEventListener('click', () => flipZoom(-1));
    q('#imgbank_zoom_next')?.addEventListener('click', () => flipZoom(1));
    q('#imgbank_zoom_delete')?.addEventListener('click', deleteCurrentImage);
    q('#imgbank_zoom_tags')?.addEventListener('input', () => {
        clearTimeout(state.tagTimer);
        state.tagTimer = setTimeout(commitZoomTags, 400);
    });
    q('#imgbank_zoom_tags')?.addEventListener('blur', commitZoomTags);

    // Swipe paging on the grid for mobile.
    let touchStartX = null;
    q('#imgbank_grid')?.addEventListener('touchstart', ev => {
        touchStartX = ev.touches[0]?.clientX ?? null;
    }, { passive: true });
    q('#imgbank_grid')?.addEventListener('touchend', ev => {
        if (touchStartX === null) return;
        const dx = (ev.changedTouches[0]?.clientX ?? touchStartX) - touchStartX;
        touchStartX = null;
        if (Math.abs(dx) > 60) flipPage(dx < 0 ? 1 : -1);
    }, { passive: true });

        window.visualViewport?.addEventListener('resize', () => {
        if (!document.querySelector('#imgbank_overlay')?.hidden) syncVisualHeight();
    });
    window.visualViewport?.addEventListener('scroll', () => {
        if (!document.querySelector('#imgbank_overlay')?.hidden) syncVisualHeight();
    });

    document.addEventListener('keydown', ev => {
        if (q('#imgbank_overlay')?.hidden) return;
        if (ev.key === 'Escape') {
            if (!q('#imgbank_zoom')?.hidden) {
                closeZoom();
            } else {
                closeManager();
            }
        }
        if (!q('#imgbank_zoom')?.hidden) {
            if (ev.key === 'ArrowLeft') flipZoom(-1);
            if (ev.key === 'ArrowRight') flipZoom(1);
        }
    });
}

async function ensureBank() {
    if (state.bankId && getBank(state.bankId)) return getBank(state.bankId);
    const name = await uiPrompt({ title: 'Create a bank first — name it:', value: '', okText: 'Create' });
    if (!name) return null;
    const bank = createBank(name);
    invalidateBankFiles();
    refreshSettingsUi();
    await openBank(bank.id);
    return bank;
}

function flipPage(delta) {
    const size = Math.max(6, Number(getSettings().pageSize) || 24);
    const pages = Math.max(1, Math.ceil(state.files.length / size));
    const next = Math.min(pages, Math.max(1, state.page + delta));
    if (next === state.page) return;
    state.page = next;
    renderGrid();
    document.querySelector('#imgbank_grid')?.scrollTo({ top: 0, behavior: 'smooth' });
}

export async function openManager() {
    UI.mount();
    const overlay = document.querySelector('#imgbank_overlay');
    if (!overlay) return;
    overlay.hidden = false;
    document.body.classList.add('imgbank-locked');

    const target = state.bankId && getBank(state.bankId) ? state.bankId : resolveBoundBankId() ?? listBanks()[0]?.id ?? null;
    if (target) {
        await openBank(target);
    } else {
        state.files = [];
        renderGrid();
    }
}

function closeManager() {
    closeZoom();
    const overlay = document.querySelector('#imgbank_overlay');
    if (overlay) {
        overlay.hidden = true;
        overlay.style.height = '';
        overlay.style.top = '';
    }
    document.body.classList.remove('imgbank-locked');
}

export async function openBank(bankId, { force = false } = {}) {
    const bank = getBank(bankId);
    if (!bank) return;
    state.bankId = bankId;
    state.page = 1;

    const select = document.querySelector('#imgbank_bank_select');
    if (select) {
        refreshBankSelect();
        select.value = bankId;
    }

    if (force) invalidateBankFiles(bank.folder);
    state.files = await getBankFiles(bank, { force });
    renderGrid();
    refreshSettingsUi();
}

function refreshBankSelect() {
    const select = document.querySelector('#imgbank_bank_select');
    if (!select) return;
    const current = state.bankId;
    select.innerHTML = '';
    for (const bank of listBanks()) {
        select.append(new Option(`${bank.name} (${bank.folder})`, bank.id));
    }
    if (current && listBanks().some(b => b.id === current)) select.value = current;
}

function renderGrid() {
    const grid = document.querySelector('#imgbank_grid');
    if (!grid) return;
    grid.innerHTML = '';

    const bank = getBank(state.bankId);
    if (!bank) {
        grid.innerHTML = '<div class="imgbank-empty">No bank selected. Create one with “New”.</div>';
        updatePager(0, 1, 1);
        return;
    }
    if (!state.files.length) {
        grid.innerHTML = '<div class="imgbank-empty">This bank is empty. Use “Import folder”, the file picker, or “From URL”.</div>';
        updatePager(0, 1, 1);
        return;
    }

    const size = Math.max(6, Number(getSettings().pageSize) || 24);
    const pages = Math.max(1, Math.ceil(state.files.length / size));
    state.page = Math.min(Math.max(1, state.page), pages);
    const start = (state.page - 1) * size;
    const slice = state.files.slice(start, start + size);

    for (const [offset, file] of slice.entries()) {
        const index = start + offset;
        const tags = bank.images?.[file]?.tags ?? [];
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'imgbank-thumb';
        button.title = tags.length ? tags.join(', ') : file;

        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = tags.join(', ') || file;
        img.src = imageSrcFor(bank, file);
        img.addEventListener('error', () => button.classList.add('imgbank-broken'), { once: true });
        button.appendChild(img);

        if (tags.length) {
            const badge = document.createElement('span');
            badge.className = 'imgbank-badge';
            badge.textContent = String(tags.length);
            button.appendChild(badge);
        }

        // Match-mode badge: amber "2+" for count, blue "AND" for all.
        const mode = entryMode(bank.images?.[file]);
        if (mode !== 'any') {
            const modeBadge = document.createElement('span');
            modeBadge.className = 'imgbank-badge imgbank-badge-mode';
            modeBadge.textContent = modeLabel(mode, bank.images?.[file]?.min ?? 2);
            button.appendChild(modeBadge);
        }

        button.addEventListener('click', () => openZoom(index));
        grid.appendChild(button);
    }

    updatePager(state.files.length, state.page, pages);
}

function updatePager(total, page, pages) {
    const info = document.querySelector('#imgbank_pageinfo');
    if (info) info.textContent = total ? `${page} / ${pages}` : '0 / 0';
    const prev = document.querySelector('#imgbank_prev');
    const next = document.querySelector('#imgbank_next');
    if (prev) prev.disabled = page <= 1;
    if (next) next.disabled = page >= pages;
}

/* ------------------------------------------------------------------- zoom */

function openZoom(index) {
    const bank = getBank(state.bankId);
    if (!bank || index < 0 || index >= state.files.length) return;
    state.zoomIndex = index;
    // Grid stays mounted, so its scroll position is preserved on return.
    document.querySelector('#imgbank_zoom')?.removeAttribute('hidden');
    renderZoom();
}

function closeZoom() {
    commitZoomTags();
    document.querySelector('#imgbank_zoom')?.setAttribute('hidden', '');
    state.zoomIndex = -1;
}

function flipZoom(delta) {
    if (state.zoomIndex < 0) return;
    commitZoomTags();
    const count = state.files.length;
    state.zoomIndex = (state.zoomIndex + delta + count) % count;
    renderZoom();
}

function renderZoom() {
    const bank = getBank(state.bankId);
    const file = state.files[state.zoomIndex];
    if (!bank || !file) return;
    const img = document.querySelector('#imgbank_zoom_img');
    if (img) img.src = imageSrcFor(bank, file);
    const nameEl = document.querySelector('#imgbank_zoom_name');
    if (nameEl) nameEl.textContent = `${state.zoomIndex + 1} / ${state.files.length} · ${file}`;
    const input = document.querySelector('#imgbank_zoom_tags');
    if (input) input.value = tagsToString(bank.images?.[file]?.tags ?? []);
    flashSaved('');
}

const MODE_CYCLE = ['any', 'count', 'all'];

function entryMode(entry) {
    const mode = entry?.match;
    return mode === 'all' || mode === 'count' ? mode : 'any';
}

function modeLabel(mode, min = 2) {
    if (mode === 'all') return 'AND';
    if (mode === 'count') return `${min}+`;
    return 'OR';
}

function currentZoomFile() {
    return state.files[state.zoomIndex] ?? null;
}

function toggleZoomMode() {
    const bank = getBank(state.bankId);
    const file = currentZoomFile();
    if (!bank || !file) return;
    const entry = bank.images?.[file];
    const next = MODE_CYCLE[(MODE_CYCLE.indexOf(entryMode(entry)) + 1) % MODE_CYCLE.length];
    setImageMode(bank.id, file, next, 2);
    renderZoomMode();
    renderGrid();
    flashSaved('saved');
}

function renderZoomMode() {
    const bank = getBank(state.bankId);
    const file = currentZoomFile();
    const entry = bank?.images?.[file];
    const mode = entryMode(entry);
    const button = document.querySelector('#imgbank_zoom_mode');
    if (!button) return;
    button.textContent = modeLabel(mode, entry?.min ?? 2);
    button.dataset.mode = mode;
    button.title = mode === 'all'
    ? 'Every tag must appear in the message'
    : mode === 'count'
    ? 'Any 2 of the tags can trigger this image'
    : 'Any single tag can trigger this image';
}

function commitZoomTags() {
    clearTimeout(state.tagTimer);
    const bank = getBank(state.bankId);
    const file = state.files[state.zoomIndex];
    const input = document.querySelector('#imgbank_zoom_tags');
    if (!bank || !file || !input) return;
    const tags = parseTags(input.value);
    const existing = bank.images?.[file]?.tags ?? [];
    if (tags.length === existing.length && tags.every((t, i) => t === existing[i])) return;
    setImageTags(bank.id, file, tags);
    flashSaved('saved');
    renderGrid();
}

function flashSaved(text) {
    const el = document.querySelector('#imgbank_zoom_saved');
    if (!el) return;
    el.textContent = text ? `${text} ✓` : '';
    clearTimeout(state.savedTimer);
    if (text) state.savedTimer = setTimeout(() => { el.textContent = ''; }, 1500);
}

async function deleteCurrentImage() {
    const bank = getBank(state.bankId);
    const file = state.files[state.zoomIndex];
    if (!bank || !file) return;

    const isRemote = !!bank.images?.[file]?.url;

    const ok = await uiPrompt({
        title: isRemote ? `Remove the link to ${file}?` : `Delete ${file} from disk?`,
        okText: isRemote ? 'Remove' : 'Delete',
        withInput: false,
    });
    if (!ok) return;

    // Remote entries have no file in the bank folder — nothing to delete server-side.
    if (!isRemote) {
        try {
            await deleteImage(bank.folder, file);
        } catch (err) {
            notify(err.message ?? 'Delete failed', 'error');
            return;
        }
    }

    removeImageMeta(bank.id, file);
    invalidateBankFiles(bank.folder);

    const wasLast = state.zoomIndex >= state.files.length - 1;
    state.files = state.files.filter(f => f !== file);
    if (!state.files.length) {
        closeZoom();
        renderGrid();
        return;
    }
    state.zoomIndex = wasLast ? state.files.length - 1 : Math.max(0, state.zoomIndex);
    renderZoom();
    renderGrid();
}

/* ---------------------------------------------------------------- uploads */

async function handleUploads(files, { replace = false } = {}) {
    if (!files?.length) return;
    const bank = await ensureBank();
    if (!bank) return;
    const existing = [...(state.files ?? [])];
    let added = 0;
    const failures = [];

    const wasEnabled = getSettings().enabled;
    if (wasEnabled) notify(`Uploading ${files.length} image(s)…`);

    for (const file of files) {
        if (!file.type?.startsWith('image/') && !/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(file.name)) continue;
        const name = uniqueFilename(existing, sanitizeFilename(file.name));
        try {
            const saved = await uploadImage(bank.folder, file, name);
            registerImage(bank.id, saved);   // <- new line
            existing.push(saved);
            added++;
        } catch (err) {
            failures.push(`${file.name}: ${err.message}`);
        }
    }

    invalidateBankFiles(bank.folder);
    await openBank(bank.id, { force: true });
    if (added) notify(`Added ${added} image(s) to “${bank.name}”.`, 'success');
    if (failures.length) notify(`Failed: ${failures.slice(0, 3).join(' | ')}`, 'error');
    refreshSettingsUi();
}

/** Can the browser actually display this URL? CORS is irrelevant for <img>. */
function canLoadAsImage(url) {
    return new Promise(resolve => {
        const probe = new Image();
        const timer = setTimeout(() => { probe.src = ''; resolve(false); }, 10000);
        probe.onload = () => { clearTimeout(timer); resolve(true); };
        probe.onerror = () => { clearTimeout(timer); resolve(false); };
        probe.src = url;
    });
}

/** Remote entries carry their own URL; local entries live in the bank folder. */
function imageSrcFor(bank, file) {
    return bank?.images?.[file]?.url ?? userImageUrl(bank.folder, file);
}

async function addFromUrl() {
    const bank = await ensureBank();
    if (!bank) return;
    const url = (await uiPrompt({ title: 'Image URL', value: '', okText: 'Download' }))?.trim();
    if (!url) return;

    const existing = [...(state.files ?? [])];
    const base = (url.split('?')[0].split('/').pop() || 'image').replace(/\.[a-z0-9]+$/i, '');
    const ext = url.split('?')[0].match(/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i)?.[0] ?? '.png';

    try {
        const file = await fetchUrlAsFile(url, base);
        const saved = await uploadImage(bank.folder, file, uniqueFilename(existing, sanitizeFilename(file.name)));
        registerImage(bank.id, saved);
        invalidateBankFiles(bank.folder);
        await openBank(bank.id, { force: true });
        notify(`Downloaded ${saved}`, 'success');
        return;
    } catch (err) {
        if (!await canLoadAsImage(url)) {
            notify(`Download failed: ${err.message} — and the URL won't render as an image either. Check the link.`, 'error');
            return;
        }
        const link = await uiPrompt({
            title: 'That host blocks cross-origin downloads, but the image displays fine. Link to it instead of copying?',
            okText: 'Link it',
            withInput: false,
        });
        if (!link) return;
        const key = uniqueFilename(existing, `remote_${sanitizeFilename(base)}${ext}`);
        registerRemoteImage(bank.id, key, url);
        await openBank(bank.id, { force: true });
        notify(`Linked ${key} — the image stays on the remote host.`, 'success');
    }
}

async function importFromServerFolder() {
    const bank = await ensureBank();
    if (!bank) return;

    let folderList = [];
    try {
        const res = await fetch('/api/images/list', { headers: (() => { try { return ctx().getRequestHeaders?.() ?? {}; } catch { return {}; } })() });
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data)) folderList = data.filter(f => typeof f === 'string');
        }
    } catch {
        /* endpoint may not exist in this build — fall back to typing a name */
    }

    const hint = folderList.length ? `Known folders: ${folderList.slice(0, 8).join(', ')}` : 'Type an existing folder name, e.g. a character name.';
    const folder = await uiPrompt({ title: `Copy images from which folder? ${hint}`, value: '', okText: 'Copy' });
    if (!folder) return;

    let files;
    try {
        files = await listBankFiles(folder);
    } catch (err) {
        notify(`Could not list “${folder}”: ${err.message}`, 'error');
        return;
    }
    if (!files.length) {
        notify(`Folder “${folder}” has no images.`, 'error');
        return;
    }

    const existing = [...(state.files ?? [])];
    let added = 0;
    for (const source of files) {
        try {
            const file = await fetchUrlAsFile(userImageUrl(folder, source), source);
            const name = uniqueFilename(existing, sanitizeFilename(source));
            const saved = await uploadImage(bank.folder, file, name);  // <- captures the real name
            registerImage(bank.id, saved);
            existing.push(saved);                                     // <- was push(name)
            added++;
        } catch (err) {
            console.warn('[image-banks] copy failed', source, err);
        }
    }
    invalidateBankFiles(bank.folder);
    await openBank(bank.id, { force: true });
    notify(added ? `Copied ${added} image(s) into “${bank.name}”.` : 'Nothing copied.', added ? 'success' : 'error');
}
