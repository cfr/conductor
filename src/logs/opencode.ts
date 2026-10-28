import { addStep, emptyUsage, type Message, type Part, type Transcript } from './markdown.ts';

interface OcContent {
    type: string;
    text?: string;
    name?: string;
    state?: {
        status?: string;
        input?: unknown;
        content?: { type: string; text?: string }[];
        error?: { message?: string };
    };
}

interface OcMessage {
    type: string;
    text?: string;
    content?: OcContent[];
    tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
}

export interface OcExport {
    info: { id: string; title?: string; time: { created: number; updated: number } };
    messages: OcMessage[];
}

function toolOutput(c: OcContent): string {
    const s = c.state ?? {};
    if (s.status === 'error') {
        return s.error?.message ?? 'error';
    }
    return (s.content ?? [])
        .filter((x) => x.type === 'text' && x.text)
        .map((x) => x.text)
        .join('\n');
}

export function fromOpencode(data: OcExport): Transcript {
    const messages: Message[] = [];
    let compactions = 0;
    for (const m of data.messages) {
        if (m.type === 'compaction') {
            compactions++;
        } else if (m.type === 'user') {
            messages.push({ role: 'user', parts: [{ kind: 'text', text: m.text ?? '' }] });
        } else if (m.type === 'assistant') {
            const parts: Part[] = [];
            for (const c of m.content ?? []) {
                if (c.type === 'reasoning') {
                    parts.push({ kind: 'thinking', text: c.text ?? '' });
                } else if (c.type === 'text') {
                    parts.push({ kind: 'text', text: c.text ?? '' });
                } else if (c.type === 'tool') {
                    parts.push({
                        kind: 'tool',
                        name: c.name ?? '?',
                        input: c.state?.input ?? {},
                        output: toolOutput(c),
                    });
                }
            }
            const usage = emptyUsage();
            usage.compactions = compactions;
            compactions = 0;
            const t = m.tokens;
            if (t) {
                addStep(usage, {
                    input: t.input ?? 0,
                    output: (t.output ?? 0) + (t.reasoning ?? 0),
                    cacheRead: t.cache?.read ?? 0,
                    cacheWrite: t.cache?.write ?? 0,
                });
            }
            messages.push({ role: 'assistant', parts, usage });
        }
    }
    return {
        title: data.info.title ?? data.info.id,
        id: data.info.id,
        created: data.info.time.created,
        updated: data.info.time.updated,
        messages,
    };
}
