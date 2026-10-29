import type { PendingWork, PendingWorkState } from './types.ts';

interface SessionInfo {
    id: string;
    outcome?: 'succeeded' | 'failed' | 'interrupted';
    time: { updated: number; idle?: number };
}
interface Message {
    id: string;
    type: string;
    time: { created: number; completed?: number };
    metadata?: { source?: string; childID?: string };
    content?: { type: string; name?: string; id?: string; time?: { created: number; completed?: number };
        state?: { status: string; input?: { description?: string }; metadata?: { sessionID?: string; status?: string } } }[];
}
interface Page { data: Message[]; cursor: { next?: string | null } }
export type WorkApi = <T>(method: string, path: string) => Promise<T>;

// API cursors and child IDs survive bridge restarts; the durable transcript is the recovery source.
export class OpencodeWork {
    private api: WorkApi;
    private id: string;
    private cwd: string;
    private state: PendingWorkState;
    private save: (state: PendingWorkState) => void;
    private checking?: Promise<PendingWork[]>;

    constructor(api: WorkApi, id: string, cwd: string, state: PendingWorkState | undefined, save: (state: PendingWorkState) => void) {
        this.api = api;
        this.id = id;
        this.cwd = cwd;
        this.state = state ?? { sessions: {} };
        this.save = save;
    }

    pending(): Promise<PendingWork[]> {
        if (!this.checking) {
            this.checking = this.inspect().finally(() => { this.checking = undefined; });
        }
        return this.checking;
    }

    async interrupt(): Promise<void> {
        const path = `/api/session/${encodeURIComponent(this.id)}/interrupt`;
        await this.api('POST', path);
        try {
            await this.stopShells();
        } finally {
            // Job completion can wake the parent while cleanup is in progress.
            await this.api('POST', path);
        }
    }

    private async stopShells(): Promise<void> {
        // Refresh ownership from structured subagent results before removing any jobs.
        await this.pending();
        const query = new URLSearchParams({ 'location[directory]': this.cwd });
        const shells = await this.api<{ data: { id: string; metadata?: { sessionID?: string } }[] }>(
            'GET', `/api/shell?${query}`,
        );
        if (!Array.isArray(shells.data)) throw new Error('opencode returned invalid shell status');
        const owned = new Set([this.id, ...Object.keys(this.state.sessions)]);
        const results = await Promise.allSettled(shells.data
            .filter((s) => s.metadata?.sessionID && owned.has(s.metadata.sessionID))
            .map((s) => this.api('DELETE', `/api/shell/${encodeURIComponent(s.id)}?${query}`)));
        const failures = results.filter((r) => r.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map((r) => r.reason), 'Could not stop owned shell jobs');
    }

    private async messages(id: string, type: 'assistant' | 'synthetic', after?: string): Promise<Message[]> {
        const messages: Message[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        for (;;) {
            const query = new URLSearchParams({ type, limit: '100', ...(cursor ? { cursor } : { order: 'desc' }) });
            const page = await this.api<Page>('GET', `/api/session/${encodeURIComponent(id)}/message?${query}`);
            if (!Array.isArray(page.data)) throw new Error('opencode returned an invalid message page');
            for (const m of page.data) {
                messages.push(m);
                if (m.id === after) return messages;
            }
            if (!page.data.length || !page.cursor?.next) return messages;
            cursor = page.cursor.next;
            if (seen.has(cursor)) throw new Error('opencode repeated a message cursor');
            seen.add(cursor);
        }
    }

    private async inspect(): Promise<PendingWork[]> {
        const beforeState = JSON.stringify(this.state);
        const pending: PendingWork[] = [];
        const observed = new Map<string, SessionInfo>();
        const initial = await this.api<{ data: Record<string, unknown> }>('GET', '/api/session/active');
        if (!initial.data || typeof initial.data !== 'object') throw new Error('opencode returned invalid active sessions');
        const visiting = new Set<string>();
        const visit = async (id: string): Promise<void> => {
            if (visiting.has(id)) throw new Error('opencode subagent cycle');
            if (observed.has(id)) return;
            visiting.add(id);
            const scope = this.state.sessions[id] ??= { children: [], notifications: {} };
            const path = `/api/session/${encodeURIComponent(id)}`;
            const [info, assistants, synthetics, inbox] = await Promise.all([
                this.api<{ data: SessionInfo }>('GET', path),
                this.messages(id, 'assistant', scope.assistantCursor),
                this.messages(id, 'synthetic', scope.syntheticCursor),
                this.api<{ data: unknown[] }>('GET', `${path}/inbox`),
            ]);
            if (!info.data?.time || !Array.isArray(inbox.data)) throw new Error('opencode returned invalid session work status');
            observed.set(id, info.data);
            if (initial.data[id] || info.data.time.idle === undefined || info.data.time.idle < info.data.time.updated) {
                pending.push({ kind: 'session', id, description: `session ${id} is still running` });
            }
            if (inbox.data.length) pending.push({ kind: 'inbox', id, description: `session ${id} has queued work` });
            for (const m of assistants) {
                for (const tool of m.content ?? []) {
                    if (tool.type !== 'tool' || tool.name !== 'subagent') continue;
                    const meta = tool.state?.metadata;
                    if (!meta?.sessionID || !tool.id) {
                        if (tool.state?.status === 'error') continue;
                        throw new Error('subagent has no session/tool ID; its work status is unknown');
                    }
                    if (!['running', 'completed', 'failed', 'interrupted'].includes(meta.status ?? '')) {
                        throw new Error('subagent completion status is unknown');
                    }
                    const returnedAt = meta.status === 'running' ? undefined : tool.time?.completed;
                    const existing = scope.children.find((c) => c.toolId === tool.id);
                    if (!existing) {
                        scope.children.push({ id: meta.sessionID, toolId: tool.id,
                            description: tool.state?.input?.description ?? meta.sessionID,
                            launchedAt: tool.time?.created ?? m.time.created, returnedAt });
                    } else if (returnedAt !== undefined) existing.returnedAt = returnedAt;
                }
            }
            // Skip only fully completed messages; an in-flight message can acquire more tools.
            scope.assistantCursor = assistants.find((m) => m.time.completed !== undefined)?.id ?? scope.assistantCursor;
            for (const m of synthetics) {
                const child = m.metadata?.source === 'subagent' ? m.metadata.childID : undefined;
                if (!child) continue;
                const old = scope.notifications[child];
                if (!old || m.time.created > old.created) scope.notifications[child] = { id: m.id, created: m.time.created };
            }
            scope.syntheticCursor = synthetics[0]?.id ?? scope.syntheticCursor;
            for (const child of scope.children) {
                await visit(child.id);
                const terminal = observed.get(child.id)!;
                const notification = scope.notifications[child.id];
                const assistant = assistants[0];
                const childDone = terminal.time.idle !== undefined && terminal.time.idle >= terminal.time.updated && !!terminal.outcome;
                const inlineAt = Math.max(0, ...scope.children.filter((c) => c.id === child.id).map((c) => c.returnedAt ?? 0));
                const deliveredAt = Math.max(notification?.created ?? 0, inlineAt);
                const delivered = childDone && deliveredAt >= Math.max(child.launchedAt, terminal.time.idle!);
                const consumed = delivered && assistant?.time.completed !== undefined &&
                    assistant.time.created >= deliveredAt && info.data.time.idle !== undefined &&
                    info.data.time.idle >= assistant.time.completed;
                if (!consumed) pending.push({ kind: 'subagent', id: child.id, description:
                    `${child.description}: ${childDone ? 'waiting for parent to process completion' : 'running'}` });
            }
            visiting.delete(id);
        };
        try {
            await visit(this.id);
            const shells = await this.api<{ data: { id: string; status: string; command: string; metadata?: { sessionID?: string } }[] }>(
                'GET', `/api/shell?${new URLSearchParams({ 'location[directory]': this.cwd })}`,
            );
            if (!Array.isArray(shells.data)) throw new Error('opencode returned invalid shell status');
            for (const s of shells.data) {
                if (s.status === 'running' && s.metadata?.sessionID && observed.has(s.metadata.sessionID)) {
                    pending.push({ kind: 'shell', id: s.id, description: s.command });
                }
            }
            // Detect a turn or inbox delivery that raced the transcript reads, including a fast resume.
            const active = await this.api<{ data: Record<string, unknown> }>('GET', '/api/session/active');
            if (!active.data || typeof active.data !== 'object') throw new Error('opencode returned invalid active sessions');
            for (const [id, before] of observed) {
                const path = `/api/session/${encodeURIComponent(id)}`;
                const [after, inbox] = await Promise.all([
                    this.api<{ data: SessionInfo }>('GET', path), this.api<{ data: unknown[] }>('GET', `${path}/inbox`),
                ]);
                if (!after.data?.time || !Array.isArray(inbox.data)) throw new Error('opencode returned invalid final work status');
                if (active.data[id] || inbox.data.length || after.data.time.updated !== before.time.updated ||
                    after.data.time.idle !== before.time.idle) {
                    pending.push({ kind: 'session', id, description: `session ${id} changed during the work check` });
                }
            }
            return pending;
        } finally { if (JSON.stringify(this.state) !== beforeState) this.save(this.state); }
    }
}
