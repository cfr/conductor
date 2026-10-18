export interface PlanItem {
    id: string;
    number: string;
    text: string;
}

export function parseNext(plan: string): PlanItem[] {
    const lines = plan.split('\n');
    const start = lines.findIndex((l) => /^## Next\s*$/.test(l));
    if (start < 0) {
        return [];
    }
    const items: PlanItem[] = [];
    let current: string[] | null = null;
    const flush = () => {
        if (!current) {
            return;
        }
        const m = /^- (\d{4})-([a-z0-9-]+):/.exec(current[0]);
        if (m) {
            items.push({ id: `${m[1]}-${m[2]}`, number: m[1], text: current.join('\n').trimEnd() });
        }
        current = null;
    };
    for (const line of lines.slice(start + 1)) {
        if (line.startsWith('## ')) {
            break;
        }
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
