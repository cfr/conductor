export interface PlanItem {
    id: string;
    number: string;
    text: string;
}

function nextSection(plan: string): string[] {
    const lines = plan.split('\n');
    const start = lines.findIndex((l) => /^## Next\s*$/.test(l));
    if (start < 0) {
        return [];
    }
    const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
    return lines.slice(start + 1, end < 0 ? undefined : end);
}

export function emptyNextMessage(plan: string): string {
    const bullets = nextSection(plan).filter((l) => l.startsWith('- ')).length;
    return bullets
        ? `PLAN.md "Next" has ${bullets} item(s), none starting with \`- NNNN-slug:\` (e.g. \`- 0059-render-scale:\`)`
        : 'PLAN.md "Next" is empty';
}

export function nextReport(plan: string): string {
    const items = parseNext(plan);
    const bullets = nextSection(plan).filter((l) => l.startsWith('- ')).length;
    const lines = [items.length ? `"Next": ${items.map((i) => i.id).join(', ')}` : emptyNextMessage(plan)];
    if (items.length && bullets > items.length) {
        lines.push(`warning: ${bullets - items.length} "Next" item(s) do not start with \`- NNNN-slug:\`; /next skips them`);
    }
    return lines.join('\n');
}

export function parseNext(plan: string): PlanItem[] {
    const items: PlanItem[] = [];
    let current: string[] | null = null;
    const flush = () => {
        if (!current) {
            return;
        }
        // planners sometimes copy CHANGELOG's `- NNNN-slug (title):` form
        const m = /^- (\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)(?=:| \()/.exec(current[0]);
        if (m) {
            items.push({ id: `${m[1]}-${m[2]}`, number: m[1], text: current.join('\n').trimEnd() });
        }
        current = null;
    };
    for (const line of nextSection(plan)) {
        if (line.startsWith('- ')) {
            flush();
            current = [line];
        } else if (current && (line === '' || line.startsWith(' '))) {
            current.push(line);
        } else {
            flush();
        }
    }
    flush();
    return items;
}

export function idNumber(id: string): string {
    return /^(\d{4})/.exec(id)?.[1] ?? id;
}

export function summary(item: PlanItem): string {
    const first = item.text.split('\n')[0].replace(/^- \d{4}-[a-z0-9-]+:?\s*/, '');
    return `${item.id}: ${first}`;
}
