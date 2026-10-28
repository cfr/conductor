import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../src/agents/codex.ts';
import { parseProjectConfig } from '../src/config.ts';

const agent = { name: 'codex', harness: 'codex' as const, model: 'test-model', tag: 'codex', effort: 'high' };
const asker = { permission: async () => 'reject' as const, question: async () => '' };

test('Codex persists thread, resumes, exports tools and usage, and changes sandbox', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-codex-'));
    try {
        const executable = join(dir, 'fake-codex');
        writeFileSync(executable, `#!/bin/sh
printf '%s\\n' "$@" > args.txt
cat > /dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"test-thread"}' '{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"files"}}' '{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}' '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":20}}'
`, { mode: 0o700 });
        const opts = { title: 'Test', cwd: dir, asker };
        const adapter = new CodexAdapter(join(dir, 'sessions'), executable);
        const session = await adapter.create(agent, opts);
        const result = await session.send('hello');
        assert.equal(result.outcome, 'succeeded', result.error ?? '');
        const transcript = await session.transcript();
        assert.equal(transcript?.messages[1].usage?.input, 60);
        assert.equal(transcript?.messages[1].usage?.cacheRead, 40);
        assert.equal(transcript?.messages[1].parts[0].kind, 'tool');
        const resumed = adapter.resume(agent, session.id, opts);
        assert.equal(await resumed.lastReply(), 'Done');
        await resumed.setReadOnly(true);
        assert.equal((await resumed.send('follow up')).outcome, 'succeeded');
        const args = readFileSync(join(dir, 'args.txt'), 'utf8').trimEnd().split('\n');
        assert.ok(args.includes('sandbox_mode="read-only"'));
        assert.ok(args.includes('approval_policy="never"'));
        assert.deepEqual(args.slice(-3), ['resume', 'test-thread', '-']);
        assert.equal((await resumed.transcript())?.messages.length, 4);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex missing executable returns failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-codex-'));
    try {
        const session = await new CodexAdapter(dir, join(dir, 'missing')).create(agent, { title: 'test', cwd: dir, asker });
        assert.equal((await session.send('test')).outcome, 'failed');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Codex config accepts effort and rejects Claude permission modes', () => {
    const base = `[gate]\ntest="true"\n[roles]\nimplement="codex"\nreview="codex"\nplan="codex"\n[agents.codex]\nharness="codex"\nmodel="test-model"\ntag="codex"\neffort="xhigh"\n`;
    assert.equal(parseProjectConfig('/r', base).agents.get('codex')?.effort, 'xhigh');
    assert.throws(() => parseProjectConfig('/r', base + 'permission_mode="auto"'), /permission_mode/);
    assert.throws(() => parseProjectConfig('/r', base.replace('xhigh', 'max')), /effort/);
});
