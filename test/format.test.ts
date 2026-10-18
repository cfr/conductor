import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownToHtml } from '../src/format.ts';

function balanced(html: string): boolean {
    const stack: string[] = [];
    for (const m of html.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
        if (m[1]) {
            if (stack.pop() !== m[2]) {
                return false;
            }
        } else {
            stack.push(m[2]);
        }
    }
    return stack.length === 0;
}

test('inline and block formatting', () => {
    const [html] = markdownToHtml(
        '## Findings\n\n1. **Bug** in `pmove` (a < b && c)\n   - nested *note*\n2. see [docs](https://x.y/?a=1&b="2")\n\n```cpp\nif (a < b) {}\n```\n\n> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |',
    );
    assert.equal(
        html,
        '<b>Findings</b>\n\n' +
            '1. <b>Bug</b> in <code>pmove</code> (a &lt; b &amp;&amp; c)\n  • nested <i>note</i>\n' +
            '2. see <a href="https://x.y/?a=1&amp;b=&quot;2&quot;">docs</a>\n\n' +
            '<pre><code class="language-cpp">if (a &lt; b) {}</code></pre>\n\n' +
            '<blockquote>quoted</blockquote>\n\n' +
            '<pre>| a | b |\n| 1 | 2 |</pre>',
    );
});

test('long replies split at blocks, every chunk balanced and under the limit', () => {
    const para = 'word '.repeat(150).trim();
    const code = '```\n' + Array.from({ length: 400 }, (_, i) => `line ${i} <x>`).join('\n') + '\n```';
    const md = [para, para, code, para, 'x'.repeat(9000)].join('\n\n');
    const chunks = markdownToHtml(md, 4000);
    assert.ok(chunks.length > 3);
    for (const c of chunks) {
        assert.ok(c.length <= 4000, `chunk of ${c.length}`);
        assert.ok(balanced(c), c.slice(0, 80));
    }
    const text = chunks.join('').replace(/<[^>]+>/g, '');
    assert.ok(text.includes('line 399 &lt;x&gt;'));
});
