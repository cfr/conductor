const subcommandTools = new Set([
    'cargo',
    'cmake',
    'ctest',
    'docker',
    'gh',
    'git',
    'go',
    'make',
    'node',
    'npm',
    'npx',
    'opencode',
    'pnpm',
    'python3',
    'yarn',
]);

export function splitCommand(command: string): string[] {
    const parts: string[] = [];
    let cur = '';
    let quote: string | null = null;
    for (let i = 0; i < command.length; i++) {
        const c = command[i];
        if (quote) {
            if (c === '\\' && quote === '"') {
                cur += c + (command[++i] ?? '');
                continue;
            }
            if (c === quote) {
                quote = null;
            }
            cur += c;
            continue;
        }
        if (c === "'" || c === '"') {
            quote = c;
            cur += c;
            continue;
        }
        if (c === '\\') {
            cur += c + (command[++i] ?? '');
            continue;
        }
        const two = command.slice(i, i + 2);
        if (two === '&&' || two === '||') {
            parts.push(cur);
            cur = '';
            i++;
            continue;
        }
        if (c === ';' || c === '|' || c === '\n') {
            parts.push(cur);
            cur = '';
            continue;
        }
        cur += c;
    }
    parts.push(cur);
    return parts.map((p) => p.trim()).filter(Boolean);
}

export function bashPatterns(command: string): string[] {
    const out: string[] = [];
    for (const part of splitCommand(command)) {
        const words = part.split(/\s+/);
        while (words.length && /^[A-Za-z_]\w*=/.test(words[0])) {
            words.shift();
        }
        const [first, second] = words;
        if (!first || /['"`$(]/.test(first)) {
            continue;
        }
        const takeSecond =
            second !== undefined &&
            !/['"`$]/.test(second) &&
            (/^--?[A-Za-z][\w-]*$/.test(second) || (subcommandTools.has(first) && /^[a-z][\w-]*$/.test(second)));
        const pattern = takeSecond ? `${first} ${second} *` : `${first} *`;
        if (!out.includes(pattern)) {
            out.push(pattern);
        }
    }
    return out;
}
