import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../src/agents/codex.ts';
import { renderMarkdown, usageMetadata } from '../src/logs/markdown.ts';
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
n=0
if test -f count.txt; then read n < count.txt; fi
n=$((n + 1))
printf '%s\\n' "$n" > count.txt
printf '%s\\n' '{"type":"thread.started","thread_id":"test-thread"}' '{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"files"}}' '{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}'
printf '{"type":"turn.completed","usage":{"input_tokens":%s,"cached_input_tokens":%s,"output_tokens":%s}}\\n' "$((100 * n))" "$((40 * n))" "$((20 * n))"
`, { mode: 0o700 });
        const opts = { title: 'Test', cwd: dir, asker };
        const adapter = new CodexAdapter(join(dir, 'sessions'), executable);
        const session = await adapter.create(agent, opts);
        const result = await session.send('hello');
        assert.equal(result.outcome, 'succeeded', result.error ?? '');
        const initialArgs = readFileSync(join(dir, 'args.txt'), 'utf8').trimEnd().split('\n');
        assert.ok(initialArgs.includes('sandbox_mode="workspace-write"'));
        assert.ok(initialArgs.includes('approval_policy="on-request"'));
        assert.ok(initialArgs.includes('approvals_reviewer="auto_review"'));
        assert.ok(!initialArgs.includes('--dangerously-bypass-approvals-and-sandbox'));
        const transcript = await session.transcript();
        assert.equal(transcript?.messages[1].usage?.input, 60);
        assert.equal(transcript?.messages[1].usage?.cacheRead, 40);
        assert.equal(transcript?.messages[1].parts[0].kind, 'tool');
        assert.match(renderMarkdown(transcript!), /1 turn · model steps unavailable/);
        assert.match(renderMarkdown(transcript!), /max context unavailable/);
        const metadata = usageMetadata(transcript!) as { total: { input: number; steps: null; maxContext: null }; entries: { source: { raw: unknown } }[] };
        assert.equal(metadata.total.input, 60);
        assert.equal(metadata.total.steps, null);
        assert.equal(metadata.total.maxContext, null);
        assert.deepEqual(metadata.entries[0].source.raw, { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 });
        // Old bridge state mislabeled turn totals as a single model step/context.
        const savedFile = join(dir, 'sessions', `${session.id}.json`);
        const old = JSON.parse(readFileSync(savedFile, 'utf8'));
        old.transcript.messages[1].usage.steps = 1;
        old.transcript.messages[1].usage.maxContext = 100;
        delete old.transcript.messages[1].usageSource;
        writeFileSync(savedFile, JSON.stringify(old));
        const resumed = adapter.resume(agent, session.id, opts);
        assert.equal(await resumed.lastReply(), 'Done');
        assert.match(renderMarkdown((await resumed.transcript())!), /model steps unavailable/);
        assert.match(renderMarkdown((await resumed.transcript())!), /max context unavailable/);
        await resumed.setReadOnly(true);
        assert.equal((await resumed.send('follow up')).outcome, 'succeeded');
        const args = readFileSync(join(dir, 'args.txt'), 'utf8').trimEnd().split('\n');
        assert.ok(args.includes('sandbox_mode="read-only"'));
        assert.ok(args.includes('approval_policy="never"'));
        assert.deepEqual(args.slice(-3), ['resume', 'test-thread', '-']);
        await resumed.setReadOnly(false);
        assert.equal((await resumed.send('commit the changes')).outcome, 'succeeded');
        const writableArgs = readFileSync(join(dir, 'args.txt'), 'utf8').trimEnd().split('\n');
        assert.ok(writableArgs.includes('approval_policy="on-request"'));
        assert.ok(writableArgs.includes('approvals_reviewer="auto_review"'));
        assert.ok(writableArgs.includes('sandbox_mode="workspace-write"'));
        assert.deepEqual(writableArgs.slice(-3), ['resume', 'test-thread', '-']);
        assert.equal((await resumed.transcript())?.messages.length, 6);
        assert.match(renderMarkdown((await resumed.transcript())!), /3 turns · model steps unavailable · input 180/);
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

test('Codex process ownership survives host exit and shutdown prevents additional turns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-codex-owner-'));
    const executable = join(dir, 'fake-codex');
    const pidFile = join(dir, 'pid');
    const module = new URL('../src/agents/codex.ts', import.meta.url).href;
    writeFileSync(executable, `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
console.log(JSON.stringify({type:'thread.started',thread_id:'test'}));setInterval(()=>{},1000);
`, { mode: 0o700 });
    const host = join(dir, 'host.mjs');
    const state = join(dir, 'state');
    writeFileSync(host, `import {CodexAdapter} from ${JSON.stringify(module)};import {writeFileSync} from 'node:fs';
const a=new CodexAdapter(${JSON.stringify(state)},${JSON.stringify(executable)});
const s=await a.create(${JSON.stringify(agent)},{title:'t',cwd:${JSON.stringify(dir)},asker:{}});
writeFileSync(${JSON.stringify(join(dir, 'id'))},s.id);void s.send('hello');setTimeout(()=>process.exit(0),600);`);
    let recovered: ReturnType<CodexAdapter['resume']> | undefined;
    let pid: number | undefined;
    try {
        const hostProcess = spawn(process.execPath, [host], { stdio: 'ignore' });
        await new Promise<void>((resolve, reject) => { hostProcess.once('error', reject); hostProcess.once('exit', () => resolve()); });
        assert.ok(existsSync(pidFile));
        pid = Number(readFileSync(pidFile, 'utf8'));
        const adapter = new CodexAdapter(state, executable);
        recovered = adapter.resume(agent, readFileSync(join(dir, 'id'), 'utf8'), { title: 't', cwd: dir, asker });
        assert.deepEqual(await recovered.turnState(0), { running: true });
        assert.equal((await recovered.pendingWork()).length, 1);
        await assert.rejects(recovered.send('another turn'), /still running/);
        await adapter.shutdown();
        assert.equal((await recovered.turnState(0)).running, false);
        assert.deepEqual(await recovered.pendingWork(), []);
        await assert.rejects(recovered.send('after shutdown'), /closed/);
        await assert.rejects(adapter.create(agent, { title: 't', cwd: dir, asker }), /shutting down/);
    } finally {
        if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
        rmSync(dir, { recursive: true, force: true });
    }
});

test('Codex shutdown interrupts a live turn and closes every session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-codex-shutdown-'));
    const executable = join(dir, 'fake-codex');
    const pidFile = join(dir, 'pid');
    writeFileSync(executable, `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
setInterval(()=>{},1000);
`, { mode: 0o700 });
    const adapter = new CodexAdapter(join(dir, 'state'), executable);
    try {
        const opts = { title: 't', cwd: dir, asker };
        const active = await adapter.create(agent, opts);
        const idle = await adapter.create(agent, opts);
        const running = active.send('hello');
        for (let n = 0; n < 150 && !existsSync(pidFile); n++) await new Promise((r) => setTimeout(r, 20));
        assert.ok(existsSync(pidFile));
        await adapter.shutdown();
        assert.equal((await running).outcome, 'interrupted');
        assert.equal((await active.turnState(0)).running, false);
        assert.deepEqual(await active.pendingWork(), []);
        assert.equal(JSON.parse(readFileSync(join(dir, 'state', `${active.id}.json`), 'utf8')).process, undefined);
        await assert.rejects(idle.send('after shutdown'), /closed/);
    } finally { await adapter.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
