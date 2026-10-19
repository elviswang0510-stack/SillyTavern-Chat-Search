// This module intentionally never enumerates arbitrary message/character fields.
export const DEFAULTS = Object.freeze({
    statusTags: 'status,statusbar,status_bar,status-block,character_status,状态栏,状态',
    ignoredTags: 'think,thinking,analysis,reasoning,cot,思考,思考过程,推理,system,system_prompt,prompt,preset,instructions,instruction,world_info,worldbook,预设,提示词,世界书',
});

const UNSAFE = 'script,style,noscript,template,iframe,object,embed,svg,math,canvas,link,meta,head,input,button,select,textarea';
const BLOCKS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'DETAILS', 'SUMMARY', 'LI', 'UL', 'OL', 'TABLE', 'TR', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'HR']);
const STATUS_SELECTOR = '[data-status],.status-bar,.status_bar,.status-panel,.status-block,.statusbar,#status-bar,#status_bar,#statusbar';
const OMIT_SELECTOR = '.reasoning,.mes_reasoning,.thinking,[data-reasoning],.system-prompt,.preset,.instructions';

export function tagNames(value) {
    return [...new Set(String(value).split(/[,，\s]+/u).map(x => x.trim().toLowerCase()).filter(x => /^[\p{L}_][\p{L}\p{N}_-]*$/u.test(x)))].slice(0, 64);
}

function visibleText(node) {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1 && node.nodeType !== 11) return '';
    if (node.nodeName === 'BR') return '\n';
    const text = Array.from(node.childNodes, visibleText).join('');
    if (node.nodeName === 'TD' || node.nodeName === 'TH') return `${text}\t`;
    return BLOCKS.has(node.nodeName) ? `\n${text}\n` : text;
}

function clean(text) {
    return text.replace(/\r\n?/g, '\n').replace(/[\t \u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function extractMessage(message, settings = DEFAULTS, doc = document) {
    if (!message || message.is_system || typeof message.mes !== 'string') return null;
    // HTML inside template.content stays inert: never append it to the live DOM.
    const template = doc.createElement('template');
    template.innerHTML = message.mes.replace(/```(?:think|thinking|analysis|reasoning|cot)\b[^\n]*\n[\s\S]*?(?:```|$)/gi, '')
        .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1');
    const root = template.content;
    const ignored = tagNames(settings.ignoredTags ?? DEFAULTS.ignoredTags);
    const omitted = [UNSAFE, OMIT_SELECTOR, ...ignored].join(',');
    root.querySelectorAll(omitted).forEach(node => node.remove());
    // Hidden template scaffolding is not visible story or status content.
    root.querySelectorAll('[hidden],[aria-hidden="true"]').forEach(node => node.remove());
    root.querySelectorAll('[style]').forEach(node => {
        if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(node.getAttribute('style'))) node.remove();
    });
    const statusNodes = new Set(root.querySelectorAll([STATUS_SELECTOR, ...tagNames(settings.statusTags ?? DEFAULTS.statusTags)].join(',')));
    root.querySelectorAll('details').forEach(node => {
        const summary = Array.from(node.children).find(child => child.nodeName === 'SUMMARY');
        if (summary && /状态|status|人物信息|角色信息/i.test(summary.textContent)) statusNodes.add(node);
    });
    const status = [];
    for (const node of statusNodes) {
        // Nested state containers must only contribute once.
        if (Array.from(statusNodes).some(parent => parent !== node && parent.contains(node))) continue;
        status.push(visibleText(node));
        node.remove();
    }
    let body = clean(visibleText(root));
    const marker = /(?:^|\n)\s*(?:【(?:状态栏|状态|人物状态)】|\[(?:状态栏|status(?:\s*bar)?)\]|#{1,6}\s*(?:状态栏|人物状态))[^\n]*(?:\n|$)/im.exec(body);
    if (marker) {
        status.push(body.slice(marker.index));
        body = body.slice(0, marker.index).trim();
    }
    return { body, status: clean(status.join('\n')) };
}

export function queryTokens(query) {
    if (query.length > 200) throw new Error('关键词最多 200 个字符，请缩短后重试。');
    return [...new Set(query.trim().toLowerCase().split(/\s+/u).filter(Boolean))];
}

export function matches(parts, tokens, content = 'both') {
    if (!parts || !tokens.length) return false;
    const text = (content === 'body' ? parts.body : content === 'status' ? parts.status : `${parts.body}\n${parts.status}`).toLowerCase();
    return tokens.every(token => text.includes(token));
}

export function excerpt(text, tokens, length = 230) {
    if (!text) return '';
    const lower = text.toLowerCase();
    const hits = tokens.map(token => lower.indexOf(token)).filter(index => index >= 0);
    const start = Math.max(0, (hits.length ? Math.min(...hits) : 0) - 65);
    const end = start + length;
    return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export function fingerprint(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
    return `${text.length}:${hash >>> 0}`;
}

export const chatName = value => String(value ?? '').replace(/\.jsonl$/i, '');
