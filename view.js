export function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export function highlight(parent, text, tokens) {
    const lower = text.toLowerCase();
    let cursor = 0;
    let marked = 0;
    while (cursor < text.length) {
        // Bound highlighting DOM size in exceptionally long messages.
        if (marked >= 250) { parent.append(document.createTextNode(text.slice(cursor))); break; }
        let next = -1;
        let size = 0;
        for (const token of tokens) {
            const index = lower.indexOf(token, cursor);
            if (index >= 0 && token.length && (next < 0 || index < next || index === next && token.length > size)) {
                next = index; size = token.length;
            }
        }
        if (next < 0) { parent.append(document.createTextNode(text.slice(cursor))); break; }
        parent.append(document.createTextNode(text.slice(cursor, next)), element('mark', '', text.slice(next, next + size)));
        cursor = next + size;
        marked++;
    }
}

export function appendParts(parent, parts, content, tokens, className = 'stcs-excerpt') {
    for (const key of content === 'body' ? ['body'] : content === 'status' ? ['status'] : ['body', 'status']) {
        if (!parts?.[key]) continue;
        const paragraph = element('p', className);
        if (key === 'status') paragraph.append(element('span', 'stcs-content-label', '状态栏'));
        highlight(paragraph, parts[key], tokens);
        parent.append(paragraph);
    }
}
