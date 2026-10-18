import type { List, ListItem, Nodes, Root, RootContent } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const parser = unified().use(remarkParse).use(remarkGfm);

export function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(node: Nodes): string {
    switch (node.type) {
        case 'text':
            return escapeHtml(node.value);
        case 'strong':
            return `<b>${children(node)}</b>`;
        case 'emphasis':
            return `<i>${children(node)}</i>`;
        case 'delete':
            return `<s>${children(node)}</s>`;
        case 'inlineCode':
            return `<code>${escapeHtml(node.value)}</code>`;
        case 'link':
            return `<a href="${escapeHtml(node.url).replace(/"/g, '&quot;')}">${children(node)}</a>`;
        case 'image':
            return escapeHtml(node.alt || node.url);
        case 'break':
            return '\n';
        case 'html':
            return escapeHtml(node.value);
        default:
            return 'children' in node ? children(node) : '';
    }
}

function children(node: { children: Nodes[] }): string {
    return node.children.map(inline).join('');
}

function listItem(item: ListItem, marker: string, depth: number): string {
    const pad = '  '.repeat(depth);
    const check = item.checked === true ? '☑ ' : item.checked === false ? '☐ ' : '';
    const parts = item.children.map((c) =>
        c.type === 'list' ? list(c, depth + 1) : block(c as RootContent, depth + 1).trimStart(),
    );
    return `${pad}${marker} ${check}${parts.join('\n')}`;
}

function list(node: List, depth: number): string {
    const start = node.start ?? 1;
    return node.children
        .map((item, i) => listItem(item, node.ordered ? `${start + i}.` : '•', depth))
        .join('\n');
}

function block(node: RootContent, depth = 0): string {
    switch (node.type) {
        case 'paragraph':
            return children(node);
        case 'heading':
            return `<b>${children(node)}</b>`;
        case 'code': {
            const lang = node.lang ? ` class="language-${escapeHtml(node.lang)}"` : '';
            return `<pre><code${lang}>${escapeHtml(node.value)}</code></pre>`;
        }
        case 'blockquote':
            return `<blockquote>${node.children.map((c) => block(c, depth)).join('\n\n')}</blockquote>`;
        case 'list':
            return list(node, depth);
        case 'thematicBreak':
            return '———';
        case 'table':
            return `<pre>${escapeHtml(
                node.children
                    .map((row) => '| ' + row.children.map((cell) => plain(cell)).join(' | ') + ' |')
                    .join('\n'),
            )}</pre>`;
        case 'html':
            return escapeHtml(node.value);
        default:
            return 'children' in node ? children(node as { children: Nodes[] }) : '';
    }
}

function plain(node: Nodes): string {
    if ('value' in node) {
        return node.value;
    }
    return 'children' in node ? node.children.map(plain).join('') : '';
}

function splitCode(text: string, lang: string | null | undefined, limit: number): string[] {
    const attr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    const open = `<pre><code${attr}>`;
    const close = '</code></pre>';
    const out: string[] = [];
    let cur = '';
    for (const line of text.split('\n')) {
        const add = escapeHtml(line) + '\n';
        if (cur && open.length + cur.length + add.length + close.length > limit) {
            out.push(open + cur.trimEnd() + close);
            cur = '';
        }
        cur += add.length + open.length + close.length > limit ? add.slice(0, limit - open.length - close.length) : add;
    }
    if (cur) {
        out.push(open + cur.trimEnd() + close);
    }
    return out;
}

function splitPlain(text: string, limit: number): string[] {
    const out: string[] = [];
    let rest = text;
    while (rest.length > limit) {
        let cut = rest.lastIndexOf('\n', limit);
        if (cut < limit / 2) {
            cut = limit;
        }
        out.push(escapeHtml(rest.slice(0, cut)));
        rest = rest.slice(cut).replace(/^\n/, '');
    }
    if (rest) {
        out.push(escapeHtml(rest));
    }
    return out;
}

export function markdownToHtml(md: string, limit = 4000): string[] {
    const tree = parser.parse(md) as Root;
    const pieces: string[] = [];
    for (const node of tree.children) {
        const html = block(node);
        if (html.length <= limit) {
            pieces.push(html);
        } else if (node.type === 'code') {
            pieces.push(...splitCode(node.value, node.lang, limit));
        } else {
            const start = node.position?.start.offset ?? 0;
            const end = node.position?.end.offset ?? md.length;
            // escaping can grow text past the limit; leave room for it
            pieces.push(...splitPlain(md.slice(start, end), Math.floor(limit / 1.5)));
        }
    }
    const chunks: string[] = [];
    let cur = '';
    for (const p of pieces) {
        if (cur && cur.length + 2 + p.length > limit) {
            chunks.push(cur);
            cur = '';
        }
        cur = cur ? `${cur}\n\n${p}` : p;
    }
    if (cur || chunks.length === 0) {
        chunks.push(cur);
    }
    return chunks;
}
