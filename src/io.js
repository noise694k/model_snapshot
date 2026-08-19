/**
 * io.js — 내보내기 / 가져오기 / 전체 삭제
 *
 * 안전 원칙:
 *  - 가져오기는 절대 통째로 덮어쓰지 않는다. 먼저 요약을 보여주고 사용자가 방식을 고른다.
 *  - 전체 삭제는 DELETE 문자열 입력을 요구한다.
 *  - 내보내기 JSON 에는 schemaVersion 을 박아 나중에 마이그레이션할 수 있게 한다.
 */

import {
    STORES, SCHEMA_VERSION, dbClearStore, diag, fmtDate, getSettings, saveSettings,
} from './core.js';
import * as store from './store.js';
import { PARAM_FIELDS } from './capture.js';
import { labelDisplay } from './labels.js';

const EXPORT_KIND = 'st-model-snapshot';

// ────────────────────────────────────────────────────────────
// 내보내기 (JSON)
// ────────────────────────────────────────────────────────────
export function buildExportObject() {
    return {
        kind: EXPORT_KIND,
        schemaVersion: SCHEMA_VERSION,
        exportedAt: Date.now(),
        exportedAtText: fmtDate(Date.now()),
        notice: '이 파일에는 프로바이더 엔드포인트 URL이 포함됩니다. 공유 시 주의하세요. (API 키/비밀번호는 포함되지 않습니다)',
        providers: store.allProviders(),
        models: store.allModels(),
        cards: store.allCards(),
        snapshots: store.allSnapshots(),
        labels: store.rawLabelRows(),
    };
}

export function downloadText(filename, text, mime = 'application/json') {
    try {
        const blob = new Blob([text], { type: `${mime};charset=utf-8` });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            URL.revokeObjectURL(url);
            a.remove();
        }, 1000);
        return true;
    } catch (e) {
        diag('error', '파일 다운로드 실패', e?.message);
        return false;
    }
}

export async function exportJson() {
    const obj = buildExportObject();
    const ts = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const name = `model-snapshot_${ts.getFullYear()}${p(ts.getMonth() + 1)}${p(ts.getDate())}_${p(ts.getHours())}${p(ts.getMinutes())}.json`;
    const ok = downloadText(name, JSON.stringify(obj, null, 2));
    if (ok) await saveSettings({ lastExportAt: Date.now() });
    return { ok, name, counts: countsOf(obj) };
}

function countsOf(obj) {
    return {
        providers: obj.providers?.length ?? 0,
        models: obj.models?.length ?? 0,
        cards: obj.cards?.length ?? 0,
        snapshots: obj.snapshots?.length ?? 0,
        labels: obj.labels?.length ?? 0,
    };
}

// ────────────────────────────────────────────────────────────
// 내보내기 (Markdown)
// ────────────────────────────────────────────────────────────
/**
 * @param {Array} cards 내보낼 카드 목록 (필터 결과를 그대로 넘길 수 있음)
 */
export function buildMarkdown(cards) {
    const labelMap = store.getLabelMap();
    const lines = [];
    lines.push('# 모델 스냅샷');
    lines.push('');
    lines.push(`> 내보낸 시각: ${fmtDate(Date.now())} · 카드 ${cards.length}개`);
    lines.push('');

    // 프로바이더 요약
    const provIds = [...new Set(cards.map(c => c.providerId))];
    if (provIds.length) {
        lines.push('## 프로바이더');
        lines.push('');
        for (const pid of provIds) {
            const p = store.getProvider(pid);
            if (!p) continue;
            const status = p.status && p.status !== 'ok' ? ` · 상태: ${statusText(p.status)}` : '';
            lines.push(`- **${p.alias}**${status}`);
            if (p.priceUrl) lines.push(`  - 가격: ${p.priceUrl}`);
            for (const l of (p.links ?? [])) {
                if (l?.url) lines.push(`  - ${l.name || '링크'}: ${l.url}`);
            }
            if (p.memo) lines.push(`  - 메모: ${oneLine(p.memo)}`);
        }
        lines.push('');
    }

    lines.push('## 카드');
    lines.push('');
    for (const c of cards) {
        const prov = store.getProvider(c.providerId);
        const mdl = store.getModel(c.modelId);
        const title = `${mdl?.alias ?? '(모델?)'} @ ${prov?.alias ?? '(프로바이더?)'}`;
        const stars = c.rating ? ` ${'★'.repeat(c.rating)}${'☆'.repeat(5 - c.rating)}` : '';
        lines.push(`### ${c.star ? '⭐ ' : ''}${title}${stars}`);
        lines.push('');
        lines.push(`- 후처리: ${c.postProcessing ?? '(미설정)'}`);
        lines.push(`- 프리셋: ${c.presetName ?? '(불명)'}`);
        if (mdl?.vendor) lines.push(`- 벤더: ${mdl.vendor}`);
        if (c.memo) {
            lines.push('- 총평:');
            for (const ln of String(c.memo).split('\n')) lines.push(`  > ${ln}`);
        }
        const snaps = store.snapshotsOfCard(c.id);
        if (!snaps.length) {
            lines.push('- 스냅샷: 없음');
        } else {
            lines.push(`- 스냅샷 ${snaps.length}개`);
            lines.push('');
            for (const s of snaps) {
                const lab = (s.labels ?? [])
                    .map(e => labelDisplay(labelMap.get(e.id), e))
                    .filter(Boolean).join(', ');
                const ctxTxt = [
                    s.ctx?.charName ? `캐릭터 ${s.ctx.charName}` : null,
                    s.ctx?.chatFile ? `채팅 ${s.ctx.chatFile}` : null,
                    (s.ctx?.mesId ?? null) !== null ? `#${s.ctx.mesId}` : null,
                ].filter(Boolean).join(' · ');
                lines.push(`  - **${fmtDate(s.ts)}** ${ctxTxt ? `— ${ctxTxt}` : ''}`);
                if (lab) lines.push(`    - 라벨: ${lab}`);
                if (s.params) {
                    const ps = PARAM_FIELDS
                        .map(f => (s.params[f.key] === null || s.params[f.key] === undefined) ? null : `${f.label} ${s.params[f.key]}`)
                        .filter(Boolean).join(' / ');
                    if (ps) lines.push(`    - 파라미터: ${ps}`);
                }
                if (s.memo) {
                    for (const ln of String(s.memo).split('\n')) lines.push(`    - ${ln}`);
                }
            }
        }
        lines.push('');
    }
    return lines.join('\n');
}

function oneLine(s) {
    return String(s ?? '').replace(/\s*\n\s*/g, ' / ');
}

export function statusText(status) {
    return { ok: '정상', unstable: '불안정', dead: '죽음', paid: '유료전환' }[status] ?? status;
}

export function exportMarkdown(cards) {
    const md = buildMarkdown(cards);
    const ts = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const name = `model-snapshot_${ts.getFullYear()}${p(ts.getMonth() + 1)}${p(ts.getDate())}.md`;
    return { ok: downloadText(name, md, 'text/markdown'), name, size: md.length };
}

// ────────────────────────────────────────────────────────────
// 가져오기
// ────────────────────────────────────────────────────────────
export function parseImportFile(text) {
    let obj;
    try {
        obj = JSON.parse(text);
    } catch (e) {
        return { ok: false, error: 'JSON 파싱에 실패했습니다. 올바른 내보내기 파일인지 확인해주세요.' };
    }
    if (obj?.kind !== EXPORT_KIND) {
        return { ok: false, error: '이 확장에서 내보낸 파일이 아닙니다.' };
    }
    if (typeof obj.schemaVersion !== 'number') {
        return { ok: false, error: 'schemaVersion 정보가 없습니다.' };
    }
    if (obj.schemaVersion > SCHEMA_VERSION) {
        return { ok: false, error: `더 새로운 버전(v${obj.schemaVersion})의 파일입니다. 확장을 먼저 업데이트해주세요.` };
    }
    for (const k of ['providers', 'models', 'cards', 'snapshots']) {
        if (!Array.isArray(obj[k])) return { ok: false, error: `필수 항목 누락: ${k}` };
    }
    return { ok: true, data: obj };
}

/** 병합 전 요약 — 사용자가 방식을 고르기 전에 보여준다. */
export function analyzeImport(data) {
    const cur = {
        providers: new Set(store.allProviders().map(x => x.id)),
        models: new Set(store.allModels().map(x => x.id)),
        cards: new Set(store.allCards().map(x => x.id)),
        snapshots: new Set(store.allSnapshots().map(x => x.id)),
        labels: new Set(store.rawLabelRows().map(x => x.id)),
    };
    const res = {};
    for (const k of ['providers', 'models', 'cards', 'snapshots', 'labels']) {
        const rows = data[k] ?? [];
        let neu = 0, conflict = 0;
        for (const r of rows) {
            if (cur[k].has(r.id)) conflict++; else neu++;
        }
        res[k] = { total: rows.length, neu, conflict, existing: cur[k].size };
    }
    return res;
}

/**
 * @param {'merge_keep'|'merge_overwrite'|'replace'} mode
 *   merge_keep      : 기존 우선 (충돌 항목은 건드리지 않음)
 *   merge_overwrite : 파일 우선 (충돌 항목을 파일 값으로 교체)
 *   replace         : 전체 삭제 후 파일 내용으로 대체
 */
export async function applyImport(data, mode) {
    const keys = [
        ['providers', STORES.providers],
        ['models', STORES.models],
        ['cards', STORES.cards],
        ['snapshots', STORES.snapshots],
        ['labels', STORES.labels],
    ];

    if (mode === 'replace') {
        for (const [, s] of keys) await dbClearStore(s);
        store.resetCache();
    }

    const existing = {
        providers: new Set(store.allProviders().map(x => x.id)),
        models: new Set(store.allModels().map(x => x.id)),
        cards: new Set(store.allCards().map(x => x.id)),
        snapshots: new Set(store.allSnapshots().map(x => x.id)),
        labels: new Set(store.rawLabelRows().map(x => x.id)),
    };

    const written = {};
    for (const [k, s] of keys) {
        let rows = (data[k] ?? []).filter(r => r && r.id);
        if (mode === 'merge_keep') rows = rows.filter(r => !existing[k].has(r.id));
        await store.bulkPut(s, rows);
        written[k] = rows.length;
    }

    // 카드 cardKey 무결성 재계산 (구버전 파일 대비)
    for (const c of store.allCards()) {
        const key = store.makeCardKey(c.providerId, c.modelId, c.postProcessing, c.presetName);
        if (c.cardKey !== key) await store.updateCard(c.id, {});
    }

    diag('info', `가져오기 완료 (${mode})`, written);
    return written;
}

// ────────────────────────────────────────────────────────────
// 전체 삭제
// ────────────────────────────────────────────────────────────
export async function wipeAll(confirmText) {
    if (String(confirmText).trim() !== 'DELETE') {
        return { ok: false, error: 'DELETE 를 정확히 입력해야 삭제됩니다.' };
    }
    for (const s of [STORES.providers, STORES.models, STORES.cards, STORES.snapshots, STORES.labels]) {
        await dbClearStore(s);
    }
    store.resetCache();
    diag('warn', '전체 데이터 삭제 완료');
    return { ok: true };
}

// ────────────────────────────────────────────────────────────
// 내보내기 리마인더
// ────────────────────────────────────────────────────────────
export function exportReminderDue() {
    const s = getSettings();
    if (!s.exportReminder) return false;
    if (!store.allSnapshots().length) return false;
    const days = s.exportReminderDays ?? 7;
    const last = s.lastExportAt ?? 0;
    if (!last) return true;
    return (Date.now() - last) > days * 24 * 60 * 60 * 1000;
}
