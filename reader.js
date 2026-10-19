import { cachedParts, createTextCache } from './core.js';
import { readConversation } from './history.js';
import { element, appendParts } from './view.js';

export function createReader(panel, options) {
    const root = panel.querySelector('[data-reader-view]');
    const list = root.querySelector('[data-reader-messages]');
    const scroll = root.querySelector('[data-reader-scroll]');
    const contentSelect = root.querySelector('[data-reader-content]');
    const feedback = root.querySelector('[data-reader-feedback]');
    const previous = root.querySelector('[data-reader-previous]');
    const next = root.querySelector('[data-reader-next]');
    let controller = null;
    let rows = [];
    let hit = -1;
    let start = 0;
    let end = 0;
    let localCache = createTextCache();
    function reset() {
        controller?.abort(); controller = null;
        rows = []; hit = -1; localCache = createTextCache();
        list.replaceChildren(); feedback.textContent = '';
        previous.hidden = true; next.hidden = true;
        root.removeAttribute('aria-busy');
    }
    function render(focusHit = false) {
        const fragment = document.createDocumentFragment();
        for (let id = start; id < end; id++) {
            const message = rows[id];
            const parts = cachedParts(message, options.getSettings(), document, localCache);
            const content = contentSelect.value;
            if (!parts || !(content === 'body' ? parts.body : content === 'status' ? parts.status : parts.body || parts.status)) continue;
            const article = element('article', 'stcs-reader-message');
            article.dataset.messageId = String(id);
            const header = element('div', 'stcs-reader-author');
            header.append(element('strong', '', message.name || (message.is_user ? '你' : '角色')));
            if (id === hit) { article.dataset.hit = 'true'; header.append(element('span', 'stcs-hit-label', '匹配消息')); }
            article.append(header);
            appendParts(article, parts, content, options.getTokens(), 'stcs-reader-text');
            fragment.append(article);
        }
        list.replaceChildren(fragment);
        previous.hidden = start === 0;
        next.hidden = end >= rows.length;
        feedback.textContent = list.childElementCount ? '' : '这段对话里没有符合当前显示方式的内容，可以切换显示方式或继续向前、向后读。';
        if (focusHit) {
            const matched = list.querySelector('[data-hit]');
            (matched?.querySelector('mark') || matched)?.scrollIntoView({ block: 'center', behavior: 'instant' });
        }
    }
    function move(direction) {
        // Only 60 messages can be mounted even after reading thousands of floors.
        const anchor = direction < 0 ? list.firstElementChild : list.lastElementChild;
        const anchorId = anchor?.dataset.messageId;
        const top = anchor?.getBoundingClientRect().top ?? 0;
        if (direction < 0) { start = Math.max(0, start - 20); end = Math.min(end, start + 60); }
        else { end = Math.min(rows.length, end + 20); start = Math.max(start, end - 60); }
        render();
        const same = anchorId && list.querySelector(`[data-message-id="${anchorId}"]`);
        if (same) scroll.scrollTop += same.getBoundingClientRect().top - top;
        else scroll.scrollTop = direction < 0 ? scroll.scrollHeight : 0;
    }
    previous.addEventListener('click', () => move(-1));
    next.addEventListener('click', () => move(1));
    contentSelect.addEventListener('change', () => render(true));
    root.querySelector('[data-reader-back]').addEventListener('click', options.onBack);
    return {
        reset,
        async open(result, content) {
            reset(); contentSelect.value = content;
            feedback.textContent = '正在展开这段对话…'; root.setAttribute('aria-busy', 'true');
            const pending = new AbortController(); controller = pending;
            try {
                const loaded = await readConversation(options.getContext(), result, pending.signal);
                if (controller !== pending) return;
                rows = loaded.rows; hit = loaded.messageId;
                start = Math.max(0, hit - 4); end = Math.min(rows.length, hit + 6);
                render(true);
            } catch (error) {
                if (!pending.signal.aborted && controller === pending) feedback.textContent = error.message || '读取失败，请返回结果后重试。';
            } finally {
                if (controller === pending) { controller = null; root.removeAttribute('aria-busy'); }
            }
        },
    };
}
