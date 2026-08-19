/**
 * ui-modal.js — 모달 헬퍼
 * SillyTavern 의 팝업 시스템에 의존하지 않고 자체 모달을 쓴다.
 * (ST 버전에 따라 popup API 가 달라 깨질 위험이 있고, 우리 UI는 단순하므로 자체 구현이 안전하다)
 */

import { escapeHtml, applySurface, verifyOverlay, overlayHost } from './core.js';

let zBase = 10050;

function buildShell(titleHtml, bodyHtml, footerHtml, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'msnap-modal-backdrop';
    wrap.style.zIndex = String(zBase++);
    wrap.innerHTML = `
        <div class="msnap-modal ${opts.wide ? 'msnap-modal-wide' : ''}" role="dialog" aria-modal="true">
            <div class="msnap-modal-head">
                <div class="msnap-modal-title">${titleHtml}</div>
                <button class="msnap-icon-btn msnap-modal-x" aria-label="닫기">✕</button>
            </div>
            <div class="msnap-modal-body">${bodyHtml}</div>
            <div class="msnap-modal-foot">${footerHtml}</div>
        </div>`;
    return wrap;
}

function mount(wrap, onClose) {
    overlayHost().appendChild(wrap);
    applySurface(wrap.querySelector('.msnap-modal'));
    verifyOverlay(wrap, { fullWidth: true });
    const close = (val) => {
        if (!wrap.isConnected) return;
        wrap.remove();
        document.removeEventListener('keydown', onKey);
        onClose?.(val);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    wrap.querySelector('.msnap-modal-x')?.addEventListener('click', () => close(null));
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(null); });
    return close;
}

export function modalAlert(title, message) {
    return new Promise((resolve) => {
        const wrap = buildShell(
            escapeHtml(title),
            `<div class="msnap-msg">${escapeHtml(message).replace(/\n/g, '<br>')}</div>`,
            `<button class="msnap-btn msnap-btn-primary" data-act="ok">확인</button>`,
        );
        const close = mount(wrap, resolve);
        wrap.querySelector('[data-act="ok"]').addEventListener('click', () => close(true));
    });
}

export function modalConfirm(title, message, { okText = '확인', cancelText = '취소', danger = false } = {}) {
    return new Promise((resolve) => {
        const wrap = buildShell(
            escapeHtml(title),
            `<div class="msnap-msg">${escapeHtml(message).replace(/\n/g, '<br>')}</div>`,
            `<button class="msnap-btn" data-act="cancel">${escapeHtml(cancelText)}</button>
             <button class="msnap-btn ${danger ? 'msnap-btn-danger' : 'msnap-btn-primary'}" data-act="ok">${escapeHtml(okText)}</button>`,
        );
        const close = mount(wrap, (v) => resolve(v === true));
        wrap.querySelector('[data-act="ok"]').addEventListener('click', () => close(true));
        wrap.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
    });
}

/**
 * 자유 폼 모달.
 * @param {(root:HTMLElement, close:(v:any)=>void)=>void} setup
 */
export function modalCustom({ title, bodyHtml, footerHtml, wide = false, setup }) {
    return new Promise((resolve) => {
        const wrap = buildShell(escapeHtml(title), bodyHtml, footerHtml ?? '', { wide });
        const close = mount(wrap, resolve);
        try {
            setup?.(wrap.querySelector('.msnap-modal'), close);
        } catch (e) {
            console.error('[ModelSnapshot] modal setup 오류', e);
        }
    });
}

/** 텍스트 입력 모달 */
export function modalPrompt(title, { label = '', value = '', placeholder = '', multiline = false, okText = '저장' } = {}) {
    return new Promise((resolve) => {
        const inputHtml = multiline
            ? `<textarea class="msnap-input msnap-textarea" data-el="inp" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>`
            : `<input type="text" class="msnap-input" data-el="inp" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">`;
        const wrap = buildShell(
            escapeHtml(title),
            `${label ? `<div class="msnap-label">${escapeHtml(label)}</div>` : ''}${inputHtml}`,
            `<button class="msnap-btn" data-act="cancel">취소</button>
             <button class="msnap-btn msnap-btn-primary" data-act="ok">${escapeHtml(okText)}</button>`,
        );
        const close = mount(wrap, resolve);
        const inp = wrap.querySelector('[data-el="inp"]');
        setTimeout(() => inp?.focus(), 30);
        wrap.querySelector('[data-act="ok"]').addEventListener('click', () => close(inp.value));
        wrap.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
        if (!multiline) {
            inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(inp.value); });
        }
    });
}

export function toastMsg(type, msg) {
    try {
        if (typeof toastr !== 'undefined' && toastr[type]) { toastr[type](msg); return; }
    } catch { /* noop */ }
    console.log(`[ModelSnapshot][${type}] ${msg}`);
}
