/**
 * labels.js — 라벨 정의
 *
 * 두 종류가 있다:
 *  1) chip  : 눌러서 켜고 끄는 단순 라벨
 *  2) axis  : 3단 토글 (미선택 / 👍 / 👎) — 품질 축 전용
 *
 * 기본 라벨은 코드에 정의되어 있고, 사용자 커스텀 라벨은 IndexedDB labels 스토어에 저장된다.
 * 기본 라벨은 삭제 대신 "숨김" 처리만 가능하다. (기존 스냅샷의 참조가 깨지지 않도록)
 */

export const LABEL_GROUPS = [
    { id: 'censor', name: '검열', color: '#e05c5c' },
    { id: 'reasoning', name: '추론', color: '#7a86e0' },
    { id: 'quality', name: '품질', color: '#3fa870' },
    { id: 'anomaly', name: '이상증상', color: '#d9922e' },
    { id: 'tech', name: '기술이슈', color: '#9b59b6' },
    { id: 'speed', name: '속도', color: '#2f9fb5' },
    { id: 'price', name: '가격', color: '#c2883a' },
    { id: 'etc', name: '기타', color: '#7d8a95' },
];

/** 기본 라벨 */
export const DEFAULT_LABELS = [
    // 검열
    { id: 'cen_hard', group: 'censor', name: '하드검열', type: 'chip' },
    { id: 'cen_soft', group: 'censor', name: '소프트검열', type: 'chip' },
    { id: 'cen_jb_ok', group: 'censor', name: '탈옥성공', type: 'chip' },

    // 추론
    { id: 'rsn_box', group: 'reasoning', name: '추론(박스)', type: 'chip' },
    { id: 'rsn_body', group: 'reasoning', name: '추론(본문)', type: 'chip' },
    { id: 'rsn_none', group: 'reasoning', name: '추론없음', type: 'chip' },
    { id: 'rsn_mixed', group: 'reasoning', name: '추론본문섞임', type: 'chip' },

    // 품질 (3단 토글)
    { id: 'q_style', group: 'quality', name: '문체', type: 'axis' },
    { id: 'q_char', group: 'quality', name: '캐해', type: 'axis' },
    { id: 'q_plot', group: 'quality', name: '전개', type: 'axis' },
    { id: 'q_instr', group: 'quality', name: '지시이행', type: 'axis' },

    // 이상증상
    { id: 'an_sentence', group: 'anomaly', name: '이상한문장', type: 'chip' },
    { id: 'an_plot', group: 'anomaly', name: '이상한전개', type: 'chip' },
    { id: 'an_char', group: 'anomaly', name: '이상한캐해', type: 'chip' },
    { id: 'an_control', group: 'anomaly', name: '포식통제', type: 'chip' },
    { id: 'an_goody', group: 'anomaly', name: '범생이', type: 'chip' },

    // 기술이슈
    { id: 'tc_memory', group: 'tech', name: '기억력이슈', type: 'chip' },
    { id: 'tc_ctxdrop', group: 'tech', name: '컨텍미주입의심', type: 'chip' },
    { id: 'tc_othermodel', group: 'tech', name: '타모델의심', type: 'chip' },

    // 속도
    { id: 'sp_fast', group: 'speed', name: '빠름', type: 'chip' },
    { id: 'sp_slow', group: 'speed', name: '느림', type: 'chip' },

    // 가격 · 기타 그룹은 기본 라벨을 두지 않는다. 사용자가 직접 만들어 쓰는 자리.
];

const DEFAULT_LABEL_IDS = new Set(DEFAULT_LABELS.map(l => l.id));

export function isDefaultLabel(id) {
    return DEFAULT_LABEL_IDS.has(id);
}

export function getGroupMeta(groupId) {
    return LABEL_GROUPS.find(g => g.id === groupId) ?? LABEL_GROUPS[LABEL_GROUPS.length - 1];
}

/**
 * 기본 라벨 + 커스텀 라벨 병합.
 * @param {Array} customLabels IndexedDB 에서 읽은 커스텀/오버라이드 레코드
 */
export function mergeLabels(customLabels) {
    const overrides = new Map();
    const extras = [];
    for (const c of (customLabels ?? [])) {
        if (isDefaultLabel(c.id)) overrides.set(c.id, c);
        else extras.push(c);
    }
    const base = DEFAULT_LABELS.map(l => {
        const o = overrides.get(l.id);
        return o ? { ...l, hidden: !!o.hidden, name: o.name ?? l.name } : { ...l, hidden: false };
    });
    const custom = extras.map(c => ({
        id: c.id,
        group: c.group ?? 'etc',
        name: c.name ?? '(이름없음)',
        type: c.type === 'axis' ? 'axis' : 'chip',
        hidden: !!c.hidden,
        custom: true,
    }));
    return [...base, ...custom];
}

/** 스냅샷의 labels 배열 형식:
 *   chip → { id }
 *   axis → { id, v: 1 | -1 }
 */
export function labelDisplay(labelDef, entry) {
    if (!labelDef) return '(삭제된 라벨)';
    if (labelDef.type === 'axis') {
        const mark = entry?.v === 1 ? '👍' : entry?.v === -1 ? '👎' : '';
        return `${labelDef.name}${mark}`;
    }
    return labelDef.name;
}
