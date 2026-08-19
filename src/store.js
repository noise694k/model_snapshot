/**
 * store.js — 데이터 계층
 *
 * 엔티티 구조
 *   provider : { id, alias, hosts[], priceUrl, links[], status, memo, pending, createdAt }
 *   model    : { id, alias, vendor, raws[], memo, pending, createdAt }
 *   card     : { id, cardKey, providerId, modelId, postProcessing, presetName,
 *                star, rating, memo, createdAt, updatedAt }
 *   snapshot : { id, cardId, ts, params, labels[], memo, ctx{}, createdAt }
 *
 * 카드 키는 "약칭"이 아니라 "엔티티 ID"로 만든다.
 * → 나중에 약칭을 바꿔도 기존 카드가 갈라지거나 합쳐지지 않는다.
 */

import {
    STORES, dbGetAll, dbPut, dbPutMany, dbDelete, uid, diag,
} from './core.js';
import { mergeLabels } from './labels.js';

// ── 메모리 캐시 (읽기는 캐시에서, 쓰기는 DB + 캐시 동시 갱신) ──
const cache = {
    providers: new Map(),
    models: new Map(),
    cards: new Map(),
    snapshots: new Map(),
    labelRows: [],
    loaded: false,
};

export async function loadAll() {
    const [providers, models, cards, snapshots, labelRows] = await Promise.all([
        dbGetAll(STORES.providers),
        dbGetAll(STORES.models),
        dbGetAll(STORES.cards),
        dbGetAll(STORES.snapshots),
        dbGetAll(STORES.labels),
    ]);
    cache.providers = new Map(providers.map(p => [p.id, p]));
    cache.models = new Map(models.map(m => [m.id, m]));
    cache.cards = new Map(cards.map(c => [c.id, c]));
    cache.snapshots = new Map(snapshots.map(s => [s.id, s]));
    cache.labelRows = labelRows;
    cache.loaded = true;
    diag('info', `데이터 로드 완료: 카드 ${cards.length} / 스냅샷 ${snapshots.length}`);
    return cache;
}


export function allProviders() { return [...cache.providers.values()]; }
export function allModels() { return [...cache.models.values()]; }
export function allCards() { return [...cache.cards.values()]; }
export function allSnapshots() { return [...cache.snapshots.values()]; }
export function getProvider(id) { return cache.providers.get(id) ?? null; }
export function getModel(id) { return cache.models.get(id) ?? null; }
export function getCard(id) { return cache.cards.get(id) ?? null; }
export function getSnapshot(id) { return cache.snapshots.get(id) ?? null; }

export function getLabels() { return mergeLabels(cache.labelRows); }
export function getLabelMap() {
    const m = new Map();
    for (const l of getLabels()) m.set(l.id, l);
    return m;
}
export function rawLabelRows() { return cache.labelRows.slice(); }

// ────────────────────────────────────────────────────────────
// 프로바이더
// ────────────────────────────────────────────────────────────
export function findProviderByEndpoint(endpoint) {
    const key = String(endpoint ?? '').trim().toLowerCase();
    if (!key) return null;
    for (const p of cache.providers.values()) {
        if ((p.hosts ?? []).some(h => String(h).toLowerCase() === key)) return p;
    }
    return null;
}

export async function createProvider({ alias, endpoint, pending = false }) {
    const p = {
        id: uid('prv'),
        alias: alias || endpoint || '(미등록)',
        hosts: endpoint ? [endpoint] : [],
        priceUrl: '',
        links: [],
        status: 'ok',
        memo: '',
        pending: !!pending,
        createdAt: Date.now(),
    };
    await dbPut(STORES.providers, p);
    cache.providers.set(p.id, p);
    return p;
}

export async function updateProvider(id, patch) {
    const cur = cache.providers.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id };
    await dbPut(STORES.providers, next);
    cache.providers.set(id, next);
    return next;
}

/**
 * 엔드포인트 목록을 통째로 교체한다.
 * 같은 엔드포인트가 다른 프로바이더에 이미 등록돼 있으면 조회가 모호해지므로 거부한다.
 * @returns {{ok:boolean, error?:string}}
 */
export async function setProviderHosts(id, hosts) {
    const cur = cache.providers.get(id);
    if (!cur) return { ok: false, error: '프로바이더를 찾을 수 없습니다.' };
    const clean = [...new Set(hosts.map(h => String(h).trim()).filter(Boolean))];
    for (const h of clean) {
        const owner = findProviderByEndpoint(h);
        if (owner && owner.id !== id) {
            return { ok: false, error: `"${h}" 는 이미 "${owner.alias}" 에 등록되어 있습니다.` };
        }
    }
    await updateProvider(id, { hosts: clean });
    return { ok: true };
}

// ────────────────────────────────────────────────────────────
// 모델
// ────────────────────────────────────────────────────────────
export function findModelByRaw(raw) {
    const key = String(raw ?? '').trim();
    if (!key) return null;
    for (const m of cache.models.values()) {
        if ((m.raws ?? []).some(r => String(r) === key)) return m;
    }
    return null;
}

export async function createModel({ alias, vendor, raw, pending = false }) {
    const m = {
        id: uid('mdl'),
        alias: alias || raw || '(미등록)',
        vendor: vendor || '',
        raws: raw ? [raw] : [],
        memo: '',
        pending: !!pending,
        createdAt: Date.now(),
    };
    await dbPut(STORES.models, m);
    cache.models.set(m.id, m);
    return m;
}

export async function updateModel(id, patch) {
    const cur = cache.models.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id };
    await dbPut(STORES.models, next);
    cache.models.set(id, next);
    return next;
}

/**
 * 모델 문자열 목록을 통째로 교체한다.
 * 같은 문자열이 다른 모델에 등록돼 있으면 거부한다.
 * @returns {{ok:boolean, error?:string}}
 */
export async function setModelRaws(id, raws) {
    const cur = cache.models.get(id);
    if (!cur) return { ok: false, error: '모델을 찾을 수 없습니다.' };
    const clean = [...new Set(raws.map(r => String(r).trim()).filter(Boolean))];
    for (const r of clean) {
        const owner = findModelByRaw(r);
        if (owner && owner.id !== id) {
            return { ok: false, error: `"${r}" 는 이미 "${owner.alias}" 에 등록되어 있습니다.` };
        }
    }
    await updateModel(id, { raws: clean });
    return { ok: true };
}

// ────────────────────────────────────────────────────────────
// 카드
// ────────────────────────────────────────────────────────────
export function makeCardKey(providerId, modelId, postProcessing, presetName) {
    return [
        providerId ?? '-',
        modelId ?? '-',
        postProcessing ?? '-',
        presetName ?? '-',
    ].join('\u0001');
}

export function findCardByKey(key) {
    for (const c of cache.cards.values()) {
        if (c.cardKey === key) return c;
    }
    return null;
}

export async function createCard({ providerId, modelId, postProcessing, presetName }) {
    const cardKey = makeCardKey(providerId, modelId, postProcessing, presetName);
    const existing = findCardByKey(cardKey);
    if (existing) { existing.__isNew = false; return existing; }
    const c = {
        id: uid('crd'),
        cardKey,
        providerId,
        modelId,
        postProcessing: postProcessing ?? null,
        presetName: presetName ?? null,
        star: false,
        rating: 0,
        memo: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    await dbPut(STORES.cards, c);
    cache.cards.set(c.id, c);
    // 호출부가 "방금 만들어진 카드"인지 알 수 있도록 표시 (저장되는 값은 아님)
    Object.defineProperty(c, '__isNew', { value: true, enumerable: false, configurable: true });
    return c;
}

export async function updateCard(id, patch) {
    const cur = cache.cards.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id, updatedAt: Date.now() };
    // providerId/modelId/postProcessing/presetName 이 바뀌면 cardKey 재계산
    next.cardKey = makeCardKey(next.providerId, next.modelId, next.postProcessing, next.presetName);
    await dbPut(STORES.cards, next);
    cache.cards.set(id, next);
    return next;
}

/**
 * 카드 삭제. 소속 스냅샷도 함께 삭제된다.
 * (사용자 확정: 스냅샷을 모두 지워도 카드는 "샷 없음" 상태로 남는다 → 카드 삭제는 명시적으로만)
 */
export async function deleteCard(id) {
    const snaps = snapshotsOfCard(id);
    for (const s of snaps) {
        await dbDelete(STORES.snapshots, s.id);
        cache.snapshots.delete(s.id);
    }
    await dbDelete(STORES.cards, id);
    cache.cards.delete(id);
    return snaps.length;
}

// ────────────────────────────────────────────────────────────
// 스냅샷
// ────────────────────────────────────────────────────────────
export function snapshotsOfCard(cardId) {
    const out = [];
    for (const s of cache.snapshots.values()) {
        if (s.cardId === cardId) out.push(s);
    }
    out.sort((a, b) => b.ts - a.ts);
    return out;
}

export async function createSnapshot({ cardId, params, labels, memo, ctx }) {
    const s = {
        id: uid('snp'),
        cardId,
        ts: Date.now(),
        params: params ?? null,
        labels: labels ?? [],
        memo: memo ?? '',
        ctx: ctx ?? {},
        createdAt: Date.now(),
    };
    await dbPut(STORES.snapshots, s);
    cache.snapshots.set(s.id, s);
    const card = cache.cards.get(cardId);
    if (card) await updateCard(cardId, {});
    return s;
}

export async function updateSnapshot(id, patch) {
    const cur = cache.snapshots.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id, cardId: cur.cardId };
    await dbPut(STORES.snapshots, next);
    cache.snapshots.set(id, next);
    return next;
}

/** 스냅샷 삭제 — 카드는 절대 같이 지우지 않는다. (사용자 확정 Q6) */
export async function deleteSnapshot(id) {
    const cur = cache.snapshots.get(id);
    if (!cur) return false;
    await dbDelete(STORES.snapshots, id);
    cache.snapshots.delete(id);
    return true;
}

// ────────────────────────────────────────────────────────────
// 엔티티 참조 조회 / 삭제
// ────────────────────────────────────────────────────────────
export function cardsUsingProvider(id) {
    return allCards().filter(c => c.providerId === id);
}

export function cardsUsingModel(id) {
    return allCards().filter(c => c.modelId === id);
}

/**
 * 프로바이더 삭제. 이 프로바이더를 쓰는 카드가 하나라도 있으면 거부한다.
 * (기록이 "프로바이더 미등록" 상태로 깨지는 것을 막기 위함)
 */
export async function deleteProvider(id) {
    const used = cardsUsingProvider(id);
    if (used.length) {
        return { ok: false, error: `이 프로바이더를 쓰는 카드가 ${used.length}개 있습니다. 카드를 먼저 삭제해주세요.` };
    }
    await dbDelete(STORES.providers, id);
    cache.providers.delete(id);
    return { ok: true };
}

/** 모델 삭제. 이 모델을 쓰는 카드가 있으면 거부한다. */
export async function deleteModel(id) {
    const used = cardsUsingModel(id);
    if (used.length) {
        return { ok: false, error: `이 모델을 쓰는 카드가 ${used.length}개 있습니다. 카드를 먼저 삭제해주세요.` };
    }
    await dbDelete(STORES.models, id);
    cache.models.delete(id);
    return { ok: true };
}

// ────────────────────────────────────────────────────────────
// 라벨 (커스텀/오버라이드)
// ────────────────────────────────────────────────────────────
export async function upsertLabelRow(row) {
    const r = { ...row };
    if (!r.id) r.id = uid('lbl');
    await dbPut(STORES.labels, r);
    const idx = cache.labelRows.findIndex(x => x.id === r.id);
    if (idx >= 0) cache.labelRows[idx] = r;
    else cache.labelRows.push(r);
    return r;
}

export async function deleteLabelRow(id) {
    await dbDelete(STORES.labels, id);
    cache.labelRows = cache.labelRows.filter(x => x.id !== id);
    return true;
}

/** 라벨 사용 횟수 */
export function labelUsageCounts() {
    const counts = new Map();
    for (const s of cache.snapshots.values()) {
        for (const e of (s.labels ?? [])) {
            counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
        }
    }
    return counts;
}

// ────────────────────────────────────────────────────────────
// 미등록(pending) 항목
// ────────────────────────────────────────────────────────────
export function pendingEntities() {
    return {
        providers: allProviders().filter(p => p.pending),
        models: allModels().filter(m => m.pending),
    };
}

// ────────────────────────────────────────────────────────────
// 대량 교체 (import / 전체 삭제용)
// ────────────────────────────────────────────────────────────
export async function bulkPut(storeName, rows) {
    await dbPutMany(storeName, rows);
    const target = {
        [STORES.providers]: cache.providers,
        [STORES.models]: cache.models,
        [STORES.cards]: cache.cards,
        [STORES.snapshots]: cache.snapshots,
    }[storeName];
    if (target) for (const r of rows) target.set(r.id, r);
    if (storeName === STORES.labels) {
        for (const r of rows) {
            const idx = cache.labelRows.findIndex(x => x.id === r.id);
            if (idx >= 0) cache.labelRows[idx] = r; else cache.labelRows.push(r);
        }
    }
}

export function resetCache() {
    cache.providers.clear();
    cache.models.clear();
    cache.cards.clear();
    cache.snapshots.clear();
    cache.labelRows = [];
}
