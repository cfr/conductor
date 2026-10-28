import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentConfig } from '../config.ts';
import { emptyUsage, type Message, type Transcript } from '../logs/markdown.ts';
import type { Adapter, AgentSession, SessionOptions, TurnResult, TurnState } from './types.ts';

interface Saved {
    thread?: string;
    transcript: Transcript;
    result?: TurnResult;
    since?: number;
}

// Keep the bridge id stable before Codex emits its thread id, including across restarts.
export class CodexAdapter implements Adapter {
    private directory: string;
    private executable: string;
    constructor(directory: string, executable = 'codex') { this.directory = directory; this.executable = executable; }
    async create(agent: AgentConfig, opts: SessionOptions): Promise<AgentSession> {
        return new CodexSession(agent, randomUUID(), opts, this.directory, this.executable);
    }
    resume(agent: AgentConfig, id: string, opts: SessionOptions): AgentSession {
        if (!/^[a-f0-9-]+$/i.test(id)) throw new Error('Invalid Codex session id');
        return new CodexSession(agent, id, opts, this.directory, this.executable);
    }
}

class CodexSession implements AgentSession {
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
        this.persist();
    }
    private persist() {
        this.saved.transcript.updated = Date.now();
        writeFileSync(`${this.file}.tmp`, JSON.stringify(this.saved), { mode: 0o600 });
        renameSync(`${this.file}.tmp`, this.file);
    }
    async send(text: string): Promise<TurnResult> {
        if (this.child) throw new Error('Codex session is already running');
        this.stopped = false;
        this.saved.since = Date.now();
        delete this.saved.result;
        this.saved.transcript.messages.push({ role: 'user', parts: [{ kind: 'text', text }] });
        const answer: Message = { role: 'assistant', parts: [] };
        this.saved.transcript.messages.push(answer);
        this.persist();
        // exec cannot ask for approvals. Keep sandboxing enabled and fail denied operations.
        // Config overrides also apply to resume, whose subcommand lacks --sandbox.
        const args = ['exec', '-c', 'approval_policy="never"', '-c',
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
                        const cached = u.cached_input_tokens ?? 0;
                        answer.usage = { ...emptyUsage(), steps: 1, input: Math.max(0, (u.input_tokens ?? 0) - cached),
                            cacheRead: cached, output: u.output_tokens ?? 0, maxContext: u.input_tokens ?? 0 };
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
        const pid = this.child?.pid;
        if (!pid) return;
        const kill = (signal: NodeJS.Signals) => {
            try { process.kill(-pid, signal); } catch { /* already exited */ }
        };
        kill('SIGTERM');
        const timer = setTimeout(() => kill('SIGKILL'), 3000);
        timer.unref();
        this.child?.once('close', () => clearTimeout(timer));
    }
    async transcript(): Promise<Transcript> { return this.saved.transcript; }
    async turnState(since: number): Promise<TurnState> {
        if (this.child) return { running: true };
        if (this.saved.result && (this.saved.since ?? 0) >= since - 1000) {
            return { running: false, outcome: this.saved.result.outcome, error: this.saved.result.error };
        }
        return { running: false, outcome: 'interrupted', error: 'Conductor restarted during the Codex turn; use /continue.' };
    }
    async backgroundJobs(): Promise<string[]> { return []; }
    async setReadOnly(on: boolean): Promise<void> { this.opts.readOnly = on; }
}
