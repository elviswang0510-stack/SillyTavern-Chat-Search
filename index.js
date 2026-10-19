import { DEFAULTS, queryTokens, fingerprint, chatName } from './core.js';
import { characterSnapshot, searchHistory } from './history.js';

const KEY = 'st_body_status_search';
const state = { controller: null, results: [], tokens: [], shown: 0, target: null, open: false, navigating: false };
let panel;
let returnFocus;

function context() { return globalThis.SillyTavern.getContext(); }
function settings() {
    const ctx = context();
    ctx.extensionSettings[KEY] ??= { ...DEFAULTS };
    return { ...DEFAULTS, ...ctx.extensionSettings[KEY] };
}
function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
function $(selector) { return panel.querySelector(selector); }
function setStatus(text) { $('[data-status]').textContent = text; }
function setError(text = '') { $('[data-error]').textContent = text; }
function abortSearch() {
    state.controller?.abort();
    state.controller = null;
    $('[data-cancel]').hidden = true;
    $('[data-submit]').disabled = false;
    panel.removeAttribute('aria-busy');
}
function clearResults() {
    state.results = [];
    state.shown = 0;
    $('[data-results]').replaceChildren();
    $('[data-more]').hidden = true;
}

function updateTarget() {
    try {
        const selected = characterSnapshot(context());
        state.target = selected.avatar;
        $('[data-target]').textContent = `${selected.name} · 正文与状态栏`;
        setStatus('输入关键词，查找这个角色的聊天记录。');
    } catch (error) {
        state.target = null;
        $('[data-target]').textContent = '尚未选择角色';
        setStatus(error.message);
    }
}

function openPanel() {
    if (!panel) return;
    returnFocus = document.activeElement;
    state.open = true;
    panel.hidden = false;
    updateTarget();
    $('[data-query]').focus();
}
function closePanel() {
    abortSearch();
    state.open = false;
    panel.hidden = true;
    returnFocus?.focus?.();
}

function highlight(parent, text) {
    const tokens = state.tokens.filter(Boolean);
    const lower = text.toLowerCase();
    let cursor = 0;
    while (cursor < text.length) {
        let next = -1;
        let size = 0;
        for (const token of tokens) {
            const index = lower.indexOf(token, cursor);
            if (index >= 0 && (next < 0 || index < next || index === next && token.length > size)) {
                next = index;
                size = token.length;
            }
        }
        if (next < 0) {
            parent.append(document.createTextNode(text.slice(cursor)));
            break;
        }
        parent.append(document.createTextNode(text.slice(cursor, next)), element('mark', '', text.slice(next, next + size)));
        cursor = next + size;
    }
}

function renderMore() {
    const list = $('[data-results]');
    const end = Math.min(state.shown + 40, state.results.length);
    const fragment = document.createDocumentFragment();
    for (let i = state.shown; i < end; i++) {
        const result = state.results[i];
        const article = element('article', 'stcs-result');
        const heading = element('div', 'stcs-result-head');
        heading.append(element('strong', '', result.author), element('span', 'stcs-muted', `第 ${result.messageId + 1} 条`));
        const jump = element('button', 'menu_button stcs-jump', '定位');
        jump.type = 'button';
        jump.setAttribute('aria-label', `定位到 ${result.author} 的第 ${result.messageId + 1} 条消息`);
        jump.addEventListener('click', async () => {
            jump.disabled = true;
            try { await goToResult(result); } catch (error) { setError(error.message); }
            finally { jump.disabled = false; }
        });
        heading.append(jump);
        const file = element('div', 'stcs-file', result.file || '当前聊天');
        file.title = result.file;
        article.append(heading, file);
        if (result.date) article.append(element('div', 'stcs-date stcs-muted', result.date));
        for (const [key, label] of [['body', '正文'], ['status', '状态栏']]) {
            if (!result[key]) continue;
            const paragraph = element('p', 'stcs-excerpt');
            paragraph.append(element('span', 'stcs-content-label', label));
            highlight(paragraph, result[key]);
            article.append(paragraph);
        }
        fragment.append(article);
    }
    list.append(fragment);
    state.shown = end;
    $('[data-more]').hidden = end >= state.results.length;
    $('[data-more]').textContent = `再显示 ${Math.min(40, state.results.length - end)} 条`;
}

async function search() {
    abortSearch();
    clearResults();
    setError();
    let tokens;
    try {
        tokens = queryTokens($('[data-query]').value);
        characterSnapshot(context());
    } catch (error) { setError(error.message); return; }
    if (!tokens.length) { setStatus('请输入关键词；多个词用空格分开，会同时匹配。'); return; }
    state.tokens = tokens;
    const controller = new AbortController();
    state.controller = controller;
    $('[data-submit]').disabled = true;
    $('[data-cancel]').hidden = false;
    panel.setAttribute('aria-busy', 'true');
    setStatus('正在读取这个角色的聊天记录…');
    try {
        const report = await searchHistory(context(), {
            signal: controller.signal, tokens, settings: settings(),
            scope: $('[data-scope]').value, content: $('[data-content]').value, speaker: $('[data-speaker]').value,
            onProgress: (done, total) => {
                if (state.controller === controller) setStatus(`正在搜索 ${done} / ${total} 个聊天…`);
            },
        });
        if (state.controller !== controller) return;
        if (characterSnapshot(context()).avatar !== report.selected.avatar) return;
        state.results = report.results;
        renderMore();
        const read = report.total - report.failed.length;
        setStatus(report.results.length ? `找到 ${report.results.length} 条消息 · 已搜索 ${read} 个聊天` : `没有找到匹配内容 · 已搜索 ${read} 个聊天。试试更短的词，或切换到“正文和状态栏”。`);
        if (report.failed.length) setError(`${report.failed.length} 个聊天读取失败，本次结果可能不完整。请重试。`);
        else if (report.warning) setError(report.warning);
    } catch (error) {
        if (!controller.signal.aborted && state.controller === controller) {
            setStatus('搜索未完成。');
            setError(error.message || '读取失败，请重试。');
        }
    } finally {
        if (state.controller === controller) abortSearch();
    }
}

async function goToResult(result) {
    setError();
    const ctx = context();
    if (characterSnapshot(ctx).avatar !== result.avatar) throw new Error('当前角色已经切换，请重新搜索。');
    const stopButton = document.querySelector('#mes_stop');
    if (ctx.streamingProcessor && !ctx.streamingProcessor.isFinished || stopButton && getComputedStyle(stopButton).display !== 'none') {
        throw new Error('请等当前回复生成完毕，再定位历史消息。');
    }
    const current = characterSnapshot(ctx).current;
    if (current !== result.file) {
        if (typeof ctx.openCharacterChat !== 'function' || typeof ctx.saveChat !== 'function') throw new Error('当前酒馆版本不支持安全切换历史聊天，请先更新酒馆。');
        state.navigating = true;
        try {
            await ctx.saveChat();
            if (characterSnapshot(context()).avatar !== result.avatar) throw new Error('当前角色已经切换，请重新搜索。');
            await ctx.openCharacterChat(result.file);
        } finally { state.navigating = false; }
    }
    const fresh = context();
    const rows = fresh.chat || [];
    let id = result.messageId;
    if (fingerprint(rows[id]?.mes || '') !== result.fingerprint) {
        id = rows.findIndex(message => typeof message.mes === 'string' && fingerprint(message.mes) === result.fingerprint);
    }
    if (id < 0) throw new Error('这条消息已被编辑或删除，请重新搜索。');
    const findMessage = () => document.querySelector(`#chat .mes[mesid="${id}"]`);
    let target = findMessage();
    let attempts = 0;
    let firstId = Infinity;
    while (!target && attempts++ < 200) {
        if (characterSnapshot(context()).avatar !== result.avatar || characterSnapshot(context()).current !== result.file) throw new Error('聊天已经切换，请重新搜索。');
        const more = document.querySelector('#show_more_messages');
        const first = Number(document.querySelector('#chat .mes')?.getAttribute('mesid'));
        if (!more || first >= firstId) break;
        firstId = first;
        more.click();
        // Wait for the host's async message rendering; don't mutate host messages.
        for (let wait = 0; wait < 40 && !findMessage() && document.querySelector('#chat .mes')?.getAttribute('mesid') === String(first); wait++) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        target = findMessage();
    }
    if (!target) throw new Error(`已打开聊天，但未能自动加载第 ${id + 1} 条消息。请在聊天顶部点击“加载更多”后再定位。`);
    closePanel();
    target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    target.classList.add('stcs-located');
    setTimeout(() => target.classList.remove('stcs-located'), 2200);
}

function mountSettings() {
    if (document.getElementById('stcs-settings')) return;
    const host = document.querySelector('#extensions_settings2, #extensions_settings');
    if (!host) return;
    const drawer = element('details', 'stcs-settings');
    drawer.id = 'stcs-settings';
    drawer.innerHTML = `<summary>聊天搜索 · 正文与状态栏</summary>
        <p>搜索当前角色的聊天记录，预设、世界书和思考内容不参与检索。</p>
        <button type="button" class="menu_button" data-open>打开聊天搜索</button>
        <details><summary>内容识别设置</summary>
          <label>状态栏标签（逗号分隔）<input class="text_pole" data-tags="statusTags" spellcheck="false"></label>
          <label>排除的标签（逗号分隔）<input class="text_pole" data-tags="ignoredTags" spellcheck="false"></label>
          <p>默认识别 status、状态栏标签，以及标题含“状态”的 details。没有标签的文字状态栏会和正文一起搜索。动态脚本生成的独立面板不在搜索范围内。</p>
          <button type="button" class="menu_button" data-reset>恢复默认识别</button>
        </details>`;
    drawer.querySelector('[data-open]').addEventListener('click', openPanel);
    for (const input of drawer.querySelectorAll('[data-tags]')) {
        input.value = settings()[input.dataset.tags];
        input.maxLength = 1200;
        input.addEventListener('change', () => {
            context().extensionSettings[KEY][input.dataset.tags] = input.value;
            context().saveSettingsDebounced();
            if (state.open) { abortSearch(); clearResults(); setStatus('识别设置已改变，请重新搜索。'); }
        });
    }
    drawer.querySelector('[data-reset]').addEventListener('click', () => {
        context().extensionSettings[KEY] = { ...DEFAULTS };
        drawer.querySelectorAll('[data-tags]').forEach(input => { input.value = DEFAULTS[input.dataset.tags]; });
        context().saveSettingsDebounced();
        if (state.open) { abortSearch(); clearResults(); setStatus('已恢复默认识别，请重新搜索。'); }
    });
    host.append(drawer);
}

function mount() {
    if (!globalThis.SillyTavern?.getContext) return;
    if (panel) { mountSettings(); return; }
    settings();
    panel = element('aside', 'stcs-panel');
    panel.id = 'stcs-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', '聊天搜索');
    panel.innerHTML = `<header class="stcs-header"><div><h2>聊天搜索</h2><p data-target></p></div>
        <button type="button" class="menu_button" data-close aria-label="关闭聊天搜索">关闭</button></header>
      <form class="stcs-form">
        <label for="stcs-query">查找正文或状态栏</label>
        <div class="stcs-query-row"><input id="stcs-query" class="text_pole" type="search" data-query placeholder="输入关键词，空格分隔多个词" maxlength="200" autocomplete="off">
          <button type="submit" class="menu_button" data-submit>搜索</button></div>
        <div class="stcs-filters">
          <label>范围<select class="text_pole" data-scope><option value="character">该角色全部聊天</option><option value="current">当前聊天</option></select></label>
          <label>内容<select class="text_pole" data-content><option value="both">正文和状态栏</option><option value="body">仅正文</option><option value="status">仅状态栏</option></select></label>
          <label>发言人<select class="text_pole" data-speaker><option value="all">全部</option><option value="character">角色</option><option value="user">我</option></select></label>
        </div>
      </form>
      <div class="stcs-feedback"><p data-status role="status" aria-live="polite"></p><button type="button" class="menu_button" data-cancel hidden>停止搜索</button><p data-error role="alert"></p></div>
      <div class="stcs-results" data-scroll><div data-results></div><button type="button" class="menu_button stcs-more" data-more hidden>显示更多</button></div>
      <footer>只搜索消息正文与状态栏 · 不调用模型</footer>`;
    document.body.append(panel);
    mountSettings();
    const menuHost = document.querySelector('#extensionsMenu');
    if (menuHost) {
        const button = element('button', 'list-group-item flex-container flexGap5 stcs-menu', '聊天搜索');
        button.type = 'button';
        button.addEventListener('click', openPanel);
        menuHost.append(button);
    }
    $('[data-close]').addEventListener('click', closePanel);
    $('form').addEventListener('submit', event => { event.preventDefault(); void search(); });
    $('[data-more]').addEventListener('click', renderMore);
    $('[data-cancel]').addEventListener('click', () => { abortSearch(); setStatus('搜索已停止，可以修改关键词重新搜索。'); });
    for (const select of panel.querySelectorAll('select')) select.addEventListener('change', () => {
        abortSearch(); clearResults(); setError(); setStatus('筛选条件已改变，点击“搜索”查看结果。');
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && state.open) { event.preventDefault(); closePanel(); }
    });
    const ctx = context();
    const events = ctx.eventTypes || ctx.event_types || {};
    if (events.CHAT_CHANGED) ctx.eventSource.on(events.CHAT_CHANGED, () => {
        abortSearch();
        if (state.navigating) return;
        clearResults(); setError(); updateTarget();
    });
    const invalidate = () => {
        abortSearch();
        clearResults();
        if (state.open) setStatus('聊天内容已更新，请重新搜索以获取最新结果。');
    };
    for (const name of ['MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED']) {
        if (events[name]) ctx.eventSource.on(events[name], invalidate);
    }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
const initial = globalThis.SillyTavern?.getContext?.();
const ready = initial?.eventTypes?.APP_READY || initial?.event_types?.APP_READY;
if (ready) initial.eventSource.on(ready, mount);
