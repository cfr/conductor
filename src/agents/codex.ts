import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentConfig } from '../config.ts';
import { type Message, type Transcript } from '../logs/markdown.ts';
import type { Adapter, AgentSession, SessionOptions, TurnResult, TurnState } from './types.ts';
import { groupAlive, killGroup } from '../jobs.ts';
import { normalizeCodexUsage } from '../logs/codex-usage.ts';

interface Saved {
    process?: { pid: number; birth: string };
    thread?: string;
    transcript: Transcript;
    result?: TurnResult;
    since?: number;
}

// Keep the bridge id stable before Codex emits its thread id, including across restarts.
export class CodexAdapter implements Adapter {
    private sessions = new Set<CodexSession>();
    private closed = false;
    private directory: string;
    private executable: string;
    constructor(directory: string, executable = 'codex') { this.directory = directory; this.executable = executable; }
    async create(agent: AgentConfig, opts: SessionOptions): Promise<AgentSession> {
        if (this.closed) throw new Error('Codex adapter is shutting down');
        const session = new CodexSession(agent, randomUUID(), opts, this.directory, this.executable);
        this.sessions.add(session);
        return session;
    }
    resume(agent: AgentConfig, id: string, opts: SessionOptions): AgentSession {
        if (this.closed) throw new Error('Codex adapter is shutting down');
        if (!/^[a-f0-9-]+$/i.test(id)) throw new Error('Invalid Codex session id');
        const session = new CodexSession(agent, id, opts, this.directory, this.executable);
        this.sessions.add(session);
        return session;
    }
    async shutdown() { this.closed = true; await Promise.all([...this.sessions].map((s) => s.close())); }
}

function processBirth(pid: number): string {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
        if (start) return `linux:${start}`;
    } catch { /* ps also supports platforms without procfs */ }
    try { return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim(); }
    catch { return ''; }
}

class CodexSession implements AgentSession {
    private closed = false;
    private child?: ChildProcess;
    private stopped = false;
    private saved: Saved;
    private file: string;
    readonly agent: AgentConfig;
    readonly id: string;
    private opts: SessionOptions;
    private executable: string;
    constructor(
        agent: AgentConfig,
        id: string,
        opts: SessionOptions,
        directory: string,
        executable: string,
    ) {
        this.agent = agent; this.id = id; this.opts = opts; this.executable = executable;
        mkdirSync(directory, { recursive: true });
        this.file = join(directory, `${id}.json`);
        const now = Date.now();
        this.saved = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as Saved : {
            transcript: { id, title: opts.title, created: now, updated: now, messages: [] },
        };
        for (const m of this.saved.transcript.messages) {
            if (m.usage) {
                m.usage = { ...m.usage, steps: 0, turns: 1, stepsKnown: false, maxContext: 0, maxContextKnown: false };
                m.usageSource ??= { kind: 'codex-turn' };
            }
        }
        normalizeCodexUsage(this.saved.transcript);
        this.persist();
    }
    private persist() {
        this.saved.transcript.updated = Date.now();
        writeFileSync(`${this.file}.tmp`, JSON.stringify(this.saved), { mode: 0o600 });
        renameSync(`${this.file}.tmp`, this.file);
    }
    async send(text: string): Promise<TurnResult> {
        if (this.closed) throw new Error('Codex session is closed');
        if (this.child || (this.saved.process && groupAlive(this.saved.process.pid))) {
            throw new Error('Codex session is still running; /stop it before continuing');
        }
        this.stopped = false;
        delete this.saved.process;
        this.saved.since = Date.now();
        delete this.saved.result;
        this.saved.transcript.messages.push({ role: 'user', parts: [{ kind: 'text', text }] });
        const answer: Message = { role: 'assistant', parts: [] };
        this.saved.transcript.messages.push(answer);
        this.persist();
        // Git metadata is protected even in workspace-write; route escalations to auto-review.
        // Config overrides also apply to resume, whose subcommand lacks --sandbox.
        const args = ['exec', '-c', `approval_policy="${this.opts.readOnly ? 'never' : 'on-request'}"`, '-c',
            'approvals_reviewer="auto_review"', '-c',
            `sandbox_mode="${this.opts.readOnly ? 'read-only' : 'workspace-write'}"`,
            '--model', this.agent.model, '--json'];
        if (this.agent.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(this.agent.effort)}`);
        if (this.saved.thread) args.push('resume', this.saved.thread);
        args.push('-');
        let reply = '';
        let failure: string | undefined;
        let completed = false;
        let stderr = '';
        try {
            const child = spawn(this.executable, args, { cwd: this.opts.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
            this.child = child;
            if (child.pid) {
                this.saved.process = { pid: child.pid, birth: processBirth(child.pid) };
                this.persist();
            }
            child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-8000); });
            child.stdin.on('error', () => {}); // spawn/exit errors are handled below
            const lines = createInterface({ input: child.stdout });
            lines.on('line', (line) => {
                try {
                    const e = JSON.parse(line);
                    if (e.type === 'thread.started') this.saved.thread = e.thread_id;
                    if (e.type === 'item.completed' && e.item) {
                        const i = e.item;
                        if (i.type === 'agent_message') {
                            reply += (reply ? '\n\n' : '') + (i.text ?? '');
                            answer.parts.push({ kind: 'text', text: i.text ?? '' });
                        } else if (i.type === 'reasoning') {
                            answer.parts.push({ kind: 'thinking', text: i.text ?? '' });
                        } else {
                            answer.parts.push({ kind: 'tool', name: i.type, input: i, output: i.aggregated_output ?? '' });
                        }
                    }
                    if (e.type === 'turn.completed') {
                        completed = true;
                        const u = e.usage ?? {};
                        answer.usageSource = { kind: 'codex-turn', raw: u, threadId: this.saved.thread };
                        normalizeCodexUsage(this.saved.transcript);
                    }
                    if (e.type === 'turn.failed' || e.type === 'error') failure = e.error?.message ?? e.message ?? 'Codex failed';
                    this.persist();
                } catch { /* ignore non-JSON diagnostics */ }
            });
            const exit = new Promise<number | null>((resolve, reject) => {
                child.once('error', reject);
                child.once('close', resolve);
            });
            child.stdin.end(text);
            const code = await exit;
            const outcome = this.stopped ? 'interrupted' : code === 0 && completed && !failure ? 'succeeded' : 'failed';
            this.saved.result = { outcome, text: reply, ...(outcome === 'failed' ? { error: failure ?? (stderr.trim() || `Codex exited ${code} without completing a turn`) } : {}) };
        } catch (e) {
            this.saved.result = { outcome: this.stopped ? 'interrupted' : 'failed', text: reply, error: (e as Error).message };
        } finally {
            if (this.saved.process) await killGroup(this.saved.process.pid);
            delete this.saved.process;
            this.child = undefined;
            this.persist();
        }
        return this.saved.result!;
    }
    async lastReply(): Promise<string> {
        return this.saved.transcript.messages.filter((m) => m.role === 'assistant').at(-1)?.parts
            .filter((p) => p.kind === 'text').map((p) => p.text).join('\n\n') ?? '';
    }
    async interrupt(): Promise<void> {
        this.stopped = true;
        const owned = this.saved.process;
        const pid = this.child?.pid ?? owned?.pid;
        if (!pid) return;
        if (!this.child && groupAlive(pid) && (!owned?.birth || processBirth(pid) !== owned.birth)) {
            throw new Error(`Cannot verify ownership of Codex process group ${pid}; refusing to signal it`);
        }
        await killGroup(pid);
        if (!this.child) {
            delete this.saved.process;
            this.saved.result = { outcome: 'interrupted', text: await this.lastReply() };
            this.persist();
        }
    }
    async close() { this.closed = true; await this.interrupt(); }
    async transcript(): Promise<Transcript> { return this.saved.transcript; }
    async turnState(since: number): Promise<TurnState> {
        if (this.child || (this.saved.process && groupAlive(this.saved.process.pid))) return { running: true };
        if (this.saved.result && (this.saved.since ?? 0) >= since - 1000) {
            return { running: false, outcome: this.saved.result.outcome, error: this.saved.result.error };
        }
        return { running: false, outcome: 'interrupted', error: 'Conductor restarted during the Codex turn; use /continue.' };
    }
    async pendingWork() {
        return this.saved.process && groupAlive(this.saved.process.pid)
            ? [{ kind: 'session' as const, id: this.id, description: `Codex process group ${this.saved.process.pid} is still running` }] : [];
    }
    async setReadOnly(on: boolean): Promise<void> { this.opts.readOnly = on; }
}
