import { DEFAULTS, queryTokens, createTextCache } from './core.js';
import { characterSnapshot, searchHistory } from './history.js';
import { createReader } from './reader.js';
import { element, appendParts } from './view.js';

const KEY = 'st_body_status_search';
const state = { controller: null, results: [], tokens: [], shown: 0, open: false, cache: createTextCache(), reading: false };
let panel;
let reader;
let returnFocus;
let resultFocus;
const context = () => globalThis.SillyTavern.getContext();
const $ = selector => panel.querySelector(selector);
function settings() {
    context().extensionSettings[KEY] ??= { ...DEFAULTS };
    return { ...DEFAULTS, ...context().extensionSettings[KEY] };
}
const setStatus = text => { $('[data-status]').textContent = text; };
const setError = (text = '') => { $('[data-error]').textContent = text; };
function abortSearch() {
    state.controller?.abort(); state.controller = null;
    $('[data-cancel]').hidden = true;
    $('[data-submit]').disabled = false;
    panel.removeAttribute('aria-busy');
}
function backToResults() {
    reader.reset(); state.reading = false;
    $('[data-reader-view]').hidden = true;
    $('[data-search-view]').hidden = false;
    resultFocus?.focus?.({ preventScroll: true });
}
function clearResults() {
    backToResults(); state.results = []; state.shown = 0;
    $('[data-results]').replaceChildren(); $('[data-more]').hidden = true;
}
function updateTarget() {
    try {
        const selected = characterSnapshot(context());
        $('[data-target]').textContent = `${selected.name} · ${$('[data-scope]').value === 'current' ? '当前聊天' : '全部历史聊天'}`;
        setStatus('输入关键词，查找正文与状态栏。');
    } catch (error) { $('[data-target]').textContent = '尚未选择角色'; setStatus(error.message); }
}
function openPanel(currentChat = false) {
    returnFocus = document.activeElement;
    if (currentChat && $('[data-scope]').value !== 'current') {
        abortSearch(); clearResults(); $('[data-scope]').value = 'current';
    }
    state.open = true; panel.hidden = false;
    if (!state.results.length && !state.reading) updateTarget();
    if (currentChat && state.reading) backToResults();
    if (!state.reading) $('[data-query]').focus();
}
function closePanel() {
    abortSearch(); reader.reset(); state.open = false; panel.hidden = true; state.reading = false;
    $('[data-reader-view]').hidden = true; $('[data-search-view]').hidden = false;
    returnFocus?.focus?.();
}
function renderMore() {
    const list = $('[data-results]');
    const end = Math.min(state.shown + 40, state.results.length);
    const fragment = document.createDocumentFragment();
    for (let i = state.shown; i < end; i++) {
        const result = state.results[i];
        const article = element('article', 'stcs-result');
        const heading = element('div', 'stcs-result-head'); heading.append(element('strong', '', result.author));
        const expand = element('button', 'menu_button stcs-expand', '展开对话'); expand.type = 'button';
        expand.setAttribute('aria-label', `展开 ${result.author} 的这段对话`);
        expand.addEventListener('click', () => {
            resultFocus = expand; state.reading = true;
            $('[data-search-view]').hidden = true; $('[data-reader-view]').hidden = false;
            $('[data-reader-back]').focus(); void reader.open(result, $('[data-content]').value);
        });
        heading.append(expand); article.append(heading);
        appendParts(article, result, $('[data-content]').value, state.tokens); fragment.append(article);
    }
    list.append(fragment); state.shown = end;
    $('[data-more]').hidden = end >= state.results.length;
    $('[data-more]').textContent = `再显示 ${Math.min(40, state.results.length - end)} 条`;
}
async function search() {
    abortSearch(); clearResults(); setError();
    let tokens;
    try { tokens = queryTokens($('[data-query]').value); characterSnapshot(context()); }
    catch (error) { setError(error.message); return; }
    if (!tokens.length) { setStatus('请输入关键词；多个词用空格分开，会同时匹配。'); return; }
    state.tokens = tokens;
    const controller = new AbortController(); state.controller = controller;
    $('[data-submit]').disabled = true; $('[data-cancel]').hidden = false; panel.setAttribute('aria-busy', 'true');
    const currentOnly = $('[data-scope]').value === 'current';
    setStatus(currentOnly ? '正在搜索当前聊天…' : '正在读取这个角色的历史聊天…');
    try {
        const report = await searchHistory(context(), {
            signal: controller.signal, tokens, settings: settings(), cache: state.cache,
            scope: $('[data-scope]').value, content: $('[data-content]').value, speaker: $('[data-speaker]').value,
            onProgress: (done, total) => { if (!currentOnly && state.controller === controller) setStatus(`正在搜索 ${done} / ${total} 个聊天…`); },
        });
        if (state.controller !== controller || characterSnapshot(context()).avatar !== report.selected.avatar) return;
        state.results = report.results; renderMore();
        setStatus(report.results.length ? `找到 ${report.results.length} 条消息 · 点击展开阅读` : '没有找到匹配内容。试试更短的词，或切换为“正文和状态栏”。');
        if (report.failed.length) setError(`${report.failed.length} 个聊天读取失败，本次结果可能不完整。请重试。`);
        else if (report.warning) setError(report.warning);
    } catch (error) {
        if (!controller.signal.aborted && state.controller === controller) { setStatus('搜索未完成。'); setError(error.message || '读取失败，请重试。'); }
    } finally { if (state.controller === controller) abortSearch(); }
}
function mountShortcuts() {
    for (const [hostSelector, id, toggleId, className] of [
        ['#options .options-content, #options', 'stcs-options-search', 'options_button', 'stcs-shortcut'],
        ['#extensionsMenu', 'stcs-wand-search', 'extensionsMenuButton', 'list-group-item flex-container flexGap5 stcs-menu stcs-shortcut'],
    ]) {
        const host = id === 'stcs-options-search'
            ? document.querySelector('#options .options-content') || document.querySelector('#options')
            : document.querySelector(hostSelector);
        if (!host || document.getElementById(id)) continue;
        const button = element('a', className); button.id = id;
        button.setAttribute('role', 'button'); button.tabIndex = 0;
        const icon = element('i', 'fa-solid fa-magnifying-glass fa-fw'); icon.setAttribute('aria-hidden', 'true');
        button.append(icon, element('span', '', '搜索当前聊天'));
        button.addEventListener('click', event => {
            event.preventDefault(); event.stopPropagation();
            const menu = host.closest('#options, #extensionsMenu');
            // Preserve the host menu's internal open state via its own toggle.
            if (menu && getComputedStyle(menu).display !== 'none') document.getElementById(toggleId)?.click();
            openPanel(true);
        });
        button.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); button.click(); } });
        host.prepend(button);
    }
}
function mountSettings() {
    if (document.getElementById('stcs-settings')) return;
    const host = document.querySelector('#extensions_settings2, #extensions_settings'); if (!host) return;
    const drawer = element('details', 'stcs-settings'); drawer.id = 'stcs-settings';
    drawer.innerHTML = `<summary>聊天搜索 · 正文与状态栏</summary>
      <p>从左下角菜单或魔法棒选择“搜索当前聊天”。点击结果可在独立界面阅读。</p>
      <button type="button" class="menu_button" data-open>打开聊天搜索</button>
      <details><summary>内容识别设置</summary>
        <label>状态栏标签（逗号分隔）<input class="text_pole" data-tags="statusTags" spellcheck="false"></label>
        <label>排除的标签（逗号分隔）<input class="text_pole" data-tags="ignoredTags" spellcheck="false"></label>
        <p>默认识别 status、状态栏标签，以及标题含“状态”的 details。未标记的普通文字会与正文一起搜索。独立脚本生成且未存入消息的状态栏不在搜索范围内。</p>
        <button type="button" class="menu_button" data-reset>恢复默认识别</button>
      </details>`;
    drawer.querySelector('[data-open]').addEventListener('click', () => openPanel(true));
    const invalidate = text => { state.cache = createTextCache(); if (state.open) { abortSearch(); clearResults(); setStatus(text); } };
    for (const input of drawer.querySelectorAll('[data-tags]')) {
        input.value = settings()[input.dataset.tags]; input.maxLength = 1200;
        input.addEventListener('change', () => {
            context().extensionSettings[KEY][input.dataset.tags] = input.value;
            context().saveSettingsDebounced(); invalidate('识别设置已改变，请重新搜索。');
        });
    }
    drawer.querySelector('[data-reset]').addEventListener('click', () => {
        context().extensionSettings[KEY] = { ...DEFAULTS };
        drawer.querySelectorAll('[data-tags]').forEach(input => { input.value = DEFAULTS[input.dataset.tags]; });
        context().saveSettingsDebounced(); invalidate('已恢复默认识别，请重新搜索。');
    });
    host.append(drawer);
}
function mount() {
    if (!globalThis.SillyTavern?.getContext) return;
    if (panel) { mountSettings(); mountShortcuts(); return; }
    settings(); panel = element('aside', 'stcs-panel'); panel.id = 'stcs-panel'; panel.hidden = true;
    panel.setAttribute('aria-label', '聊天搜索');
    panel.innerHTML = `<header class="stcs-header"><div><h2>聊天搜索</h2><p data-target></p></div>
      <button type="button" class="menu_button" data-close aria-label="关闭聊天搜索">关闭</button></header>
      <section class="stcs-search-view" data-search-view>
        <form class="stcs-form"><label for="stcs-query">查找正文或状态栏</label>
          <div class="stcs-query-row"><input id="stcs-query" class="text_pole" type="search" data-query placeholder="输入关键词，空格分隔多个词" maxlength="200" autocomplete="off"><button type="submit" class="menu_button" data-submit>搜索</button></div>
          <div class="stcs-filters">
            <label>范围<select class="text_pole" data-scope><option value="current">当前聊天</option><option value="character">该角色全部聊天</option></select></label>
            <label>内容<select class="text_pole" data-content><option value="both">正文和状态栏</option><option value="body">仅正文</option><option value="status">仅状态栏</option></select></label>
            <label>发言人<select class="text_pole" data-speaker><option value="all">全部</option><option value="character">角色</option><option value="user">我</option></select></label>
          </div>
        </form>
        <div class="stcs-feedback"><p data-status role="status" aria-live="polite"></p><button type="button" class="menu_button" data-cancel hidden>停止搜索</button><p data-error role="alert"></p></div>
        <div class="stcs-results" data-scroll><div data-results></div><button type="button" class="menu_button stcs-more" data-more hidden>显示更多</button></div>
      </section>
      <section class="stcs-reader-view" data-reader-view hidden aria-label="展开阅读对话">
        <div class="stcs-reader-toolbar"><button type="button" class="menu_button" data-reader-back>返回结果</button>
          <label>显示<select class="text_pole" data-reader-content><option value="both">正文和状态栏</option><option value="body">仅正文</option><option value="status">仅状态栏</option></select></label></div>
        <p class="stcs-reader-feedback" data-reader-feedback role="status" aria-live="polite"></p>
        <div class="stcs-reader-scroll" data-reader-scroll tabindex="0" aria-label="上下滑动阅读对话">
          <button type="button" class="menu_button stcs-reader-page" data-reader-previous hidden>再看前面 20 条</button>
          <div data-reader-messages></div>
          <button type="button" class="menu_button stcs-reader-page" data-reader-next hidden>再看后面 20 条</button>
        </div>
      </section>
      <footer>独立阅读 · 不跳转原聊天</footer>`;
    document.body.append(panel);
    reader = createReader(panel, { getContext: context, getSettings: settings, getTokens: () => state.tokens, onBack: backToResults });
    mountSettings(); mountShortcuts();
    $('[data-close]').addEventListener('click', closePanel);
    $('form').addEventListener('submit', event => { event.preventDefault(); void search(); });
    $('[data-more]').addEventListener('click', renderMore);
    $('[data-cancel]').addEventListener('click', () => { abortSearch(); setStatus('搜索已停止，可以修改关键词重新搜索。'); });
    for (const select of panel.querySelectorAll('[data-search-view] select')) select.addEventListener('change', () => {
        abortSearch(); clearResults(); setError(); updateTarget(); setStatus('筛选条件已改变，点击“搜索”查看结果。');
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && state.open) { event.preventDefault(); if (state.reading) backToResults(); else closePanel(); }
    });
    const ctx = context(); const events = ctx.eventTypes || ctx.event_types || {};
    if (events.CHAT_CHANGED) ctx.eventSource.on(events.CHAT_CHANGED, () => {
        abortSearch(); clearResults(); state.cache = createTextCache(); setError(); updateTarget();
    });
    const invalidate = () => { abortSearch(); clearResults(); if (state.open) setStatus('聊天内容已更新，请重新搜索以获取最新结果。'); };
    for (const name of ['MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED']) {
        if (events[name]) ctx.eventSource.on(events[name], invalidate);
    }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
const initial = globalThis.SillyTavern?.getContext?.();
const ready = initial?.eventTypes?.APP_READY || initial?.event_types?.APP_READY;
if (ready) initial.eventSource.on(ready, mount);
