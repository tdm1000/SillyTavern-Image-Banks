// Thin wrappers over SillyTavern's user-image endpoints, plus a short-lived
// file-list cache shared by the runtime layer and the UI.

import { ctx } from './settings.js';
import { getStore, saveStore } from './store.js';

/**
 * Static mount for the per-user data directory. A file at
 *   data/<user>/user/images/<folder>/<file>
 * is served at /user/images/<folder>/<file>.
 * If your build differs, this is the one constant to change.
 */
export const USER_IMAGE_PREFIX = '/user/images/';

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.svg'];

export function isImageFile(name) {
    const lower = String(name ?? '').toLowerCase();
    return IMAGE_EXT.some(ext => lower.endsWith(ext));
}

export function userImageUrl(folder, file) {
    return `${USER_IMAGE_PREFIX}${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
}

/**
 * ST's getRequestHeaders() sends `Content-Type: application/json` by default.
 * That must not ride along with a FormData body: the browser then skips the
 * multipart boundary, multer can't parse the request, and every upload 400s.
 * Current builds accept `{ omitContentType: true }`; the delete loop covers
 * older ones that ignore the argument.
 */
function requestHeaders({ json = false, multipart = false } = {}) {
    let headers = {};
    try {
        headers = { ...(ctx().getRequestHeaders?.({ omitContentType: multipart }) ?? {}) };
    } catch (err) {
        console.warn('[image-banks] getRequestHeaders failed', err);
    }
    if (multipart) {
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === 'content-type') delete headers[key];
        }
    }
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
}

/** Strip anything that would make a filename awkward on disk. */
export function sanitizeFilename(name) {
    const trimmed = String(name ?? '').split(/[\\/]/).pop() ?? '';
    const cleaned = trimmed
        .replace(/[^\p{L}\p{N}._-]+/gu, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^[._]+/, '')
        .slice(0, 96);
    return cleaned || `image_${Date.now()}`;
}

/** name.png -> name_2.png when name.png is already present. */
export function uniqueFilename(existing, filename) {
    const taken = new Set((existing ?? []).map(f => f.toLowerCase()));
    if (!taken.has(filename.toLowerCase())) return filename;
    const dot = filename.lastIndexOf('.');
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';
    for (let i = 2; i < 2000; i++) {
        const candidate = `${base}_${i}${ext}`;
        if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${base}_${Date.now()}${ext}`;
}

export async function listBankFiles(folder) {
    const res = await fetch(`/api/images/list/${encodeURIComponent(folder)}`, {
        method: 'GET',
        headers: requestHeaders(),
    });
    if (res.status === 404) return []; // folder doesn't exist yet
    if (!res.ok) throw new Error(`list ${folder}: HTTP ${res.status}`);
    const data = await res.json().catch(() => []);
    if (!Array.isArray(data)) return [];
    return data.filter(f => typeof f === 'string' && isImageFile(f) && !f.startsWith('.'));
}

const fileCache = new Map(); // folder -> { files, ts }

export async function getBankFiles(bank, { force = false, ttl = 30_000 } = {}) {
    if (!bank) return [];
    const cached = fileCache.get(bank.folder);
    if (!force && cached && Date.now() - cached.ts < ttl) return cached.files;

    let serverFiles = [];
    try {
        serverFiles = await listBankFiles(bank.folder);
    } catch (err) {
        console.warn('[image-banks] list failed:', err.message ?? err);
    }

    const meta = getStore().banks[bank.id];
    const known = Object.keys(meta?.images ?? {});

    // Union, never intersect. The store is our record of what we uploaded and
    // deleted; the server list is reconciliation for files added by hand.
    const files = [...new Set([...serverFiles, ...known])].sort((a, b) => a.localeCompare(b));

    if (meta) {
        meta.images ??= {};
        let changed = false;
        for (const file of files) {
            if (!meta.images[file]) {
                meta.images[file] = { tags: [], addedAt: Date.now() };
                changed = true;
            }
        }
        if (changed) saveStore();
    }

    fileCache.set(bank.folder, { files, ts: Date.now() });
    return files;
}

export function invalidateBankFiles(folder = null) {
    if (folder) {
        fileCache.delete(folder);
    } else {
        fileCache.clear();
    }
}

const FORMAT_BY_EXT = {
    png: 'png',
    jpg: 'jpg',
    jpeg: 'jpeg',
    jfif: 'jpeg',
    gif: 'gif',
    webp: 'webp',
    avif: 'avif',
    bmp: 'bmp',
    svg: 'svg',
};

function formatFromName(name) {
    const ext = String(name ?? '').match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    return ext ? (FORMAT_BY_EXT[ext] ?? ext) : null;
}

function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
        reader.readAsDataURL(file);
    });
}

/** The endpoint wants bare base64; FileReader gives us a full data URL. */
function stripDataUrlPrefix(dataUrl) {
    const comma = dataUrl.indexOf(',');
    return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/** Flatten to PNG via canvas — used only when the server rejects the source format. */
async function transcodeToPng(file) {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) return null;
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

function postImage(payload) {
    return fetch('/api/images/upload', {
        method: 'POST',
        headers: requestHeaders({ json: true }), // JSON this time — no FormData anywhere
        body: JSON.stringify(payload),
    });
}

export async function uploadImage(folder, file, filename) {
    let name = filename;
    let format = formatFromName(filename) ?? formatFromName(file?.name) ?? 'png';
    let image;

    try {
        image = stripDataUrlPrefix(await readAsDataUrl(file));
    } catch (err) {
        throw new Error(`upload ${filename} failed: could not read the file (${err.message})`);
    }

    let res = await postImage({ image, format, ch_name: folder, filename: name });
    let detail = res.ok ? '' : (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);

    // MEDIA_EXTENSIONS may not cover every format we accept; convert and retry once.
    if (!res.ok && /invalid image format/i.test(detail)) {
        const png = await transcodeToPng(file);
        if (png) {
            name = `${String(name).replace(/\.[a-z0-9]+$/i, '')}.png`;
            format = 'png';
            image = stripDataUrlPrefix(await readAsDataUrl(png));
            res = await postImage({ image, format, ch_name: folder, filename: name });
            detail = res.ok ? '' : (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
        }
    }

    if (!res.ok) {
        throw new Error(
            `upload ${filename} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''} `
            + `[sent format "${format}", ${image.length} base64 chars]`,
        );
    }
    return name; // may differ from the input if we converted to PNG
}

export async function deleteImage(folder, filename) {
    const res = await fetch('/api/images/delete', {
        method: 'POST',
        headers: requestHeaders({ json: true }),
        body: JSON.stringify({ path: `user/images/${folder}/${filename}` }),
    });
    if (!res.ok) throw new Error(`delete ${filename}: HTTP ${res.status}`);
}

export async function fetchUrlAsFile(url, fallbackName = 'image') {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) {
        throw new Error(`not an image (${blob.type || 'unknown type'})`);
    }
    const extByType = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/avif': '.avif',
        'image/bmp': '.bmp',
        'image/svg+xml': '.svg',
    };
    const urlExt = String(url).match(/\.(png|jpe?g|gif|webp|avif|bmp|svg)(?=[?#]|$)/i)?.[0] ?? '';
    const ext = extByType[blob.type] ?? urlExt ?? '.png';
    const base = sanitizeFilename(fallbackName).replace(/\.[a-z0-9]+$/i, '') || 'image';
    return new File([blob], `${base}${ext}`, { type: blob.type || 'image/png' });
}
