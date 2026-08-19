/**
 * ui-shot.js — 📸 SHOT 다이얼로그
 *
 * 흐름:
 *  1. 현재 상태를 읽는다 (읽기 전용)
 *  2. 프로바이더/모델 엔티티를 찾거나 pending 상태로 새로 만든다
 *  3. 카드를 찾거나 만든다
 *  4. 스냅샷을 "먼저 저장"한다  ← ST가 강제종료돼도 기록이 남도록
 *  5. 그 다음 다이얼로그를 띄워 약칭 등록 / 라벨 / 메모를 입력받는다
 *  6. 취소를 누르면 방금 만든 스냅샷을 지운다 (사용자가 명시적으로 취소한 경우에만)
 */

import { escapeHtml, getSettings, diag, fmtDate } from './core.js';
import {
    captureModelState, captureChatContext, getContextSafe,
    suggestProviderAlias, suggestModelAlias, suggestVendor, PARAM_FIELDS,
} from './capture.js';
import * as store from './store.js';
import { LABEL_GROUPS } from './labels.js';
import { modalCustom, modalAlert, toastMsg } from './ui-modal.js';

/** 라벨 선택 UI 생성 (스냅샷 편집 / 필터 공용) */
export function renderLabelPicker(selected, { allowAxis = true } = {}) {
    const labels = store.getLabels().filter(l => !l.hidden);
    const selMap = new Map((selected ?? []).map(e => [e.id, e]));
    const groups = LABEL_GROUPS
        .map(g => ({ g, items: labels.filter(l => l.group === g.id) }))
        .filter(x => x.items.length);

    return groups.map(({ g, items }) => {
        const activeCount = items.filter(i => selMap.has(i.id)).length;
        const chips = items.map(l => {
            if (l.type === 'axis' && allowAxis) {
                const v = selMap.get(l.id)?.v ?? 0;
                return `<button type="button" class="msnap-chip msnap-axis ${v === 1 ? 'up' : v === -1 ? 'down' : ''}"
                    data-label-id="${escapeHtml(l.id)}" data-type="axis" data-v="${v}"
                    style="--msnap-c:${g.color}">${escapeHtml(l.name)}<span class="msnap-axis-mark">${v === 1 ? '👍' : v === -1 ? '👎' : '⬜'}</span></button>`;
            }
            const on = selMap.has(l.id);
            return `<button type="button" class="msnap-chip ${on ? 'on' : ''}"
                data-label-id="${escapeHtml(l.id)}" data-type="chip"
                style="--msnap-c:${g.color}">${escapeHtml(l.name)}</button>`;
        }).join('');
        return `
        <div class="msnap-lgroup" data-group="${escapeHtml(g.id)}" style="--msnap-c:${g.color}">
            <button type="button" class="msnap-lgroup-head" data-act="toggle-group">
                <span class="msnap-dot"></span>
                <span class="msnap-lgroup-name">${escapeHtml(g.name)}</span>
                <span class="msnap-lgroup-count" data-el="gcount">${activeCount || ''}</span>
                <span class="msnap-caret">▾</span>
            </button>
            <div class="msnap-lgroup-body">${chips}</div>
        </div>`;
    }).join('');
}

/** 라벨 선택 UI 의 이벤트를 붙이고 현재 선택값을 읽는 함수를 돌려준다 */
export function bindLabelPicker(root) {
    root.addEventListener('click', (e) => {
        const head = e.target.closest('[data-act="toggle-group"]');
        if (head) {
            head.parentElement.classList.toggle('open');
            return;
        }
        const chip = e.target.closest('[data-label-id]');
        if (!chip) return;
        if (chip.dataset.type === 'axis') {
            let v = parseInt(chip.dataset.v, 10) || 0;
            v = v === 0 ? 1 : v === 1 ? -1 : 0;
            chip.dataset.v = String(v);
            chip.classList.toggle('up', v === 1);
            chip.classList.toggle('down', v === -1);
            const mark = chip.querySelector('.msnap-axis-mark');
            if (mark) mark.textContent = v === 1 ? '👍' : v === -1 ? '👎' : '⬜';
        } else {
            chip.classList.toggle('on');
        }
        updateCounts(root);
    });
    updateCounts(root);
    return () => readLabelPicker(root);
}

function updateCounts(root) {
    root.querySelectorAll('.msnap-lgroup').forEach(g => {
        let n = 0;
        g.querySelectorAll('[data-label-id]').forEach(c => {
            if (c.dataset.type === 'axis') { if ((parseInt(c.dataset.v, 10) || 0) !== 0) n++; }
            else if (c.classList.contains('on')) n++;
        });
        const el = g.querySelector('[data-el="gcount"]');
        if (el) el.textContent = n || '';
    });
}

export function readLabelPicker(root) {
    const out = [];
    root.querySelectorAll('[data-label-id]').forEach(c => {
        const id = c.dataset.labelId;
        if (c.dataset.type === 'axis') {
            const v = parseInt(c.dataset.v, 10) || 0;
            if (v !== 0) out.push({ id, v });
        } else if (c.classList.contains('on')) {
            out.push({ id });
        }
    });
    return out;
}

// ────────────────────────────────────────────────────────────
// 엔티티 해석
// ────────────────────────────────────────────────────────────
async function resolveEntities(data) {
    let provider = store.findProviderByEndpoint(data.endpoint);
    let providerIsNew = false;
    if (!provider && data.endpoint) {
        provider = await store.createProvider({
            alias: suggestProviderAlias(data.endpoint),
            endpoint: data.endpoint,
            pending: true,
        });
        providerIsNew = true;
    }

    let model = store.findModelByRaw(data.modelRaw);
    let modelIsNew = false;
    if (!model && data.modelRaw) {
        model = await store.createModel({
            alias: suggestModelAlias(data.modelRaw),
            vendor: suggestVendor(data.modelRaw),
            raw: data.modelRaw,
            pending: true,
        });
        modelIsNew = true;
    }

    return { provider, model, providerIsNew, modelIsNew };
}

// ────────────────────────────────────────────────────────────
// SHOT
// ────────────────────────────────────────────────────────────
export async function doShot(onSaved) {
    const settings = getSettings();
    const cap = captureModelState({ captureParams: settings.captureParams });

    if (!cap.data.modelRaw && !cap.data.endpoint) {
        await modalAlert('스냅샷 실패', `현재 모델 설정을 읽지 못했습니다.\n읽기 실패 항목: ${cap.fails.join(', ') || '알 수 없음'}\n\nChat Completion API가 선택되어 있는지 확인해주세요.`);
        return null;
    }

    const ctx = getContextSafe();
    const { ctxInfo, fails: ctxFails } = captureChatContext(ctx);

    const { provider, model, providerIsNew, modelIsNew } = await resolveEntities(cap.data);

    const card = await store.createCard({
        providerId: provider?.id ?? null,
        modelId: model?.id ?? null,
        postProcessing: cap.data.postProcessing,
        presetName: cap.data.presetName,
    });
    const cardIsNew = card.__isNew === true;

    // ① 먼저 저장 (강제종료 대비)
    const snap = await store.createSnapshot({
        cardId: card.id,
        params: cap.data.params,
        labels: [],
        memo: '',
        ctx: ctxInfo,
    });

    diag('info', `스냅샷 생성: ${snap.id} (카드 ${card.id})`);

    // ② 편집 다이얼로그
    const result = await openShotDialog({
        snap, card, provider, model, cap, ctxInfo, ctxFails,
        providerIsNew, modelIsNew,
    });

    if (result === 'cancelled') {
        // 취소하면 이번 샷 때문에 새로 생긴 것을 전부 되돌린다.
        // 순서가 중요하다: 스냅샷 → 카드 → 엔티티.
        // (앞 단계를 지워야 뒷 단계의 "참조 없음" 판정이 성립한다)
        await rollbackShot({ snap, card, cardIsNew, provider, model, providerIsNew, modelIsNew });
        toastMsg('info', '스냅샷을 취소했습니다.');
        onSaved?.();
        return null;
    }

    toastMsg('success', '스냅샷을 저장했습니다.');
    onSaved?.(card.id, snap.id);
    return snap;
}

/**
 * 취소 시 정리.
 * 이번 샷에서 "새로 생긴" 것만 지운다. 이전부터 있던 것은 절대 건드리지 않는다.
 * 참조가 남아 있으면 삭제가 거부되므로, 데이터가 깨질 위험이 없다.
 */
async function rollbackShot({ snap, card, cardIsNew, provider, model, providerIsNew, modelIsNew }) {
    try {
        await store.deleteSnapshot(snap.id);

        // 카드는 이번에 새로 만들어졌고 남은 스냅샷이 없을 때만 지운다.
        if (cardIsNew && card && store.snapshotsOfCard(card.id).length === 0) {
            await store.deleteCard(card.id);
        }

        // 엔티티는 이번에 새로 만들어졌고 참조하는 카드가 없을 때만 지운다.
        if (providerIsNew && provider) {
            const r = await store.deleteProvider(provider.id);
            if (!r.ok) diag('info', '프로바이더 정리 생략 (사용 중)', r.error);
        }
        if (modelIsNew && model) {
            const r = await store.deleteModel(model.id);
            if (!r.ok) diag('info', '모델 정리 생략 (사용 중)', r.error);
        }
    } catch (e) {
        diag('error', '취소 정리 중 오류', e?.message);
    }
}

function pendingBlock(provider, model, providerIsNew, modelIsNew) {
    const needProv = provider && (provider.pending || providerIsNew);
    const needMdl = model && (model.pending || modelIsNew);
    if (!needProv && !needMdl) return '';
    const rows = [];
    if (needProv) {
        rows.push(`
        <div class="msnap-field">
            <div class="msnap-label">프로바이더 약칭 <span class="msnap-sub">${escapeHtml(provider.hosts?.[0] ?? '')}</span></div>
            <input type="text" class="msnap-input" data-el="provAlias" value="${escapeHtml(provider.alias ?? '')}" placeholder="예: 마프">
        </div>`);
    }
    if (needMdl) {
        rows.push(`
        <div class="msnap-field">
            <div class="msnap-label">모델 약칭 <span class="msnap-sub">${escapeHtml(model.raws?.[0] ?? '')}</span></div>
            <input type="text" class="msnap-input" data-el="mdlAlias" value="${escapeHtml(model.alias ?? '')}" placeholder="예: 옾4.6">
            <div class="msnap-hint">모델명 전체가 들어가 있습니다. 원하는 만큼 줄여서 쓰세요.</div>
            <div class="msnap-label">벤더 <span class="msnap-sub">같은 계열끼리 묶어보는 기준</span></div>
            <input type="text" class="msnap-input msnap-input-sm" data-el="mdlVendor" value="${escapeHtml(model.vendor ?? '')}" placeholder="예: 옾">
        </div>`);
    }
    return `
    <div class="msnap-section msnap-pending">
        <div class="msnap-section-title">처음 보는 항목이 있습니다 — 약칭을 정해주세요</div>
        <div class="msnap-hint">약칭은 표시용입니다. 나중에 바꿔도 기존 기록은 그대로 유지됩니다.</div>
        ${rows.join('')}
    </div>`;
}

function paramsBlock(params) {
    if (!params) {
        return `<div class="msnap-hint">파라미터 캡처가 꺼져 있습니다. (설정에서 켤 수 있습니다)</div>`;
    }
    const rows = PARAM_FIELDS.map(f => {
        const v = params[f.key];
        return `<div class="msnap-kv"><span>${escapeHtml(f.label)}</span><b>${v === null || v === undefined ? '-' : escapeHtml(String(v))}</b></div>`;
    }).join('');
    return `<div class="msnap-kvlist">${rows}</div>`;
}

function openShotDialog(o) {
    const { snap, card, provider, model, cap, ctxInfo, ctxFails, providerIsNew, modelIsNew } = o;
    const failNote = cap.fails.length || ctxFails.length
        ? `<div class="msnap-warn">읽지 못한 항목: ${escapeHtml([...cap.fails, ...ctxFails].join(', '))}</div>`
        : '';

    const bodyHtml = `
        ${pendingBlock(provider, model, providerIsNew, modelIsNew)}
        <div class="msnap-section">
            <div class="msnap-section-title">카드 분류 정보</div>
            <div class="msnap-kvlist">
                <div class="msnap-kv"><span>프로바이더</span><b>${escapeHtml(provider?.alias ?? '(없음)')}</b></div>
                <div class="msnap-kv"><span>모델</span><b>${escapeHtml(model?.alias ?? '(없음)')}</b></div>
                <div class="msnap-kv"><span>후처리</span><b>${escapeHtml(cap.data.postProcessing ?? '(미설정)')}</b></div>
                <div class="msnap-kv"><span>프리셋</span><b>${escapeHtml(cap.data.presetName ?? '(불명)')}</b></div>
            </div>
            ${failNote}
        </div>

        <div class="msnap-section">
            <div class="msnap-section-title">기록 대상</div>
            <div class="msnap-kvlist">
                <div class="msnap-kv"><span>일시</span><b>${escapeHtml(fmtDate(snap.ts))}</b></div>
                <div class="msnap-kv"><span>캐릭터</span><b>${escapeHtml(ctxInfo.charName ?? '(없음)')}</b></div>
                <div class="msnap-kv"><span>채팅방</span><b>${escapeHtml(ctxInfo.chatFile ?? '(없음)')}</b></div>
            </div>
            <div class="msnap-field">
                <div class="msnap-label">메시지 번호 <span class="msnap-sub">나중에 이 메시지로 이동할 수 있습니다</span></div>
                <input type="number" class="msnap-input" data-el="mesId" value="${ctxInfo.mesId ?? ''}" placeholder="비우면 이동 기능 없음">
            </div>
        </div>

        <div class="msnap-section">
            <div class="msnap-section-title">라벨</div>
            <div class="msnap-labels" data-el="labels">${renderLabelPicker([])}</div>
        </div>

        <div class="msnap-section">
            <div class="msnap-label">메모</div>
            <textarea class="msnap-input msnap-textarea" data-el="memo" placeholder="이 조합에서 느낀 점 / 프리셋 세부 설정 중 달랐던 부분 등"></textarea>
        </div>

        <details class="msnap-details">
            <summary>캡처된 파라미터 보기</summary>
            ${paramsBlock(cap.data.params)}
        </details>
    `;

    const footerHtml = `
        <button class="msnap-btn" data-act="cancel">취소</button>
        <button class="msnap-btn msnap-btn-primary" data-act="save">저장</button>`;

    return modalCustom({
        title: '📸 스냅샷',
        bodyHtml,
        footerHtml,
        wide: true,
        setup: (root, close) => {
            const labelsRoot = root.querySelector('[data-el="labels"]');
            bindLabelPicker(labelsRoot);

            root.querySelector('[data-act="cancel"]').addEventListener('click', () => close('cancelled'));

            root.querySelector('[data-act="save"]').addEventListener('click', async () => {
                try {
                    // 약칭 등록
                    const provInp = root.querySelector('[data-el="provAlias"]');
                    if (provInp && provider) {
                        const alias = provInp.value.trim();
                        await store.updateProvider(provider.id, {
                            alias: alias || provider.alias,
                            pending: false,
                        });
                    }
                    const mdlInp = root.querySelector('[data-el="mdlAlias"]');
                    if (mdlInp && model) {
                        const alias = mdlInp.value.trim();
                        const vendor = root.querySelector('[data-el="mdlVendor"]')?.value.trim() ?? '';
                        await store.updateModel(model.id, {
                            alias: alias || model.alias,
                            vendor,
                            pending: false,
                        });
                    }

                    const mesRaw = root.querySelector('[data-el="mesId"]').value.trim();
                    const mesId = mesRaw === '' ? null : parseInt(mesRaw, 10);
                    const newCtx = { ...snap.ctx };
                    if (mesId !== snap.ctx.mesId) {
                        newCtx.mesId = Number.isNaN(mesId) ? null : mesId;
                        // 번호를 손으로 바꿨으면 해시를 다시 계산한다
                        const ctx = getContextSafe();
                        const reCap = captureChatContext(ctx, newCtx.mesId);
                        newCtx.mesHash = reCap.ctxInfo.mesHash;
                    }

                    await store.updateSnapshot(snap.id, {
                        labels: readLabelPicker(labelsRoot),
                        memo: root.querySelector('[data-el="memo"]').value,
                        ctx: newCtx,
                    });
                    close('saved');
                } catch (e) {
                    diag('error', '스냅샷 저장 실패', e?.message);
                    toastMsg('error', `저장 실패: ${e?.message ?? e}`);
                }
            });
        },
    }).then(v => (v === 'saved' ? 'saved' : 'cancelled'));
}

/** 기존 스냅샷 편집 */
export function editSnapshot(snap, onDone) {
    const card = store.getCard(snap.cardId);
    const provider = card ? store.getProvider(card.providerId) : null;
    const model = card ? store.getModel(card.modelId) : null;

    const bodyHtml = `
        <div class="msnap-section">
            <div class="msnap-kvlist">
                <div class="msnap-kv"><span>카드</span><b>${escapeHtml(model?.alias ?? '?')} @ ${escapeHtml(provider?.alias ?? '?')}</b></div>
                <div class="msnap-kv"><span>일시</span><b>${escapeHtml(fmtDate(snap.ts))}</b></div>
                <div class="msnap-kv"><span>캐릭터</span><b>${escapeHtml(snap.ctx?.charName ?? '(없음)')}</b></div>
                <div class="msnap-kv"><span>채팅방</span><b>${escapeHtml(snap.ctx?.chatFile ?? '(없음)')}</b></div>
            </div>
            <div class="msnap-field">
                <div class="msnap-label">메시지 번호</div>
                <input type="number" class="msnap-input" data-el="mesId" value="${snap.ctx?.mesId ?? ''}">
                <div class="msnap-hint">번호를 바꾸면 이동 검증용 지문이 갱신되지 않습니다. 다른 채팅에서는 부정확할 수 있습니다.</div>
            </div>
        </div>
        <div class="msnap-section">
            <div class="msnap-section-title">라벨</div>
            <div class="msnap-labels" data-el="labels">${renderLabelPicker(snap.labels ?? [])}</div>
        </div>
        <div class="msnap-section">
            <div class="msnap-label">메모</div>
            <textarea class="msnap-input msnap-textarea" data-el="memo">${escapeHtml(snap.memo ?? '')}</textarea>
        </div>
        <details class="msnap-details">
            <summary>캡처된 파라미터 보기</summary>
            ${paramsBlock(snap.params)}
        </details>`;

    return modalCustom({
        title: '스냅샷 편집',
        bodyHtml,
        footerHtml: `<button class="msnap-btn" data-act="cancel">취소</button>
                     <button class="msnap-btn msnap-btn-primary" data-act="save">저장</button>`,
        wide: true,
        setup: (root, close) => {
            const labelsRoot = root.querySelector('[data-el="labels"]');
            bindLabelPicker(labelsRoot);
            root.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
            root.querySelector('[data-act="save"]').addEventListener('click', async () => {
                const mesRaw = root.querySelector('[data-el="mesId"]').value.trim();
                const mesId = mesRaw === '' ? null : parseInt(mesRaw, 10);
                await store.updateSnapshot(snap.id, {
                    labels: readLabelPicker(labelsRoot),
                    memo: root.querySelector('[data-el="memo"]').value,
                    ctx: { ...snap.ctx, mesId: Number.isNaN(mesId) ? null : mesId },
                });
                close(true);
                onDone?.();
            });
        },
    });
}
