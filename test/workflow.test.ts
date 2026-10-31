import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Conductor } from '../src/conductor.ts';
import { Store } from '../src/state.ts';
import { FindingStore } from '../src/findings.ts';
import type { AgentConfig, LocalConfig } from '../src/config.ts';
import type { Adapter, AgentSession, SessionOptions, TurnResult } from '../src/agents/types.ts';
import type { Messenger } from '../src/telegram.ts';

interface Harness {
    adapters: Record<AgentConfig['harness'], Adapter>;
    project: { gate: { name: string; cmd: string }[] };
    live: Map<string, AgentSession>;
    busy: string | null;
    afterImplementGate(): Promise<void>;
    continueTurn(args: string): Promise<void>;
    fix(notes: string): Promise<void>;
    gateCommand(): Promise<void>;
    settle(role: 'implement', result: TurnResult): Promise<{ waiting: boolean }>;
    drainWork(): Promise<void>;
    startReview(agent: string): Promise<void>;
    shutdown(): Promise<void>;
    announce(): Promise<void>;
    stop(args?: string): Promise<void>;
    skipFeedback(): Promise<void>;
    runFeedback(agent: string): Promise<void>;
    rolesCommand(args: string): Promise<void>;
    agentCommand(args: string): Promise<void>;
    roleList(): string;
    agentList(): string;
    unsolicited(id: string, event: { phase: 'started' }): Promise<void>;
}
const feedback = (findings: unknown[], verifications: unknown[] = [], verdict = findings.length ? 'findings' : 'clean') =>
    'Report.\n```conductor-feedback\n' + JSON.stringify({ findings, verifications, verdict }) + '\n```\nVERDICT: ' + verdict;
const finding = { key: 'bug', category: 'bug', summary: 'Routing skips prediction', location: 'code.txt:1', evidence: 'late arrival probe fails' };
const answer = 'Fixed.\n```conductor-dispositions\n' + JSON.stringify({ dispositions: [{ id: '0170-F01', status: 'fixed', reason: 'Regression fails without fix' }] }) + '\n```';

function setup(feedbackReplies: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-workflow-'));
    const project = join(dir, 'project');
    mkdirSync(project);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    writeFileSync(join(project, '.gitignore'), 'wlog/\ngate-count\n');
    writeFileSync(join(project, 'code.txt'), 'before');
    writeFileSync(join(project, 'PLAN.md'), '# Plan\n');
    writeFileSync(join(project, 'CONDUCTOR.toml'), `
[gate]
all = "echo passed >> gate-count"
[roles]
implement = "kimi"
review = "sol"
plan = "sol"
feedback = ["ds", "glm", "mm"]
[agents.kimi]
harness="codex"
model="test-kimi"
tag="kimi"
[agents.ds]
harness="codex"
model="test-ds"
tag="ds"
[agents.glm]
harness="codex"
model="test-glm"
tag="glm"
[agents.mm]
harness="codex"
model="test-mm"
tag="mm"
[agents.sol]
harness="codex"
model="test-sol"
tag="sol"
[prompts]
feedback="Custom checker prompt"
feedback_fix="Custom repair prompt: {findings}"
`);
    git('add', '.');
    git('commit', '-qm', 'Initial');
    const base = git('rev-parse', 'HEAD');
    const local: LocalConfig = { file: join(dir, 'config.toml'), project, stateFile: join(dir, 'state', 'state.json'),
        telegram: { token: 'test', allowedUserId: 1 }, opencodeUrl: 'http://unused' };
    const store = new Store(local.stateFile);
    const sent: string[] = [];
    const prompts: { agent: string; text: string }[] = [];
    const sessions = new Map<string, AgentSession>();
    let implementationReplies = [answer];
    let reviewReplies: string[] = [];
    let reviewFixReplies: string[] = [];
    let implementationCommits = true;
    let implementationOutcome: TurnResult['outcome'] = 'succeeded';
    let repairs = 0;
    const repair = () => {
        writeFileSync(join(project, 'code.txt'), `after ${++repairs}`);
        git('add', 'code.txt'); git('commit', '-qm', 'Repair');
    };
    const makeSession = (agent: AgentConfig, id: string, opts: SessionOptions): AgentSession => {
        let last = '';
        const messages: { role: 'user' | 'assistant'; parts: { kind: 'text'; text: string }[] }[] = [];
        const session: AgentSession = {
            id, agent,
            async send(text): Promise<TurnResult> {
                prompts.push({ agent: agent.name, text });
                messages.push({ role: 'user', parts: [{ kind: 'text', text }] });
                if (agent.name === 'kimi') {
                    // Only the actual repair turn commits; report correction turns do not.
                    if (implementationCommits && !text.includes('Do not edit files or commit during this correction')) repair();
                    last = implementationReplies.shift() ?? answer;
                } else if (agent.name === 'sol') {
                    if (store.state.sessions.review?.fixingFindings) { repair(); last = reviewFixReplies.shift() ?? answer; }
                    else last = reviewReplies.shift() ?? feedback([]);
                }
                else last = feedbackReplies.shift() ?? feedback([]);
                messages.push({ role: 'assistant', parts: [{ kind: 'text', text: last }] });
                return { outcome: agent.name === 'kimi' ? implementationOutcome : 'succeeded', text: last };
            },
            async lastReply() { return last; }, async interrupt() {}, async setReadOnly() {},
            async pendingWork() { return []; }, async turnState() { return { running: false, outcome: 'succeeded' }; },
            async transcript() { return { id, title: opts.title, created: 0, updated: 1, messages }; },
        };
        sessions.set(id, session);
        return session;
    };
    const adapter: Adapter = {
        async create(agent, opts) { return makeSession(agent, randomUUID(), opts); },
        resume(agent, id, opts) { return sessions.get(id) ?? makeSession(agent, id, opts); },
    };
    const noop = async () => {};
    const chat: Messenger = { onText: noop, command() {}, send: async (text) => { sent.push(text); },
        sendMarkdown: noop, sendQuoted: noop, sendLog: noop, sendHtml: noop, sendFile: noop,
        ask: async () => 'keep', pendingQuestions: () => 0, takeOver: noop };
    const conductor = new Conductor(local, store, chat);
    const h = conductor as unknown as Harness;
    h.adapters = { codex: adapter, opencode: adapter, claude: adapter };
    const implId = randomUUID();
    const implAgent: AgentConfig = { name: 'kimi', model: 'test-kimi', tag: 'kimi', harness: 'codex' };
    const impl = makeSession(implAgent, implId, { title: '0170-task', cwd: project, asker: { permission: async () => 'reject', question: async () => '' } });
    h.live.set('implement', impl);
    store.state.task = { id: '0170-task', number: '0170', text: 'Task' };
    store.state.sessions.implement = { id: implId, agent: 'kimi', title: '0170-task', startSha: base, checkedSha: base };
    store.state.lastGate = { ok: true, sha: base, at: '2026-10-29', commands: ['echo passed >> gate-count'] };
    store.save();
    return { dir, project, local, store, chat, sessions, adapter, h, prompts, sent, git,
        setImplementationReplies(replies: string[]) { implementationReplies = replies; },
        setReviewReplies(replies: string[]) { reviewReplies = replies; },
        setReviewFixReplies(replies: string[]) { reviewFixReplies = replies; },
        setImplementationCommits(on: boolean) { implementationCommits = on; },
        setImplementationOutcome(outcome: TurnResult['outcome']) { implementationOutcome = outcome; },
        records: new FindingStore(join(dir, 'state', 'findings')) };
}

test('full feedback flow records actual repair commits, passes ledger/gate context and exports findings', async () => {
    const f = setup([
        feedback([finding]),
        feedback([], [{ id: '0170-F01', status: 'verified', reason: 'Probe now passes and fails before repair' }]),
        feedback([]),
    ]);
    try {
        await f.h.afterImplementGate();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'kimi', 'glm', 'mm', 'sol']);
        const l = f.records.read('0170-task');
        assert.equal(l.findings[0].disposition, 'fixed');
        assert.equal(l.findings[0].verification, 'verified');
        assert.deepEqual(l.findings[0].fixCommits, [f.git('rev-parse', 'HEAD')]);
        assert.equal(l.findings[0].source.agent, 'ds');
        const glm = f.prompts.find((p) => p.agent === 'glm')!.text;
        assert.match(glm, /Custom checker prompt/);
        assert.match(glm, /0170-F01 \[bug; fixed; verification pending\]/);
        assert.match(glm, /Conductor gate: PASSED at/);
        assert.match(glm, /Conductor owns the full verification gate/);
        assert.match(glm, /regression test failing without the fix/);
        assert.match(glm, /real caller\/entry path/);
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\n');
        assert.match(readFileSync(join(f.project, 'wlog', '0170-task-findings.md'), 'utf8'), /verification verified/);
        assert.ok(existsSync(join(f.project, 'wlog', '0170-task-gate.log')));
        assert.ok(existsSync(join(f.project, 'wlog', '0170-task-feedback-ds.usage.json')));
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('malformed feedback retries once and stays pending across a restarted conductor', async () => {
    const f = setup(['Intro only', 'VERDICT: clean']);
    try {
        await f.h.afterImplementGate();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'ds']);
        assert.equal(f.records.read('0170-task').reports.length, 2);
        assert.ok(f.records.read('0170-task').reports.every((r) => r.error));
        assert.match(f.sent.at(-1)!, /task flow paused/);
        const restarted = new Conductor(f.local, new Store(f.local.stateFile), f.chat) as unknown as Harness;
        restarted.adapters = { codex: f.adapter, opencode: f.adapter, claude: f.adapter };
        for (const [id, session] of f.sessions) {
            const ref = Object.entries(f.store.state.sessions).find(([, r]) => r?.id === id);
            if (ref) restarted.live.set(ref[0], session);
        }
        await restarted.continueTurn('feedback');
        // Default next reply is structurally valid clean, so the explicit continuation proceeds.
        assert.ok(f.prompts.some((p) => p.agent === 'glm'));
        assert.ok(!f.prompts.some((p) => p.agent === 'kimi'));
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('malformed dispositions are corrected without losing the original repair commit or rerunning repair', async () => {
    const f = setup([feedback([finding]), feedback([], [{ id: '0170-F01', status: 'verified', reason: 'checked' }]), feedback([])]);
    f.setImplementationReplies(['Fixed the code.', answer]);
    try {
        await f.h.afterImplementGate();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'kimi', 'kimi', 'glm', 'mm', 'sol']);
        const l = f.records.read('0170-task');
        assert.equal(l.findings[0].verification, 'verified');
        assert.deepEqual(l.findings[0].fixCommits, [f.git('rev-parse', 'HEAD')]);
        assert.equal(l.reports.filter((r) => r.kind === 'dispositions' && r.error).length, 1);
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\n');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});


test('final review independently verifies fixes from the last feedback checker', async () => {
    const f = setup([feedback([]), feedback([]), feedback([finding])]);
    f.setReviewReplies([feedback([], [{ id: '0170-F01', status: 'verified', reason: 'Final review reproduced the regression test' }])]);
    try {
        await f.h.afterImplementGate();
        const l = f.records.read('0170-task');
        assert.equal(l.findings[0].verification, 'verified');
        assert.equal(l.findings[0].history.at(-1)?.source.role, 'review');
        assert.equal(l.reports.at(-1)?.kind, 'review');
        assert.match(f.prompts.at(-1)!.text, /0170-F01 \[bug; fixed; verification pending\]/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('rejected findings and duplicate paperwork reach later checkers without another repair or gate', async () => {
    const f = setup([feedback([{ ...finding, category: 'process', summary: 'Rewrite old commit body' }]),
        feedback([{ ...finding, key: 'repeat', duplicateOf: '0170-F01' }],
            [{ id: '0170-F01', status: 'accepted_rejection', reason: 'New-commit rule prohibits rewriting history' }], 'clean'), feedback([])]);
    f.setImplementationCommits(false);
    f.setImplementationReplies(['```conductor-dispositions\n' + JSON.stringify({ dispositions: [
        { id: '0170-F01', status: 'rejected', reason: 'Requires history rewrite prohibited by instructions' },
    ] }) + '\n```']);
    try {
        await f.h.afterImplementGate();
        assert.equal(f.prompts.filter((p) => p.agent === 'kimi').length, 1);
        assert.equal(existsSync(join(f.project, 'gate-count')), false);
        assert.match(f.prompts.find((p) => p.agent === 'glm')!.text, /Requires history rewrite/);
        const l = f.records.read('0170-task');
        assert.equal(l.findings[0].verification, 'accepted_rejection');
        assert.equal(l.findings[1].duplicateOf, '0170-F01');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('failed repair with commits pauses before dispositions and cannot advance to another checker', async () => {
    const f = setup([feedback([finding])]);
    f.setImplementationOutcome('failed');
    try {
        await f.h.afterImplementGate();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'kimi']);
        assert.equal(f.records.read('0170-task').findings[0].disposition, 'open');
        assert.deepEqual(f.store.state.feedbackFindingIds, ['0170-F01']);
        assert.equal(existsSync(join(f.project, 'gate-count')), false);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('review findings and explicit /fix dispositions are tracked without claiming self-verification', async () => {
    const f = setup([feedback([]), feedback([]), feedback([])]);
    f.setReviewReplies([feedback([finding])]);
    f.setReviewFixReplies([answer]);
    try {
        await f.h.afterImplementGate();
        assert.equal(f.records.read('0170-task').findings[0].source.role, 'review');
        await f.h.fix('');
        const f1 = f.records.read('0170-task').findings[0];
        assert.equal(f1.disposition, 'fixed');
        assert.equal(f1.verification, 'pending');
        assert.equal(f1.answeredBy, 'sol');
        assert.deepEqual(f1.fixCommits, [f.git('rev-parse', 'HEAD')]);
        assert.equal(f.store.state.sessions.review?.fixingFindings, undefined);
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\n');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});


test('two malformed disposition reports pause without losing commits, and /gate cannot bypass them', async () => {
    const f = setup([feedback([finding])]);
    f.setImplementationReplies(['Fixed it', 'Still no JSON']);
    try {
        await f.h.afterImplementGate();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'kimi', 'kimi']);
        assert.match(f.sent.at(-1)!, /task flow paused/);
        assert.equal(f.store.state.feedbackDispositionPending, true);
        await f.h.gateCommand();
        assert.match(f.sent.at(-1)!, /dispositions are pending/);
        assert.equal(existsSync(join(f.project, 'gate-count')), false);
        assert.equal(f.records.read('0170-task').findings[0].disposition, 'open');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});


test('gate-failure repair commits stay linked and require dispositions before subsequent verification', async () => {
    const f = setup([feedback([finding]), feedback([], [{ id: '0170-F01', status: 'verified', reason: 'Checked both repair commits' }]), feedback([])]);
    f.h.project.gate[0].cmd = 'echo passed >> gate-count; test "$(wc -l < gate-count)" -ge 2';
    try {
        await f.h.afterImplementGate();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'kimi', 'kimi', 'glm', 'mm', 'sol']);
        const bug = f.records.read('0170-task').findings[0];
        assert.equal(bug.fixCommits.length, 2);
        assert.equal(bug.fixCommits[0], f.git('rev-parse', 'HEAD'));
        assert.equal(bug.verification, 'verified');
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\npassed\n');
        assert.match(f.prompts.filter((p) => p.agent === 'kimi')[1].text, /Requested IDs: 0170-F01/);
        assert.equal(f.store.state.feedbackFindingIds, undefined);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});


test('discussion after a completed review stays conversational and does not trigger report retries', async () => {
    const f = setup([feedback([]), feedback([]), feedback([])]);
    f.setReviewReplies([feedback([finding]), 'The routing decision uses the wrong tick source.']);
    try {
        await f.h.afterImplementGate();
        await f.h.continueTurn('review explain the finding');
        assert.equal(f.prompts.filter((p) => p.agent === 'sol').length, 2);
        assert.doesNotMatch(f.prompts.at(-1)!.text, /exactly one fenced conductor-feedback/);
        assert.equal(f.records.read('0170-task').reports.filter((r) => r.kind === 'review').length, 1);
        assert.ok(!f.sent.some((s) => s.includes('review report pending')));
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});


test('a prompt preparation failure releases the task lock without starting a model turn', async () => {
    const f = setup([feedback([])]);
    try {
        mkdirSync(join(f.dir, 'state', 'findings'), { recursive: true });
        writeFileSync(join(f.dir, 'state', 'findings', '0170-task.json'), '{broken');
        await assert.rejects(f.h.afterImplementGate(), SyntaxError);
        assert.equal(f.h.busy, null);
        assert.equal(f.store.state.sessions.feedback?.turn, undefined);
        assert.equal(f.prompts.length, 0);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});


test('pending subagents retain the writer lock and defer gate/feedback until the parent settles', async () => {
    const f = setup([feedback([]), feedback([]), feedback([])]);
    const impl = f.h.live.get('implement')!;
    let pending = true;
    impl.pendingWork = async () => pending ? [{ kind: 'subagent', id: 'child', description: 'Review still running' }] : [];
    impl.lastReply = async () => 'Final implementation reply';
    try {
        writeFileSync(join(f.project, 'code.txt'), 'implemented');
        f.git('add', 'code.txt'); f.git('commit', '-qm', 'Implement');
        assert.equal((await f.h.settle('implement', { outcome: 'succeeded', text: 'Initial reply' })).waiting, true);
        assert.ok(f.store.state.sessions.implement?.workWait);
        assert.equal(existsSync(join(f.project, 'gate-count')), false);
        await assert.rejects(f.h.startReview('sol'), /pending work/);
        f.store.state.focus = 'implement';
        const checked = f.store.state.sessions.implement!.checkedSha;
        await assert.rejects(f.h.gateCommand(), /pending work/);
        assert.equal(f.store.state.sessions.implement!.checkedSha, checked);
        await f.h.drainWork();
        assert.equal(f.prompts.length, 0);
        pending = false;
        await f.h.drainWork();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'glm', 'mm', 'sol']);
        assert.equal(f.store.state.sessions.implement?.workWait, undefined);
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\n');
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('pending-work lookup errors hold the flow and automatically recover without a model resume event', async () => {
    const f = setup([feedback([])]);
    const impl = f.h.live.get('implement')!;
    let unavailable = true;
    impl.pendingWork = async () => { if (unavailable) throw new Error('offline'); return []; };
    impl.lastReply = async () => 'Done';
    try {
        assert.equal((await f.h.settle('implement', { outcome: 'succeeded', text: 'Done' })).waiting, true);
        assert.match(f.store.state.sessions.implement!.workWait!.detail, /status unknown/);
        await assert.rejects(f.h.startReview('sol'), /pending work/);
        await f.h.drainWork();
        assert.ok(f.store.state.sessions.implement!.workWait);
        unavailable = false;
        await f.h.drainWork();
        assert.equal(f.store.state.sessions.implement!.workWait, undefined);
        assert.equal(f.prompts.length, 0);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('pending turn waits survive restart and are processed only once', async () => {
    const f = setup([feedback([]), feedback([]), feedback([])]);
    const impl = f.h.live.get('implement')!;
    let pending = true;
    impl.pendingWork = async () => pending ? [{ kind: 'subagent', description: 'child completion queued' }] : [];
    impl.lastReply = async () => 'Done';
    let restored: Harness | undefined;
    try {
        writeFileSync(join(f.project, 'code.txt'), 'implemented');
        f.git('add', 'code.txt'); f.git('commit', '-qm', 'Implement');
        await f.h.settle('implement', { outcome: 'succeeded', text: 'Done' });
        await f.h.shutdown();
        const restoredStore = new Store(f.local.stateFile);
        restored = new Conductor(f.local, restoredStore, f.chat) as unknown as Harness;
        restored.adapters = { codex: f.adapter, opencode: f.adapter, claude: f.adapter };
        restored.live.set('implement', impl);
        await restored.drainWork();
        assert.equal(f.prompts.length, 0);
        pending = false;
        await restored.drainWork();
        await restored.drainWork();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'glm', 'mm', 'sol']);
        assert.equal(restoredStore.state.sessions.implement?.workWait, undefined);
        assert.equal(readFileSync(join(f.project, 'gate-count'), 'utf8'), 'passed\n');
    } finally { await f.h.shutdown(); await restored?.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});


test('startup discovers child work even when the previous bridge never recorded a wait', async () => {
    const f = setup([feedback([])]);
    const impl = f.h.live.get('implement')!;
    impl.pendingWork = async () => [{ kind: 'subagent', description: 'still running from the previous bridge' }];
    try {
        assert.equal(f.store.state.sessions.implement?.workWait, undefined);
        await f.h.announce();
        assert.ok(f.store.state.sessions.implement?.workWait);
        await assert.rejects(f.h.startReview('sol'), /pending work/);
        assert.equal(f.prompts.length, 0);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('an overlapping writer resume pauses automatic flow until an explicit fresh gate', async () => {
    const f = setup([feedback([]), feedback([]), feedback([])]);
    const impl = f.h.live.get('implement')!;
    impl.lastReply = async () => 'Late repair complete';
    try {
        writeFileSync(join(f.project, 'code.txt'), 'late repair');
        f.git('add', 'code.txt'); f.git('commit', '-qm', 'Late repair');
        f.h.busy = 'feedback';
        await f.h.unsolicited(impl.id, { phase: 'started' });
        assert.match(f.store.state.workConflict!, /implement resumed during feedback/);
        f.h.busy = null;
        await f.h.drainWork();
        assert.equal(f.store.state.sessions.implement?.workWait, undefined);
        assert.equal(existsSync(join(f.project, 'gate-count')), false);
        assert.equal(f.prompts.length, 0);
        await assert.rejects(f.h.startReview('sol'), /verify the current tree/);
        await f.h.gateCommand();
        assert.equal(f.store.state.workConflict, undefined);
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'glm', 'mm', 'sol']);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('stop reaches an idle session waiting on shell jobs and prevents automatic advancement', async () => {
    const f = setup([feedback([])]);
    const impl = f.h.live.get('implement')!;
    let pending = true;
    let interrupted = 0;
    impl.pendingWork = async () => pending ? [{ kind: 'shell', id: 'job', description: 'Xvfb' }] : [];
    impl.interrupt = async () => {
        interrupted++;
        pending = false;
        await f.h.drainWork(); // Polling during cleanup must not start the gate.
    };
    try {
        writeFileSync(join(f.project, 'code.txt'), 'implemented');
        f.git('add', 'code.txt'); f.git('commit', '-qm', 'Implement');
        await f.h.settle('implement', { outcome: 'succeeded', text: 'Finished' });
        assert.equal(f.h.busy, null);
        await f.h.stop();
        assert.equal(interrupted, 1);
        assert.equal(f.store.state.sessions.implement!.workWait!.result.outcome, 'interrupted');
        await f.h.drainWork();
        assert.equal(f.store.state.sessions.implement!.workWait, undefined);
        assert.equal(existsSync(join(f.project, 'gate-count')), false);
        assert.equal(f.prompts.length, 0);
        assert.ok(f.sent.some((s) => s.includes('turn interrupted')));
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('skip interrupts active feedback, waits for pending work across restart, and advances once', async () => {
    const f = setup([feedback([]), feedback([]), feedback([])]);
    const create = f.adapter.create.bind(f.adapter);
    let pending = true;
    let release!: () => void;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const ended = new Promise<void>((resolve) => { release = resolve; });
    let checker: AgentSession | undefined;
    let restored: Harness | undefined;
    f.adapter.create = async (agent, opts) => {
        const session = await create(agent, opts);
        if (agent.name === 'ds') {
            checker = session;
            const send = session.send.bind(session);
            session.send = async (text) => {
                await send(text);
                ready();
                await ended;
                return { outcome: 'interrupted', text: 'Partial report' };
            };
            session.interrupt = async () => { release(); };
            session.pendingWork = async () => pending ? [{ kind: 'shell', id: 'job', description: 'review experiment' }] : [];
        }
        return session;
    };
    try {
        const turn = f.h.runFeedback('ds');
        await started;
        await f.h.skipFeedback();
        await turn;
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds']);
        assert.equal(f.store.state.sessions.feedback!.skipRequested, true);
        assert.ok(f.store.state.sessions.feedback!.workWait);
        await f.h.skipFeedback();
        assert.ok(f.sent.some((s) => s.includes('already requested')));
        await f.h.shutdown();
        const store = new Store(f.local.stateFile);
        restored = new Conductor(f.local, store, f.chat) as unknown as Harness;
        restored.adapters = { codex: f.adapter, opencode: f.adapter, claude: f.adapter };
        restored.live.set('feedback', checker!);
        pending = false;
        await restored.drainWork();
        await restored.drainWork();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'glm', 'mm', 'sol']);
        assert.equal(store.state.feedbackSkips!.length, 1);
        assert.equal(store.state.feedbackSkips![0].agent, 'ds');
        assert.equal(store.state.feedbackSkips![0].round, 1);
        assert.ok(f.prompts.slice(1).every((p) => p.text.includes('not clean checks')));
        assert.equal(new FindingStore(join(f.dir, 'state', 'findings')).read('0170-task').reports.some((r) => r.source.agent === 'ds'), false);
    } finally { release(); await f.h.shutdown(); await restored?.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('skip of the final paused checker goes to final review without running implementation', async () => {
    const f = setup([]);
    const impl = f.h.live.get('implement')!;
    try {
        f.store.state.sessions.feedback = { id: impl.id, agent: 'mm', title: 'Paused feedback', startSha: f.git('rev-parse', 'HEAD') };
        f.store.state.focus = 'feedback';
        f.store.state.feedbackRound = 3;
        f.h.live.set('feedback', impl);
        await f.h.skipFeedback();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['sol']);
        assert.equal(f.store.state.feedbackSkips![0].agent, 'mm');
        assert.equal(f.store.state.sessions.feedback!.skipRequested, undefined);
        await f.h.skipFeedback();
        assert.equal(f.store.state.feedbackSkips!.length, 1);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('skip cannot bypass implementation or pending feedback repair dispositions', async () => {
    const f = setup([]);
    try {
        await f.h.skipFeedback();
        assert.equal(f.prompts.length, 0);
        f.store.state.sessions.feedback = { id: 'checker', agent: 'ds', title: 'Feedback', startSha: f.git('rev-parse', 'HEAD') };
        f.store.state.focus = 'feedback';
        f.store.state.feedbackDispositionPending = true;
        await f.h.skipFeedback();
        assert.equal(f.prompts.length, 0);
        assert.equal(f.store.state.sessions.feedback.skipRequested, undefined);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('skip consumes exactly one round when the next round uses the same checker', async () => {
    const f = setup([feedback([]), feedback([])]);
    try {
        const config = join(f.project, 'CONDUCTOR.toml');
        writeFileSync(config, readFileSync(config, 'utf8').replace('["ds", "glm", "mm"]', '["ds", "ds", "mm"]'));
        const ds = await f.adapter.create({ name: 'ds', model: 'test-ds', tag: 'ds', harness: 'codex' },
            { title: '0170-task feedback', cwd: f.project, asker: { permission: async () => 'reject', question: async () => '' } });
        f.h.live.set('feedback', ds);
        f.store.state.sessions.feedback = { id: ds.id, agent: 'ds', title: '0170-task feedback', startSha: f.git('rev-parse', 'HEAD') };
        f.store.state.focus = 'feedback';
        f.store.state.feedbackRound = 1;
        await f.h.skipFeedback();
        assert.deepEqual(f.prompts.map((p) => p.agent), ['ds', 'mm', 'sol']);
        assert.ok(f.prompts[0].text.startsWith('Custom checker prompt'));
        assert.equal(f.store.state.feedbackSkips!.length, 1);
        assert.equal(f.store.state.feedbackSkips![0].round, 1);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('provider failures are reported before pending work settles without repeated polling alerts', async () => {
    const f = setup([]);
    const impl = f.h.live.get('implement')!;
    const error = "You've reached your 5-hour usage limit.";
    let pending = true;
    impl.pendingWork = async () => pending ? [{ kind: 'subagent', id: 'child',
        description: 'Map navigation: failed (provider.quota: HTTP 429); waiting for parent to process failure' }] : [];
    impl.turnState = async () => ({ running: false, outcome: 'failed', error });
    try {
        await f.h.settle('implement', { outcome: 'failed', error, text: '' });
        assert.ok(f.store.state.sessions.implement!.workWait);
        const failures = () => f.sent.filter((s) => s.includes('turn failed: ' + error));
        assert.equal(failures().length, 1);
        assert.ok(f.sent.some((s) => s.includes('provider.quota: HTTP 429')));
        await f.h.drainWork();
        await f.h.drainWork();
        assert.equal(failures().length, 1);
        assert.equal(f.prompts.length, 0);
        pending = false;
        await f.h.drainWork();
        assert.equal(failures().length, 1);
        assert.equal(f.prompts.length, 0);
        assert.equal(f.store.state.sessions.implement!.workWait, undefined);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('roles edit supports keep, discard and config-only commits without disturbing staged work', async () => {
    for (const choice of ['keep', 'discard', 'commit']) {
        const f = setup([]);
        try {
            f.store.state.task = undefined;
            const file = join(f.project, 'CONDUCTOR.toml');
            const original = readFileSync(file, 'utf8');
            writeFileSync(join(f.project, 'code.txt'), 'staged unrelated work');
            f.git('add', 'code.txt');
            f.chat.ask = async () => choice;
            await f.h.rolesCommand('implement sol');
            const content = readFileSync(file, 'utf8');
            assert.equal(content === original, choice === 'discard');
            if (choice === 'commit') {
                assert.equal(f.git('show', '--format=', '--name-only', 'HEAD'), 'CONDUCTOR.toml');
                assert.match(f.git('log', '-1', '--format=%B'), /Co-Authored-By: Codex/);
                assert.equal(f.git('diff', '--cached', '--name-only'), 'code.txt');
            } else assert.equal(f.git('log', '-1', '--format=%s'), 'Initial');
            assert.equal(f.h.busy, null);
        } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
    }
});

test('roles edits refuse unfinished tasks, hidden pending work and dirty configuration', async () => {
    const f = setup([]);
    try {
        await assert.rejects(f.h.rolesCommand('implement sol'), /task or session is still in progress/);
        f.store.state.taskComplete = true;
        f.h.live.get('implement')!.pendingWork = async () => [{ kind: 'shell', id: 'job', description: 'unfinished smoke' }];
        await assert.rejects(f.h.rolesCommand('implement sol'), /pending work/);
        f.h.live.get('implement')!.pendingWork = async () => [];
        const file = join(f.project, 'CONDUCTOR.toml');
        writeFileSync(file, readFileSync(file, 'utf8') + '\n# user edit\n');
        await assert.rejects(f.h.rolesCommand('implement sol'), /already has uncommitted/);
        assert.equal(f.h.busy, null);
        assert.equal(f.h.agentList().includes('roles:'), false);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('agent handoff preserves dirty work, task base and repair metadata and waits for continue', async () => {
    const f = setup([]);
    f.store.state.focus = 'implement';
    try {
        const old = f.store.state.sessions.implement!;
        const base = old.startSha;
        old.checkedSha = base;
        f.store.state.feedbackFindingIds = ['0170-F01'];
        f.store.state.feedbackFixBase = base;
        f.store.state.feedbackDispositionPending = true;
        writeFileSync(join(f.project, 'code.txt'), 'unfinished implementation');
        await f.h.agentCommand('sol');
        const fresh = f.store.state.sessions.implement!;
        assert.equal(fresh.agent, 'sol');
        assert.equal(fresh.originalAgent, 'kimi');
        assert.equal(fresh.startSha, base);
        assert.equal(fresh.checkedSha, base);
        assert.notEqual(fresh.id, old.id);
        assert.equal(readFileSync(join(f.project, 'code.txt'), 'utf8'), 'unfinished implementation');
        assert.deepEqual(f.store.state.feedbackFindingIds, ['0170-F01']);
        assert.equal(f.store.state.feedbackFixBase, base);
        assert.equal(f.store.state.feedbackDispositionPending, true);
        assert.equal(f.prompts.length, 0);
        assert.match(fresh.handoff!, /Working tree:[\s\S]*code.txt/);
        assert.match(f.h.roleList(), /implement: kimi -> sol/);
        assert.ok(existsSync(old.logFile!));
        assert.equal(f.store.state.archivedSessions!.length, 1);
        assert.match(readFileSync(join(f.project, 'CONDUCTOR.toml'), 'utf8'), /implement = "kimi"/);
        await f.h.agentCommand('kimi');
        assert.equal(f.store.state.sessions.implement!.agent, 'kimi');
        assert.equal(f.store.state.sessions.implement!.logSequence, 2);
        assert.ok(existsSync(old.logFile!));
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('quota-failed terminal children transfer to the new agent and handoff survives restart', async () => {
    const f = setup([]);
    f.store.state.focus = 'implement';
    const impl = f.h.live.get('implement')!;
    impl.pendingWork = async () => [{ kind: 'subagent', id: 'child', terminal: 'failed',
        description: 'Nav scout: failed (provider.quota HTTP 429)' }];
    let restored: Harness | undefined;
    try {
        await f.h.settle('implement', { outcome: 'failed', text: '', error: 'Quota exhausted' });
        await f.h.agentCommand('sol');
        assert.match(f.store.state.sessions.implement!.handoff!, /provider.quota HTTP 429/);
        assert.equal(f.store.state.sessions.implement!.workWait, undefined);
        assert.equal(f.prompts.length, 0);
        await f.h.shutdown();
        const store = new Store(f.local.stateFile);
        restored = new Conductor(f.local, store, f.chat) as unknown as Harness;
        restored.adapters = { codex: f.adapter, opencode: f.adapter, claude: f.adapter };
        restored.live.set('implement', f.h.live.get('implement')!);
        await restored.continueTurn('implement');
        assert.equal(f.prompts[0].agent, 'sol');
        assert.match(f.prompts[0].text, /Agent handoff for 0170-task/);
        assert.match(f.prompts[0].text, /provider.quota HTTP 429/);
        assert.equal(store.state.sessions.implement!.handoff, undefined);
    } finally { await f.h.shutdown(); await restored?.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('agent swap waits for running children, then hands off exactly once', async () => {
    const f = setup([]);
    f.store.state.focus = 'implement';
    const impl = f.h.live.get('implement')!;
    let running = true;
    let interrupted = 0;
    let restored: Harness | undefined;
    impl.interrupt = async () => { interrupted++; };
    impl.pendingWork = async () => running ? [{ kind: 'subagent', id: 'child', description: 'still running' }] : [];
    try {
        await f.h.agentCommand('sol');
        assert.equal(interrupted, 1);
        assert.equal(f.store.state.sessions.implement!.agent, 'kimi');
        assert.equal(f.store.state.sessions.implement!.swapRequested, 'sol');
        await f.h.shutdown();
        const store = new Store(f.local.stateFile);
        restored = new Conductor(f.local, store, f.chat) as unknown as Harness;
        restored.adapters = { codex: f.adapter, opencode: f.adapter, claude: f.adapter };
        restored.live.set('implement', impl);
        running = false;
        await restored.drainWork();
        await restored.drainWork();
        assert.equal(store.state.sessions.implement!.agent, 'sol');
        assert.equal(store.state.archivedSessions!.length, 1);
        assert.equal(f.prompts.length, 0);
    } finally { await f.h.shutdown(); await restored?.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('agent interrupts a running implementer and prevents the old turn from starting feedback', async () => {
    const f = setup([]);
    f.store.state.focus = 'implement';
    const impl = f.h.live.get('implement')!;
    let ready!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const stopped = new Promise<void>((resolve) => { release = resolve; });
    impl.send = async () => { ready(); await stopped; return { outcome: 'interrupted', text: 'Interrupted implementation' }; };
    impl.interrupt = async () => { release(); };
    try {
        const turn = f.h.continueTurn('implement');
        await started;
        await f.h.agentCommand('sol');
        await turn;
        await f.h.drainWork();
        assert.equal(f.store.state.sessions.implement!.agent, 'sol');
        assert.equal(f.store.state.archivedSessions!.length, 1);
        assert.equal(f.prompts.length, 0);
        assert.equal(existsSync(join(f.project, 'gate-count')), false);
        assert.equal(f.h.busy, null);
    } finally { release(); await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('feedback agent swap affects the current slot only and final review marks the task settled', async () => {
    const f = setup([feedback([]), feedback([]), feedback([])]);
    try {
        const checker = await f.adapter.create({ name: 'ds', model: 'test-ds', tag: 'ds', harness: 'codex' }, {
            title: '0170-task feedback', cwd: f.project, asker: { permission: async () => 'reject', question: async () => '' },
        });
        f.h.live.set('feedback', checker);
        f.store.state.sessions.feedback = { id: checker.id, agent: 'ds', title: '0170-task feedback', startSha: f.git('rev-parse', 'HEAD') };
        f.store.state.focus = 'feedback';
        f.store.state.feedbackRound = 1;
        await f.h.agentCommand('glm');
        assert.match(f.h.roleList(), /feedback: ds glm mm/);
        assert.match(f.h.roleList(), /feedback: 1\/3 — ds -> glm/);
        assert.equal(f.store.state.feedbackRound, 1);
        await f.h.continueTurn('feedback');
        assert.deepEqual(f.prompts.map((p) => p.agent), ['glm', 'glm', 'mm', 'sol']);
        assert.equal(f.store.state.taskComplete, true);
        await assert.rejects(f.h.agentCommand('kimi'), /no task in progress/);
        f.chat.ask = async () => 'discard';
        await f.h.rolesCommand('feedback mm ds');
        assert.match(f.h.roleList(), /feedback: ds glm mm/);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('roles confirmation cannot overwrite concurrent edits and never stages unrelated files', async () => {
    const f = setup([]);
    f.store.state.task = undefined;
    const path = join(f.project, 'CONDUCTOR.toml');
    try {
        f.chat.ask = async () => {
            writeFileSync(path, readFileSync(path, 'utf8') + '\n# concurrent user edit\n');
            return 'discard';
        };
        await assert.rejects(f.h.rolesCommand('implement sol'), /changed during confirmation/);
        assert.match(readFileSync(path, 'utf8'), /concurrent user edit/);
        assert.equal(f.git('diff', '--cached', '--name-only'), '');
        assert.equal(f.h.busy, null);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('failed handoff restores the old session and a retired resume cannot silently keep writing', async () => {
    const f = setup([]);
    f.store.state.focus = 'implement';
    const old = f.h.live.get('implement')!;
    const oldId = old.id;
    const create = f.adapter.create.bind(f.adapter);
    try {
        f.adapter.create = async () => { throw new Error('target provider unavailable'); };
        await assert.rejects(f.h.agentCommand('sol'), /target provider unavailable/);
        assert.equal(f.store.state.sessions.implement!.id, oldId);
        assert.equal(f.store.state.sessions.implement!.swapRequested, undefined);
        assert.equal(f.h.live.get('implement'), old);
        assert.equal(f.h.busy, null);
        f.adapter.create = create;
        await f.h.agentCommand('sol');
        let stopped = false;
        old.interrupt = async () => { stopped = true; };
        const newId = f.store.state.sessions.implement!.id;
        await f.h.unsolicited(oldId, { phase: 'started' });
        assert.equal(stopped, true);
        assert.match(f.store.state.workConflict!, /retired implement session/);
        assert.equal(f.store.state.sessions.implement!.id, newId);
        assert.equal(f.prompts.length, 0);
    } finally { await f.h.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});
