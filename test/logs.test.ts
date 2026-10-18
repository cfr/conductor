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
