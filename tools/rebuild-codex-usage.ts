import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupAlive } from '../src/jobs.ts';
import { normalizeCodexUsage } from '../src/logs/codex-usage.ts';
import { renderMarkdown, usageMetadata, type Transcript } from '../src/logs/markdown.ts';

function replace(file: string, before: string, after: string) {
    if (readFileSync(file, 'utf8') !== before) throw new Error(`File changed during rebuild: ${file}`);
    writeFileSync(`${file}.usage-tmp`, after, { mode: 0o600 });
    renameSync(`${file}.usage-tmp`, file);
}

export function rebuildCodexUsage(stateDir: string, logDir: string, write = false) {
    const sessions = new Map<string, Transcript>();
    const changes: { file: string; before: string; after: string }[] = [];
    const skipped: string[] = [];
    for (const name of readdirSync(stateDir).filter((n) => n.endsWith('.json'))) {
        const file = join(stateDir, name);
        const before = readFileSync(file, 'utf8');
        const saved = JSON.parse(before);
        if (saved.process && groupAlive(saved.process.pid)) { skipped.push(`${file}: running`); continue; }
        const transcript: Transcript = saved.transcript;
        if (!transcript?.messages) continue;
        for (const m of transcript.messages) if (m.usage) m.usageSource ??= { kind: 'codex-turn' };
        normalizeCodexUsage(transcript);
        sessions.set(transcript.id, transcript);
        const after = JSON.stringify(saved);
        if (JSON.stringify(JSON.parse(before)) !== after) changes.push({ file, before, after });
    }
    for (const name of readdirSync(logDir).filter((n) => n.endsWith('.usage.json'))) {
        const file = join(logDir, name);
        const before = readFileSync(file, 'utf8');
        const metadata = JSON.parse(before);
        if (metadata.agent?.harness !== 'codex') continue;
        const saved = sessions.get(metadata.sessionId);
        if (!saved) { skipped.push(`${file}: no idle saved transcript`); continue; }
        const transcript = { ...saved, updated: metadata.updated };
        const corrected = { ...metadata, ...usageMetadata(transcript) as object };
        const after = JSON.stringify(corrected, null, 2) + '\n';
        const markdown = file.replace(/\.usage\.json$/, '.md');
        if (existsSync(markdown)) {
            const original = readFileSync(markdown, 'utf8');
            const rendered = renderMarkdown(transcript);
            const stripUsage = (s: string) => s.replace(/^\*\*(?:Tokens|Turn tokens):\*\*[^\n]*\n/gm, '');
            if (stripUsage(original) !== stripUsage(rendered)) {
                skipped.push(`${file}: transcript content differs from saved state`);
                continue;
            }
            if (original !== rendered) changes.push({ file: markdown, before: original, after: rendered });
        }
        if (JSON.stringify(metadata) !== JSON.stringify(corrected)) changes.push({ file, before, after });
    }
    if (write) for (const change of changes) replace(change.file, change.before, change.after);
    return { mode: write ? 'write' : 'dry-run', changed: changes.map((c) => c.file), skipped };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const value = (flag: string, fallback: string) => {
        const i = args.indexOf(flag);
        if (i < 0) return fallback;
        if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${flag}`);
        return args[i + 1];
    };
    console.log(JSON.stringify(rebuildCodexUsage(value('--state-dir', 'state/codex'), value('--logs', 'wlog'), args.includes('--write')), null, 2));
}
