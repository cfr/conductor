export type Part =
    | { kind: 'thinking'; text: string }
    | { kind: 'text'; text: string }
    | { kind: 'tool'; name: string; input: unknown; output: string };

export interface Usage {
    steps: number;
    turns?: number;
    stepsKnown?: boolean;
    maxContextKnown?: boolean;
    input: number;
    // reasoning included
    output: number;
    cacheRead: number;
    cacheWrite: number;
    // the largest prompt one step sent: input plus cache reads and writes
    maxContext: number;
    compactions: number;
}

export interface Step {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

export interface Message {
    role: 'user' | 'assistant';
    parts: Part[];
    usage?: Usage;
    usageSource?: { kind: 'codex-turn'; raw?: Record<string, number> };
}

export interface Transcript {
    title: string;
    id: string;
    created: number;
    updated: number;
    messages: Message[];
}

export function emptyUsage(): Usage {
    return { steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, maxContext: 0, compactions: 0 };
}

export function addStep(u: Usage, s: Step) {
    u.steps++;
    u.input += s.input;
    u.output += s.output;
    u.cacheRead += s.cacheRead;
    u.cacheWrite += s.cacheWrite;
    u.maxContext = Math.max(u.maxContext, s.input + s.cacheRead + s.cacheWrite);
}

function addUsage(to: Usage, u: Usage) {
    to.steps += u.steps;
    if (u.turns !== undefined) to.turns = (to.turns ?? 0) + u.turns;
    if (u.stepsKnown === false) to.stepsKnown = false;
    if (u.maxContextKnown === false) to.maxContextKnown = false;
    to.input += u.input;
    to.output += u.output;
    to.cacheRead += u.cacheRead;
    to.cacheWrite += u.cacheWrite;
    to.maxContext = Math.max(to.maxContext, u.maxContext);
    to.compactions += u.compactions;
}

function count(n: number): string {
    if (n >= 1e6) {
        return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
    }
    return n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

export function formatUsage(u: Usage): string {
    const parts = [
        ...(u.turns ? [`${u.turns} turn${u.turns === 1 ? '' : 's'}`] : []),
        u.stepsKnown === false ? 'model steps unavailable' : `${u.steps} step${u.steps === 1 ? '' : 's'}`,
        `input ${count(u.input)}`,
        `output ${count(u.output)}`,
        `cache read ${count(u.cacheRead)}`,
        `cache write ${count(u.cacheWrite)}`,
        u.maxContextKnown === false ? 'max context unavailable' : `max context ${count(u.maxContext)}`,
    ];
    if (u.compactions) {
        parts.push(`${u.compactions} compaction${u.compactions === 1 ? '' : 's'}`);
    }
    return parts.join(' · ');
}

// one entry per user message: the usage of the assistant messages answering it
function turnUsage(messages: Message[]): Map<Message, Usage> {
    const turns = new Map<Message, Usage>();
    let turn: Usage | undefined;
    for (const m of messages) {
        if (m.role === 'user') {
            turn = emptyUsage();
            turns.set(m, turn);
        } else if (m.usage && turn) {
            addUsage(turn, m.usage);
        }
    }
    return turns;
}

function stamp(ms: number): string {
    return new Date(ms).toLocaleString('en-US');
}

function clip(text: string, maxLines: number): string {
    if (maxLines <= 0) {
        return text;
    }
    const lines = text.split('\n');
    if (lines.length <= maxLines) {
        return text;
    }
    return `${lines.slice(0, maxLines).join('\n')}\n... (${lines.length - maxLines} more lines)`;
}

export function renderMarkdown(t: Transcript, maxToolOutputLines = 0): string {
    const total = emptyUsage();
    for (const m of t.messages) {
        if (m.usage) {
            addUsage(total, m.usage);
        }
    }
    const metered = total.steps > 0 || (total.turns ?? 0) > 0 || total.compactions > 0;
    const out: string[] = [
        `# ${t.title}`,
        '',
        `**Session ID:** ${t.id}`,
        `**Created:** ${stamp(t.created)}`,
        `**Updated:** ${stamp(t.updated)}`,
        ...(metered ? [`**Tokens:** ${formatUsage(total)}`] : []),
        '',
        '---',
        '',
    ];
    const turns = metered ? turnUsage(t.messages) : new Map<Message, Usage>();
    const sections: string[][] = [];
    for (const m of t.messages) {
        const body: string[] = [];
        const turn = turns.get(m);
        if (turn) {
            body.push(`**Turn tokens:** ${formatUsage(turn)}`, '');
        }
        for (const p of m.parts) {
            if (p.kind === 'thinking') {
                if (p.text.trim()) {
                    body.push('_Thinking:_', '', p.text.trim(), '');
                }
            } else if (p.kind === 'text') {
                if (p.text.trim()) {
                    body.push(p.text.trim(), '');
                }
            } else {
                body.push(`**Tool: ${p.name}**`, '', '**Input:**', '```json');
                body.push(JSON.stringify(p.input, null, 2), '```', '');
                if (p.output.trim()) {
                    body.push(clip(p.output, maxToolOutputLines), '');
                }
            }
        }
        if (body.length === 0) {
            continue;
        }
        sections.push([m.role === 'user' ? '## User' : '## Assistant', '', ...body]);
    }
    sections.forEach((lines, i) => out.push(...(i ? ['---', ''] : []), ...lines));
    return out.join('\n');
}

export function usageMetadata(t: Transcript): unknown {
    let turn = 0;
    const entries: unknown[] = [];
    const total = emptyUsage();
    const meteredTurns = new Set<number>();
    for (const m of t.messages) {
        if (m.role === 'user') turn++;
        if (m.usage) {
            addUsage(total, m.usage);
            if (turn > 0) meteredTurns.add(turn);
            entries.push({ turn, ...m.usage,
                steps: m.usage.stepsKnown === false ? null : m.usage.steps,
                maxContext: m.usage.maxContextKnown === false ? null : m.usage.maxContext,
                source: m.usageSource ?? { kind: 'model-step' },
            });
        }
    }
    return { version: 1, sessionId: t.id, title: t.title, updated: t.updated,
        total: { ...total, turns: turn, unmeteredTurns: turn - meteredTurns.size,
            steps: total.stepsKnown === false ? null : total.steps,
            maxContext: total.maxContextKnown === false ? null : total.maxContext }, entries };
}
