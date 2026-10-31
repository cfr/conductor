import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpencodeWork, type WorkApi } from '../src/agents/opencode-work.ts';
import { OpencodeAdapter } from '../src/agents/opencode.ts';
import type { PendingWorkState } from '../src/agents/types.ts';

interface Info { id: string; outcome?: string; time: { updated: number; idle?: number } }
interface Msg { id: string; type: string; time: { created: number; completed?: number }; metadata?: object; content?: object[];
    error?: { type?: string; message?: string; status?: number } }
interface Session { info: Info; assistant: Msg[]; synthetic: Msg[]; inbox: unknown[] }
const assistant = (id: string, at: number, content: object[] = []): Msg => ({ id, type: 'assistant', time: { created: at, completed: at + 1 }, content });
const tool = (id = 'child', toolId = 'tool1', at = 100) => ({ type: 'tool', name: 'subagent', id: toolId, time: { created: at },
    state: { status: 'completed', input: { description: 'Independent review' }, metadata: { sessionID: id, status: 'running' } } });
const notification = (id = 'child', at = 130): Msg => ({ id: `n${at}`, type: 'synthetic', time: { created: at },
    metadata: { source: 'subagent', childID: id, state: 'completed' } });
function fixture(saved?: PendingWorkState) {
    const sessions: Record<string, Session> = {
        root: { info: { id: 'root', outcome: 'succeeded', time: { updated: 111, idle: 112 } },
            assistant: [assistant('m2', 110), assistant('m1', 100, [tool()])], synthetic: [], inbox: [] },
        child: { info: { id: 'child', time: { updated: 120 } }, assistant: [], synthetic: [], inbox: [] },
    };
    let active: Record<string, object> = { child: { type: 'running' } };
    let shells: object[] = [];
    let fail = '';
    let stored: PendingWorkState | undefined;
    let hook: ((path: string) => void) | undefined;
    const requests: string[] = [];
    const removed: string[] = [];
    const api: WorkApi = async <T>(method: string, path: string): Promise<T> => {
        requests.push(path);
        hook?.(path);
        if (fail && path.includes(fail)) throw new Error('service unavailable');
        if (method === 'DELETE' && path.startsWith('/api/shell/')) {
            const id = new URL(path, 'http://test').pathname.split('/').at(-1)!;
            removed.push(id);
            shells = shells.filter((s) => (s as { id: string }).id !== id);
            return undefined as T;
        }
        if (path === '/api/session/active') return { data: structuredClone(active) } as T;
        if (path.startsWith('/api/shell?')) return { data: shells } as T;
        const u = new URL(path, 'http://test');
        const [, , , id, endpoint] = u.pathname.split('/');
        const s = sessions[id];
        if (!s) throw new Error(`unknown session ${id}`);
        if (endpoint === 'inbox') return { data: s.inbox } as T;
        if (endpoint === 'message') {
            const type = u.searchParams.get('type') as 'assistant' | 'synthetic';
            const offset = Number(u.searchParams.get('cursor') ?? '0');
            const data = s[type].slice(offset, offset + 100);
            return { data, cursor: { next: data.length ? String(offset + data.length) : null } } as T;
        }
        return { data: structuredClone(s.info) } as T;
    };
    const work = new OpencodeWork(api, 'root', '/repo', saved, (state) => { stored = structuredClone(state); });
    return { work, sessions, api, requests, removed, saved: () => stored!, setActive(v: Record<string, object>) { active = v; },
        setShells(v: object[]) { shells = v; }, fail(path: string) { fail = path; }, hook(fn: (path: string) => void) { hook = fn; },
        finishChild() { sessions.child.info = { id: 'child', outcome: 'succeeded', time: { updated: 124, idle: 125 } }; active = {}; },
        consume() {
            sessions.root.synthetic = [notification()];
            sessions.root.assistant.unshift(assistant('m3', 135));
            sessions.root.info.time = { updated: 136, idle: 140 };
            sessions.root.inbox = [];
        } };
}

test('waits for running child, queued completion, and parent processing before releasing', async () => {
    const f = fixture();
    assert.ok((await f.work.pending()).some((p) => p.kind === 'subagent'));
    f.finishChild();
    assert.ok((await f.work.pending()).some((p) => p.description.includes('process completion')));
    f.sessions.root.inbox = [{ type: 'synthetic', payload: { metadata: { source: 'subagent', childID: 'child' } } }];
    assert.ok((await f.work.pending()).some((p) => p.kind === 'inbox'));
    f.sessions.root.synthetic = [notification()];
    f.sessions.root.inbox = [];
    assert.ok((await f.work.pending()).some((p) => p.kind === 'subagent'));
    f.setActive({ root: { type: 'running' } });
    f.consume();
    assert.ok((await f.work.pending()).some((p) => p.kind === 'session'));
    f.setActive({});
    assert.deepEqual(await f.work.pending(), []);
});

test('completion must precede a new assistant request, not just finish while an old request is streaming', async () => {
    const f = fixture();
    f.finishChild();
    f.sessions.root.synthetic = [notification()];
    f.sessions.root.assistant[0].time.completed = 139;
    f.sessions.root.info.time = { updated: 139, idle: 140 };
    assert.ok((await f.work.pending()).some((p) => p.kind === 'subagent'));
    f.consume();
    assert.deepEqual(await f.work.pending(), []);
});

test('state survives restart, and task launches older than the first page are found', async () => {
    const f = fixture();
    f.sessions.root.assistant.unshift(...Array.from({ length: 120 }, (_, i) => assistant(`recent${i}`, 1000 - i)));
    await f.work.pending();
    assert.ok(f.requests.some((p) => p.includes('cursor=100')));
    assert.equal(f.saved().sessions.root.children[0].id, 'child');
    f.finishChild();
    f.consume();
    const restored = new OpencodeWork(f.api, 'root', '/repo', f.saved(), () => {});
    assert.deepEqual(await restored.pending(), []);
});

test('old completion cannot acknowledge a reused child session', async () => {
    const f = fixture();
    f.finishChild(); f.consume();
    assert.deepEqual(await f.work.pending(), []);
    f.sessions.root.assistant.unshift(assistant('m4', 150, [tool('child', 'tool2', 150)]));
    f.sessions.root.info.time = { updated: 151, idle: 152 };
    assert.ok((await f.work.pending()).some((p) => p.kind === 'subagent'));
});

test('checks descendant subagents and their shell jobs', async () => {
    const f = fixture();
    f.finishChild(); f.consume();
    f.sessions.child.assistant = [assistant('c1', 110, [tool('grandchild', 'nested', 110)])];
    f.sessions.grandchild = { info: { id: 'grandchild', time: { updated: 120 } }, assistant: [], synthetic: [], inbox: [] };
    f.setActive({ grandchild: { type: 'running' } });
    f.setShells([{ id: 'shell', status: 'running', command: 'tests', metadata: { sessionID: 'grandchild' } }]);
    const work = await f.work.pending();
    assert.ok(work.some((p) => p.id === 'grandchild'));
    assert.ok(work.some((p) => p.kind === 'shell'));
});

test('API failures fail closed and retain discovered children', async () => {
    const f = fixture();
    await f.work.pending();
    f.fail('/inbox');
    await assert.rejects(f.work.pending(), /service unavailable/);
    assert.equal(f.saved().sessions.root.children.length, 1);
});

test('detects a fast parent resume between transcript inspection and final status check', async () => {
    const f = fixture();
    f.finishChild(); f.consume();
    let reads = 0;
    f.hook((path) => {
        if (path === '/api/session/root' && ++reads === 2) f.sessions.root.info.time = { updated: 150, idle: 151 };
    });
    assert.ok((await f.work.pending()).some((p) => p.description.includes('changed during')));
});

test('unrelated sessions and shell jobs do not block the tracked tree', async () => {
    const f = fixture(); f.finishChild(); f.consume();
    f.setActive({ unrelated: { type: 'running' } });
    f.setShells([{ id: 'other', status: 'running', command: 'server', metadata: { sessionID: 'unrelated' } }]);
    assert.deepEqual(await f.work.pending(), []);
});


test('foreground subagents use inline completion receipts and still expose pending descendants', async () => {
    const f = fixture();
    f.finishChild();
    f.sessions.root.assistant = [assistant('m3', 140), assistant('m1', 100, [{
        ...tool(), time: { created: 100, completed: 130 },
        state: { status: 'completed', input: { description: 'Synchronous review' }, metadata: { sessionID: 'child', status: 'completed' } },
    }])];
    f.sessions.root.info.time = { updated: 141, idle: 145 };
    assert.deepEqual(await f.work.pending(), []);
    f.sessions.child.assistant = [assistant('c1', 110, [tool('grandchild', 'nested', 110)])];
    f.sessions.grandchild = { info: { id: 'grandchild', time: { updated: 120 } }, assistant: [], synthetic: [], inbox: [] };
    assert.ok((await f.work.pending()).some((p) => p.id === 'grandchild'));
});

test('unknown subagent metadata cannot be treated as no pending work', async () => {
    const f = fixture();
    f.sessions.root.assistant = [assistant('m1', 100, [{ type: 'tool', name: 'subagent', id: 't', state: { status: 'completed' } }])];
    await assert.rejects(f.work.pending(), /status is unknown/);
});

test('stop removes only root and discovered descendant shell jobs in the project location', async () => {
    const f = fixture();
    f.setShells([
        { id: 'root-job', status: 'running', command: 'Xvfb', metadata: { sessionID: 'root' } },
        { id: 'child-job', status: 'running', command: 'client', metadata: { sessionID: 'child' } },
        { id: 'other-job', status: 'running', command: 'server', metadata: { sessionID: 'other' } },
        { id: 'unowned-job', status: 'running', command: 'server' },
    ]);
    await f.work.interrupt();
    assert.deepEqual(f.removed.sort(), ['child-job', 'root-job']);
    assert.equal(f.requests[0], '/api/session/root/interrupt');
    assert.equal(f.requests.at(-1), '/api/session/root/interrupt');
    assert.ok(f.requests.filter((p) => p.startsWith('/api/shell/')).every((p) => p.includes('location%5Bdirectory%5D=%2Frepo')));
    assert.equal((await f.work.pending()).some((p) => p.kind === 'shell'), false);
});

test('stop attempts the remaining jobs and reports a cleanup failure', async () => {
    const f = fixture();
    f.setShells([
        { id: 'root-job', status: 'running', command: 'Xvfb', metadata: { sessionID: 'root' } },
        { id: 'child-job', status: 'running', command: 'client', metadata: { sessionID: 'child' } },
    ]);
    f.fail('/api/shell/root-job?');
    await assert.rejects(f.work.interrupt(), /Could not stop owned shell jobs/);
    assert.deepEqual(f.removed, ['child-job']);
    assert.equal(f.requests.at(-1), '/api/session/root/interrupt');
    assert.ok((await f.work.pending()).some((p) => p.id === 'root-job'));
});

test('failed child exposes quota error without a synthetic completion and survives restart', async () => {
    const f = fixture();
    f.finishChild();
    f.sessions.child.info.outcome = 'failed';
    f.sessions.child.assistant = [{ ...assistant('quota-error', 123),
        error: { type: 'provider.quota', status: 429, message: "You've reached your 5-hour usage limit." } }];
    const pending = await f.work.pending();
    assert.match(pending.find((p) => p.kind === 'subagent')!.description,
        /Independent review: failed \(provider.quota: HTTP 429: You've reached your 5-hour usage limit/);
    const restored = new OpencodeWork(f.api, 'root', '/repo', f.saved(), () => {});
    assert.match((await restored.pending()).find((p) => p.kind === 'subagent')!.description, /provider.quota/);
    f.sessions.child.assistant.unshift(assistant('recovered', 145));
    f.sessions.child.info = { id: 'child', outcome: 'succeeded', time: { updated: 146, idle: 147 } };
    assert.doesNotMatch((await restored.pending()).find((p) => p.kind === 'subagent')!.description, /provider.quota|failed/);
});

test('explicit parent continuation handles a failed child only after delivery and successful completion', async () => {
    const f = fixture();
    f.finishChild();
    f.sessions.child.info.outcome = 'failed';
    f.sessions.child.assistant = [{ ...assistant('quota-error', 123),
        error: { type: 'provider.quota', status: 429, message: 'Five-hour usage limit reached' } }];
    const prompt = await f.work.preparePrompt('Continue the committed task');
    assert.match(prompt.text, /provider.quota: HTTP 429/);
    assert.match(prompt.text, /failures, not completed reports/);
    assert.ok((await f.work.pending()).some((p) => p.kind === 'subagent'));
    f.work.promptDelivered(prompt, 'm25');
    // Delivery by itself does not acknowledge the failure.
    assert.ok((await f.work.pending()).some((p) => p.kind === 'subagent'));
    f.sessions.root.assistant.unshift({ ...assistant('m3', 135), error: { message: 'Still over quota' } });
    f.sessions.root.info = { id: 'root', outcome: 'failed', time: { updated: 136, idle: 137 } };
    assert.ok((await f.work.pending()).some((p) => p.kind === 'subagent'));
    f.sessions.root.assistant.unshift(assistant('m4', 145));
    f.sessions.root.info = { id: 'root', outcome: 'succeeded', time: { updated: 146, idle: 147 } };
    assert.deepEqual(await f.work.pending(), []);
    // The receipt and error survive bridge restart without a synthetic child notification.
    const restored = new OpencodeWork(f.api, 'root', '/repo', f.saved(), () => {});
    assert.deepEqual(await restored.pending(), []);
    // A surviving shell is still work even after the failed child has been handled.
    f.setShells([{ id: 'job', status: 'running', command: 'client', metadata: { sessionID: 'child' } }]);
    assert.ok((await restored.pending()).some((p) => p.kind === 'shell'));
    f.setShells([]);
    // Reusing the child requires acknowledgement of its new failure, not the old receipt.
    f.sessions.root.assistant.unshift(assistant('m5', 150, [tool('child', 'tool2', 150)]));
    f.sessions.root.info.time = { updated: 151, idle: 152 };
    f.sessions.child.assistant.unshift({ ...assistant('new-error', 155), error: { message: 'New failure' } });
    f.sessions.child.info.time = { updated: 156, idle: 157 };
    assert.ok((await restored.pending()).some((p) => p.kind === 'subagent'));
});

test('failed-child receipt cannot hide a running parent, child, inbox or a racing resume', async () => {
    const f = fixture();
    f.finishChild();
    f.sessions.child.info.outcome = 'failed';
    const prompt = await f.work.preparePrompt('Continue');
    f.work.promptDelivered(prompt, 'm25');
    f.sessions.root.assistant.unshift(assistant('m3', 135));
    f.sessions.root.info.time = { updated: 136, idle: 140 };
    f.setActive({ root: { type: 'running' } });
    assert.ok((await f.work.pending()).some((p) => p.kind === 'session'));
    f.setActive({ child: { type: 'running' } });
    assert.ok((await f.work.pending()).some((p) => p.id === 'child'));
    f.setActive({});
    f.sessions.child.inbox = [{ type: 'user' }];
    assert.ok((await f.work.pending()).some((p) => p.kind === 'inbox'));
    f.sessions.child.inbox = [];
    assert.deepEqual(await f.work.pending(), []);
    let reads = 0;
    f.hook((path) => {
        if (path === '/api/session/child' && ++reads === 2) f.sessions.child.info.time = { updated: 160 };
    });
    assert.ok((await f.work.pending()).some((p) => p.kind === 'session'));
});

test('OpenCode send delivers the failure advisory and persists acknowledgement only after prompt acceptance', async () => {
    const f = fixture();
    f.finishChild();
    f.sessions.child.info.outcome = 'failed';
    f.sessions.child.assistant = [{ ...assistant('quota-error', 123),
        error: { type: 'provider.quota', status: 429, message: 'Usage exhausted' } }];
    await f.work.pending();
    const adapter = new OpencodeAdapter('http://unused');
    Object.assign(adapter, { ensureEvents() {} });
    let reject = true;
    let delivered = '';
    let saved = f.saved();
    adapter.api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        if (path.endsWith('/prompt')) {
            if (reject) throw new Error('prompt rejected');
            delivered = (body as { text: string }).text;
            f.sessions.root.assistant.unshift(assistant('m3', 135, [{ type: 'text', text: 'Handled the failed exploration myself.' }]));
            f.sessions.root.info.time = { updated: 136, idle: 140 };
            return { data: { id: 'm25' } } as T;
        }
        if (path.includes('/message?order=')) return { data: f.sessions.root.assistant } as T;
        return f.api<T>(method, path);
    };
    adapter.waitForEnd = async () => ({ outcome: 'succeeded' });
    const session = adapter.resume({ name: 'kimi', tag: 'kimi', harness: 'opencode', model: 'test' }, 'root', {
        title: 'Task', cwd: '/repo', pendingWorkState: saved,
        asker: { permission: async () => 'reject', question: async () => '' },
        savePendingWork: (_id, state) => { saved = structuredClone(state); },
    });
    await assert.rejects(session.send('Continue'), /prompt rejected/);
    assert.equal(saved.sessions.root.failureDeliveries, undefined);
    reject = false;
    const result = await session.send('Continue');
    assert.equal(result.outcome, 'succeeded');
    assert.match(delivered, /Usage exhausted/);
    assert.equal(saved.sessions.root.failureDeliveries!.child.messageId, 'm25');
    assert.deepEqual(await session.pendingWork(), []);
});
