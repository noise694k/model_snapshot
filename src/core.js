/**
 * core.js — IndexedDB 래퍼, 유틸리티, 확장 설정, 진단 로그
 *
 * 설계 원칙:
 *  - SillyTavern 의 settings.json 을 절대 건드리지 않는다. (saveSettingsDebounced 호출 없음)
 *  - 모든 데이터는 IndexedDB 에만 저장한다.
 *  - 어떤 경우에도 SillyTavern 의 원본 데이터를 쓰지 않는다. (읽기 전용)
 */

export const EXT_ID = 'st-model-snapshot';
export const DB_NAME = 'ModelSnapshotDB';
export const DB_VERSION = 1;
export const SCHEMA_VERSION = 1;

export const STORES = {
    meta: 'meta',
    providers: 'providers',
    models: 'models',
    cards: 'cards',
    snapshots: 'snapshots',
    labels: 'labels',
};

// ────────────────────────────────────────────────────────────
// 진단 로그 (모바일에서 F12 없이 확인 가능)
// ────────────────────────────────────────────────────────────
const DIAG_MAX = 200;
const diagLog = [];

export function diag(level, msg, extra) {
    const entry = {
        t: Date.now(),
        level,
        msg: String(msg),
        extra: extra === undefined ? null : safeStringify(extra),
    };
    diagLog.push(entry);
    if (diagLog.length > DIAG_MAX) diagLog.shift();
    if (level === 'error') console.error(`[ModelSnapshot] ${msg}`, extra ?? '');
}

export function getDiagLog() {
    return diagLog.slice();
}

export function clearDiagLog() {
    diagLog.length = 0;
}

function safeStringify(v) {
    try {
        return typeof v === 'string' ? v : JSON.stringify(v);
    } catch {
        return '[stringify 실패]';
    }
}

// ────────────────────────────────────────────────────────────
// 유틸
// ────────────────────────────────────────────────────────────

/** 짧은 고유 ID */
export function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * FNV-1a 기반 16자 hex 해시.
 * 메시지 "본문"을 저장하지 않고 지문만 남기기 위한 용도.
 * 역산으로 원문을 복원할 수 없다.
 */
export function shortHash(str) {
    const s = String(str ?? '');
    let h1 = 0x811c9dc5 >>> 0;
    let h2 = 0x01000193 >>> 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 ^= c;
        h1 = Math.imul(h1, 0x01000193) >>> 0;
        h2 = (h2 + c) >>> 0;
        h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
        h2 ^= h2 >>> 13;
    }
    return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 16);
}

/** 해시 비교용 본문 정규화 (공백/개행 차이 무시) */
export function normalizeText(str) {
    return String(str ?? '').replace(/\s+/g, ' ').trim();
}

export function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * href 에 넣어도 안전한 URL 인지 확인한다.
 * escapeHtml 은 속성 탈출만 막을 뿐 javascript: 같은 스킴은 막지 못하므로,
 * 렌더 직전에 한 번 더 거른다. (남이 공유한 JSON을 가져왔을 때를 대비)
 * @returns {string} 안전하면 원본, 아니면 빈 문자열
 */
export function safeUrl(url) {
    const raw = String(url ?? '').trim();
    if (!raw) return '';
    // 제어문자/공백을 끼워넣어 스킴을 숨기는 우회를 차단
    const flat = raw.replace(/[\u0000-\u0020]/g, '').toLowerCase();
    if (!/^https?:\/\//.test(flat)) return '';
    return raw;
}

export function fmtDate(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDateShort(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${String(d.getFullYear()).slice(2)}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

/** 이벤트 대기 + 타임아웃 (blind sleep 대신 사용) */
export function waitForEvent(eventSource, eventName, timeoutMs = 3000) {
    return new Promise((resolve) => {
        let done = false;
        const handler = () => {
            if (done) return;
            done = true;
            cleanup();
            resolve(true);
        };
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            cleanup();
            resolve(false);
        }, timeoutMs);
        function cleanup() {
            clearTimeout(timer);
            try { eventSource?.removeListener?.(eventName, handler); } catch { /* noop */ }
        }
        try {
            eventSource?.once?.(eventName, handler);
        } catch (e) {
            clearTimeout(timer);
            resolve(false);
        }
    });
}

// ────────────────────────────────────────────────────────────
// 표면(surface) 처리 — 배경 불투명화 & 고정 위치 검증
// ────────────────────────────────────────────────────────────

/** 현재 테마가 어두운지 판정 (본문 글자색의 밝기로) */
export function isDarkTheme() {
    try {
        if (typeof getComputedStyle !== 'function') return true;
        const c = getComputedStyle(document.body).color || 'rgb(220,220,220)';
        const m = c.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (!m) return true;
        const lum = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
        return lum > 0.5; // 글자가 밝다 = 어두운 테마
    } catch {
        return true;
    }
}

/**
 * 패널/모달에 불투명 배경을 입힌다.
 * --SmartThemeBlurTintColor 는 알파가 낮아 단독으로 쓰면 뒤가 비쳐 보이므로,
 * 불투명 기준색 위에 테마 틴트를 겹쳐 올린다.
 */
export function applySurface(el) {
    try {
        const base = isDarkTheme() ? '#17181c' : '#f3f3f6';
        el.style.backgroundColor = base;
        el.style.backgroundImage =
            'linear-gradient(var(--SmartThemeBlurTintColor, transparent), var(--SmartThemeBlurTintColor, transparent))';
    } catch (e) {
        diag('warn', '배경 적용 실패', e?.message);
    }
}

/** position:fixed 를 깨뜨리는 조상 요소를 찾는다 (transform/filter/contain 등) */
export function findFixedBreakers(startEl) {
    const bad = [];
    try {
        if (typeof getComputedStyle !== 'function') return bad;
        let node = startEl;
        while (node && node !== document.documentElement) {
            const cs = getComputedStyle(node);
            const reasons = [];
            if (cs.transform && cs.transform !== 'none') reasons.push(`transform:${cs.transform.slice(0, 28)}`);
            if (cs.filter && cs.filter !== 'none') reasons.push(`filter:${cs.filter.slice(0, 28)}`);
            if (cs.backdropFilter && cs.backdropFilter !== 'none') reasons.push('backdrop-filter');
            if (cs.perspective && cs.perspective !== 'none') reasons.push('perspective');
            if (cs.contain && /paint|layout|strict|content/.test(cs.contain)) reasons.push(`contain:${cs.contain}`);
            if (cs.willChange && /transform|filter|perspective/.test(cs.willChange)) reasons.push(`will-change:${cs.willChange}`);
            if (reasons.length) {
                bad.push({
                    tag: node.tagName.toLowerCase(),
                    id: node.id || '',
                    cls: (node.className && typeof node.className === 'string') ? node.className.slice(0, 40) : '',
                    reasons,
                });
            }
            node = node.parentElement;
        }
    } catch { /* noop */ }
    return bad;
}

/** 전체화면을 덮어야 하는 요소를 어디에 붙일지 고른다 */
export function overlayHost() {
    const breakers = findFixedBreakers(document.body);
    if (breakers.length) {
        diag('warn', 'body 계통에 fixed 를 깨는 스타일이 있어 html 에 직접 부착합니다', breakers.map(b => `${b.tag}#${b.id}`).join(','));
        return document.documentElement;
    }
    return document.body;
}

/**
 * 마운트 후 실제 위치를 재서, 뷰포트를 못 덮고 있으면 인라인으로 강제 교정한다.
 * @returns {{ok:boolean, rect:object, vw:number, vh:number, fixedApplied:string}}
 */
export function verifyOverlay(el, { fullWidth = true } = {}) {
    try {
        return verifyOverlayInner(el, { fullWidth });
    } catch (e) {
        // 위치 검증은 어디까지나 보조 기능이다. 실패해도 본 기능을 막지 않는다.
        diag('warn', '위치 검증 중 오류 (무시하고 계속)', e?.message);
        return { ok: null, rect: null, vw: 0, vh: 0, fixedApplied: 'unknown' };
    }
}

function verifyOverlayInner(el, { fullWidth = true } = {}) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const measure = () => {
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
    };
    let rect = measure();
    // 레이아웃이 아직 계산되지 않은 환경(크기 0)에서는 판정 자체가 의미 없다.
    if (rect.width === 0 && rect.height === 0) {
        return { ok: null, rect, vw, vh, fixedApplied: 'unmeasured' };
    }
    const good = (r) => Math.abs(r.top) <= 2 && Math.abs(r.height - vh) <= 6 && (!fullWidth || Math.abs(r.width - vw) <= 6);

    if (!good(rect)) {
        // 1차 교정: 인라인으로 확정값 지정
        el.style.setProperty('position', 'fixed', 'important');
        el.style.setProperty('top', '0px', 'important');
        el.style.setProperty('height', `${vh}px`, 'important');
        if (fullWidth) {
            el.style.setProperty('left', '0px', 'important');
            el.style.setProperty('width', `${vw}px`, 'important');
        }
        rect = measure();
    }

    if (!good(rect) && el.parentElement !== document.documentElement) {
        // 2차 교정: 조상 containing block 회피
        document.documentElement.appendChild(el);
        rect = measure();
    }

    const ok = good(rect);
    if (!ok) diag('error', 'UI 오버레이 위치 교정 실패', { rect, vw, vh });
    const pos = (typeof getComputedStyle === 'function') ? getComputedStyle(el).position : 'unknown';
    return { ok, rect, vw, vh, fixedApplied: pos };
}

// ────────────────────────────────────────────────────────────
// IndexedDB
// ────────────────────────────────────────────────────────────
let _dbPromise = null;

export function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
        let req;
        try {
            req = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (e) {
            diag('error', 'IndexedDB open 실패 (indexedDB 사용 불가)', e?.message);
            reject(e);
            return;
        }
        req.onupgradeneeded = (ev) => {
            const db = ev.target.result;
            if (!db.objectStoreNames.contains(STORES.meta)) {
                db.createObjectStore(STORES.meta, { keyPath: 'key' });
            }
            if (!db.objectStoreNames.contains(STORES.providers)) {
                db.createObjectStore(STORES.providers, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(STORES.models)) {
                db.createObjectStore(STORES.models, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(STORES.cards)) {
                db.createObjectStore(STORES.cards, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(STORES.snapshots)) {
                db.createObjectStore(STORES.snapshots, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(STORES.labels)) {
                db.createObjectStore(STORES.labels, { keyPath: 'id' });
            }
            diag('info', 'IndexedDB 스키마 생성/업그레이드 완료');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
            diag('error', 'IndexedDB open 오류', req.error?.message);
            reject(req.error);
        };
        req.onblocked = () => diag('warn', 'IndexedDB가 다른 탭에 의해 잠김 (다른 탭을 닫아주세요)');
    });
    return _dbPromise;
}

function tx(db, storeNames, mode) {
    return db.transaction(storeNames, mode);
}

export async function dbGet(store, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const r = tx(db, [store], 'readonly').objectStore(store).get(key);
        r.onsuccess = () => resolve(r.result ?? null);
        r.onerror = () => reject(r.error);
    });
}

export async function dbGetAll(store) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const r = tx(db, [store], 'readonly').objectStore(store).getAll();
        r.onsuccess = () => resolve(r.result ?? []);
        r.onerror = () => reject(r.error);
    });
}

export async function dbPut(store, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const t = tx(db, [store], 'readwrite');
        t.objectStore(store).put(value);
        t.oncomplete = () => resolve(value);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
    });
}

export async function dbPutMany(store, values) {
    if (!values?.length) return 0;
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const t = tx(db, [store], 'readwrite');
        const os = t.objectStore(store);
        for (const v of values) os.put(v);
        t.oncomplete = () => resolve(values.length);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
    });
}

export async function dbDelete(store, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const t = tx(db, [store], 'readwrite');
        t.objectStore(store).delete(key);
        t.oncomplete = () => resolve(true);
        t.onerror = () => reject(t.error);
    });
}

export async function dbClearStore(store) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const t = tx(db, [store], 'readwrite');
        t.objectStore(store).clear();
        t.oncomplete = () => resolve(true);
        t.onerror = () => reject(t.error);
    });
}

// ────────────────────────────────────────────────────────────
// 확장 설정 (settings.json 이 아니라 IndexedDB meta 스토어에 보관)
// ────────────────────────────────────────────────────────────
export const DEFAULT_SETTINGS = {
    captureParams: true,          // 파라미터 캡처 on/off
    exportReminder: true,         // 7일 export 리마인더
    exportReminderDays: 7,
    lastExportAt: 0,
    confirmBeforeJump: true,      // 점프 전 확인 모달
    panelSide: 'right',
    schemaVersion: SCHEMA_VERSION,
};

let _settingsCache = null;

export async function loadSettings() {
    const row = await dbGet(STORES.meta, 'settings').catch(() => null);
    _settingsCache = { ...DEFAULT_SETTINGS, ...(row?.value ?? {}) };
    return _settingsCache;
}

export function getSettings() {
    return _settingsCache ?? { ...DEFAULT_SETTINGS };
}

export async function saveSettings(patch) {
    _settingsCache = { ...getSettings(), ...(patch ?? {}) };
    await dbPut(STORES.meta, { key: 'settings', value: _settingsCache });
    return _settingsCache;
}

// ────────────────────────────────────────────────────────────
// 저장소 지속성 / 사용량
// ────────────────────────────────────────────────────────────
export async function requestPersistence() {
    try {
        if (!navigator.storage?.persist) return { supported: false, persisted: false };
        const already = await navigator.storage.persisted();
        if (already) return { supported: true, persisted: true };
        const granted = await navigator.storage.persist();
        return { supported: true, persisted: !!granted };
    } catch (e) {
        diag('warn', 'persist 요청 실패', e?.message);
        return { supported: false, persisted: false };
    }
}

export async function getStorageEstimate() {
    try {
        if (!navigator.storage?.estimate) return null;
        const est = await navigator.storage.estimate();
        return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
    } catch {
        return null;
    }
}

export function fmtBytes(n) {
    if (!n && n !== 0) return '-';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
