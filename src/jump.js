/**
 * jump.js — 저장된 스냅샷의 메시지로 이동
 *
 * Highlighter 확장 대비 개선점:
 *  - 고정 setTimeout(blind sleep) 대신 CHAT_CHANGED 이벤트 + 타임아웃 race 를 쓴다.
 *  - DOM 버튼 클릭 대신 context API 를 먼저 시도한다.
 *  - 자동 이동이 불가능한 환경이면 무리하게 시도하지 않고 수동 이동 안내를 띄운다.
 *
 * 안전 원칙:
 *  - 채팅 데이터를 수정하지 않는다. 화면 이동과 "더 불러오기"만 수행한다.
 */

import { diag, normalizeText, shortHash, waitForEvent, escapeHtml } from './core.js';
import { getContextSafe } from './capture.js';

const JUMP_TIMEOUT = 4000;
const LOAD_MORE_MAX = 30;

function toast(type, msg, opts) {
    try {
        if (typeof toastr !== 'undefined' && toastr[type]) toastr[type](msg, undefined, opts);
        else diag('info', msg);
    } catch { diag('info', msg); }
}

function currentCharKey(ctx) {
    if (!ctx) return null;
    if (ctx.groupId) return `group:${ctx.groupId}`;
    const chid = ctx.characterId;
    const ch = (chid !== undefined && chid !== null) ? ctx.characters?.[chid] : null;
    return ch?.avatar ?? null;
}

function currentChatFile(ctx) {
    if (!ctx) return null;
    if (ctx.groupId) {
        const g = (ctx.groups ?? []).find(x => String(x.id) === String(ctx.groupId));
        return g?.chat_id ?? null;
    }
    const chid = ctx.characterId;
    const ch = (chid !== undefined && chid !== null) ? ctx.characters?.[chid] : null;
    return ch?.chat ?? null;
}

/** 결과 코드 */
export const JUMP_RESULT = {
    OK: 'ok',
    NO_TARGET: 'no_target',
    CHAR_MISSING: 'char_missing',
    NEEDS_MANUAL: 'needs_manual',
    MES_MISSING: 'mes_missing',
    HASH_MISMATCH: 'hash_mismatch',
    ERROR: 'error',
};

/**
 * 스냅샷 컨텍스트로 이동한다.
 * @param {object} snapCtx { charKey, charName, chatFile, mesId, mesHash, isGroup }
 * @returns {Promise<{code:string, message:string}>}
 */
export async function jumpToSnapshot(snapCtx) {
    const ctx = getContextSafe();
    if (!ctx) {
        return { code: JUMP_RESULT.ERROR, message: 'SillyTavern 컨텍스트를 읽을 수 없습니다.' };
    }
    if (!snapCtx || snapCtx.mesId === null || snapCtx.mesId === undefined) {
        return { code: JUMP_RESULT.NO_TARGET, message: '이 스냅샷에는 저장된 메시지 위치가 없습니다.' };
    }

    const nowChar = currentCharKey(ctx);
    const nowChat = currentChatFile(ctx);
    const sameChar = snapCtx.charKey && nowChar && String(snapCtx.charKey) === String(nowChar);
    const sameChat = !snapCtx.chatFile || (nowChat && String(snapCtx.chatFile) === String(nowChat));

    if (sameChar && sameChat) {
        return await scrollToMessage(ctx, snapCtx);
    }

    // 다른 캐릭터/채팅 → 전환 시도
    const switched = await trySwitch(ctx, snapCtx);
    if (switched.code !== JUMP_RESULT.OK) return switched;

    const ctx2 = getContextSafe();
    return await scrollToMessage(ctx2 ?? ctx, snapCtx);
}

async function trySwitch(ctx, snapCtx) {
    const targetKey = snapCtx.charKey;
    if (!targetKey) {
        return { code: JUMP_RESULT.NEEDS_MANUAL, message: '저장된 캐릭터 정보가 없어 자동 이동할 수 없습니다.' };
    }

    const isGroup = String(targetKey).startsWith('group:');

    try {
        if (isGroup) {
            const gid = String(targetKey).slice(6);
            const group = (ctx.groups ?? []).find(g => String(g.id) === gid);
            if (!group) {
                return {
                    code: JUMP_RESULT.CHAR_MISSING,
                    message: `그룹을 찾을 수 없습니다. 삭제되었을 수 있습니다.\n기록: ${snapCtx.charName ?? '(이름없음)'}`,
                };
            }
            if (typeof ctx.openGroupById !== 'function') {
                return {
                    code: JUMP_RESULT.NEEDS_MANUAL,
                    message: '이 SillyTavern 버전에서는 그룹 자동 전환을 지원하지 않습니다.',
                };
            }
            const p = waitForEvent(ctx.eventSource, ctx.eventTypes?.CHAT_CHANGED, JUMP_TIMEOUT);
            await ctx.openGroupById(gid);
            await p;
        } else {
            const idx = (ctx.characters ?? []).findIndex(c => c?.avatar === targetKey);
            if (idx === -1) {
                return {
                    code: JUMP_RESULT.CHAR_MISSING,
                    message: `캐릭터를 찾을 수 없습니다. 삭제되었거나 파일명이 바뀌었을 수 있습니다.\n기록: ${snapCtx.charName ?? '(이름없음)'}`,
                };
            }
            if (typeof ctx.selectCharacterById !== 'function') {
                return {
                    code: JUMP_RESULT.NEEDS_MANUAL,
                    message: '이 SillyTavern 버전에서는 캐릭터 자동 전환을 지원하지 않습니다.',
                };
            }
            const p = waitForEvent(ctx.eventSource, ctx.eventTypes?.CHAT_CHANGED, JUMP_TIMEOUT);
            await ctx.selectCharacterById(String(idx));
            await p;
        }
    } catch (e) {
        diag('error', '캐릭터/그룹 전환 실패', e?.message);
        return { code: JUMP_RESULT.ERROR, message: `전환 중 오류: ${e?.message ?? e}` };
    }

    // 채팅 파일까지 다른 경우
    const ctx2 = getContextSafe() ?? ctx;
    const afterChat = currentChatFile(ctx2);
    if (snapCtx.chatFile && afterChat && String(afterChat) !== String(snapCtx.chatFile)) {
        const isGroup2 = String(targetKey).startsWith('group:');
        const fn = isGroup2 ? ctx2.openGroupChat : ctx2.openCharacterChat;
        if (typeof fn !== 'function') {
            return {
                code: JUMP_RESULT.NEEDS_MANUAL,
                message: `캐릭터로는 이동했지만 채팅방 자동 전환은 지원되지 않습니다.\n수동으로 열어주세요: ${snapCtx.chatFile}`,
            };
        }
        try {
            const p = waitForEvent(ctx2.eventSource, ctx2.eventTypes?.CHAT_CHANGED, JUMP_TIMEOUT);
            if (isGroup2) await fn.call(ctx2, String(targetKey).slice(6), snapCtx.chatFile);
            else await fn.call(ctx2, snapCtx.chatFile);
            await p;
        } catch (e) {
            diag('error', '채팅방 전환 실패', e?.message);
            return {
                code: JUMP_RESULT.NEEDS_MANUAL,
                message: `채팅방 전환에 실패했습니다. 수동으로 열어주세요: ${snapCtx.chatFile}`,
            };
        }
    }

    return { code: JUMP_RESULT.OK, message: '' };
}

/** 메시지가 DOM 에 없으면 "더 불러오기"를 눌러 로드한다. */
async function ensureMessageLoaded(mesId) {
    let el = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    if (el) return el;

    for (let i = 0; i < LOAD_MORE_MAX; i++) {
        const btn = document.querySelector('#show_more_messages');
        if (!btn || btn.offsetParent === null) break;
        btn.click();
        // 렌더 프레임 대기 (고정 sleep 이 아니라 프레임 단위)
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        el = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
        if (el) return el;
    }
    return document.querySelector(`#chat .mes[mesid="${mesId}"]`);
}

async function scrollToMessage(ctx, snapCtx) {
    const mesId = snapCtx.mesId;
    const el = await ensureMessageLoaded(mesId);
    if (!el) {
        return {
            code: JUMP_RESULT.MES_MISSING,
            message: `메시지 #${mesId} 를 찾을 수 없습니다. 삭제되었을 수 있습니다.`,
        };
    }

    // 해시 검증 (본문을 저장하지 않고 지문만 비교)
    let mismatch = false;
    if (snapCtx.mesHash) {
        try {
            const cur = ctx?.chat?.[mesId]?.mes;
            if (cur === undefined) mismatch = true;
            else mismatch = shortHash(normalizeText(cur)) !== snapCtx.mesHash;
        } catch { mismatch = true; }
    }

    el.scrollIntoView({ behavior: 'auto', block: 'start' });
    el.classList.add('msnap-flash');
    setTimeout(() => el.classList.remove('msnap-flash'), 1800);

    if (mismatch) {
        return {
            code: JUMP_RESULT.HASH_MISMATCH,
            message: `#${mesId} 로 이동했지만, 저장 당시와 내용이 다릅니다.\n메시지가 수정/삭제되어 번호가 밀렸을 수 있습니다.`,
        };
    }
    return { code: JUMP_RESULT.OK, message: `#${mesId} 로 이동했습니다.` };
}

/** 이동 확인 모달 HTML 생성용 요약 */
export function jumpSummaryHtml(snapCtx) {
    const rows = [
        ['캐릭터', snapCtx?.charName ?? '(기록없음)'],
        ['채팅방', snapCtx?.chatFile ?? '(기록없음)'],
        ['메시지', snapCtx?.mesId === null || snapCtx?.mesId === undefined ? '(기록없음)' : `#${snapCtx.mesId}`],
    ];
    return rows.map(([k, v]) => `<div class="msnap-kv"><span>${escapeHtml(k)}</span><b>${escapeHtml(String(v))}</b></div>`).join('');
}

export { toast };
