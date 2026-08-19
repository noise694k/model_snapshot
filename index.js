/**
 * Model Snapshot — SillyTavern 확장
 *
 * 설계 요약
 *  - SillyTavern 의 settings.json 을 전혀 사용하지 않는다. (saveSettingsDebounced 호출 없음)
 *  - 모든 데이터는 브라우저 IndexedDB 에만 저장한다.
 *  - MutationObserver / 폴링 / 상시 이벤트 리스너가 없다. → 유휴 상태 부하 0
 *  - SillyTavern 데이터는 읽기만 한다. 쓰기 동작이 전혀 없다.
 */

import { diag, loadSettings, openDB } from './src/core.js';
import * as store from './src/store.js';
import { openPanel, ensurePanel, render } from './src/ui-panel.js';
import { doShot } from './src/ui-shot.js';
import { modalAlert } from './src/ui-modal.js';

const WAND_ID = 'msnap_wand_entry';
let initialized = false;

function wandHtml() {
    return `
    <div id="${WAND_ID}" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="모델 스냅샷">
        <div class="fa-solid fa-camera extensionsMenuExtensionButton"></div>
        <span>모델 스냅샷</span>
    </div>
    <div id="${WAND_ID}_shot" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="지금 설정을 기록">
        <div class="fa-solid fa-bolt extensionsMenuExtensionButton"></div>
        <span>📸 지금 SHOT</span>
    </div>`;
}

function injectWand() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;
    if (document.getElementById(WAND_ID)) return true;
    menu.insertAdjacentHTML('beforeend', wandHtml());
    document.getElementById(WAND_ID)?.addEventListener('click', onOpenPanel);
    document.getElementById(`${WAND_ID}_shot`)?.addEventListener('click', onQuickShot);
    return true;
}

async function ensureReady() {
    if (initialized) return true;
    try {
        await openDB();
        await loadSettings();
        await store.loadAll();
        initialized = true;
        return true;
    } catch (e) {
        diag('error', '초기화 실패', e?.message);
        await modalAlert('모델 스냅샷 — 초기화 실패',
            `브라우저 저장소(IndexedDB)를 열지 못했습니다.\n\n원인: ${e?.message ?? e}\n\n` +
            '시크릿 모드이거나 브라우저가 저장소를 차단한 경우 발생할 수 있습니다.');
        return false;
    }
}

async function onOpenPanel() {
    if (!(await ensureReady())) return;
    openPanel();
}

async function onQuickShot() {
    if (!(await ensureReady())) return;
    ensurePanel();
    await doShot(() => render());
}

// 마법봉 메뉴는 ST가 나중에 만들 수 있으므로 잠깐만 재시도한다. (상시 감시 아님)
(function boot() {
    let tries = 0;
    const timer = setInterval(() => {
        tries++;
        if (injectWand() || tries > 40) {
            clearInterval(timer);
            if (tries > 40) diag('warn', '마법봉 메뉴(#extensionsMenu)를 찾지 못했습니다.');
            else diag('info', '마법봉 메뉴 등록 완료');
        }
    }, 500);
})();
