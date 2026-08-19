/**
 * capture.js — SillyTavern 현재 상태를 "읽기 전용"으로 수집한다.
 *
 * 중요:
 *  - 여기서는 절대 SillyTavern 의 값을 쓰거나 수정하지 않는다. 오직 읽기만 한다.
 *  - API 키 / reverse_proxy_password 등 비밀정보는 접근하지도, 저장하지도 않는다.
 *  - 읽지 못한 필드는 null 로 두고 실패 목록을 함께 반환한다. (통째로 죽지 않게)
 */

import { diag, normalizeText, shortHash } from './core.js';

/** 캡처 대상 파라미터 (사용자 확정: 7종) */
export const PARAM_FIELDS = [
    { key: 'temperature', label: '온도', src: ['temp_openai', 'temperature'] },
    { key: 'top_p', label: 'Top P', src: ['top_p_openai', 'top_p'] },
    { key: 'top_k', label: 'Top K', src: ['top_k_openai', 'top_k'] },
    { key: 'frequency_penalty', label: 'Freq Penalty', src: ['freq_pen_openai', 'frequency_penalty'] },
    { key: 'presence_penalty', label: 'Pres Penalty', src: ['pres_pen_openai', 'presence_penalty'] },
    { key: 'reasoning_effort', label: 'Reasoning Effort', src: ['reasoning_effort'] },
    { key: 'verbosity', label: 'Verbosity', src: ['verbosity'] },
];

/** chat_completion_source → 모델 필드명 */
const MODEL_FIELD_MAP = {
    openai: 'openai_model',
    claude: 'claude_model',
    windowai: 'windowai_model',
    openrouter: 'openrouter_model',
    ai21: 'ai21_model',
    scale: 'scale_model',
    makersuite: 'google_model',
    vertexai: 'vertexai_model',
    mistralai: 'mistralai_model',
    custom: 'custom_model',
    cohere: 'cohere_model',
    perplexity: 'perplexity_model',
    groq: 'groq_model',
    zerooneai: 'zerooneai_model',
    '01ai': 'zerooneai_model',
    blockentropy: 'blockentropy_model',
    nanogpt: 'nanogpt_model',
    deepseek: 'deepseek_model',
    xai: 'xai_model',
    pollinations: 'pollinations_model',
    aimlapi: 'aimlapi_model',
    electronhub: 'electronhub_model',
    moonshot: 'moonshot_model',
    fireworks: 'fireworks_model',
    cometapi: 'cometapi_model',
};

export function getContextSafe() {
    try {
        if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
            return SillyTavern.getContext();
        }
    } catch (e) {
        diag('error', 'SillyTavern.getContext() 호출 실패', e?.message);
    }
    return null;
}

function getOaiSettings(ctx) {
    // 여러 경로를 방어적으로 시도. ST 버전에 따라 노출 위치가 다르다.
    const candidates = [
        () => ctx?.chatCompletionSettings,
        () => ctx?.oaiSettings,
        () => ctx?.oai_settings,
    ];
    for (const f of candidates) {
        try {
            const v = f();
            if (v && typeof v === 'object') return v;
        } catch { /* noop */ }
    }
    return null;
}

function pickFirst(obj, keys) {
    if (!obj) return undefined;
    for (const k of keys) {
        if (obj[k] !== undefined) return obj[k];
    }
    return undefined;
}

/** URL 에서 호스트만 뽑되, 실패하면 원본 문자열을 그대로 돌려준다. */
export function urlToHost(url) {
    const raw = String(url ?? '').trim();
    if (!raw) return '';
    try {
        const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
        return u.host.toLowerCase();
    } catch {
        return raw.toLowerCase();
    }
}

/**
 * 화면에 보이는 마지막 메시지 번호를 구한다.
 * 상시 감시가 아니라 호출 시점에 1회만 계산한다. (유휴 부하 0)
 */
export function getVisibleLastMesId() {
    try {
        const nodes = document.querySelectorAll('#chat .mes[mesid]');
        if (!nodes.length) return null;
        const vh = window.innerHeight || document.documentElement.clientHeight;
        let best = null;
        for (const el of nodes) {
            const r = el.getBoundingClientRect();
            // 화면과 조금이라도 겹치면 후보
            if (r.bottom > 0 && r.top < vh) {
                const id = parseInt(el.getAttribute('mesid'), 10);
                if (!Number.isNaN(id)) best = id;
            }
        }
        if (best === null) {
            const last = nodes[nodes.length - 1];
            const id = parseInt(last.getAttribute('mesid'), 10);
            best = Number.isNaN(id) ? null : id;
        }
        return best;
    } catch (e) {
        diag('warn', '화면 메시지 번호 계산 실패', e?.message);
        return null;
    }
}

/** 캐릭터 / 그룹 / 채팅 식별 정보 (값으로 박제) */
export function captureChatContext(ctx, mesIdOverride) {
    const fails = [];
    const out = {
        charKey: null,      // 'group:<id>' 또는 아바타 파일명
        charName: null,
        isGroup: false,
        chatFile: null,
        chatName: null,
        mesId: null,
        mesHash: null,
    };
    if (!ctx) {
        fails.push('SillyTavern context');
        return { ctxInfo: out, fails };
    }

    try {
        const groupId = ctx.groupId ?? null;
        if (groupId) {
            out.isGroup = true;
            out.charKey = `group:${groupId}`;
            const group = (ctx.groups ?? []).find(g => String(g.id) === String(groupId));
            out.charName = group?.name ?? null;
            out.chatFile = group?.chat_id ?? null;
        } else {
            const chid = ctx.characterId;
            const ch = (chid !== undefined && chid !== null) ? ctx.characters?.[chid] : null;
            if (ch) {
                out.charKey = ch.avatar ?? null;
                out.charName = ch.name ?? null;
                out.chatFile = ch.chat ?? null;
            } else {
                fails.push('현재 캐릭터');
            }
        }
        out.chatName = (typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : null) ?? out.chatFile;
    } catch (e) {
        fails.push('캐릭터/채팅 정보');
        diag('warn', '채팅 컨텍스트 캡처 실패', e?.message);
    }

    try {
        const chat = ctx.chat ?? [];
        let mesId = (mesIdOverride === undefined || mesIdOverride === null)
            ? getVisibleLastMesId()
            : mesIdOverride;
        if (mesId === null && chat.length) mesId = chat.length - 1;
        if (mesId !== null && chat[mesId]) {
            out.mesId = mesId;
            out.mesHash = shortHash(normalizeText(chat[mesId].mes));
        } else if (mesId !== null) {
            out.mesId = mesId;
            fails.push('메시지 해시');
        }
    } catch (e) {
        fails.push('메시지 정보');
        diag('warn', '메시지 캡처 실패', e?.message);
    }

    return { ctxInfo: out, fails };
}

/**
 * 현재 모델/프로바이더/후처리/프리셋/파라미터를 읽는다.
 * @returns {{ok:boolean, data:object, fails:string[], partial:boolean}}
 */
export function captureModelState(options = {}) {
    const captureParams = options.captureParams !== false;
    const ctx = getContextSafe();
    const fails = [];
    const data = {
        mainApi: null,
        source: null,           // chat_completion_source
        endpoint: null,         // 전체 URL 또는 'official:<source>'
        endpointHost: null,
        modelRaw: null,
        postProcessing: null,
        presetName: null,
        params: null,
        partial: false,
    };

    if (!ctx) {
        fails.push('SillyTavern context');
        return { ok: false, data, fails, partial: true };
    }

    try {
        data.mainApi = ctx.mainApi ?? ctx.main_api ?? null;
    } catch { /* noop */ }

    const oai = getOaiSettings(ctx);

    if (!oai) {
        fails.push('Chat Completion 설정 객체');
        data.partial = true;
        return { ok: false, data, fails, partial: true };
    }

    // 소스
    try {
        data.source = oai.chat_completion_source ?? null;
        if (!data.source) fails.push('API 소스');
    } catch { fails.push('API 소스'); }

    // 모델명
    try {
        const field = MODEL_FIELD_MAP[data.source];
        let model = field ? oai[field] : undefined;
        if (model === undefined && data.source) {
            // 폴백: <source>_model 형태 추정
            model = oai[`${data.source}_model`];
        }
        if (model === undefined) {
            // 최종 폴백: _model 로 끝나는 키 중 소스명이 포함된 것
            const key = Object.keys(oai).find(k => k.endsWith('_model') && data.source && k.includes(data.source));
            if (key) model = oai[key];
        }
        data.modelRaw = (model === undefined || model === null || model === '') ? null : String(model);
        if (!data.modelRaw) fails.push('모델명');
    } catch (e) {
        fails.push('모델명');
    }

    // 엔드포인트 (비밀번호/키는 읽지 않는다)
    try {
        const customUrl = String(oai.custom_url ?? '').trim();
        const revProxy = String(oai.reverse_proxy ?? '').trim();
        if (data.source === 'custom' && customUrl) {
            data.endpoint = customUrl;
        } else if (revProxy) {
            data.endpoint = revProxy;
        } else if (customUrl) {
            data.endpoint = customUrl;
        } else {
            data.endpoint = `official:${data.source ?? 'unknown'}`;
        }
        data.endpointHost = data.endpoint.startsWith('official:')
            ? data.endpoint
            : urlToHost(data.endpoint);
    } catch (e) {
        fails.push('엔드포인트');
    }

    // 후처리 (소스 분기 없이 필드 그대로 읽음)
    try {
        const pp = oai.custom_prompt_post_processing;
        data.postProcessing = (pp === undefined || pp === null || pp === '') ? null : String(pp);
    } catch {
        fails.push('Prompt Post-Processing');
    }

    // 프리셋명
    try {
        let p = oai.preset_settings_openai ?? null;
        if (!p) {
            const el = document.querySelector('#settings_preset_openai option:checked, #settings_preset_openai option[selected]');
            p = el?.textContent?.trim() || null;
        }
        data.presetName = p || null;
        if (!data.presetName) fails.push('프리셋명');
    } catch {
        fails.push('프리셋명');
    }

    // 파라미터
    if (captureParams) {
        try {
            const params = {};
            for (const f of PARAM_FIELDS) {
                const v = pickFirst(oai, f.src);
                params[f.key] = (v === undefined || v === '') ? null : v;
            }
            data.params = params;
        } catch {
            fails.push('파라미터');
        }
    } else {
        data.params = null;
    }

    data.partial = fails.length > 0;
    return { ok: fails.length === 0, data, fails, partial: data.partial };
}

/** 벤더 약칭 기본값 제안 (확정이 아니라 입력창 초기값 제안일 뿐) */
const VENDOR_HINTS = [
    [/gemini|makersuite|google|vertex/i, '젬'],
    [/claude|anthropic|opus|sonnet|haiku/i, '옾'],
    [/gpt|o1|o3|o4|openai/i, '짚'],
    [/deepseek/i, '딮'],
    [/grok|xai/i, '그록'],
    [/llama|meta/i, '라마'],
    [/mistral|mixtral/i, '미스'],
    [/qwen/i, '퀜'],
    [/glm|zhipu|z\.ai/i, 'GLM'],
    [/kimi|moonshot/i, '키미'],
    [/command|cohere/i, '코히어'],
];

export function suggestVendor(modelRaw) {
    const s = String(modelRaw ?? '');
    for (const [re, name] of VENDOR_HINTS) {
        if (re.test(s)) return name;
    }
    return '';
}

/** 모델 약칭 기본값 제안: 벤더 약칭 + 버전 숫자 */
/**
 * 모델 약칭 기본값 = 모델 문자열 전체.
 *
 * 임의로 잘라내지 않는다. 프록시 사이트가 붙이는 접두사(가격표 등) 때문에
 * 어느 부분이 실제 모델명인지 기계가 판단할 수 없기 때문이다.
 * 예) "[0.25]a마/claude-opus-4-6" 에서 0.25 는 버전이 아니라 가격이다.
 * 사용자가 입력창에서 직접 다듬는 편이 항상 정확하다.
 */
export function suggestModelAlias(modelRaw) {
    return String(modelRaw ?? '');
}

/** 프로바이더 약칭 기본값 제안: 호스트의 대표 라벨 */
export function suggestProviderAlias(endpoint) {
    const raw = String(endpoint ?? '');
    if (raw.startsWith('official:')) return `공식-${raw.slice(9)}`;
    const host = urlToHost(raw);
    if (!host) return '';
    const parts = host.split('.').filter(p => p && p !== 'www' && p !== 'api');
    if (!parts.length) return host;
    return parts[0].slice(0, 16);
}
