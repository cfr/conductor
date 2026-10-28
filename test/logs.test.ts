import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromClaudeJsonl } from '../src/logs/claude.ts';
import { renderMarkdown } from '../src/logs/markdown.ts';
import { fromOpencode } from '../src/logs/opencode.ts';

test('opencode export renders in the /export layout', () => {
    const md = renderMarkdown(
        fromOpencode({
            info: { id: 'ses_1', title: '0048-antlion', time: { created: 0, updated: 0 } },
            messages: [
                { type: 'user', text: 'please do 0048-antlion' },
                {
                    type: 'assistant',
                    content: [
                        { type: 'reasoning', text: 'look at PLAN' },
                        { type: 'tool', name: 'read', state: { status: 'completed', input: { path: 'PLAN.md' }, content: [{ type: 'text', text: 'ok\n' }] } },
                    ],
                },
                { type: 'synthetic', text: 'hidden' },
                { type: 'assistant', content: [{ type: 'text', text: 'done' }] },
            ],
        }),
    );
    const body = md.slice(md.indexOf('## User'));
    assert.equal(
        body,
        '## User\n\nplease do 0048-antlion\n\n---\n\n' +
            '## Assistant\n\n_Thinking:_\n\nlook at PLAN\n\n**Tool: read**\n\n**Input:**\n```json\n{\n  "path": "PLAN.md"\n}\n```\n\nok\n\n\n---\n\n' +
            '## Assistant\n\ndone\n',
    );
});

test('claude transcript groups assistant blocks and pairs tool results', () => {
    const lines = [
        { type: 'custom-title', customTitle: '0048-antlion review' },
        { type: 'user', timestamp: '2026-10-18T10:00:00Z', message: { content: 'please review 0048' } },
        { type: 'assistant', timestamp: '2026-10-18T10:00:01Z', message: { content: [{ type: 'thinking', thinking: '' }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git log' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'abc' }] }] } },
        { type: 'user', isMeta: true, message: { content: 'meta' } },
        { type: 'user', message: { content: '<task-notification>x</task-notification>' } },
        { type: 'assistant', timestamp: '2026-10-18T10:00:05Z', message: { content: [{ type: 'text', text: 'Findings' }] } },
    ];
    const t = fromClaudeJsonl('uuid', lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"partial');
    assert.equal(t.title, '0048-antlion review');
    assert.equal(t.messages.length, 2);
    assert.deepEqual(t.messages[1].parts.map((p) => p.kind), ['thinking', 'tool', 'text']);
    assert.equal((t.messages[1].parts[1] as { output: string }).output, 'abc');
    assert.equal(t.updated - t.created, 5000);
    assert.doesNotMatch(renderMarkdown(t), /_Thinking:_/);
});

test('opencode steps add up to the header and per-turn token lines', () => {
    const step = (read: number) => ({ type: 'assistant', content: [{ type: 'text', text: 'x' }], tokens: { input: 10, output: 5, reasoning: 1, cache: { read, write: 0 } } });
    const md = renderMarkdown(
        fromOpencode({
            info: { id: 'ses_1', title: '0048-antlion', time: { created: 0, updated: 0 } },
            messages: [
                { type: 'user', text: 'please do 0048-antlion' },
                step(1000),
                step(2000),
                { type: 'compaction' },
                { type: 'user', text: 'fix it' },
                step(1_500_000),
            ],
        }),
    );
    assert.match(md, /^\*\*Tokens:\*\* 3 steps · input 30 · output 18 · cache read 1\.5M · cache write 0 · max context 1\.5M · 1 compaction$/m);
    const turns = [...md.matchAll(/^\*\*Turn tokens:\*\* (.*)$/gm)].map((m) => m[1]);
    assert.deepEqual(turns, [
        '2 steps · input 20 · output 12 · cache read 3k · cache write 0 · max context 2k',
        '1 step · input 10 · output 6 · cache read 1.5M · cache write 0 · max context 1.5M · 1 compaction',
    ]);
});

test('claude usage counts each API message once', () => {
    const usage = { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 };
    const lines = [
        { type: 'user', message: { content: 'please review 0048' } },
        { type: 'assistant', message: { id: 'm1', usage, content: [{ type: 'thinking', thinking: 'hm' }] } },
        { type: 'assistant', message: { id: 'm1', usage, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
        { type: 'assistant', message: { id: 'm2', usage, content: [{ type: 'text', text: 'Findings' }] } },
    ];
    const t = fromClaudeJsonl('uuid', lines.map((l) => JSON.stringify(l)).join('\n'));
    assert.equal(t.messages[1].usage?.steps, 2);
    assert.equal(t.messages[1].usage?.cacheRead, 10000);
    assert.match(renderMarkdown(t), /^\*\*Tokens:\*\* 2 steps · input 4 · output 200 · cache read 10k · cache write 600 · max context 5k$/m);
});
