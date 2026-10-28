import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { addStep, emptyUsage, type Message, type Part, type Step, type Transcript } from './markdown.ts';

interface Block {
    type: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: unknown;
    tool_use_id?: string;
    content?: string | Block[];
    is_error?: boolean;
}

interface ApiUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
}

interface Entry {
    type: string;
    subtype?: string;
    isMeta?: boolean;
    isSidechain?: boolean;
    timestamp?: string;
    customTitle?: string;
    message?: { id?: string; content?: string | Block[]; usage?: ApiUsage };
}

const harnessText = /^\s*<(task-notification|command-|local-command|system-reminder)/;

export function findTranscript(sessionId: string): string | undefined {
    const root = join(homedir(), '.claude', 'projects');
    if (!existsSync(root)) {
        return undefined;
    }
    for (const dir of readdirSync(root)) {
        const f = join(root, dir, `${sessionId}.jsonl`);
        if (existsSync(f)) {
            return f;
        }
    }
    return undefined;
}

function resultText(content: string | Block[] | undefined): string {
    if (typeof content === 'string') {
        return content;
    }
    return (content ?? [])
        .map((b) => (b.type === 'text' ? (b.text ?? '') : `[${b.type}]`))
        .join('\n');
}

export function fromClaudeJsonl(sessionId: string, jsonl: string): Transcript {
    const entries: Entry[] = [];
    for (const line of jsonl.split('\n')) {
        if (line.trim()) {
            try {
                entries.push(JSON.parse(line) as Entry);
            } catch {
                // a line being appended while we read
            }
        }
    }

    const results = new Map<string, string>();
    for (const e of entries) {
        const c = e.message?.content;
        if (e.type === 'user' && Array.isArray(c)) {
            for (const b of c) {
                if (b.type === 'tool_result' && b.tool_use_id) {
                    results.set(b.tool_use_id, resultText(b.content));
                }
            }
        }
    }

    let title = sessionId;
    const times: number[] = [];
    const messages: Message[] = [];
    let current: Message | null = null;
    // an API message spans several entries, one per content block, each repeating its usage
    const steps = new Map<Message, Map<string, Step>>();
    let compactions = 0;
    for (const e of entries) {
        if (e.type === 'custom-title' && e.customTitle) {
            title = e.customTitle;
        }
        if (e.type === 'system' && e.subtype === 'compact_boundary') {
            compactions++;
        }
        if ((e.type !== 'user' && e.type !== 'assistant') || e.isMeta || e.isSidechain) {
            continue;
        }
        if (e.timestamp) {
            times.push(Date.parse(e.timestamp));
        }
        const c = e.message?.content;
        if (e.type === 'user') {
            const text =
                typeof c === 'string'
                    ? c
                    : (c ?? [])
                          .filter((b) => b.type === 'text')
                          .map((b) => b.text ?? '')
                          .join('\n');
            if (text.trim() && !harnessText.test(text)) {
                current = null;
                messages.push({ role: 'user', parts: [{ kind: 'text', text }] });
            }
            continue;
        }
        if (!current) {
            current = { role: 'assistant', parts: [], usage: emptyUsage() };
            current.usage!.compactions = compactions;
            compactions = 0;
            messages.push(current);
            steps.set(current, new Map());
        }
        const u = e.message?.usage;
        if (u && e.message?.id) {
            steps.get(current)!.set(e.message.id, {
                input: u.input_tokens ?? 0,
                output: u.output_tokens ?? 0,
                cacheRead: u.cache_read_input_tokens ?? 0,
                cacheWrite: u.cache_creation_input_tokens ?? 0,
            });
        }
        for (const b of Array.isArray(c) ? c : []) {
            let part: Part | null = null;
            if (b.type === 'thinking') {
                part = { kind: 'thinking', text: b.thinking ?? '' };
            } else if (b.type === 'text') {
                part = { kind: 'text', text: b.text ?? '' };
            } else if (b.type === 'tool_use') {
                const output = b.id ? (results.get(b.id) ?? '') : '';
                part = { kind: 'tool', name: b.name ?? '?', input: b.input ?? {}, output };
            }
            if (part) {
                current.parts.push(part);
            }
        }
    }
    for (const [m, byId] of steps) {
        for (const s of byId.values()) {
            addStep(m.usage!, s);
        }
    }
    return {
        title,
        id: sessionId,
        created: times.length ? Math.min(...times) : Date.now(),
        updated: times.length ? Math.max(...times) : Date.now(),
        messages,
    };
}

export function readClaudeTranscript(sessionId: string): Transcript | undefined {
    const f = findTranscript(sessionId);
    return f ? fromClaudeJsonl(sessionId, readFileSync(f, 'utf8')) : undefined;
}
