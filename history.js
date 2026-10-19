import { chatName, cachedParts, matches, excerpt, fingerprint } from './core.js';

async function post(context, path, body, signal, allowListError = false) {
    const response = await fetch(path, {
        method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify(body), signal,
    });
    if (!response.ok) throw new Error(`读取聊天失败（HTTP ${response.status}），请确认已登录酒馆后重试。`);
    const data = await response.json();
    if (!data || data.error && !allowListError) throw new Error('酒馆未返回可用的聊天记录，请刷新页面后重试。');
    return data;
}

export function characterSnapshot(context) {
    if (context.groupId) throw new Error('请先打开一个角色的单人聊天，再搜索该角色的历史记录。');
    const character = context.characters?.[context.characterId];
    if (!character?.avatar) throw new Error('请先打开一个角色的聊天，再开始搜索。');
    return { avatar: character.avatar, name: character.name || '当前角色', current: chatName(context.chatId ?? character.chat) };
}

export async function searchHistory(context, options) {
    const { signal, tokens, settings, scope, content, speaker, cache, onProgress = () => {}, doc = document } = options;
    const selected = characterSnapshot(context);
    // Preserve message order without reading extra, swipes, prompts, world info,
    // character description or chat metadata. Extraction only uses allowed text.
    const current = (context.chat || []).slice();
    const files = new Set();
    let warning = '';
    if (scope === 'character') {
        const data = await post(context, '/api/characters/chats', { avatar_url: selected.avatar, simple: true }, signal, true);
        if (data.error) warning = '历史聊天列表暂不可用，已只搜索当前聊天。若已有历史记录，请重试。';
        if (typeof data !== 'object') throw new Error('历史聊天列表格式不兼容，请更新酒馆或使用“当前聊天”。');
        for (const item of Object.values(data)) {
            if (typeof item?.file_name === 'string') files.add(chatName(item.file_name));
        }
    }
    files.delete(selected.current);
    const queue = scope === 'character' ? [...files].sort().reverse() : [];
    const total = queue.length + 1;
    let done = 0;
    const results = [];
    const failed = [];
    async function scan(messages, file, hasHeader = false) {
        signal.throwIfAborted();
        // Only the JSONL header is skipped; preserve every actual message ID.
        const rows = hasHeader && typeof messages[0]?.mes !== 'string' ? messages.slice(1) : messages;
        let sliceStart = performance.now();
        for (let messageId = 0; messageId < rows.length; messageId++) {
            signal.throwIfAborted();
            if (performance.now() - sliceStart >= 8) {
                await new Promise(resolve => setTimeout(resolve, 0));
                signal.throwIfAborted();
                sliceStart = performance.now();
            }
            const message = rows[messageId];
            if (!message) continue;
            if (speaker === 'character' && message.is_user) continue;
            if (speaker === 'user' && !message.is_user) continue;
            const parts = cachedParts(message, settings, doc, file === selected.current ? cache : undefined);
            if (!matches(parts, tokens, content)) continue;
            const body = content !== 'status' ? excerpt(parts.body, tokens) : '';
            const status = content !== 'body' ? excerpt(parts.status, tokens) : '';
            results.push({
                avatar: selected.avatar, file, messageId,
                author: typeof message.name === 'string' ? message.name : message.is_user ? '你' : selected.name,
                body, status, fingerprint: fingerprint(message.mes),
            });
        }
        done++;
        onProgress(done, total);
    }
    await scan(current, selected.current);
    let cursor = 0;
    async function worker() {
        while (cursor < queue.length) {
            const file = queue[cursor++];
            signal.throwIfAborted();
            try {
                const messages = await post(context, '/api/chats/get', {
                    avatar_url: selected.avatar, ch_name: selected.name, file_name: file,
                }, signal);
                if (!Array.isArray(messages)) throw new Error('聊天格式不兼容或文件已被删除');
                await scan(messages, file, true);
            } catch (error) {
                if (signal.aborted) throw error;
                failed.push(file);
                done++;
                onProgress(done, total);
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    signal.throwIfAborted();
    results.sort((a, b) => Number(b.file === selected.current) - Number(a.file === selected.current) || b.file.localeCompare(a.file) || b.messageId - a.messageId);
    return { results, failed, total, selected, warning };
}

// Read-only snapshot: never open/save a host chat or render its old floors.
export async function readConversation(context, result, signal) {
    const selected = characterSnapshot(context);
    if (selected.avatar !== result.avatar) throw new Error('当前角色已经切换，请重新搜索。');
    let rows;
    if (selected.current === result.file) rows = (context.chat || []).slice();
    else {
        const data = await post(context, '/api/chats/get', {
            avatar_url: selected.avatar, ch_name: selected.name, file_name: result.file,
        }, signal);
        if (!Array.isArray(data)) throw new Error('这段聊天读取失败，请返回结果后重试。');
        rows = typeof data[0]?.mes !== 'string' ? data.slice(1) : data;
    }
    signal.throwIfAborted();
    let messageId = result.messageId;
    if (fingerprint(rows[messageId]?.mes || '') !== result.fingerprint) {
        messageId = rows.findIndex(message => typeof message?.mes === 'string' && fingerprint(message.mes) === result.fingerprint);
    }
    if (messageId < 0) throw new Error('这条消息已被编辑或删除，请返回后重新搜索。');
    return { rows, messageId };
}
