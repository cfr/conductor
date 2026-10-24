import { execFileSync } from 'node:child_process';
import type { AgentConfig } from '../config.ts';
import { fromOpencode, type OcExport } from '../logs/opencode.ts';
import type { Transcript } from '../logs/markdown.ts';
import type { Adapter, AgentSession, Asker, SessionOptions, TurnResult, TurnState, UnsolicitedEvent } from './types.ts';

interface OcEvent {
    type: string;
    data?: Record<string, unknown>;
}

interface Waiter {
    resolve(r: { outcome: TurnResult['outcome']; error?: string }): void;
}

interface FormField {
    key: string;
    type: string;
    title?: string;
    description?: string;
    options?: { value: string; label: string; description?: string }[];
    hidden?: boolean;
}

const endEvents: Record<string, TurnResult['outcome']> = {
    'session.execution.succeeded': 'succeeded',
    'session.execution.failed': 'failed',
    'session.execution.interrupted': 'interrupted',
};

export class OpencodeAdapter implements Adapter {
    private auth = '';
    private waiters = new Map<string, Waiter>();
    private askers = new Map<string, Asker>();
    private streaming = false;
    private url: string;
    onUnsolicited?: (sessionId: string, event: UnsolicitedEvent) => void;

    constructor(url: string) {
        this.url = url;
    }

    private login() {
        execFileSync('opencode', ['service', 'start'], { stdio: 'ignore' });
        const pw = execFileSync('opencode', ['service', 'get', 'password']).toString().trim();
        this.auth = 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64');
    }

    async api<T>(method: string, path: string, body?: unknown): Promise<T> {
        if (!this.auth) {
            this.login();
        }
        const res = await fetch(this.url + path, {
            method,
            headers: { authorization: this.auth, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        if (!res.ok) {
            throw new Error(`opencode ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
        }
        return (text ? JSON.parse(text) : undefined) as T;
    }

    private ensureEvents() {
        if (this.streaming) {
            return;
        }
        this.streaming = true;
        void this.eventLoop();
    }

    private async eventLoop() {
        for (;;) {
            try {
                if (!this.auth) {
                    this.login();
                }
                const res = await fetch(this.url + '/api/event', {
                    headers: { authorization: this.auth, accept: 'text/event-stream' },
                });
                if (!res.ok || !res.body) {
                    throw new Error(`event stream: ${res.status}`);
                }
                const dec = new TextDecoder();
                let buf = '';
                for await (const chunk of res.body) {
                    buf += dec.decode(chunk as Uint8Array, { stream: true });
                    let i;
                    while ((i = buf.indexOf('\n\n')) >= 0) {
                        const raw = buf.slice(0, i);
                        buf = buf.slice(i + 2);
                        const data = raw
                            .split('\n')
                            .filter((l) => l.startsWith('data:'))
                            .map((l) => l.slice(5).trim())
                            .join('');
                        if (data) {
                            this.dispatch(JSON.parse(data) as OcEvent);
                        }
                    }
                }
            } catch (e) {
                console.error('opencode events:', (e as Error).message);
                this.auth = '';
            }
            await new Promise((r) => setTimeout(r, 2000));
        }
    }

    private dispatch(ev: OcEvent) {
        const data = ev.data ?? {};
        const sid = data.sessionID as string | undefined;
        if (!sid) {
            return;
        }
        const tracked = this.askers.has(sid);
        const waiter = this.waiters.get(sid);
        // opencode resumes a session by itself, e.g. when a background shell job finishes
        if (ev.type === 'session.execution.started' && tracked && !waiter) {
            this.onUnsolicited?.(sid, { phase: 'started' });
            return;
        }
        const outcome = endEvents[ev.type];
        if (outcome) {
            const err = data.error as { message?: string } | undefined;
            if (waiter) {
                waiter.resolve({ outcome, error: err?.message });
            } else if (tracked) {
                this.onUnsolicited?.(sid, { phase: 'ended', outcome, error: err?.message });
            }
            return;
        }
        const asker = this.askers.get(sid);
        if (!asker) {
            return;
        }
        if (ev.type === 'permission.asked') {
            void this.answerPermission(sid, asker, (data.request as Record<string, unknown>) ?? data);
        } else if (ev.type === 'form.created') {
            void this.answerForm(sid, asker, (data.form as Record<string, unknown>) ?? data);
        }
    }

    private async answerPermission(sid: string, asker: Asker, req: Record<string, unknown>) {
        const resources = (req.resources as string[] | undefined)?.join('\n') ?? '';
        const detail = [req.message as string | undefined, resources].filter(Boolean).join('\n\n');
        const asked = await asker.permission(`permission: ${String(req.action)}`, detail);
        const decision = asked === 'pattern' ? 'always' : asked;
        await this.api('POST', `/api/session/${sid}/permission/${String(req.id)}/reply`, { decision });
    }

    private async answerForm(sid: string, asker: Asker, form: Record<string, unknown>) {
        const answer: Record<string, string | boolean | string[]> = {};
        for (const f of (form.fields as FormField[] | undefined) ?? []) {
            if (f.hidden) {
                continue;
            }
            const title = [form.title, f.title ?? f.key].filter(Boolean).join(': ');
            if (f.type === 'boolean') {
                const a = await asker.question({
                    title,
                    detail: f.description,
                    choices: [{ label: 'yes' }, { label: 'no' }],
                    allowText: false,
                });
                answer[f.key] = a === 'yes';
                continue;
            }
            const options = f.options ?? [];
            const a = await asker.question({
                title,
                detail: f.description,
                choices: options.map((o) => ({ label: o.label, description: o.description })),
                allowText: f.type !== 'multiselect' || options.length === 0,
            });
            const value = options.find((o) => o.label === a)?.value ?? a;
            answer[f.key] = f.type === 'multiselect' ? [value] : value;
        }
        await this.api('POST', `/api/session/${sid}/form/${String(form.id)}/reply`, { answer });
    }

    private async checkVariant(providerID: string, id: string, variant: string) {
        const res = await this.api<{ data: { providerID: string; id: string; variants?: { id: string }[] }[] }>(
            'GET',
            '/api/model',
        );
        const model = res.data.find((m) => m.providerID === providerID && m.id === id);
        if (!model) {
            throw new Error(`opencode has no model ${providerID}/${id}`);
        }
        const allowed = ['default', ...(model.variants ?? []).map((v) => v.id)];
        if (!allowed.includes(variant)) {
            throw new Error(`${providerID}/${id} has no variant "${variant}"; one of ${allowed.join(', ')}`);
        }
    }

    async create(agent: AgentConfig, opts: SessionOptions): Promise<AgentSession> {
        const slash = agent.model.indexOf('/');
        const providerID = agent.model.slice(0, slash);
        const id = agent.model.slice(slash + 1);
        if (agent.variant) {
            await this.checkVariant(providerID, id, agent.variant);
        }
        const res = await this.api<{ data: { id: string } }>('POST', '/api/session', {
            title: opts.title,
            model: { providerID, id, ...(agent.variant ? { variant: agent.variant } : {}) },
            ...(opts.readOnly ? { agent: 'plan' } : {}),
            location: { directory: opts.cwd },
        });
        return this.resume(agent, res.data.id, opts);
    }

    resume(agent: AgentConfig, id: string, opts: SessionOptions): AgentSession {
        this.ensureEvents();
        this.askers.set(id, opts.asker);
        return new OpencodeSession(this, agent, id, opts.cwd);
    }

    waitForEnd(sid: string, since: number): Promise<{ outcome: TurnResult['outcome']; error?: string }> {
        return new Promise((resolve) => {
            let done = false;
            const finish = (r: { outcome: TurnResult['outcome']; error?: string }) => {
                if (!done) {
                    done = true;
                    clearInterval(poll);
                    this.waiters.delete(sid);
                    resolve(r);
                }
            };
            this.waiters.set(sid, { resolve: finish });
            const poll = setInterval(async () => {
                try {
                    const s = await this.api<{ data: { time: { idle?: number }; outcome?: string } }>(
                        'GET',
                        `/api/session/${sid}`,
                    );
                    if (s.data.time.idle && s.data.time.idle > since && s.data.outcome) {
                        finish({ outcome: s.data.outcome as TurnResult['outcome'] });
                    }
                } catch {
                    // the event stream may still deliver it
                }
            }, 15000);
        });
    }
}

class OpencodeSession implements AgentSession {
    private oc: OpencodeAdapter;
    readonly agent: AgentConfig;
    readonly id: string;
    private cwd: string;

    constructor(oc: OpencodeAdapter, agent: AgentConfig, id: string, cwd: string) {
        this.oc = oc;
        this.agent = agent;
        this.id = id;
        this.cwd = cwd;
    }

    async send(text: string): Promise<TurnResult> {
        const since = Date.now();
        const end = this.oc.waitForEnd(this.id, since);
        const sent = await this.oc.api<{ data: { id: string } }>(
            'POST',
            `/api/session/${this.id}/prompt`,
            { text },
        );
        const r = await end;
        return { ...r, text: await this.replyAfter(sent.data.id) };
    }

    lastReply(): Promise<string> {
        return this.replyAfter('');
    }

    private async replyAfter(userMessageId: string): Promise<string> {
        const res = await this.oc.api<{ data: { id: string; type: string; content?: { type: string; text?: string }[] }[] }>(
            'GET',
            `/api/session/${this.id}/message?order=desc&limit=50`,
        );
        for (const m of res.data) {
            if (m.id <= userMessageId) {
                break;
            }
            if (m.type !== 'assistant') {
                continue;
            }
            const text = (m.content ?? [])
                .filter((c) => c.type === 'text' && c.text?.trim())
                .map((c) => c.text)
                .join('\n\n');
            if (text) {
                return text;
            }
        }
        return '';
    }

    async interrupt(): Promise<void> {
        await this.oc.api('POST', `/api/session/${this.id}/interrupt`);
    }

    async backgroundJobs(): Promise<string[]> {
        const res = await this.oc.api<{ data: { status: string; command: string; metadata?: { sessionID?: string } }[] }>(
            'GET',
            `/api/shell?${new URLSearchParams({ 'location[directory]': this.cwd })}`,
        );
        return res.data.filter((s) => s.status === 'running' && s.metadata?.sessionID === this.id).map((s) => s.command);
    }

    async turnState(): Promise<TurnState> {
        const s = await this.oc.api<{ data: { time: { updated: number; idle?: number }; outcome?: string } }>(
            'GET',
            `/api/session/${this.id}`,
        );
        // starting a turn bumps `updated`; `idle` is set when one ends
        const { idle, updated } = s.data.time;
        if (!idle || idle < updated) {
            return { running: true };
        }
        const last = await this.oc.api<{ data: { type: string; error?: { message?: string } }[] }>(
            'GET',
            `/api/session/${this.id}/message?order=desc&limit=1`,
        );
        const outcome = (s.data.outcome ?? 'failed') as TurnResult['outcome'];
        return { running: false, outcome, error: last.data[0]?.error?.message };
    }

    async transcript(): Promise<Transcript | undefined> {
        const res = await this.oc.api<{ data: OcExport }>(
            'GET',
            `/api/experimental/session/${this.id}/export`,
        );
        return fromOpencode(res.data);
    }
}
