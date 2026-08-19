/**
 * ui-panel.js — 메인 패널
 * 구조는 하나이고, 화면 폭에 따라 CSS 로만 사이드패널 ↔ 전체화면이 바뀐다.
 */

import {
    escapeHtml, safeUrl, fmtDate, fmtDateShort, fmtBytes, getSettings, saveSettings,
    getDiagLog, clearDiagLog, requestPersistence, getStorageEstimate, diag,
    applySurface, verifyOverlay, overlayHost, findFixedBreakers, isDarkTheme,
} from './core.js';
import * as store from './store.js';
import { LABEL_GROUPS, getGroupMeta, labelDisplay, isDefaultLabel } from './labels.js';
import { PARAM_FIELDS } from './capture.js';
import { modalAlert, modalConfirm, modalPrompt, modalCustom, toastMsg } from './ui-modal.js';
import { doShot, editSnapshot, renderLabelPicker, bindLabelPicker, readLabelPicker } from './ui-shot.js';
import { jumpToSnapshot, jumpSummaryHtml, JUMP_RESULT } from './jump.js';
import * as io from './io.js';

const PANEL_ID = 'msnap-panel';

const ui = {
    tab: 'cards',
    search: '',
    filter: {
        vendor: '',
        providerId: '',
        modelId: '',
        starOnly: false,
        labels: [],   // [{id, v?}]
        labelMode: 'and',
    },
    expanded: new Set(),
    diffPick: [],
    root: null,
};

// ────────────────────────────────────────────────────────────
// 패널 생성 / 열기 / 닫기
// ────────────────────────────────────────────────────────────
export function ensurePanel() {
    let el = document.getElementById(PANEL_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = PANEL_ID;
    el.className = 'msnap-panel';
    el.innerHTML = `
        <div class="msnap-head">
            <div class="msnap-head-title">📸 모델 스냅샷</div>
            <div class="msnap-head-actions">
                <button class="msnap-icon-btn" data-act="shot" title="지금 스냅샷">📸</button>
                <button class="msnap-icon-btn" data-act="close" title="닫기">✕</button>
            </div>
        </div>
        <div class="msnap-tabs">
            <button class="msnap-tab" data-tab="cards">카드</button>
            <button class="msnap-tab" data-tab="providers">프로바이더</button>
            <button class="msnap-tab" data-tab="labels">라벨</button>
            <button class="msnap-tab" data-tab="settings">설정</button>
        </div>
        <div class="msnap-body" data-el="body"></div>`;
    overlayHost().appendChild(el);
    applySurface(el);
    ui.root = el;
    bindPanelEvents(el);
    return el;
}

export function openPanel() {
    const el = ensurePanel();
    el.classList.add('open');
    applySurface(el);
    // 실제로 화면을 덮고 있는지 재서, 아니면 인라인으로 교정한다.
    lastOverlayCheck = verifyOverlay(el, { fullWidth: window.innerWidth <= 768 });
    render();
}

let lastOverlayCheck = null;

export function closePanel() {
    document.getElementById(PANEL_ID)?.classList.remove('open');
}

function bindPanelEvents(el) {
    el.addEventListener('click', onPanelClick);
    el.addEventListener('input', onPanelInput);
    el.addEventListener('change', onPanelChange);
}

function body() {
    return ui.root?.querySelector('[data-el="body"]');
}

// ────────────────────────────────────────────────────────────
// 렌더
// ────────────────────────────────────────────────────────────
export function render() {
    if (!ui.root) return;
    ui.root.querySelectorAll('.msnap-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === ui.tab);
    });
    const b = body();
    if (!b) return;
    const scroll = b.scrollTop;
    if (ui.tab === 'cards') b.innerHTML = renderCardsTab();
    else if (ui.tab === 'providers') b.innerHTML = renderProvidersTab();
    else if (ui.tab === 'labels') b.innerHTML = renderLabelsTab();
    else b.innerHTML = renderSettingsTab();
    b.scrollTop = scroll;

    if (ui.tab === 'cards') {
        const lp = b.querySelector('[data-el="filterLabels"]');
        if (lp) bindLabelPicker(lp);
    }
}

// ── 카드 탭 ──────────────────────────────────────────────────
function matchSearch(card, q) {
    if (!q) return true;
    const prov = store.getProvider(card.providerId);
    const mdl = store.getModel(card.modelId);
    const labelMap = store.getLabelMap();
    const parts = [
        prov?.alias, ...(prov?.hosts ?? []), prov?.memo, prov?.priceUrl,
        ...((prov?.links ?? []).flatMap(l => [l?.name, l?.url])),
        mdl?.alias, mdl?.vendor, ...(mdl?.raws ?? []), mdl?.memo,
        card.postProcessing, card.presetName, card.memo,
    ];
    for (const s of store.snapshotsOfCard(card.id)) {
        parts.push(s.memo, s.ctx?.charName, s.ctx?.chatFile, s.ctx?.chatName);
        for (const e of (s.labels ?? [])) parts.push(labelMap.get(e.id)?.name);
    }
    const hay = parts.filter(Boolean).join(' \u0001 ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(t => hay.includes(t));
}

function matchFilter(card) {
    const f = ui.filter;
    if (f.starOnly && !card.star) return false;
    if (f.providerId && card.providerId !== f.providerId) return false;
    if (f.modelId && card.modelId !== f.modelId) return false;
    if (f.vendor) {
        const mdl = store.getModel(card.modelId);
        if ((mdl?.vendor ?? '') !== f.vendor) return false;
    }
    if (f.labels.length) {
        const snaps = store.snapshotsOfCard(card.id);
        const has = (want) => snaps.some(s => (s.labels ?? []).some(e =>
            e.id === want.id && (want.v === undefined || e.v === want.v)));
        if (f.labelMode === 'and') {
            if (!f.labels.every(has)) return false;
        } else if (!f.labels.some(has)) return false;
    }
    return true;
}

function filteredCards() {
    return store.allCards()
        .filter(c => matchFilter(c) && matchSearch(c, ui.search))
        .sort((a, b) => {
            if (a.star !== b.star) return a.star ? -1 : 1;
            return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
        });
}

function renderCardsTab() {
    const cards = filteredCards();
    const total = store.allCards().length;
    const vendors = [...new Set(store.allModels().map(m => m.vendor).filter(Boolean))].sort();
    const provs = store.allProviders().slice().sort((a, b) => (a.alias ?? '').localeCompare(b.alias ?? ''));
    const mdls = store.allModels().slice().sort((a, b) => (a.alias ?? '').localeCompare(b.alias ?? ''));
    const f = ui.filter;
    const reminder = io.exportReminderDue()
        ? `<div class="msnap-banner">마지막 내보내기 이후 ${getSettings().exportReminderDays ?? 7}일이 지났습니다.
           <button class="msnap-linkbtn" data-act="go-settings">설정에서 내보내기</button></div>`
        : '';

    const diffBar = ui.diffPick.length
        ? `<div class="msnap-diffbar">비교 선택: ${ui.diffPick.length}/2
             <button class="msnap-btn msnap-btn-sm" data-act="diff-run" ${ui.diffPick.length !== 2 ? 'disabled' : ''}>비교</button>
             <button class="msnap-btn msnap-btn-sm" data-act="diff-clear">해제</button>
           </div>` : '';

    return `
    ${reminder}
    <div class="msnap-toolbar">
        <input type="search" class="msnap-input" data-el="search" value="${escapeHtml(ui.search)}" placeholder="검색 (약칭·모델명·메모·캐릭터·라벨…)">
        <button class="msnap-icon-btn ${isFilterActive() ? 'active' : ''}" data-act="toggle-filter" title="필터">⚙</button>
    </div>
    <div class="msnap-filterpane ${ui.filterOpen ? 'open' : ''}">
        <div class="msnap-row3">
            <select class="msnap-input" data-el="fVendor">
                <option value="">벤더 전체</option>
                ${vendors.map(v => `<option value="${escapeHtml(v)}" ${f.vendor === v ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}
            </select>
            <select class="msnap-input" data-el="fProvider">
                <option value="">프로바이더 전체</option>
                ${provs.map(p => `<option value="${escapeHtml(p.id)}" ${f.providerId === p.id ? 'selected' : ''}>${escapeHtml(p.alias)}</option>`).join('')}
            </select>
            <select class="msnap-input" data-el="fModel">
                <option value="">모델 전체</option>
                ${mdls.map(m => `<option value="${escapeHtml(m.id)}" ${f.modelId === m.id ? 'selected' : ''}>${escapeHtml(m.alias)}</option>`).join('')}
            </select>
        </div>
        <div class="msnap-row-inline">
            <label class="msnap-check"><input type="checkbox" data-el="fStar" ${f.starOnly ? 'checked' : ''}> 즐겨찾기만</label>
            <label class="msnap-check"><input type="radio" name="msnapLabelMode" value="and" data-el="fMode" ${f.labelMode === 'and' ? 'checked' : ''}> 모두 포함</label>
            <label class="msnap-check"><input type="radio" name="msnapLabelMode" value="or" data-el="fMode" ${f.labelMode === 'or' ? 'checked' : ''}> 하나라도</label>
            <button class="msnap-linkbtn" data-act="filter-reset">필터 초기화</button>
        </div>
        <div class="msnap-labels msnap-labels-sm" data-el="filterLabels">${renderLabelPicker(f.labels)}</div>
        <button class="msnap-btn msnap-btn-sm" data-act="filter-apply">라벨 필터 적용</button>
    </div>
    ${diffBar}
    <div class="msnap-count">${cards.length} / ${total} 카드</div>
    <div class="msnap-list">
        ${cards.length ? cards.map(renderCard).join('') : emptyState(total)}
    </div>`;
}

function emptyState(total) {
    if (!total) {
        return `<div class="msnap-empty">
            아직 스냅샷이 없습니다.<br>
            채팅 중에 마법봉 메뉴 → <b>📸 모델 스냅샷</b> → 상단 📸 버튼으로 지금 설정을 기록해보세요.
        </div>`;
    }
    return `<div class="msnap-empty">조건에 맞는 카드가 없습니다. 검색어나 필터를 바꿔보세요.</div>`;
}

function isFilterActive() {
    const f = ui.filter;
    return !!(f.vendor || f.providerId || f.modelId || f.starOnly || f.labels.length);
}

function renderCard(card) {
    const prov = store.getProvider(card.providerId);
    const mdl = store.getModel(card.modelId);
    const snaps = store.snapshotsOfCard(card.id);
    const open = ui.expanded.has(card.id);
    const statusBadge = prov && prov.status && prov.status !== 'ok'
        ? `<span class="msnap-badge msnap-badge-${escapeHtml(prov.status)}">${escapeHtml(io.statusText(prov.status))}</span>` : '';

    return `
    <div class="msnap-card ${open ? 'open' : ''}" data-card-id="${escapeHtml(card.id)}">
        <div class="msnap-card-head" data-act="toggle-card">
            <button class="msnap-star ${card.star ? 'on' : ''}" data-act="star" title="즐겨찾기">${card.star ? '★' : '☆'}</button>
            <div class="msnap-card-title">
                <div class="msnap-card-name">
                    ${escapeHtml(mdl?.alias ?? '(모델 미등록)')}
                    <span class="msnap-at">@</span>
                    ${escapeHtml(prov?.alias ?? '(프로바이더 미등록)')}
                    ${statusBadge}
                </div>
                <div class="msnap-card-sub">
                    ${mdl?.vendor ? `<span class="msnap-tag">${escapeHtml(mdl.vendor)}</span>` : ''}
                    <span class="msnap-tag">후처리 ${escapeHtml(card.postProcessing ?? '미설정')}</span>
                    <span class="msnap-tag">${escapeHtml(card.presetName ?? '프리셋?')}</span>
                </div>
            </div>
            <div class="msnap-card-right">
                <div class="msnap-rating" data-act="rating">${[1, 2, 3, 4, 5].map(n =>
                    `<span class="msnap-rstar ${n <= (card.rating ?? 0) ? 'on' : ''}" data-r="${n}">★</span>`).join('')}</div>
                <div class="msnap-snapcount ${snaps.length ? '' : 'zero'}">${snaps.length ? `샷 ${snaps.length}` : '샷 없음'}</div>
            </div>
        </div>
        ${open ? renderCardBody(card, snaps, prov) : ''}
    </div>`;
}

function renderCardBody(card, snaps, prov) {
    const priceHref = safeUrl(prov?.priceUrl);
    const priceLink = priceHref
        ? `<a class="msnap-linkbtn" href="${escapeHtml(priceHref)}" target="_blank" rel="noopener noreferrer">가격 페이지</a>` : '';
    return `
    <div class="msnap-card-body">
        <div class="msnap-card-actions">
            ${priceLink}
            <button class="msnap-linkbtn" data-act="card-memo">총평 편집</button>
            <button class="msnap-linkbtn" data-act="card-md">이 카드 MD</button>
            <button class="msnap-linkbtn danger" data-act="card-delete">카드 삭제</button>
        </div>
        ${card.memo ? `<div class="msnap-cardmemo">${escapeHtml(card.memo).replace(/\n/g, '<br>')}</div>` : ''}
        <div class="msnap-snaps">
            ${snaps.length ? snaps.map(s => renderSnapshot(s)).join('')
            : '<div class="msnap-empty-sm">이 카드에는 스냅샷이 없습니다.</div>'}
        </div>
    </div>`;
}

function renderSnapshot(s) {
    const labelMap = store.getLabelMap();
    const chips = (s.labels ?? []).map(e => {
        const def = labelMap.get(e.id);
        if (!def) return `<span class="msnap-schip missing">삭제된 라벨</span>`;
        const g = getGroupMeta(def.group);
        return `<span class="msnap-schip" style="--msnap-c:${g.color}">${escapeHtml(labelDisplay(def, e))}</span>`;
    }).join('');

    const hasMes = s.ctx?.mesId !== null && s.ctx?.mesId !== undefined;
    const ctxLine = [
        s.ctx?.charName ? escapeHtml(s.ctx.charName) : null,
        s.ctx?.chatFile ? escapeHtml(String(s.ctx.chatFile).replace(/\.jsonl$/, '')) : null,
    ].filter(Boolean).join(' · ');

    const picked = ui.diffPick.includes(s.id);

    return `
    <div class="msnap-snap ${picked ? 'picked' : ''}" data-snap-id="${escapeHtml(s.id)}">
        <div class="msnap-snap-head">
            <span class="msnap-snap-date">${escapeHtml(fmtDateShort(s.ts))}</span>
            ${ctxLine ? `<span class="msnap-snap-ctx">${ctxLine}</span>` : ''}
            ${hasMes ? `<button class="msnap-linkbtn" data-act="jump">#${s.ctx.mesId} 이동</button>` : ''}
        </div>
        ${chips ? `<div class="msnap-snap-labels">${chips}</div>` : ''}
        ${s.memo ? `<div class="msnap-snap-memo">${escapeHtml(s.memo).replace(/\n/g, '<br>')}</div>` : ''}
        <div class="msnap-snap-actions">
            ${s.params ? `<button class="msnap-mini" data-act="snap-params">⚙ 파라미터</button>` : ''}
            <button class="msnap-mini" data-act="snap-edit">편집</button>
            <button class="msnap-mini ${picked ? 'on' : ''}" data-act="snap-diff">${picked ? '비교해제' : '비교선택'}</button>
            <button class="msnap-mini danger" data-act="snap-delete">삭제</button>
        </div>
    </div>`;
}

// ── 프로바이더 탭 ────────────────────────────────────────────
function renderProvidersTab() {
    const provs = store.allProviders().slice().sort((a, b) => (a.alias ?? '').localeCompare(b.alias ?? ''));
    const models = store.allModels().slice().sort((a, b) => (a.alias ?? '').localeCompare(b.alias ?? ''));
    const pend = store.pendingEntities();
    const pendBox = (pend.providers.length || pend.models.length)
        ? `<div class="msnap-banner">약칭 미등록 항목이 있습니다 — 프로바이더 ${pend.providers.length}, 모델 ${pend.models.length}</div>`
        : '';

    return `
    ${pendBox}
    <div class="msnap-section-title">프로바이더 ${provs.length}</div>
    <div class="msnap-list">
    ${provs.length ? provs.map(p => `
        <div class="msnap-entity ${p.pending ? 'pending' : ''}" data-prov-id="${escapeHtml(p.id)}">
            <div class="msnap-entity-head">
                <b>${escapeHtml(p.alias)}</b>
                ${p.pending ? '<span class="msnap-badge msnap-badge-pending">미등록</span>' : ''}
                <span class="msnap-badge msnap-badge-${escapeHtml(p.status ?? 'ok')}">${escapeHtml(io.statusText(p.status ?? 'ok'))}</span>
            </div>
            <div class="msnap-entity-sub">${(p.hosts ?? []).map(h => escapeHtml(h)).join('<br>') || '(엔드포인트 없음)'}</div>
            ${safeUrl(p.priceUrl) ? `<a class="msnap-linkbtn" href="${escapeHtml(safeUrl(p.priceUrl))}" target="_blank" rel="noopener noreferrer">가격 페이지</a>` : ''}
            ${(p.links ?? []).map((l, i) => safeUrl(l?.url)
        ? `<a class="msnap-linkbtn" href="${escapeHtml(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.name || `링크${i + 1}`)}</a>` : '').join('')}
            ${p.memo ? `<div class="msnap-entity-memo">${escapeHtml(p.memo).replace(/\n/g, '<br>')}</div>` : ''}
            <div class="msnap-entity-actions">
                <span class="msnap-usage">카드 ${store.cardsUsingProvider(p.id).length}개</span>
                <button class="msnap-mini" data-act="prov-edit">편집</button>
                <button class="msnap-mini danger" data-act="prov-delete">삭제</button>
            </div>
        </div>`).join('') : '<div class="msnap-empty">등록된 프로바이더가 없습니다.</div>'}
    </div>

    <div class="msnap-section-title">모델 ${models.length}</div>
    <div class="msnap-list">
    ${models.length ? models.map(m => `
        <div class="msnap-entity ${m.pending ? 'pending' : ''}" data-model-id="${escapeHtml(m.id)}">
            <div class="msnap-entity-head">
                <b>${escapeHtml(m.alias)}</b>
                ${m.vendor ? `<span class="msnap-tag">${escapeHtml(m.vendor)}</span>` : ''}
                ${m.pending ? '<span class="msnap-badge msnap-badge-pending">미등록</span>' : ''}
            </div>
            <div class="msnap-entity-sub">${(m.raws ?? []).map(r => escapeHtml(r)).join('<br>') || '(모델명 없음)'}</div>
            ${m.memo ? `<div class="msnap-entity-memo">${escapeHtml(m.memo).replace(/\n/g, '<br>')}</div>` : ''}
            <div class="msnap-entity-actions">
                <span class="msnap-usage">카드 ${store.cardsUsingModel(m.id).length}개</span>
                <button class="msnap-mini" data-act="model-edit">편집</button>
                <button class="msnap-mini danger" data-act="model-delete">삭제</button>
            </div>
        </div>`).join('') : '<div class="msnap-empty">등록된 모델이 없습니다.</div>'}
    </div>`;
}

// ── 라벨 탭 ─────────────────────────────────────────────────
function renderLabelsTab() {
    const labels = store.getLabels();
    const counts = store.labelUsageCounts();
    // 라벨 탭에서는 비어 있는 그룹도 보여준다. (직접 라벨을 추가할 자리를 알 수 있도록)
    const groups = LABEL_GROUPS.map(g => ({ g, items: labels.filter(l => l.group === g.id) }));

    const hiddenCount = labels.filter(l => l.hidden).length;
    return `
    <div class="msnap-hint">
        <b>숨김</b>은 라벨을 지우지 않고, 스냅샷 찍을 때 뜨는 선택 목록에서만 빼는 기능입니다.
        안 쓰는 라벨이 많아 목록이 길어질 때 쓰세요. 이 화면에는 계속 보이며, <b>표시</b>를 누르면 언제든 되돌릴 수 있습니다.
        <br>이미 그 라벨이 붙은 스냅샷의 기록은 숨겨도 그대로 남습니다.
    </div>
    <div class="msnap-btnrow">
        <button class="msnap-btn msnap-btn-sm" data-act="label-add">＋ 커스텀 라벨 추가</button>
        ${hiddenCount ? `<button class="msnap-btn msnap-btn-sm" data-act="label-unhide-all">숨긴 라벨 ${hiddenCount}개 모두 표시</button>` : ''}
    </div>
    ${groups.map(({ g, items }) => `
        <div class="msnap-lgroup open" style="--msnap-c:${g.color}">
            <div class="msnap-lgroup-head static"><span class="msnap-dot"></span><span class="msnap-lgroup-name">${escapeHtml(g.name)}</span></div>
            <div class="msnap-lgroup-body vertical">
                ${items.length ? '' : '<div class="msnap-hint">라벨이 없습니다. 위의 “＋ 커스텀 라벨 추가”에서 이 그룹을 골라 직접 만들어 쓰세요.</div>'}
                ${items.map(l => `
                <div class="msnap-labelrow ${l.hidden ? 'hidden' : ''}" data-label-id="${escapeHtml(l.id)}">
                    <span class="msnap-chip on" style="--msnap-c:${g.color}">${escapeHtml(l.name)}${l.type === 'axis' ? ' 👍👎' : ''}</span>
                    ${l.hidden ? '<span class="msnap-hidden-badge">숨김</span>' : ''}
                    <span class="msnap-usage">${counts.get(l.id) ?? 0}회</span>
                    <button class="msnap-mini" data-act="label-toggle-hidden">${l.hidden ? '표시' : '숨김'}</button>
                    ${l.custom ? `<button class="msnap-mini" data-act="label-rename">이름</button>
                                  <button class="msnap-mini danger" data-act="label-delete">삭제</button>` : ''}
                </div>`).join('')}
            </div>
        </div>`).join('')}`;
}

// ── 설정 탭 ─────────────────────────────────────────────────
let storageInfo = { est: null, persist: null };

function renderSettingsTab() {
    const s = getSettings();
    const counts = {
        cards: store.allCards().length,
        snaps: store.allSnapshots().length,
        provs: store.allProviders().length,
        mdls: store.allModels().length,
    };
    const pend = store.pendingEntities();
    const est = storageInfo.est;
    const per = storageInfo.persist;

    return `
    <div class="msnap-section">
        <div class="msnap-section-title">동작</div>
        <label class="msnap-check"><input type="checkbox" data-el="setCapture" ${s.captureParams ? 'checked' : ''}> 파라미터 캡처 (온도·TopP·TopK·penalty·reasoning effort·verbosity)</label>
        <label class="msnap-check"><input type="checkbox" data-el="setJumpConfirm" ${s.confirmBeforeJump ? 'checked' : ''}> 메시지 이동 전 확인 모달 표시</label>
        <label class="msnap-check"><input type="checkbox" data-el="setReminder" ${s.exportReminder ? 'checked' : ''}> 내보내기 리마인더</label>
        <div class="msnap-field ${s.exportReminder ? '' : 'msnap-dim'}">
            <div class="msnap-label">리마인더 주기 (일)</div>
            <input type="number" class="msnap-input msnap-input-sm" data-el="setReminderDays" min="1" max="90" value="${s.exportReminderDays ?? 7}">
        </div>
    </div>

    <div class="msnap-section">
        <div class="msnap-section-title">데이터</div>
        <div class="msnap-kvlist">
            <div class="msnap-kv"><span>카드 / 스냅샷</span><b>${counts.cards} / ${counts.snaps}</b></div>
            <div class="msnap-kv"><span>프로바이더 / 모델</span><b>${counts.provs} / ${counts.mdls}</b></div>
            <div class="msnap-kv"><span>약칭 미등록</span><b>${pend.providers.length + pend.models.length}</b></div>
            <div class="msnap-kv"><span>마지막 내보내기</span><b>${s.lastExportAt ? escapeHtml(fmtDate(s.lastExportAt)) : '없음'}</b></div>
        </div>
        <div class="msnap-btnrow">
            <button class="msnap-btn msnap-btn-sm" data-act="export-json">JSON 내보내기</button>
            <button class="msnap-btn msnap-btn-sm" data-act="export-md">MD 내보내기</button>
            <button class="msnap-btn msnap-btn-sm" data-act="import-json">가져오기</button>
        </div>
        <div class="msnap-hint">내보내기 파일에는 엔드포인트 URL이 포함됩니다. API 키·프록시 비밀번호는 저장하지도, 내보내지도 않습니다.</div>
    </div>

    <div class="msnap-section">
        <div class="msnap-section-title">저장소</div>
        <div class="msnap-kvlist">
            <div class="msnap-kv"><span>사용량</span><b>${est ? `${fmtBytes(est.usage)} / ${fmtBytes(est.quota)}` : '측정 전'}</b></div>
            <div class="msnap-kv"><span>지속성</span><b>${per === null ? '확인 전' : per.supported ? (per.persisted ? '보호됨' : '보호 안 됨') : '미지원'}</b></div>
        </div>
        <div class="msnap-btnrow">
            <button class="msnap-btn msnap-btn-sm" data-act="storage-check">저장소 상태 확인</button>
            <button class="msnap-btn msnap-btn-sm" data-act="storage-persist">브라우저에 보호 요청</button>
        </div>
        <div class="msnap-hint">브라우저는 저장 공간이 부족하면 IndexedDB 데이터를 지울 수 있습니다. 정기적으로 JSON을 내보내 백업해두세요.</div>
    </div>

    <div class="msnap-section">
        <div class="msnap-section-title">진단 (모바일용)</div>
        <div class="msnap-btnrow">
            <button class="msnap-btn msnap-btn-sm" data-act="diag-capture">현재 캡처 테스트</button>
            <button class="msnap-btn msnap-btn-sm" data-act="diag-ui">화면 배치 진단</button>
            <button class="msnap-btn msnap-btn-sm" data-act="diag-show">로그 보기 (${getDiagLog().length})</button>
            <button class="msnap-btn msnap-btn-sm" data-act="diag-clear">로그 비우기</button>
        </div>
    </div>

    <div class="msnap-section msnap-danger-zone">
        <div class="msnap-section-title">전체 삭제</div>
        <div class="msnap-hint">이 확장이 저장한 모든 데이터를 지웁니다. SillyTavern 본체 데이터에는 영향이 없습니다. 되돌릴 수 없습니다.</div>
        <button class="msnap-btn msnap-btn-danger msnap-btn-sm" data-act="wipe">전체 데이터 삭제…</button>
    </div>`;
}

// ────────────────────────────────────────────────────────────
// 이벤트
// ────────────────────────────────────────────────────────────
function onPanelInput(e) {
    const t = e.target;
    if (t.matches('[data-el="search"]')) {
        ui.search = t.value;
        const b = body();
        const listWrap = b.querySelector('.msnap-list');
        const countEl = b.querySelector('.msnap-count');
        const cards = filteredCards();
        if (listWrap) listWrap.innerHTML = cards.length ? cards.map(renderCard).join('') : emptyState(store.allCards().length);
        if (countEl) countEl.textContent = `${cards.length} / ${store.allCards().length} 카드`;
    }
}

function onPanelChange(e) {
    const t = e.target;
    if (t.matches('[data-el="fVendor"]')) { ui.filter.vendor = t.value; render(); }
    else if (t.matches('[data-el="fProvider"]')) { ui.filter.providerId = t.value; render(); }
    else if (t.matches('[data-el="fModel"]')) { ui.filter.modelId = t.value; render(); }
    else if (t.matches('[data-el="fStar"]')) { ui.filter.starOnly = t.checked; render(); }
    else if (t.matches('[data-el="fMode"]')) { ui.filter.labelMode = t.value; render(); }
    else if (t.matches('[data-el="setCapture"]')) { saveSettings({ captureParams: t.checked }); }
    else if (t.matches('[data-el="setJumpConfirm"]')) { saveSettings({ confirmBeforeJump: t.checked }); }
    else if (t.matches('[data-el="setReminder"]')) { saveSettings({ exportReminder: t.checked }).then(render); }
    else if (t.matches('[data-el="setReminderDays"]')) {
        const n = Math.max(1, Math.min(90, parseInt(t.value, 10) || 7));
        saveSettings({ exportReminderDays: n });
    }
}

async function onPanelClick(e) {
    const t = e.target;

    const tab = t.closest('.msnap-tab');
    if (tab) { ui.tab = tab.dataset.tab; render(); return; }

    const act = t.closest('[data-act]')?.dataset.act;
    if (!act) return;

    const cardEl = t.closest('[data-card-id]');
    const snapEl = t.closest('[data-snap-id]');
    const card = cardEl ? store.getCard(cardEl.dataset.cardId) : null;
    const snap = snapEl ? store.getSnapshot(snapEl.dataset.snapId) : null;

    switch (act) {
        case 'close': closePanel(); return;
        case 'shot': await doShot(() => render()); return;
        case 'go-settings': ui.tab = 'settings'; render(); return;

        // ── 필터 ──
        case 'toggle-filter': ui.filterOpen = !ui.filterOpen; render(); return;
        case 'filter-apply': {
            const lp = body().querySelector('[data-el="filterLabels"]');
            ui.filter.labels = lp ? readLabelPicker(lp) : [];
            render(); return;
        }
        case 'filter-reset':
            ui.filter = { vendor: '', providerId: '', modelId: '', starOnly: false, labels: [], labelMode: 'and' };
            render(); return;

        // ── 카드 ──
        case 'toggle-card': {
            if (!card) return;
            if (t.closest('[data-act="star"]') || t.closest('[data-act="rating"]')) return;
            if (ui.expanded.has(card.id)) ui.expanded.delete(card.id);
            else ui.expanded.add(card.id);
            render(); return;
        }
        case 'star':
            if (card) { await store.updateCard(card.id, { star: !card.star }); render(); }
            return;
        case 'rating': {
            if (!card) return;
            const r = parseInt(t.dataset.r, 10);
            if (!r) return;
            await store.updateCard(card.id, { rating: card.rating === r ? 0 : r });
            render(); return;
        }
        case 'card-memo': {
            if (!card) return;
            const v = await modalPrompt('카드 총평', { value: card.memo ?? '', multiline: true, placeholder: '이 조합의 전반적인 장단점' });
            if (v !== null) { await store.updateCard(card.id, { memo: v }); render(); }
            return;
        }
        case 'card-md': {
            if (!card) return;
            const r = io.exportMarkdown([card]);
            toastMsg(r.ok ? 'success' : 'error', r.ok ? `${r.name} 저장됨` : 'MD 내보내기 실패');
            return;
        }
        case 'card-delete': {
            if (!card) return;
            const n = store.snapshotsOfCard(card.id).length;
            const ok = await modalConfirm('카드 삭제',
                `이 카드와 소속 스냅샷 ${n}개가 모두 삭제됩니다.\n되돌릴 수 없습니다.`,
                { okText: '삭제', danger: true });
            if (ok) { await store.deleteCard(card.id); ui.expanded.delete(card.id); render(); }
            return;
        }

        // ── 스냅샷 ──
        case 'jump': if (snap) await handleJump(snap); return;
        case 'snap-edit':
            if (snap) { await editSnapshot(snap); render(); }
            return;
        case 'snap-delete': {
            if (!snap) return;
            const ok = await modalConfirm('스냅샷 삭제',
                '이 스냅샷을 삭제합니다.\n카드와 카드 총평은 그대로 남습니다.',
                { okText: '삭제', danger: true });
            if (ok) { await store.deleteSnapshot(snap.id); render(); }
            return;
        }
        case 'snap-params': if (snap) await showParams(snap); return;
        case 'snap-diff': {
            if (!snap) return;
            const i = ui.diffPick.indexOf(snap.id);
            if (i >= 0) ui.diffPick.splice(i, 1);
            else { if (ui.diffPick.length >= 2) ui.diffPick.shift(); ui.diffPick.push(snap.id); }
            render(); return;
        }
        case 'diff-clear': ui.diffPick = []; render(); return;
        case 'diff-run': await showDiff(); return;

        // ── 엔티티 ──
        case 'prov-edit': {
            const id = t.closest('[data-prov-id]')?.dataset.provId;
            if (id) { await editProvider(store.getProvider(id)); render(); }
            return;
        }
        case 'model-edit': {
            const id = t.closest('[data-model-id]')?.dataset.modelId;
            if (id) { await editModel(store.getModel(id)); render(); }
            return;
        }
        case 'prov-delete': {
            const id = t.closest('[data-prov-id]')?.dataset.provId;
            const p = id ? store.getProvider(id) : null;
            if (!p) return;
            const used = store.cardsUsingProvider(id);
            if (used.length) {
                await modalAlert('삭제할 수 없습니다',
                    `"${p.alias}" 를 쓰는 카드가 ${used.length}개 있습니다.\n기록이 깨지지 않도록, 카드를 먼저 삭제해야 합니다.`);
                return;
            }
            const ok = await modalConfirm('프로바이더 삭제',
                `"${p.alias}" 를 삭제합니다.\n이 프로바이더를 쓰는 카드가 없어 안전합니다.`,
                { okText: '삭제', danger: true });
            if (!ok) return;
            const r = await store.deleteProvider(id);
            if (!r.ok) await modalAlert('삭제 실패', r.error);
            render(); return;
        }
        case 'model-delete': {
            const id = t.closest('[data-model-id]')?.dataset.modelId;
            const m = id ? store.getModel(id) : null;
            if (!m) return;
            const used = store.cardsUsingModel(id);
            if (used.length) {
                await modalAlert('삭제할 수 없습니다',
                    `"${m.alias}" 를 쓰는 카드가 ${used.length}개 있습니다.\n기록이 깨지지 않도록, 카드를 먼저 삭제해야 합니다.`);
                return;
            }
            const ok = await modalConfirm('모델 삭제',
                `"${m.alias}" 를 삭제합니다.\n이 모델을 쓰는 카드가 없어 안전합니다.`,
                { okText: '삭제', danger: true });
            if (!ok) return;
            const r = await store.deleteModel(id);
            if (!r.ok) await modalAlert('삭제 실패', r.error);
            render(); return;
        }

        // ── 라벨 ──
        case 'label-add': await addCustomLabel(); render(); return;
        case 'label-unhide-all': {
            const hidden = store.getLabels().filter(l => l.hidden);
            if (!hidden.length) return;
            const ok = await modalConfirm('숨긴 라벨 표시',
                `숨겨진 라벨 ${hidden.length}개를 모두 다시 표시합니다.`, { okText: '표시' });
            if (!ok) return;
            for (const l of hidden) {
                const row = store.rawLabelRows().find(r => r.id === l.id)
                    ?? { id: l.id, group: l.group, name: l.name, type: l.type, ...(l.custom ? { custom: true } : {}) };
                await store.upsertLabelRow({ ...row, hidden: false });
            }
            render(); return;
        }
        case 'label-toggle-hidden': {
            const id = t.closest('[data-label-id]')?.dataset.labelId;
            if (!id) return;
            const all = store.getLabels();
            const def = all.find(l => l.id === id);
            const row = store.rawLabelRows().find(r => r.id === id);
            await store.upsertLabelRow({
                ...(row ?? { id, group: def?.group, name: def?.name, type: def?.type, ...(isDefaultLabel(id) ? {} : { custom: true }) }),
                hidden: !def?.hidden,
            });
            render(); return;
        }
        case 'label-rename': {
            const id = t.closest('[data-label-id]')?.dataset.labelId;
            const def = store.getLabels().find(l => l.id === id);
            if (!def) return;
            const v = await modalPrompt('라벨 이름', { value: def.name });
            if (v !== null && v.trim()) {
                const row = store.rawLabelRows().find(r => r.id === id) ?? { id, group: def.group, type: def.type, custom: true };
                await store.upsertLabelRow({ ...row, name: v.trim() });
                render();
            }
            return;
        }
        case 'label-delete': {
            const id = t.closest('[data-label-id]')?.dataset.labelId;
            if (!id) return;
            const used = store.labelUsageCounts().get(id) ?? 0;
            const ok = await modalConfirm('라벨 삭제',
                used ? `이 라벨은 스냅샷 ${used}개에 사용 중입니다.\n삭제하면 해당 스냅샷에 "삭제된 라벨"로 표시됩니다.` : '이 라벨을 삭제합니다.',
                { okText: '삭제', danger: true });
            if (ok) { await store.deleteLabelRow(id); render(); }
            return;
        }

        // ── 설정 ──
        case 'export-json': {
            const r = await io.exportJson();
            toastMsg(r.ok ? 'success' : 'error', r.ok ? `${r.name} 저장됨` : '내보내기 실패');
            render(); return;
        }
        case 'export-md': {
            const r = io.exportMarkdown(filteredCards());
            toastMsg(r.ok ? 'success' : 'error', r.ok ? `${r.name} 저장됨 (현재 필터 ${filteredCards().length}카드)` : 'MD 내보내기 실패');
            return;
        }
        case 'import-json': await doImport(); return;
        case 'storage-check': {
            storageInfo.est = await getStorageEstimate();
            if (storageInfo.persist === null) {
                storageInfo.persist = { supported: !!navigator.storage?.persisted, persisted: await (navigator.storage?.persisted?.() ?? Promise.resolve(false)) };
            }
            render(); return;
        }
        case 'storage-persist': {
            storageInfo.persist = await requestPersistence();
            storageInfo.est = await getStorageEstimate();
            render();
            await modalAlert('저장소 보호',
                storageInfo.persist.supported
                    ? (storageInfo.persist.persisted
                        ? '이 브라우저가 데이터를 보호 대상으로 표시했습니다.'
                        : '브라우저가 보호 요청을 거절했습니다. 정기적으로 JSON을 내보내 백업해주세요.')
                    : '이 브라우저는 저장소 보호 요청을 지원하지 않습니다. 정기적으로 JSON을 내보내 백업해주세요.');
            return;
        }
        case 'diag-capture': await showCaptureTest(); return;
        case 'diag-ui': await showUiDiag(); return;
        case 'diag-show': await showDiagLog(); return;
        case 'diag-clear': clearDiagLog(); render(); return;
        case 'wipe': await doWipe(); return;
    }
}

// ────────────────────────────────────────────────────────────
// 개별 동작
// ────────────────────────────────────────────────────────────
async function handleJump(snap) {
    const s = getSettings();
    if (s.confirmBeforeJump) {
        const go = await modalCustom({
            title: '메시지로 이동',
            bodyHtml: `<div class="msnap-kvlist">${jumpSummaryHtml(snap.ctx)}</div>
                       <div class="msnap-hint">캐릭터나 채팅방이 다르면 전환한 뒤 이동합니다. 채팅 내용은 변경되지 않습니다.</div>`,
            footerHtml: `<button class="msnap-btn" data-act="cancel">취소</button>
                         <button class="msnap-btn msnap-btn-primary" data-act="ok">이동</button>`,
            setup: (root, close) => {
                root.querySelector('[data-act="ok"]').addEventListener('click', () => close(true));
                root.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
            },
        });
        if (go !== true) return;
    }

    const r = await jumpToSnapshot(snap.ctx);
    if (r.code === JUMP_RESULT.OK) {
        closePanel();
        toastMsg('info', r.message);
    } else if (r.code === JUMP_RESULT.HASH_MISMATCH) {
        closePanel();
        await modalAlert('내용이 다릅니다', r.message);
    } else {
        await modalAlert('이동할 수 없습니다', r.message);
    }
}

async function showParams(snap) {
    const rows = PARAM_FIELDS.map(f => {
        const v = snap.params?.[f.key];
        return `<div class="msnap-kv"><span>${escapeHtml(f.label)}</span><b>${v === null || v === undefined ? '-' : escapeHtml(String(v))}</b></div>`;
    }).join('');
    await modalCustom({
        title: `파라미터 · ${fmtDate(snap.ts)}`,
        bodyHtml: `<div class="msnap-kvlist">${rows}</div>`,
        footerHtml: `<button class="msnap-btn msnap-btn-primary" data-act="ok">닫기</button>`,
        setup: (root, close) => root.querySelector('[data-act="ok"]').addEventListener('click', () => close(true)),
    });
}

async function showDiff() {
    const [a, b] = ui.diffPick.map(id => store.getSnapshot(id));
    if (!a || !b) { toastMsg('error', '비교할 스냅샷을 찾을 수 없습니다.'); return; }
    const cardA = store.getCard(a.cardId);
    const cardB = store.getCard(b.cardId);
    const labelMap = store.getLabelMap();

    const head = (s, c) => {
        const m = store.getModel(c?.modelId);
        const p = store.getProvider(c?.providerId);
        return `${escapeHtml(m?.alias ?? '?')} @ ${escapeHtml(p?.alias ?? '?')}<br><small>${escapeHtml(fmtDate(s.ts))}</small>`;
    };

    const classRows = [
        ['프로바이더', store.getProvider(cardA?.providerId)?.alias, store.getProvider(cardB?.providerId)?.alias],
        ['모델', store.getModel(cardA?.modelId)?.alias, store.getModel(cardB?.modelId)?.alias],
        ['후처리', cardA?.postProcessing, cardB?.postProcessing],
        ['프리셋', cardA?.presetName, cardB?.presetName],
    ];
    const paramRows = PARAM_FIELDS.map(f => [f.label, a.params?.[f.key], b.params?.[f.key]]);

    const renderRows = (rows) => rows.map(([k, va, vb]) => {
        const sa = va === null || va === undefined || va === '' ? '-' : String(va);
        const sb = vb === null || vb === undefined || vb === '' ? '-' : String(vb);
        const diff = sa !== sb;
        return `<tr class="${diff ? 'diff' : ''}"><th>${escapeHtml(k)}</th><td>${escapeHtml(sa)}</td><td>${escapeHtml(sb)}</td></tr>`;
    }).join('');

    const labelsOf = (s) => new Set((s.labels ?? []).map(e => labelDisplay(labelMap.get(e.id), e)));
    const la = labelsOf(a); const lb = labelsOf(b);
    const onlyA = [...la].filter(x => !lb.has(x));
    const onlyB = [...lb].filter(x => !la.has(x));
    const both = [...la].filter(x => lb.has(x));

    await modalCustom({
        title: '스냅샷 비교',
        wide: true,
        bodyHtml: `
            <table class="msnap-difftable">
                <thead><tr><th></th><th>${head(a, cardA)}</th><th>${head(b, cardB)}</th></tr></thead>
                <tbody>
                    <tr class="sec"><th colspan="3">분류</th></tr>
                    ${renderRows(classRows)}
                    <tr class="sec"><th colspan="3">파라미터</th></tr>
                    ${renderRows(paramRows)}
                </tbody>
            </table>
            <div class="msnap-section">
                <div class="msnap-section-title">라벨 차이</div>
                <div class="msnap-kvlist">
                    <div class="msnap-kv"><span>공통</span><b>${escapeHtml(both.join(', ') || '-')}</b></div>
                    <div class="msnap-kv"><span>왼쪽만</span><b>${escapeHtml(onlyA.join(', ') || '-')}</b></div>
                    <div class="msnap-kv"><span>오른쪽만</span><b>${escapeHtml(onlyB.join(', ') || '-')}</b></div>
                </div>
            </div>
            <div class="msnap-section">
                <div class="msnap-section-title">메모</div>
                <div class="msnap-diffmemo"><b>왼쪽</b><div>${escapeHtml(a.memo || '(없음)').replace(/\n/g, '<br>')}</div></div>
                <div class="msnap-diffmemo"><b>오른쪽</b><div>${escapeHtml(b.memo || '(없음)').replace(/\n/g, '<br>')}</div></div>
            </div>`,
        footerHtml: `<button class="msnap-btn msnap-btn-primary" data-act="ok">닫기</button>`,
        setup: (root, close) => root.querySelector('[data-act="ok"]').addEventListener('click', () => close(true)),
    });
}

async function editProvider(p) {
    if (!p) return;
    const linksText = (p.links ?? []).map(l => `${l.name ?? ''}|${l.url ?? ''}`).join('\n');
    await modalCustom({
        title: '프로바이더 편집',
        wide: true,
        bodyHtml: `
            <div class="msnap-field"><div class="msnap-label">약칭</div>
                <input class="msnap-input" data-el="alias" value="${escapeHtml(p.alias ?? '')}"></div>
            <div class="msnap-field"><div class="msnap-label">상태</div>
                <select class="msnap-input" data-el="status">
                    ${['ok', 'unstable', 'dead', 'paid'].map(s => `<option value="${s}" ${p.status === s ? 'selected' : ''}>${io.statusText(s)}</option>`).join('')}
                </select></div>
            <div class="msnap-field"><div class="msnap-label">가격 페이지 URL</div>
                <input class="msnap-input" data-el="price" value="${escapeHtml(p.priceUrl ?? '')}" placeholder="https://..."></div>
            <div class="msnap-field"><div class="msnap-label">추가 링크 <span class="msnap-sub">한 줄에 하나. 형식: 이름|URL</span></div>
                <textarea class="msnap-input msnap-textarea" data-el="links" placeholder="디스코드|https://...">${escapeHtml(linksText)}</textarea></div>
            <div class="msnap-field"><div class="msnap-label">메모</div>
                <textarea class="msnap-input msnap-textarea" data-el="memo">${escapeHtml(p.memo ?? '')}</textarea></div>
            <div class="msnap-field"><div class="msnap-label">엔드포인트 <span class="msnap-sub">한 줄에 하나. 같은 사이트의 여러 주소를 여기 모으면 하나의 프로바이더로 묶입니다</span></div>
                <textarea class="msnap-input msnap-textarea msnap-mono" data-el="hosts">${escapeHtml((p.hosts ?? []).join('\n'))}</textarea></div>`,
        footerHtml: `<button class="msnap-btn" data-act="cancel">취소</button>
                     <button class="msnap-btn msnap-btn-primary" data-act="save">저장</button>`,
        setup: (root, close) => {
            root.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
            root.querySelector('[data-act="save"]').addEventListener('click', async () => {
                const hostRes = await store.setProviderHosts(
                    p.id,
                    root.querySelector('[data-el="hosts"]').value.split('\n'),
                );
                if (!hostRes.ok) { await modalAlert('엔드포인트 저장 실패', hostRes.error); return; }
                const links = root.querySelector('[data-el="links"]').value
                    .split('\n').map(s => s.trim()).filter(Boolean)
                    .map(line => {
                        const i = line.indexOf('|');
                        return i === -1 ? { name: '링크', url: line } : { name: line.slice(0, i).trim(), url: line.slice(i + 1).trim() };
                    })
                    .filter(l => safeUrl(l.url));
                await store.updateProvider(p.id, {
                    alias: root.querySelector('[data-el="alias"]').value.trim() || p.alias,
                    status: root.querySelector('[data-el="status"]').value,
                    priceUrl: safeUrl(root.querySelector('[data-el="price"]').value),
                    links,
                    memo: root.querySelector('[data-el="memo"]').value,
                    pending: false,
                });
                close(true);
            });
        },
    });
}

async function editModel(m) {
    if (!m) return;
    await modalCustom({
        title: '모델 편집',
        bodyHtml: `
            <div class="msnap-field"><div class="msnap-label">약칭</div>
                <input class="msnap-input" data-el="alias" value="${escapeHtml(m.alias ?? '')}"></div>
            <div class="msnap-field"><div class="msnap-label">벤더</div>
                <input class="msnap-input" data-el="vendor" value="${escapeHtml(m.vendor ?? '')}" placeholder="예: 젬"></div>
            <div class="msnap-field"><div class="msnap-label">메모</div>
                <textarea class="msnap-input msnap-textarea" data-el="memo">${escapeHtml(m.memo ?? '')}</textarea></div>
            <div class="msnap-field"><div class="msnap-label">모델 문자열 <span class="msnap-sub">한 줄에 하나. 같은 모델의 이름 변형을 여기 모으면 하나로 묶입니다</span></div>
                <textarea class="msnap-input msnap-textarea msnap-mono" data-el="raws">${escapeHtml((m.raws ?? []).join('\n'))}</textarea></div>`,
        footerHtml: `<button class="msnap-btn" data-act="cancel">취소</button>
                     <button class="msnap-btn msnap-btn-primary" data-act="save">저장</button>`,
        setup: (root, close) => {
            root.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
            root.querySelector('[data-act="save"]').addEventListener('click', async () => {
                const rawRes = await store.setModelRaws(
                    m.id,
                    root.querySelector('[data-el="raws"]').value.split('\n'),
                );
                if (!rawRes.ok) { await modalAlert('모델 문자열 저장 실패', rawRes.error); return; }
                await store.updateModel(m.id, {
                    alias: root.querySelector('[data-el="alias"]').value.trim() || m.alias,
                    vendor: root.querySelector('[data-el="vendor"]').value.trim(),
                    memo: root.querySelector('[data-el="memo"]').value,
                    pending: false,
                });
                close(true);
            });
        },
    });
}

async function addCustomLabel() {
    await modalCustom({
        title: '커스텀 라벨 추가',
        bodyHtml: `
            <div class="msnap-field"><div class="msnap-label">이름</div>
                <input class="msnap-input" data-el="name" placeholder="예: 번역깨짐"></div>
            <div class="msnap-field"><div class="msnap-label">그룹</div>
                <select class="msnap-input" data-el="group">
                    ${LABEL_GROUPS.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('')}
                </select></div>
            <div class="msnap-field"><div class="msnap-label">형태</div>
                <select class="msnap-input" data-el="type">
                    <option value="chip">단순 라벨</option>
                    <option value="axis">3단 토글 (⬜ 👍 👎)</option>
                </select></div>`,
        footerHtml: `<button class="msnap-btn" data-act="cancel">취소</button>
                     <button class="msnap-btn msnap-btn-primary" data-act="save">추가</button>`,
        setup: (root, close) => {
            root.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
            root.querySelector('[data-act="save"]').addEventListener('click', async () => {
                const name = root.querySelector('[data-el="name"]').value.trim();
                if (!name) { toastMsg('error', '이름을 입력해주세요.'); return; }
                await store.upsertLabelRow({
                    group: root.querySelector('[data-el="group"]').value,
                    name,
                    type: root.querySelector('[data-el="type"]').value,
                    custom: true,
                    hidden: false,
                });
                close(true);
            });
        },
    });
}

async function doImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    document.body.appendChild(input);
    const file = await new Promise((resolve) => {
        input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
        input.click();
    });
    input.remove();
    if (!file) return;

    let text;
    try { text = await file.text(); } catch (e) {
        await modalAlert('가져오기 실패', `파일을 읽지 못했습니다: ${e?.message ?? e}`);
        return;
    }

    const parsed = io.parseImportFile(text);
    if (!parsed.ok) { await modalAlert('가져오기 실패', parsed.error); return; }

    const a = io.analyzeImport(parsed.data);
    const row = (k, label) => `<tr><th>${label}</th><td>${a[k].total}</td><td>${a[k].neu}</td><td>${a[k].conflict}</td><td>${a[k].existing}</td></tr>`;

    const mode = await modalCustom({
        title: '가져오기 확인',
        wide: true,
        bodyHtml: `
            <div class="msnap-hint">파일 내보낸 시각: ${escapeHtml(parsed.data.exportedAtText ?? fmtDate(parsed.data.exportedAt))}</div>
            <table class="msnap-difftable">
                <thead><tr><th></th><th>파일</th><th>신규</th><th>충돌</th><th>현재</th></tr></thead>
                <tbody>
                    ${row('providers', '프로바이더')}
                    ${row('models', '모델')}
                    ${row('cards', '카드')}
                    ${row('snapshots', '스냅샷')}
                    ${row('labels', '라벨')}
                </tbody>
            </table>
            <div class="msnap-field">
                <div class="msnap-label">방식</div>
                <label class="msnap-check"><input type="radio" name="msnapImportMode" value="merge_keep" checked> 병합 — 기존 우선 (충돌 항목은 그대로 둠)</label>
                <label class="msnap-check"><input type="radio" name="msnapImportMode" value="merge_overwrite"> 병합 — 파일 우선 (충돌 항목을 파일 값으로 교체)</label>
                <label class="msnap-check"><input type="radio" name="msnapImportMode" value="replace"> 전체 대체 — 현재 데이터를 모두 지우고 파일로 교체</label>
            </div>
            <div class="msnap-warn">전체 대체는 되돌릴 수 없습니다. 먼저 현재 데이터를 내보내두는 것을 권합니다.</div>`,
        footerHtml: `<button class="msnap-btn" data-act="cancel">취소</button>
                     <button class="msnap-btn msnap-btn-primary" data-act="ok">가져오기</button>`,
        setup: (root, close) => {
            root.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
            root.querySelector('[data-act="ok"]').addEventListener('click', () => {
                close(root.querySelector('input[name="msnapImportMode"]:checked')?.value ?? null);
            });
        },
    });
    if (!mode) return;

    if (mode === 'replace') {
        const ok = await modalConfirm('전체 대체', '현재 저장된 모든 데이터가 삭제되고 파일 내용으로 교체됩니다.\n계속할까요?', { okText: '교체', danger: true });
        if (!ok) return;
    }

    try {
        const written = await io.applyImport(parsed.data, mode);
        await modalAlert('가져오기 완료',
            `프로바이더 ${written.providers} / 모델 ${written.models} / 카드 ${written.cards} / 스냅샷 ${written.snapshots} / 라벨 ${written.labels} 적용됨`);
        render();
    } catch (e) {
        diag('error', '가져오기 실패', e?.message);
        await modalAlert('가져오기 실패', String(e?.message ?? e));
    }
}

async function doWipe() {
    const val = await modalCustom({
        title: '전체 데이터 삭제',
        bodyHtml: `
            <div class="msnap-warn">이 확장이 저장한 카드·스냅샷·프로바이더·모델·라벨이 모두 삭제됩니다.<br>
            되돌릴 수 없습니다. SillyTavern 본체 데이터에는 영향이 없습니다.</div>
            <div class="msnap-kvlist">
                <div class="msnap-kv"><span>카드</span><b>${store.allCards().length}</b></div>
                <div class="msnap-kv"><span>스냅샷</span><b>${store.allSnapshots().length}</b></div>
            </div>
            <div class="msnap-field">
                <div class="msnap-label">확인을 위해 <b>DELETE</b> 를 입력하세요</div>
                <input class="msnap-input" data-el="confirm" placeholder="DELETE" autocomplete="off">
            </div>`,
        footerHtml: `<button class="msnap-btn" data-act="cancel">취소</button>
                     <button class="msnap-btn msnap-btn-danger" data-act="ok" disabled>삭제</button>`,
        setup: (root, close) => {
            const inp = root.querySelector('[data-el="confirm"]');
            const btn = root.querySelector('[data-act="ok"]');
            inp.addEventListener('input', () => { btn.disabled = inp.value.trim() !== 'DELETE'; });
            root.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
            btn.addEventListener('click', () => close(inp.value));
        },
    });
    if (!val) return;
    const r = await io.wipeAll(val);
    if (!r.ok) { await modalAlert('삭제 취소됨', r.error); return; }
    ui.expanded.clear();
    ui.diffPick = [];
    render();
    await modalAlert('삭제 완료', '모든 데이터가 삭제되었습니다.');
}

async function showCaptureTest() {
    const { captureModelState, captureChatContext, getContextSafe } = await import('./capture.js');
    const s = getSettings();
    const cap = captureModelState({ captureParams: s.captureParams });
    const ctx = getContextSafe();
    const { ctxInfo, fails } = captureChatContext(ctx);
    const rows = [
        ['SillyTavern context', ctx ? 'OK' : '실패'],
        ['main_api', cap.data.mainApi ?? '-'],
        ['소스', cap.data.source ?? '-'],
        ['엔드포인트', cap.data.endpoint ?? '-'],
        ['모델', cap.data.modelRaw ?? '-'],
        ['후처리', cap.data.postProcessing ?? '(미설정)'],
        ['프리셋', cap.data.presetName ?? '-'],
        ['파라미터', cap.data.params ? Object.entries(cap.data.params).map(([k, v]) => `${k}=${v ?? '-'}`).join(', ') : '(캡처 꺼짐)'],
        ['캐릭터', ctxInfo.charName ?? '-'],
        ['채팅', ctxInfo.chatFile ?? '-'],
        ['메시지', ctxInfo.mesId ?? '-'],
        ['메시지 지문', ctxInfo.mesHash ?? '-'],
        ['읽기 실패', [...cap.fails, ...fails].join(', ') || '없음'],
    ];
    await modalCustom({
        title: '캡처 테스트',
        wide: true,
        bodyHtml: `<div class="msnap-kvlist">${rows.map(([k, v]) =>
            `<div class="msnap-kv"><span>${escapeHtml(k)}</span><b class="msnap-wrap">${escapeHtml(String(v))}</b></div>`).join('')}</div>
            <div class="msnap-hint">이 창은 읽기만 합니다. 아무것도 저장하지 않습니다.</div>`,
        footerHtml: `<button class="msnap-btn msnap-btn-primary" data-act="ok">닫기</button>`,
        setup: (root, close) => root.querySelector('[data-act="ok"]').addEventListener('click', () => close(true)),
    });
}

async function showUiDiag() {
    const el = ui.root;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const breakers = findFixedBreakers(document.body);
    const chk = lastOverlayCheck;

    const rows = [
        ['화면 크기', `${window.innerWidth} × ${window.innerHeight}`],
        ['패널 실제 위치', `top ${Math.round(r.top)} / left ${Math.round(r.left)}`],
        ['패널 실제 크기', `${Math.round(r.width)} × ${Math.round(r.height)}`],
        ['position 계산값', cs.position],
        ['부착 위치', el.parentElement?.tagName?.toLowerCase() ?? '?'],
        ['배경색 계산값', cs.backgroundColor],
        ['어두운 테마 판정', isDarkTheme() ? '어두움' : '밝음'],
        ['dvh 지원', CSS.supports?.('height', '100dvh') ? '지원' : '미지원'],
        ['위치 검증', chk ? (chk.ok ? '정상' : '교정 시도함') : '미실행'],
    ];

    const breakerHtml = breakers.length
        ? breakers.map(b => `<div class="msnap-logline">&lt;${escapeHtml(b.tag)}${b.id ? ' #' + escapeHtml(b.id) : ''}${b.cls ? ' .' + escapeHtml(b.cls) : ''}&gt;<br>&nbsp;&nbsp;→ ${escapeHtml(b.reasons.join(', '))}</div>`).join('')
        : '<div class="msnap-hint">없음 — 고정 위치를 방해하는 조상 요소가 발견되지 않았습니다.</div>';

    await modalCustom({
        title: '화면 배치 진단',
        wide: true,
        bodyHtml: `
            <div class="msnap-kvlist">${rows.map(([k, v]) =>
            `<div class="msnap-kv"><span>${escapeHtml(k)}</span><b class="msnap-wrap">${escapeHtml(String(v))}</b></div>`).join('')}</div>
            <div class="msnap-section-title">고정 위치를 깨는 조상 요소</div>
            ${breakerHtml}
            <div class="msnap-hint">패널 크기가 화면 크기와 다르거나 position 이 fixed 가 아니면 배치 문제가 있는 것입니다. 이 화면을 캡처해서 알려주세요.</div>`,
        footerHtml: `<button class="msnap-btn" data-act="copy">복사</button>
                     <button class="msnap-btn msnap-btn-primary" data-act="ok">닫기</button>`,
        setup: (root, close) => {
            root.querySelector('[data-act="ok"]').addEventListener('click', () => close(true));
            root.querySelector('[data-act="copy"]').addEventListener('click', async () => {
                const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n')
                    + '\n\n[고정위치 방해요소]\n'
                    + (breakers.length ? breakers.map(b => `<${b.tag}#${b.id}.${b.cls}> ${b.reasons.join(', ')}`).join('\n') : '없음');
                try { await navigator.clipboard.writeText(text); toastMsg('success', '복사했습니다.'); }
                catch { toastMsg('error', '복사 실패. 길게 눌러 수동 복사해주세요.'); }
            });
        },
    });
}

async function showDiagLog() {
    const log = getDiagLog().slice().reverse();
    const html = log.length
        ? log.map(e => `<div class="msnap-logline msnap-log-${escapeHtml(e.level)}">
             <span>${escapeHtml(fmtDate(e.t))}</span> [${escapeHtml(e.level)}] ${escapeHtml(e.msg)}${e.extra ? ` — ${escapeHtml(e.extra)}` : ''}</div>`).join('')
        : '<div class="msnap-empty">로그가 없습니다.</div>';
    await modalCustom({
        title: '진단 로그',
        wide: true,
        bodyHtml: `<div class="msnap-loglist">${html}</div>`,
        footerHtml: `<button class="msnap-btn" data-act="copy">복사</button>
                     <button class="msnap-btn msnap-btn-primary" data-act="ok">닫기</button>`,
        setup: (root, close) => {
            root.querySelector('[data-act="ok"]').addEventListener('click', () => close(true));
            root.querySelector('[data-act="copy"]').addEventListener('click', async () => {
                const text = log.map(e => `${fmtDate(e.t)} [${e.level}] ${e.msg}${e.extra ? ` — ${e.extra}` : ''}`).join('\n');
                try {
                    await navigator.clipboard.writeText(text);
                    toastMsg('success', '복사했습니다.');
                } catch {
                    toastMsg('error', '복사에 실패했습니다. 길게 눌러 수동 복사해주세요.');
                }
            });
        },
    });
}

export { ui };
