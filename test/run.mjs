/**
 * 실제 동작 검증 테스트 (UI만 만들고 기능은 없는 상태를 방지하기 위한 실검증)
 * jsdom + fake-indexeddb 로 브라우저 환경을 흉내내고, 실제 모듈을 그대로 돌린다.
 */
import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';

// ── jsdom 전역 세팅 (모듈 import 전에) ──
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="extensionsMenu"></div><div id="chat"></div></body></html>', {
    url: 'https://localhost/',
});
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
global.Blob = dom.window.Blob;
global.HTMLElement = dom.window.HTMLElement;
global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
global.CSS = dom.window.CSS;
global.URL.createObjectURL = () => 'blob:mock';
global.URL.revokeObjectURL = () => {};

let results = [];
let failed = 0;
function check(name, cond, detail) {
    results.push({ name, ok: !!cond, detail });
    if (!cond) { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
    else console.log(`  ✓ ${name}`);
}
function section(t) { console.log(`\n── ${t} ──`); }
const tick = (n = 1) => new Promise(r => setTimeout(r, n));

// ── SillyTavern 목 (deepFreeze 로 "쓰기 시도"를 잡아낸다) ──
function deepFreeze(o) {
    Object.getOwnPropertyNames(o).forEach(k => {
        const v = o[k];
        if (v && typeof v === 'object') deepFreeze(v);
    });
    return Object.freeze(o);
}

const mockChat = [
    { mes: '안녕하세요 첫 메시지입니다', is_user: true, name: '나' },
    { mes: '반갑습니다. 저는 단테입니다.', is_user: false, name: '단테' },
    { mes: '두 번째 답변입니다. 문체가 꽤 좋네요.', is_user: false, name: '단테' },
];

let mockOai = {
    chat_completion_source: 'custom',
    custom_url: 'https://api.myproxy.xyz/v1',
    custom_model: 'gemini-3.2-pro',
    custom_prompt_post_processing: 'claude',
    preset_settings_openai: '내프리셋A',
    reverse_proxy: '',
    reverse_proxy_password: 'SECRET-DO-NOT-CAPTURE',
    temp_openai: 1.0,
    top_p_openai: 0.95,
    top_k_openai: 0,
    freq_pen_openai: 0,
    pres_pen_openai: 0,
    reasoning_effort: 'medium',
    verbosity: 'medium',
    openai_api_key: 'sk-SECRET',
};

const mockCtx = {
    chat: mockChat,
    characters: [{ avatar: 'dante.png', name: '단테', chat: 'dante_2026-08-01.jsonl' }],
    characterId: 0,
    groupId: null,
    groups: [],
    mainApi: 'openai',
    getCurrentChatId: () => 'dante_2026-08-01',
    eventSource: { once: () => {}, removeListener: () => {} },
    eventTypes: { CHAT_CHANGED: 'chat_changed' },
    get chatCompletionSettings() { return mockOai; },
};

global.SillyTavern = { getContext: () => mockCtx };
deepFreeze(mockChat);
deepFreeze(mockCtx.characters);

// 다운로드 가로채기 (파일 저장 대신 내용을 캡처)
const downloads = [];
const origCreate = dom.window.document.createElement.bind(dom.window.document);
let lastBlobText = null;
dom.window.Blob = class MockBlob {
    constructor(parts) { this._text = parts.join(''); lastBlobText = this._text; }
    text() { return Promise.resolve(this._text); }
};
global.Blob = dom.window.Blob;

// ── 모듈 로드 ──
const core = await import('../st-model-snapshot/src/core.js');
const capture = await import('../st-model-snapshot/src/capture.js');
const store = await import('../st-model-snapshot/src/store.js');
const io = await import('../st-model-snapshot/src/io.js');
const jump = await import('../st-model-snapshot/src/jump.js');
const shot = await import('../st-model-snapshot/src/ui-shot.js');
const labels = await import('../st-model-snapshot/src/labels.js');

await core.openDB();
await core.loadSettings();
await store.loadAll();

// ════════════════════════════════════════════════════════════
section('1. 저장소 / 설정');
check('IndexedDB 열림', true);
check('기본 설정 captureParams=true', core.getSettings().captureParams === true);
await core.saveSettings({ captureParams: false });
check('설정 저장 반영', core.getSettings().captureParams === false);
await core.saveSettings({ captureParams: true });
const reread = await core.loadSettings();
check('설정 영속화(재로드)', reread.captureParams === true);

// ════════════════════════════════════════════════════════════
section('2. 캡처 (읽기 전용 / 비밀정보 미수집)');
let cap = capture.captureModelState({ captureParams: true });
check('소스 = custom', cap.data.source === 'custom', cap.data.source);
check('엔드포인트 = custom_url', cap.data.endpoint === 'https://api.myproxy.xyz/v1', cap.data.endpoint);
check('호스트 추출', cap.data.endpointHost === 'api.myproxy.xyz', cap.data.endpointHost);
check('모델명', cap.data.modelRaw === 'gemini-3.2-pro', cap.data.modelRaw);
check('후처리', cap.data.postProcessing === 'claude', cap.data.postProcessing);
check('프리셋명', cap.data.presetName === '내프리셋A', cap.data.presetName);
check('파라미터 7종 캡처', Object.keys(cap.data.params).length === 7, JSON.stringify(cap.data.params));
check('temperature 값', cap.data.params.temperature === 1.0);
check('reasoning_effort 값', cap.data.params.reasoning_effort === 'medium');

const capJson = JSON.stringify(cap.data);
check('프록시 비밀번호 미포함', !capJson.includes('SECRET-DO-NOT-CAPTURE'));
check('API 키 미포함', !capJson.includes('sk-SECRET'));
check('읽기 실패 없음', cap.fails.length === 0, cap.fails.join(','));

// 파라미터 캡처 OFF
const capOff = capture.captureModelState({ captureParams: false });
check('captureParams=false 시 params=null', capOff.data.params === null);

// vertexai + reverse_proxy 경로
mockOai = { ...mockOai, chat_completion_source: 'vertexai', vertexai_model: 'claude-opus-4-6', reverse_proxy: 'https://proxy2.example.com/v1', custom_url: '' };
const capV = capture.captureModelState({ captureParams: true });
check('vertexai 모델 인식', capV.data.modelRaw === 'claude-opus-4-6', capV.data.modelRaw);
check('reverse_proxy 를 엔드포인트로 사용', capV.data.endpoint === 'https://proxy2.example.com/v1', capV.data.endpoint);
check('vertexai 에서도 후처리 읽힘', capV.data.postProcessing === 'claude', String(capV.data.postProcessing));
// 원복
mockOai = { ...mockOai, chat_completion_source: 'custom', custom_url: 'https://api.myproxy.xyz/v1', reverse_proxy: '' };

// 약칭 제안
check('벤더 제안 gemini→젬', capture.suggestVendor('gemini-3.2-pro') === '젬');
check('벤더 제안 claude→옾', capture.suggestVendor('claude-opus-4-6') === '옾', capture.suggestVendor('claude-opus-4-6'));
check('sonnet 도 같은 벤더로 묶임', capture.suggestVendor('claude-sonnet-4-6') === '옾');
// 모델 약칭 기본값 = 모델 문자열 전체 (임의 절단 금지)
const proxyModel = '[0.25]a마/claude-opus-4-6';
check('약칭 기본값 = 원본 전체 (프록시 접두사 포함)', capture.suggestModelAlias(proxyModel) === proxyModel, capture.suggestModelAlias(proxyModel));
check('가격표 [0.25] 를 버전으로 오인하지 않음', !capture.suggestModelAlias(proxyModel).includes('오푸스0.25'));
check('약칭 기본값 = 원본 전체 (일반 모델)', capture.suggestModelAlias('gemini-3.2-pro') === 'gemini-3.2-pro');
check('약칭 기본값 = 원본 전체 (날짜 포함)', capture.suggestModelAlias('gemini-3.2-pro-preview-20250801') === 'gemini-3.2-pro-preview-20250801');
check('긴 모델명도 절단 안 됨', capture.suggestModelAlias('a'.repeat(80)).length === 80);
check('빈 모델명 안전 처리', capture.suggestModelAlias(null) === '' && capture.suggestModelAlias(undefined) === '');
check('프록시 접두사 모델의 벤더도 인식', capture.suggestVendor(proxyModel) === '옾');
check('프로바이더 약칭 제안', capture.suggestProviderAlias('https://api.myproxy.xyz/v1') === 'myproxy', capture.suggestProviderAlias('https://api.myproxy.xyz/v1'));

// 컨텍스트 캡처 (DOM 메시지)
document.getElementById('chat').innerHTML = mockChat.map((m, i) => `<div class="mes" mesid="${i}"></div>`).join('');
const cc = capture.captureChatContext(mockCtx);
check('캐릭터 키 = 아바타 파일명', cc.ctxInfo.charKey === 'dante.png', cc.ctxInfo.charKey);
check('캐릭터명 박제', cc.ctxInfo.charName === '단테');
check('채팅 파일명 박제', cc.ctxInfo.chatFile === 'dante_2026-08-01.jsonl');
check('메시지 번호', cc.ctxInfo.mesId === 2, String(cc.ctxInfo.mesId));
check('메시지 지문 16자', typeof cc.ctxInfo.mesHash === 'string' && cc.ctxInfo.mesHash.length === 16, cc.ctxInfo.mesHash);
check('지문에서 원문 복원 불가(본문 미포함)', !JSON.stringify(cc.ctxInfo).includes('두 번째 답변'));

// ════════════════════════════════════════════════════════════
section('3. SHOT 전체 흐름 (모달 실제 조작)');

async function runShot({ labelsToPick = [], memo = '', provAlias = null, mdlAlias = null, vendor = null } = {}) {
    const p = shot.doShot();
    await tick(20);
    const modal = document.querySelector('.msnap-modal-backdrop:last-of-type .msnap-modal')
        || document.querySelector('.msnap-modal');
    if (!modal) throw new Error('모달이 열리지 않음');
    if (provAlias !== null) {
        const el = modal.querySelector('[data-el="provAlias"]');
        if (el) el.value = provAlias;
    }
    if (mdlAlias !== null) {
        const el = modal.querySelector('[data-el="mdlAlias"]');
        if (el) el.value = mdlAlias;
    }
    if (vendor !== null) {
        const el = modal.querySelector('[data-el="mdlVendor"]');
        if (el) el.value = vendor;
    }
    for (const pick of labelsToPick) {
        const chip = modal.querySelector(`[data-label-id="${pick.id}"]`);
        if (!chip) throw new Error(`라벨 칩 없음: ${pick.id}`);
        const times = pick.v === 1 ? 1 : pick.v === -1 ? 2 : 1;
        for (let i = 0; i < times; i++) chip.click();
    }
    modal.querySelector('[data-el="memo"]').value = memo;
    modal.querySelector('[data-act="save"]').click();
    await tick(20);
    await p;
    return p;
}

await runShot({
    labelsToPick: [{ id: 'q_style', v: 1 }, { id: 'cen_soft' }],
    mem: '',
    memo: '문체 좋음. 검열 살짝 있음.',
    provAlias: '마프',
    mdlAlias: '젬3.2',
    vendor: '젬',
});

check('프로바이더 1개 생성', store.allProviders().length === 1, String(store.allProviders().length));
check('모델 1개 생성', store.allModels().length === 1);
check('카드 1개 생성', store.allCards().length === 1);
check('스냅샷 1개 생성', store.allSnapshots().length === 1);

let prov = store.allProviders()[0];
let mdl = store.allModels()[0];
let card = store.allCards()[0];
let snap = store.allSnapshots()[0];

check('약칭 등록됨 (프로바이더)', prov.alias === '마프', prov.alias);
check('약칭 등록됨 (모델)', mdl.alias === '젬3.2', mdl.alias);
check('벤더 등록됨', mdl.vendor === '젬', mdl.vendor);
check('pending 해제됨', prov.pending === false && mdl.pending === false);
check('메모 저장됨', snap.memo === '문체 좋음. 검열 살짝 있음.', snap.memo);
check('라벨 저장됨 (2개)', snap.labels.length === 2, JSON.stringify(snap.labels));
check('3단 토글 값 저장 (문체👍)', snap.labels.some(l => l.id === 'q_style' && l.v === 1), JSON.stringify(snap.labels));
check('단순 칩 저장 (소프트검열)', snap.labels.some(l => l.id === 'cen_soft' && l.v === undefined));
check('파라미터 저장됨', snap.params && snap.params.temperature === 1.0);
check('캐릭터명 박제됨', snap.ctx.charName === '단테');
check('메시지 지문 저장됨', !!snap.ctx.mesHash);
check('스냅샷에 본문 미저장', !JSON.stringify(snap).includes('두 번째 답변'));

// ════════════════════════════════════════════════════════════
section('4. 카드 분류 규칙 (Q2 확정 사항)');

// 4-1. 완전히 동일 → 같은 카드
await runShot({ memo: '두번째 샷' });
check('동일 설정 → 같은 카드에 누적', store.allCards().length === 1, `카드 ${store.allCards().length}`);
check('스냅샷 2개', store.allSnapshots().length === 2);

// 4-2. 파라미터만 변경 → 같은 카드 (분류 기준 아님)
mockOai = { ...mockOai, temp_openai: 1.3, top_p_openai: 0.8 };
await runShot({ memo: '온도만 1.3으로 바꿈' });
check('파라미터만 달라도 같은 카드', store.allCards().length === 1, `카드 ${store.allCards().length}`);
const snapsNow = store.snapshotsOfCard(card.id);
check('파라미터 변경분이 raw 로 저장됨', snapsNow[0].params.temperature === 1.3, String(snapsNow[0].params.temperature));
check('이전 스냅샷 파라미터는 그대로', snapsNow[2].params.temperature === 1.0, String(snapsNow[2].params.temperature));

// 4-3. 후처리 변경 → 새 카드
mockOai = { ...mockOai, custom_prompt_post_processing: 'merge' };
await runShot({ memo: '후처리 merge' });
check('후처리 다르면 새 카드', store.allCards().length === 2, `카드 ${store.allCards().length}`);

// 4-4. 프리셋명 변경 → 새 카드
mockOai = { ...mockOai, custom_prompt_post_processing: 'claude', preset_settings_openai: '내프리셋B' };
await runShot({ memo: '프리셋 B' });
check('프리셋명 다르면 새 카드', store.allCards().length === 3, `카드 ${store.allCards().length}`);

// 4-5. 모델 변경 → 새 카드 + 새 모델 엔티티
mockOai = { ...mockOai, preset_settings_openai: '내프리셋A', custom_model: 'claude-opus-4-6' };
await runShot({ memo: '옾으로 변경', mdlAlias: '옾4.6', vendor: '클' });
check('모델 다르면 새 카드', store.allCards().length === 4, `카드 ${store.allCards().length}`);
check('모델 엔티티 2개', store.allModels().length === 2);
check('프로바이더는 그대로 1개', store.allProviders().length === 1);

// 4-6. 프로바이더 변경 → 새 카드 + 새 프로바이더 엔티티
mockOai = { ...mockOai, custom_url: 'https://api.other-proxy.io/v1', custom_model: 'gemini-3.2-pro' };
await runShot({ memo: '다른 프록시', provAlias: '아더' });
check('프로바이더 다르면 새 카드', store.allCards().length === 5, `카드 ${store.allCards().length}`);
check('프로바이더 엔티티 2개', store.allProviders().length === 2);
check('모델 엔티티는 재사용 (2개 유지)', store.allModels().length === 2, `모델 ${store.allModels().length}`);

// 원복
mockOai = { ...mockOai, custom_url: 'https://api.myproxy.xyz/v1', temp_openai: 1.0, top_p_openai: 0.95 };

// ════════════════════════════════════════════════════════════
section('5. 약칭 변경이 카드를 쪼개지 않는가 (엔티티 ID 키)');
const cardCountBefore = store.allCards().length;
const cardKeyBefore = card.cardKey;
await store.updateProvider(prov.id, { alias: '마이프록시(개명)' });
await store.updateModel(mdl.id, { alias: '제미나이3.2프로' });
await runShot({ memo: '약칭 바꾼 뒤 샷' });
check('약칭 변경 후에도 카드 수 동일', store.allCards().length === cardCountBefore, `${store.allCards().length} vs ${cardCountBefore}`);
check('cardKey 불변', store.getCard(card.id).cardKey === cardKeyBefore);
check('표시 약칭은 바뀜', store.getProvider(prov.id).alias === '마이프록시(개명)');

// ════════════════════════════════════════════════════════════
section('6. 삭제 정책 (Q6)');
const beforeSnaps = store.snapshotsOfCard(card.id).length;
await store.deleteSnapshot(store.snapshotsOfCard(card.id)[0].id);
check('스냅샷 삭제됨', store.snapshotsOfCard(card.id).length === beforeSnaps - 1);
check('카드는 남아있음', !!store.getCard(card.id));

// 전부 지워도 카드 유지
for (const s of store.snapshotsOfCard(card.id)) await store.deleteSnapshot(s.id);
check('샷 0개여도 카드 유지 ("샷 없음")', !!store.getCard(card.id) && store.snapshotsOfCard(card.id).length === 0);

// 카드 명시적 삭제
const tmpCard = store.allCards().find(c => c.id !== card.id);
const tmpSnapCount = store.snapshotsOfCard(tmpCard.id).length;
const removed = await store.deleteCard(tmpCard.id);
check('카드 삭제 시 소속 스냅샷도 제거', removed === tmpSnapCount && !store.getCard(tmpCard.id));

// ════════════════════════════════════════════════════════════
section('7. 검색 / 필터');
// 검색용 데이터 재구성
await store.updateCard(card.id, { memo: '이 조합은 야간에 특히 빠름' });
await runShot({ memo: '검색테스트용 스냅샷', labelsToPick: [{ id: 'tc_memory' }] });

function search(cards, q) {
    // ui-panel 의 matchSearch 와 동일 로직을 재현 (모듈 export 가 아니므로 여기서 검증)
    const labelMap = store.getLabelMap();
    return cards.filter(c => {
        const p = store.getProvider(c.providerId);
        const m = store.getModel(c.modelId);
        const parts = [p?.alias, ...(p?.hosts ?? []), m?.alias, m?.vendor, ...(m?.raws ?? []),
            c.postProcessing, c.presetName, c.memo];
        for (const s of store.snapshotsOfCard(c.id)) {
            parts.push(s.memo, s.ctx?.charName, s.ctx?.chatFile);
            for (const e of (s.labels ?? [])) parts.push(labelMap.get(e.id)?.name);
        }
        const hay = parts.filter(Boolean).join(' ').toLowerCase();
        return q.toLowerCase().split(/\s+/).filter(Boolean).every(t => hay.includes(t));
    });
}
check('약칭으로 검색', search(store.allCards(), '마이프록시').length > 0);
check('원본 모델명으로 검색', search(store.allCards(), 'gemini-3.2-pro').length > 0);
check('스냅샷 메모로 검색', search(store.allCards(), '검색테스트용').length === 1);
check('캐릭터명으로 검색', search(store.allCards(), '단테').length > 0);
check('라벨명으로 검색', search(store.allCards(), '기억력이슈').length === 1);
check('카드 총평으로 검색', search(store.allCards(), '야간에').length === 1);
check('없는 단어 검색 시 0건', search(store.allCards(), '존재하지않는단어zzz').length === 0);

// 라벨 필터 AND/OR
function labelFilter(cards, wants, mode) {
    return cards.filter(c => {
        const snaps = store.snapshotsOfCard(c.id);
        const has = (w) => snaps.some(s => (s.labels ?? []).some(e => e.id === w.id && (w.v === undefined || e.v === w.v)));
        return mode === 'and' ? wants.every(has) : wants.some(has);
    });
}
const andRes = labelFilter(store.allCards(), [{ id: 'tc_memory' }], 'and');
check('라벨 AND 필터', andRes.length === 1, String(andRes.length));
const orRes = labelFilter(store.allCards(), [{ id: 'tc_memory' }, { id: 'q_style', v: 1 }], 'or');
check('라벨 OR 필터', orRes.length >= 1, String(orRes.length));
const axisRes = labelFilter(store.allCards(), [{ id: 'q_style', v: -1 }], 'and');
check('3단 토글 방향 구분 (👎로 검색 시 0건)', axisRes.length === 0, String(axisRes.length));

// ════════════════════════════════════════════════════════════
section('7b. 엔드포인트 / 모델 문자열 묶기');
const pA = store.allProviders()[0];
const pB = store.allProviders()[1];
let hr = await store.setProviderHosts(pA.id, [...pA.hosts, 'https://api2.myproxy.xyz/v1']);
check('같은 프로바이더에 주소 추가', hr.ok === true, hr.error);
check('추가된 주소로 조회됨', store.findProviderByEndpoint('https://api2.myproxy.xyz/v1')?.id === pA.id);
hr = await store.setProviderHosts(pB.id, [...(pB?.hosts ?? []), 'https://api2.myproxy.xyz/v1']);
check('다른 프로바이더가 같은 주소 못 가져감', hr.ok === false, hr.error);
check('거부 시 원래 주인 유지', store.findProviderByEndpoint('https://api2.myproxy.xyz/v1')?.id === pA.id);

const mA = store.allModels()[0];
const mB = store.allModels()[1];
let rr = await store.setModelRaws(mA.id, [...mA.raws, 'gemini-3.2-pro-preview-0801']);
check('모델 문자열 변형 묶기', rr.ok === true, rr.error);
check('변형 문자열로 같은 모델 조회', store.findModelByRaw('gemini-3.2-pro-preview-0801')?.id === mA.id);
rr = await store.setModelRaws(mB.id, [...(mB?.raws ?? []), 'gemini-3.2-pro-preview-0801']);
check('중복 문자열 거부', rr.ok === false, rr.error);

// 실제로 묶임이 동작하는지: 변형 모델명으로 샷 → 새 모델이 안 생겨야 함
const modelsBefore = store.allModels().length;
const cardsBefore = store.allCards().length;
mockOai = { ...mockOai, custom_model: 'gemini-3.2-pro-preview-0801' };
await runShot({ memo: '변형 모델명으로 샷' });
check('변형 모델명 → 새 모델 엔티티 안 생김', store.allModels().length === modelsBefore, `${store.allModels().length} vs ${modelsBefore}`);
check('변형 모델명 → 기존 카드에 누적', store.allCards().length === cardsBefore, `${store.allCards().length} vs ${cardsBefore}`);
mockOai = { ...mockOai, custom_model: 'gemini-3.2-pro' };

// ════════════════════════════════════════════════════════════
section('7c. 취소 시 정리 (고아 데이터 방지)');

async function runShotCancel() {
    const pr = shot.doShot();
    await tick(20);
    const modal = document.querySelector('.msnap-modal-backdrop:last-of-type .msnap-modal')
        || document.querySelector('.msnap-modal');
    if (!modal) throw new Error('모달이 열리지 않음');
    modal.querySelector('[data-act="cancel"]').click();
    await tick(20);
    return pr;
}

// (a) 완전히 새로운 조합에서 취소 → 아무것도 안 남아야 함
const before = {
    prov: store.allProviders().length,
    mdl: store.allModels().length,
    card: store.allCards().length,
    snap: store.allSnapshots().length,
};
mockOai = { ...mockOai, custom_url: 'https://api.brandnew-proxy.test/v1', custom_model: 'brandnew-model-x1' };
await runShotCancel();
check('취소 → 스냅샷 안 남음', store.allSnapshots().length === before.snap, `${store.allSnapshots().length} vs ${before.snap}`);
check('취소 → 카드 안 남음', store.allCards().length === before.card, `${store.allCards().length} vs ${before.card}`);
check('취소 → 프로바이더 안 남음', store.allProviders().length === before.prov, `${store.allProviders().length} vs ${before.prov}`);
check('취소 → 모델 안 남음', store.allModels().length === before.mdl, `${store.allModels().length} vs ${before.mdl}`);
check('취소 → 미등록 항목도 안 남음', store.pendingEntities().providers.length === 0 && store.pendingEntities().models.length === 0);

// (b) X 버튼(닫기)으로 취소해도 동일해야 함
async function runShotCloseX() {
    const pr = shot.doShot();
    await tick(20);
    const back = document.querySelector('.msnap-modal-backdrop:last-of-type') || document.querySelector('.msnap-modal-backdrop');
    back.querySelector('.msnap-modal-x').click();
    await tick(20);
    return pr;
}
await runShotCloseX();
check('X 버튼 취소도 정리됨 (프로바이더)', store.allProviders().length === before.prov, String(store.allProviders().length));
check('X 버튼 취소도 정리됨 (모델)', store.allModels().length === before.mdl, String(store.allModels().length));
check('X 버튼 취소도 정리됨 (카드)', store.allCards().length === before.card);

// (c) 기존 엔티티에서 취소 → 기존 것은 절대 지워지면 안 됨
mockOai = { ...mockOai, custom_url: 'https://api.myproxy.xyz/v1', custom_model: 'gemini-3.2-pro' };
const existProv = store.findProviderByEndpoint('https://api.myproxy.xyz/v1');
const existMdl = store.findModelByRaw('gemini-3.2-pro');
check('기존 엔티티 존재 확인', !!existProv && !!existMdl);
const cardsBeforeC = store.allCards().length;
await runShotCancel();
check('취소해도 기존 프로바이더 보존', !!store.getProvider(existProv.id));
check('취소해도 기존 모델 보존', !!store.getModel(existMdl.id));
check('취소해도 기존 카드 보존', store.allCards().length === cardsBeforeC, `${store.allCards().length} vs ${cardsBeforeC}`);

// (d) 기존 카드에 두번째 샷 찍고 취소 → 카드와 이전 스냅샷은 남아야 함
const anyCard = store.allCards().find(c => store.snapshotsOfCard(c.id).length > 0);
if (anyCard) {
    const cardSnapsBefore = store.snapshotsOfCard(anyCard.id).length;
    const cd = store.getCard(anyCard.id);
    mockOai = {
        ...mockOai,
        custom_url: store.getProvider(cd.providerId).hosts[0],
        custom_model: store.getModel(cd.modelId).raws[0],
        custom_prompt_post_processing: cd.postProcessing,
        preset_settings_openai: cd.presetName,
    };
    await runShotCancel();
    check('기존 카드에서 취소 → 카드 보존', !!store.getCard(anyCard.id));
    check('기존 카드에서 취소 → 이전 스냅샷 보존', store.snapshotsOfCard(anyCard.id).length === cardSnapsBefore,
        `${store.snapshotsOfCard(anyCard.id).length} vs ${cardSnapsBefore}`);
}
mockOai = { ...mockOai, custom_url: 'https://api.myproxy.xyz/v1', custom_model: 'gemini-3.2-pro',
    custom_prompt_post_processing: 'claude', preset_settings_openai: '내프리셋A' };

// ════════════════════════════════════════════════════════════
section('7d. 엔티티 수동 삭제 (참조 보호)');
const usedProv = store.allProviders().find(p => store.cardsUsingProvider(p.id).length > 0);
check('사용 중인 프로바이더 존재', !!usedProv);
let delRes = await store.deleteProvider(usedProv.id);
check('사용 중이면 삭제 거부', delRes.ok === false, delRes.error);
check('거부 후에도 그대로 존재', !!store.getProvider(usedProv.id));

const usedMdl = store.allModels().find(m => store.cardsUsingModel(m.id).length > 0);
delRes = await store.deleteModel(usedMdl.id);
check('사용 중인 모델 삭제 거부', delRes.ok === false, delRes.error);

// 고아 엔티티는 삭제 가능
const orphan = await store.createProvider({ alias: '고아프록시', endpoint: 'https://orphan.test/v1', pending: true });
check('고아 프로바이더 참조 0', store.cardsUsingProvider(orphan.id).length === 0);
delRes = await store.deleteProvider(orphan.id);
check('고아 프로바이더 삭제 성공', delRes.ok === true, delRes.error);
check('삭제 후 조회 안 됨', !store.getProvider(orphan.id));

const orphanM = await store.createModel({ alias: '고아모델', raw: 'orphan-model', pending: true });
delRes = await store.deleteModel(orphanM.id);
check('고아 모델 삭제 성공', delRes.ok === true);
check('삭제 후 raw 조회도 안 됨', !store.findModelByRaw('orphan-model'));

// ════════════════════════════════════════════════════════════
section('8. 라벨 커스텀 / 사용 횟수');
check('가격 그룹에 기본 라벨 없음 (직접 입력)', labels.DEFAULT_LABELS.filter(l => l.group === 'price').length === 0);
check('가격 그룹 자체는 존재', labels.LABEL_GROUPS.some(g => g.id === 'price'));
const custom = await store.upsertLabelRow({ group: 'etc', name: '번역깨짐', type: 'chip', custom: true });
check('커스텀 라벨 추가', store.getLabels().some(l => l.id === custom.id && l.name === '번역깨짐'));
await store.upsertLabelRow({ id: 'sp_slow', group: 'speed', name: '느림', type: 'chip', hidden: true });
check('기본 라벨 숨김 처리', store.getLabels().find(l => l.id === 'sp_slow').hidden === true);
check('숨겨도 기본 라벨 목록에서 사라지지 않음', store.getLabels().some(l => l.id === 'sp_slow'));
check('숨긴 라벨은 선택 목록에서 제외됨', !store.getLabels().filter(l => !l.hidden).some(l => l.id === 'sp_slow'));
// 다시 표시로 되돌리기
await store.upsertLabelRow({ id: 'sp_slow', group: 'speed', name: '느림', type: 'chip', hidden: false });
check('숨김 해제 가능 (되돌리기)', store.getLabels().find(l => l.id === 'sp_slow').hidden === false);
check('해제 후 선택 목록에 복귀', store.getLabels().filter(l => !l.hidden).some(l => l.id === 'sp_slow'));
const counts = store.labelUsageCounts();
check('라벨 사용 횟수 집계', (counts.get('tc_memory') ?? 0) === 1, String(counts.get('tc_memory')));

// ════════════════════════════════════════════════════════════
section('9. 내보내기 / 가져오기 / 전체삭제');
const exp = io.buildExportObject();
check('export schemaVersion 포함', exp.schemaVersion === core.SCHEMA_VERSION);
check('export kind 포함', exp.kind === 'st-model-snapshot');
check('export 에 URL 포함(사용자 확정)', JSON.stringify(exp).includes('api.myproxy.xyz'));
check('export 에 비밀번호 미포함', !JSON.stringify(exp).includes('SECRET-DO-NOT-CAPTURE'));
check('export 에 API 키 미포함', !JSON.stringify(exp).includes('sk-SECRET'));

const snapshotOfState = {
    cards: store.allCards().length,
    snaps: store.allSnapshots().length,
    provs: store.allProviders().length,
    mdls: store.allModels().length,
    labels: store.rawLabelRows().length,
};
const expText = JSON.stringify(exp);

// MD
const md = io.buildMarkdown(store.allCards());
check('MD 에 카드 제목 포함', md.includes('마이프록시(개명)'), md.slice(0, 200));
check('MD 에 라벨 포함', md.includes('기억력이슈'));
check('MD 에 3단 토글 표기', md.includes('문체👍') || !store.allSnapshots().some(s => s.labels.some(l => l.id === 'q_style')));

// 전체 삭제 — 잘못된 확인 문자열
let w = await io.wipeAll('delete');
check('DELETE 소문자는 거부', w.ok === false);
w = await io.wipeAll('');
check('빈 문자열 거부', w.ok === false);
check('거부 시 데이터 보존', store.allCards().length === snapshotOfState.cards);

// 정상 삭제
w = await io.wipeAll('DELETE');
check('DELETE 정확 입력 시 삭제', w.ok === true);
check('삭제 후 카드 0', store.allCards().length === 0);
check('삭제 후 스냅샷 0', store.allSnapshots().length === 0);
check('삭제 후 프로바이더 0', store.allProviders().length === 0);

// 가져오기 왕복
const parsed = io.parseImportFile(expText);
check('import 파일 파싱 성공', parsed.ok === true, parsed.error);
const analysis = io.analyzeImport(parsed.data);
check('분석: 카드 전부 신규', analysis.cards.neu === snapshotOfState.cards && analysis.cards.conflict === 0);
await io.applyImport(parsed.data, 'merge_keep');
check('복원: 카드 수 일치', store.allCards().length === snapshotOfState.cards, `${store.allCards().length} vs ${snapshotOfState.cards}`);
check('복원: 스냅샷 수 일치', store.allSnapshots().length === snapshotOfState.snaps);
check('복원: 프로바이더 수 일치', store.allProviders().length === snapshotOfState.provs);
check('복원: 라벨 수 일치', store.rawLabelRows().length === snapshotOfState.labels);
check('복원: 약칭 유지', store.allProviders().some(p => p.alias === '마이프록시(개명)'));

// merge_keep 은 기존을 덮지 않는다
const someProv = store.allProviders()[0];
await store.updateProvider(someProv.id, { alias: '로컬수정본' });
await io.applyImport(parsed.data, 'merge_keep');
check('merge_keep 은 기존 값 보존', store.getProvider(someProv.id).alias === '로컬수정본', store.getProvider(someProv.id).alias);
await io.applyImport(parsed.data, 'merge_overwrite');
check('merge_overwrite 는 파일 값으로 교체', store.getProvider(someProv.id).alias !== '로컬수정본');

// 잘못된 파일
check('잘못된 JSON 거부', io.parseImportFile('{{{').ok === false);
check('다른 확장 파일 거부', io.parseImportFile('{"kind":"other","schemaVersion":1}').ok === false);
check('미래 스키마 거부', io.parseImportFile(JSON.stringify({ kind: 'st-model-snapshot', schemaVersion: 999, providers: [], models: [], cards: [], snapshots: [] })).ok === false);

// ════════════════════════════════════════════════════════════
section('10. 메시지 이동 / 지문 검증');
const anySnap = store.allSnapshots().find(s => s.ctx?.mesId !== null && s.ctx?.mesHash);
check('이동 대상 스냅샷 존재', !!anySnap);

document.getElementById('chat').innerHTML = mockChat.map((m, i) => `<div class="mes" mesid="${i}"></div>`).join('');
dom.window.HTMLElement.prototype.scrollIntoView = function () { this.__scrolled = true; };

let r = await jump.jumpToSnapshot(anySnap.ctx);
check('같은 채팅에서 이동 성공', r.code === jump.JUMP_RESULT.OK, `${r.code}: ${r.message}`);
check('대상 엘리먼트로 스크롤됨', !!document.querySelector(`.mes[mesid="${anySnap.ctx.mesId}"]`).__scrolled);

// 지문 불일치 시나리오 (메시지 내용이 바뀐 경우)
const tampered = { ...anySnap.ctx, mesHash: 'ffffffffffffffff' };
r = await jump.jumpToSnapshot(tampered);
check('내용 변경 감지 (지문 불일치)', r.code === jump.JUMP_RESULT.HASH_MISMATCH, r.code);

// 메시지가 없는 경우
r = await jump.jumpToSnapshot({ ...anySnap.ctx, mesId: 999 });
check('없는 메시지 번호 → 안내', r.code === jump.JUMP_RESULT.MES_MISSING, r.code);

// 캐릭터가 삭제된 경우
r = await jump.jumpToSnapshot({ ...anySnap.ctx, charKey: 'deleted_char.png', charName: '사라진캐릭', chatFile: 'x.jsonl' });
check('삭제된 캐릭터 → 안내', r.code === jump.JUMP_RESULT.CHAR_MISSING, r.code);

// 위치 기록 없음
r = await jump.jumpToSnapshot({ charKey: 'dante.png', mesId: null });
check('메시지 기록 없음 → 안내', r.code === jump.JUMP_RESULT.NO_TARGET, r.code);

// ════════════════════════════════════════════════════════════
section('11. SillyTavern 데이터 불변 검증');
check('mockChat 여전히 frozen', Object.isFrozen(mockChat));
check('chat 배열 길이 불변', mockCtx.chat.length === 3);
check('chat[2] 본문 불변', mockCtx.chat[2].mes === '두 번째 답변입니다. 문체가 꽤 좋네요.');
check('characters 불변', mockCtx.characters[0].name === '단테' && mockCtx.characters[0].avatar === 'dante.png');
check('oai_settings 키 개수 불변', Object.keys(mockOai).length === 16, String(Object.keys(mockOai).length));

// 소스 코드 정적 검사
import { readFileSync, readdirSync } from 'fs';
const srcFiles = ['index.js', ...readdirSync('/home/claude/st-model-snapshot/src').map(f => `src/${f}`)];
function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}
let allSrc = '';
for (const f of srcFiles) allSrc += stripComments(readFileSync(`/home/claude/st-model-snapshot/${f}`, 'utf8'));
check('정적 검사 대상이 비어있지 않음', allSrc.length > 20000, String(allSrc.length));
check('saveSettingsDebounced 호출 없음 (settings.json 미사용)', !/saveSettingsDebounced\s*\(/.test(allSrc));
check('extension_settings 사용 없음', !/extension_settings/.test(allSrc));
check('localStorage 사용 없음', !/localStorage/.test(allSrc));
check('MutationObserver 없음 (유휴 부하 0)', !/MutationObserver/.test(allSrc));
check('setInterval 은 부팅 1회만', (allSrc.match(/setInterval\(/g) ?? []).length === 1);
check('API 키/비밀번호 필드 접근 없음', !/reverse_proxy_password|api_key/.test(allSrc));
check('eval / Function 생성자 없음', !/\beval\(|new Function\(/.test(allSrc));
check('innerHTML 에 원시 사용자 입력 직접 삽입 없음', !/innerHTML\s*=\s*[a-zA-Z_$][\w$]*\.(memo|alias|name)\b/.test(allSrc));

// ════════════════════════════════════════════════════════════
section('11b. URL / HTML 안전성');
check('http 허용', core.safeUrl('http://a.com') === 'http://a.com');
check('https 허용', core.safeUrl('https://a.com/p?x=1') === 'https://a.com/p?x=1');
check('javascript: 차단', core.safeUrl('javascript:alert(1)') === '');
check('대소문자 섞은 JaVaScRiPt: 차단', core.safeUrl('JaVaScRiPt:alert(1)') === '');
check('제어문자 삽입 우회 차단', core.safeUrl('java\u0000script:alert(1)') === '');
check('앞 공백/개행 우회 차단', core.safeUrl('  \n javascript:alert(1)') === '');
check('data: 차단', core.safeUrl('data:text/html,<script>x</script>') === '');
check('vbscript: 차단', core.safeUrl('vbscript:msgbox') === '');
check('상대경로 차단', core.safeUrl('/etc/passwd') === '');
check('빈값 처리', core.safeUrl('') === '' && core.safeUrl(null) === '' && core.safeUrl(undefined) === '');

check('escapeHtml 태그 무력화', core.escapeHtml('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;');
check('escapeHtml 속성 탈출 차단', core.escapeHtml('" onmouseover="alert(1)').includes('&quot;'));

// 악의적 import 시나리오: 적대적 JSON을 넣어도 href 로 새어나가지 않아야 함
const hostile = {
    kind: 'st-model-snapshot', schemaVersion: core.SCHEMA_VERSION, exportedAt: Date.now(),
    providers: [{ id: 'prv_evil', alias: '<img src=x onerror=alert(1)>', hosts: ['https://evil.test'],
        priceUrl: 'javascript:alert("pwned")',
        links: [{ name: '<script>bad</script>', url: 'javascript:alert(2)' }, { name: '정상', url: 'https://ok.test' }],
        status: 'ok', memo: '<script>alert(3)</script>', pending: false, createdAt: Date.now() }],
    models: [], cards: [], snapshots: [], labels: [],
};
const hp = io.parseImportFile(JSON.stringify(hostile));
check('적대적 파일도 형식은 통과 (내용 검증은 렌더 단계)', hp.ok === true);
await io.applyImport(hp.data, 'merge_overwrite');
const evil = store.getProvider('prv_evil');
check('악성 priceUrl 이 렌더에서 걸러짐', core.safeUrl(evil.priceUrl) === '');
check('악성 링크 걸러짐', core.safeUrl(evil.links[0].url) === '');
check('정상 링크는 통과', core.safeUrl(evil.links[1].url) === 'https://ok.test');
check('alias 는 escape 대상', core.escapeHtml(evil.alias).includes('&lt;img'));

// ════════════════════════════════════════════════════════════
section('11c. 화면 배치 / 배경 불투명화');
const probe = document.createElement('div');
document.body.appendChild(probe);
core.applySurface(probe);
check('불투명 기준색 지정됨', /rgb|#/.test(probe.style.backgroundColor), probe.style.backgroundColor);
check('테마 틴트가 위에 겹쳐짐', probe.style.backgroundImage.includes('SmartThemeBlurTintColor'));
check('배경이 투명이 아님', probe.style.backgroundColor !== 'transparent' && probe.style.backgroundColor !== '');
check('테마 밝기 판정 동작', typeof core.isDarkTheme() === 'boolean');
check('fixed 방해요소 탐지가 배열 반환', Array.isArray(core.findFixedBreakers(document.body)));
check('오버레이 부착 대상 결정됨', !!core.overlayHost());

document.body.style.transform = 'translateZ(0)';
const brk = core.findFixedBreakers(document.body);
check('body transform 을 방해요소로 탐지', brk.some(b => b.tag === 'body' && b.reasons.some(r => r.startsWith('transform'))), JSON.stringify(brk));
check('방해요소 있으면 html 에 부착', core.overlayHost() === document.documentElement);
document.body.style.transform = '';
check('방해요소 없으면 body 에 부착', core.overlayHost() === document.body);

const vo = core.verifyOverlay(probe, { fullWidth: true });
check('레이아웃 미계산 시 판정 보류(ok=null)', vo.ok === null, JSON.stringify(vo));
check('위치 검증이 예외를 던지지 않음', typeof vo === 'object');
check('null 요소에도 안 죽음', typeof core.verifyOverlay(null, {}) === 'object');
check('applySurface 가 null 에도 안 죽음', (() => { core.applySurface(null); return true; })());
probe.remove();

// ════════════════════════════════════════════════════════════
section('12. 리마인더 로직');
await core.saveSettings({ exportReminder: true, lastExportAt: Date.now(), exportReminderDays: 7 });
check('방금 내보냈으면 리마인더 없음', io.exportReminderDue() === false);
await core.saveSettings({ lastExportAt: Date.now() - 8 * 24 * 3600 * 1000 });
check('8일 경과 시 리마인더', io.exportReminderDue() === true);
await core.saveSettings({ exportReminder: false });
check('리마인더 끄면 안 뜸', io.exportReminderDue() === false);

// ════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(50)}`);
console.log(`총 ${results.length}개 검사 · 통과 ${results.length - failed} · 실패 ${failed}`);
if (failed) {
    console.log('\n실패 항목:');
    results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.name}${r.detail ? ` (${r.detail})` : ''}`));
    process.exit(1);
}
console.log('전부 통과');
