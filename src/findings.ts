import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export type Category = 'bug' | 'test_gap' | 'docs' | 'process';
export type Disposition = 'open' | 'fixed' | 'rejected' | 'deferred' | 'duplicate';
export interface Source {
    agent: string;
    role?: 'feedback' | 'review' | 'implement';
    model: string;
    session: string;
    sha: string;
    log?: string;
}
export interface Finding {
    id: string;
    category: Category;
    summary: string;
    location: string;
    evidence: string;
    source: Source;
    relatedTo?: string;
    duplicateOf?: string;
    disposition: Disposition;
    reason?: string;
    answeredBy?: string;
    answerSession?: string;
    fixCommits: string[];
    verification: 'pending' | 'verified' | 'open' | 'accepted_rejection';
    history: { at: string; action: string; source: Source; reason: string; commits?: string[] }[];
}
export interface Receipt {
    key: string;
    kind: 'feedback' | 'review' | 'dispositions';
    at: string;
    source: Source;
    raw: string;
    error?: string;
    findingIds: string[];
}
export interface Ledger {
    version: 1;
    task: string;
    findings: Finding[];
    reports: Receipt[];
}
interface NewFinding {
    key: string;
    category: Category;
    summary: string;
    location: string;
    evidence: string;
    relatedTo?: string;
    duplicateOf?: string;
}
interface Verification {
    id: string;
    status: 'verified' | 'open' | 'accepted_rejection';
    reason: string;
}
interface Feedback {
    verdict: 'clean' | 'findings';
    findings: NewFinding[];
    verifications: Verification[];
}
interface Answer {
    id: string;
    status: 'fixed' | 'rejected' | 'deferred';
    reason: string;
}

function object(v: unknown): Record<string, unknown> {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected an object');
    return v as Record<string, unknown>;
}
function string(v: unknown, field: string): string {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${field} must be a nonempty string`);
    return v;
}
function list(v: unknown, field: string): unknown[] {
    if (!Array.isArray(v)) throw new Error(`${field} must be an array`);
    return v;
}
function choice<T extends string>(v: unknown, field: string, choices: readonly T[]): T {
    if (!choices.includes(v as T)) throw new Error(`${field} must be ${choices.join(', ')}`);
    return v as T;
}
function block(text: string, kind: string): Record<string, unknown> {
    const blocks = [...text.matchAll(new RegExp('^```' + kind + '[ \\t]*\\r?\\n([\\s\\S]*?)^```[ \\t]*$', 'gm'))];
    if (blocks.length !== 1) throw new Error(`include exactly one fenced ${kind} JSON block`);
    return object(JSON.parse(blocks[0][1]));
}
export function parseFeedback(text: string): Feedback {
    const b = block(text, 'conductor-feedback');
    const verdict = choice(b.verdict, 'verdict', ['clean', 'findings']);
    const endings = [...text.matchAll(/^VERDICT: (clean|findings)\s*$/gm)];
    if (endings.length !== 1 || endings[0][1] !== verdict) throw new Error('VERDICT line must agree with JSON verdict');
    const keys = new Set<string>();
    const findings = list(b.findings, 'findings').map((raw): NewFinding => {
        const f = object(raw);
        const key = string(f.key, 'key');
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key) || keys.has(key)) throw new Error('finding keys must be unique simple names');
        keys.add(key);
        if (f.relatedTo !== undefined && f.duplicateOf !== undefined) throw new Error('use relatedTo or duplicateOf, not both');
        return {
            key, category: choice(f.category, 'category', ['bug', 'test_gap', 'docs', 'process']),
            summary: string(f.summary, 'summary'), location: string(f.location, 'location'),
            evidence: string(f.evidence, 'evidence'),
            ...(f.relatedTo === undefined ? {} : { relatedTo: string(f.relatedTo, 'relatedTo') }),
            ...(f.duplicateOf === undefined ? {} : { duplicateOf: string(f.duplicateOf, 'duplicateOf') }),
        };
    });
    const verified = new Set<string>();
    const verifications = list(b.verifications, 'verifications').map((raw): Verification => {
        const v = object(raw);
        const id = string(v.id, 'id');
        if (verified.has(id)) throw new Error(`duplicate verification ${id}`);
        verified.add(id);
        return { id, status: choice(v.status, 'status', ['verified', 'open', 'accepted_rejection']), reason: string(v.reason, 'reason') };
    });
    return { verdict, findings, verifications };
}

export function applyFeedback(ledger: Ledger, text: string, source: Source): string[] {
    const report = parseFeedback(text);
    const byId = new Map(ledger.findings.map((f) => [f.id, f]));
    const ids = new Map(report.findings.map((f, i) => [f.key, `${ledger.task.slice(0, 4)}-F${String(ledger.findings.length + i + 1).padStart(2, '0')}`]));
    const additions = report.findings.map((f): Finding => {
        const resolve = (ref: string | undefined) => ref === undefined ? undefined : (ids.get(ref) ?? ref);
        return { id: ids.get(f.key)!, category: f.category, summary: f.summary, location: f.location, evidence: f.evidence,
            source, relatedTo: resolve(f.relatedTo), duplicateOf: resolve(f.duplicateOf), disposition: f.duplicateOf ? 'duplicate' : 'open',
            fixCommits: [], verification: 'pending', history: [] };
    });
    const all = new Map([...byId, ...additions.map((f) => [f.id, f] as const)]);
    for (const f of additions) {
        for (const ref of [f.relatedTo, f.duplicateOf]) {
            if (ref && (!all.has(ref) || ref === f.id)) throw new Error(`invalid finding reference ${ref}`);
        }
        const seen = new Set([f.id]);
        let parent = f.relatedTo ?? f.duplicateOf;
        while (parent) {
            if (seen.has(parent)) throw new Error('finding links must not contain cycles');
            seen.add(parent);
            const next = all.get(parent)!;
            parent = next.relatedTo ?? next.duplicateOf;
        }
    }
    for (const v of report.verifications) {
        const f = byId.get(v.id);
        if (!f) throw new Error(`unknown verification ${v.id}`);
        if (v.status === 'verified' && f.disposition !== 'fixed') throw new Error(`${v.id} has no claimed fix to verify`);
        if (['verified', 'accepted_rejection'].includes(v.status) && f.answerSession === source.session) throw new Error(`${v.id} needs verification by another session`);
        if (v.status === 'accepted_rejection' && !['rejected', 'deferred', 'duplicate'].includes(f.disposition)) {
            throw new Error(`${v.id} has no rejection/deferral to accept`);
        }
    }
    for (const f of ledger.findings.filter((f) => f.disposition === 'fixed' && f.verification === 'pending')) {
        if (!report.verifications.some((v) => v.id === f.id)) throw new Error(`verify pending fix ${f.id}`);
    }
    const actionable = [...new Set([...additions.filter((f) => !f.duplicateOf).map((f) => f.id),
        ...ledger.findings.filter((f) => f.disposition === 'open').map((f) => f.id),
        ...report.verifications.filter((v) => v.status === 'open').map((v) => v.id)])];
    if ((report.verdict === 'clean') !== (actionable.length === 0)) throw new Error('verdict disagrees with actionable findings');
    // Validate the entire report before changing the ledger.
    ledger.findings.push(...additions);
    const at = new Date().toISOString();
    for (const v of report.verifications) {
        const f = byId.get(v.id)!;
        f.verification = v.status;
        if (v.status === 'open') f.disposition = 'open';
        f.history.push({ at, action: v.status, source, reason: v.reason });
    }
    return actionable;
}

export function applyDispositions(ledger: Ledger, text: string, source: Source, expected: string[], commits: string[]): void {
    const b = block(text, 'conductor-dispositions');
    const answers = list(b.dispositions, 'dispositions').map((raw): Answer => {
        const a = object(raw);
        return { id: string(a.id, 'id'), status: choice(a.status, 'status', ['fixed', 'rejected', 'deferred']), reason: string(a.reason, 'reason') };
    });
    if (answers.length !== expected.length || new Set(answers.map((a) => a.id)).size !== answers.length ||
        answers.some((a) => !expected.includes(a.id))) throw new Error('answer every requested finding exactly once');
    for (const a of answers) {
        if (!ledger.findings.some((f) => f.id === a.id)) throw new Error(`unknown finding ${a.id}`);
        if (a.status === 'fixed' && !commits.length) throw new Error(`${a.id}: a fixed claim requires a new commit`);
    }
    const at = new Date().toISOString();
    for (const a of answers) {
        const f = ledger.findings.find((f) => f.id === a.id)!;
        f.disposition = a.status;
        f.reason = a.reason;
        f.answeredBy = source.agent;
        f.answerSession = source.session;
        f.fixCommits = a.status === 'fixed' ? [...commits] : [];
        f.verification = 'pending';
        f.history.push({ at, action: a.status, source, reason: a.reason, commits: f.fixCommits });
    }
}

export function findingSummary(ledger: Ledger): string {
    if (!ledger.findings.length) return 'No tracked findings yet.';
    return ledger.findings.map((f) => `${f.id} [${f.category}; ${f.disposition}; verification ${f.verification}] ` +
        `${f.summary} (${f.location}); checker ${f.source.agent} at ${f.source.sha}. Evidence: ${f.evidence}` +
        `${f.relatedTo ? `; related to ${f.relatedTo}` : ''}${f.duplicateOf ? `; duplicate of ${f.duplicateOf}` : ''}` +
        `${f.reason ? `; implementer: ${f.reason}` : ''}${f.fixCommits.length ? `; fixing commits ${f.fixCommits.join(', ')}` : ''}` +
        `${f.history.length ? `; latest assessment: ${f.history.at(-1)!.reason}` : ''}`).join('\n');
}

export function findingStats(ledger: Ledger) {
    const rows = new Map<string, { agent: string; model: string; role: string; defects: number; verified: number;
        testGaps: number; other: number; rejectedOrDeferred: number; duplicates: number; reports: number; invalid: number }>();
    const rowFor = (source: Source) => {
        const role = source.role ?? 'feedback';
        const key = JSON.stringify([source.agent, source.model, role]);
        const row = rows.get(key) ?? { agent: source.agent, model: source.model, role,
            defects: 0, verified: 0, testGaps: 0, other: 0, rejectedOrDeferred: 0, duplicates: 0, reports: 0, invalid: 0 };
        rows.set(key, row);
        return row;
    };
    for (const report of ledger.reports.filter((r) => r.kind !== 'dispositions')) {
        const row = rowFor(report.source);
        row.reports++;
        if (report.error) row.invalid++;
    }
    const byId = new Map(ledger.findings.map((f) => [f.id, f]));
    const groups = new Map<string, Finding[]>();
    for (const f of ledger.findings) {
        const row = rowFor(f.source);
        if (f.duplicateOf) { row.duplicates++; continue; }
        if (f.category === 'bug') {
            let root = f;
            while (root.relatedTo || root.duplicateOf) root = byId.get((root.relatedTo ?? root.duplicateOf)!)!;
            const members = groups.get(root.id) ?? [];
            members.push(f);
            groups.set(root.id, members);
        } else if (f.category === 'test_gap') row.testGaps++;
        else row.other++;
        if (f.disposition === 'rejected' || f.disposition === 'deferred') row.rejectedOrDeferred++;
    }
    for (const [id, members] of groups) {
        const owner = members.find((f) => f.id === id) ?? members[0];
        const row = rowFor(owner.source);
        row.defects++;
        if (members.every((f) => f.verification === 'verified')) row.verified++;
    }
    return [...rows.values()];
}

export class FindingStore {
    private directory: string;
    constructor(directory: string) { this.directory = directory; }
    private file(task: string): string {
        if (!/^\d{4}(?:-[a-z0-9-]+)?$/.test(task)) throw new Error('invalid task id for finding ledger');
        return join(this.directory, `${task}.json`);
    }
    read(task: string): Ledger {
        const file = this.file(task);
        return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Ledger : { version: 1, task, findings: [], reports: [] };
    }
    record(task: string, kind: Receipt['kind'], text: string, source: Source, expected: string[] = [], commits: string[] = [], validationError?: string): Receipt {
        const ledger = this.read(task);
        const key = createHash('sha256').update(JSON.stringify({ kind, text, source, expected, commits, validationError })).digest('hex');
        const existing = ledger.reports.find((r) => r.key === key);
        if (existing) return existing;
        const receipt: Receipt = { key, kind, at: new Date().toISOString(), source, raw: text, findingIds: [] };
        try {
            if (validationError) throw new Error(validationError);
            if (kind !== 'dispositions') receipt.findingIds = applyFeedback(ledger, text, source);
            else { applyDispositions(ledger, text, source, expected, commits); receipt.findingIds = expected; }
        } catch (e) { receipt.error = (e as Error).message; }
        ledger.reports.push(receipt);
        mkdirSync(this.directory, { recursive: true });
        const file = this.file(task);
        writeFileSync(`${file}.tmp`, JSON.stringify(ledger, null, 2) + '\n');
        renameSync(`${file}.tmp`, file);
        return receipt;
    }
    export(task: string, directory: string): string {
        const ledger = this.read(task);
        mkdirSync(directory, { recursive: true });
        const file = join(directory, `${task}-findings.md`);
        const lines = [`# ${task} findings`, '', 'Disposition is the implementer claim; verification is a separate checker assessment.', '',
            'Counts describe sequential checks of different revisions, not a controlled model ranking.', '',
            '| Checker | Model | Role | Reports | Invalid replies | Defect groups | Verified groups | Test gaps | Docs/process | Rejected/deferred | Duplicates |',
            '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
        const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
        for (const r of findingStats(ledger)) {
            lines.push(`| ${cell(r.agent)} | ${cell(r.model)} | ${r.role} | ${r.reports} | ${r.invalid} | ${r.defects} | ${r.verified} | ${r.testGaps} | ${r.other} | ${r.rejectedOrDeferred} | ${r.duplicates} |`);
        }
        lines.push('', '## Findings', '', findingSummary(ledger), '', '## Reports', '');
        for (const r of ledger.reports) {
            lines.push(`### ${r.kind}: ${r.source.agent} at ${r.source.sha}`, '', `${r.at}; session ${r.source.session}`,
                ...(r.source.log ? [`[Session log](./${encodeURIComponent(basename(r.source.log))})`] : []),
                '', r.error ? `Pending: ${r.error}` : `Recorded: ${r.findingIds.join(', ') || 'no actionable findings'}`, '', r.raw, '');
        }
        writeFileSync(file, lines.join('\n'));
        return file;
    }
}
