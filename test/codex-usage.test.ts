import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCodexUsage } from '../src/logs/codex-usage.ts';
import { emptyUsage, renderMarkdown, usageMetadata, type Transcript } from '../src/logs/markdown.ts';
import { rebuildCodexUsage } from '../tools/rebuild-codex-usage.ts';

function fixture(): Transcript {
    const values = [[100, 40, 20], [220, 100, 35], [260, 120, 40]];
    return { id: 'test', title: 'Test', created: 0, updated: 0, messages: values.flatMap(([input, cached, output]) => [
        { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'Continue' }] },
        { role: 'assistant' as const, parts: [{ kind: 'text' as const, text: 'Done' }],
            usage: { ...emptyUsage(), input: input - cached, cacheRead: cached, output },
            usageSource: { kind: 'codex-turn' as const, raw: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } },
    ]) };
}

test('exports subtract cumulative counters before aggregating, preserve raw values and are idempotent', () => {
    const t = fixture();
    const metadata = usageMetadata(t) as { total: { input: number; output: number; cacheRead: number }; entries: { input: number; output: number; cacheRead: number }[] };
    assert.equal(metadata.total.input, 140); assert.equal(metadata.total.output, 40); assert.equal(metadata.total.cacheRead, 120);
    assert.deepEqual(metadata.entries.map((e) => [e.input, e.cacheRead, e.output]), [[60, 40, 20], [60, 60, 15], [20, 20, 5]]);
    assert.equal(t.messages[3].usageSource?.raw?.output_tokens, 35);
    assert.match(renderMarkdown(t), /input 140 · output 40 · cache read 120/);
    assert.deepEqual(usageMetadata(t), metadata);
});

test('counter resets begin a new epoch and absent completion usage stays unmetered', () => {
    const t = fixture();
    t.messages[3].usageSource!.raw = { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 };
    t.messages[5].usage = undefined; t.messages[5].usageSource = undefined;
    normalizeCodexUsage(t);
    assert.equal(t.messages[3].usage?.input, 8);
    assert.equal(t.messages[3].usageSource?.counterReset, true);
    const metadata = usageMetadata(t) as { total: { input: number; output: number; unmeteredTurns: number } };
    assert.equal(metadata.total.input, 68); assert.equal(metadata.total.output, 23); assert.equal(metadata.total.unmeteredTurns, 1);
});

test('historical rebuild updates usage only, supports dry-run and repeat runs, and preserves other harnesses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-usage-rebuild-'));
    const state = join(dir, 'state'), logs = join(dir, 'logs'); mkdirSync(state); mkdirSync(logs);
    try {
        const t = fixture();
        writeFileSync(join(state, 'test.json'), JSON.stringify({ thread: 'native', transcript: t }));
        const corrected = usageMetadata(t) as { entries: unknown[]; total: object };
        const old = { ...corrected, total: { input: 340, output: 95 }, agent: { harness: 'codex' } };
        const sidecar = join(logs, 'test.usage.json'), markdown = join(logs, 'test.md');
        writeFileSync(sidecar, JSON.stringify(old));
        const text = renderMarkdown(t).replace(/^\*\*Tokens:\*\*.*$/m, '**Tokens:** old counters');
        writeFileSync(markdown, text);
        writeFileSync(join(logs, 'other.usage.json'), '{"agent":{"harness":"opencode"}}');
        assert.ok(rebuildCodexUsage(state, logs).changed.includes(sidecar));
        assert.equal(readFileSync(markdown, 'utf8'), text);
        const result = rebuildCodexUsage(state, logs, true);
        assert.equal(result.skipped.length, 0);
        assert.deepEqual(JSON.parse(readFileSync(sidecar, 'utf8')).total, corrected.total);
        assert.equal(readFileSync(markdown, 'utf8'), renderMarkdown(t));
        assert.equal(readFileSync(join(logs, 'other.usage.json'), 'utf8'), '{"agent":{"harness":"opencode"}}');
        assert.equal(rebuildCodexUsage(state, logs, true).changed.length, 0);
        writeFileSync(markdown, readFileSync(markdown, 'utf8') + '\nmanual note');
        assert.match(rebuildCodexUsage(state, logs, true).skipped[0], /content differs/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
