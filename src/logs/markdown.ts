export type Part =
    | { kind: 'thinking'; text: string }
    | { kind: 'text'; text: string }
    | { kind: 'tool'; name: string; input: unknown; output: string };

export interface Message {
    role: 'user' | 'assistant';
    parts: Part[];
}

export interface Transcript {
    title: string;
    id: string;
    created: number;
    updated: number;
    messages: Message[];
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
    const out: string[] = [
        `# ${t.title}`,
        '',
        `**Session ID:** ${t.id}`,
        `**Created:** ${stamp(t.created)}`,
        `**Updated:** ${stamp(t.updated)}`,
        '',
        '---',
        '',
    ];
    const sections: string[][] = [];
    for (const m of t.messages) {
        const body: string[] = [];
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
