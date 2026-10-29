import type { Role, ProjectConfig } from './config.ts';
import { FindingStore, findingSummary, type Receipt, type Source } from './findings.ts';
import type { Store } from './state.ts';
import * as repo from './repo.ts';

export const validationGuidance =
    'For behavior fixes, demonstrate at least one regression test failing without the fix and passing ' +
    'with it, or explain why this cannot be demonstrated. When behavior crosses components, test through ' +
    'the real caller/entry path, not only an isolated helper. For bounds changes use maximum supported ' +
    'lengths/counts and realistic combinations. Check repair regressions and invariants changed by a fix. ' +
    'Conductor owns the full verification gate after commits. Use focused tests while implementing or ' +
    'reviewing; do not rerun a green full gate on an unchanged tree. A stale, failed, or missing gate is ' +
    'not evidence of success. Do not rewrite history to fix old commit messages; record the limitation.';

export const feedbackContract = `Return a readable report and exactly one fenced conductor-feedback JSON block:
\`\`\`conductor-feedback
{"verdict":"findings","findings":[{"key":"new1","category":"bug","summary":"Short description","location":"file:line","evidence":"Concrete input or failing check"}],"verifications":[]}
\`\`\`
Allowed categories: bug, test_gap, docs, process. For a clean check use verdict "clean" and findings [].
Conductor assigns stable IDs. Link related coverage gaps with "relatedTo":"new1" (a key in this report)
or an existing finding ID; report repeated findings with "duplicateOf":"existing-ID". Do not silently
merge similar findings. For previous fixes use verifications [{"id":"existing-ID","status":"verified",
"reason":"Independent evidence at this SHA"}]. Other statuses: "open" for a still-broken/rejected fix,
"accepted_rejection" when the rejection or deferral is justified. Verify every pending claimed fix.
Use verdict "findings" for new or still-open issues; a duplicate-only report can be clean if the
original is resolved. An overall clean verdict alone does not verify a finding. Do not repeat rejected findings without new
evidence; honor the recorded reason. Investigate until an issue is demonstrated, then report it without
repeated speculative probes. End with exactly VERDICT: clean or VERDICT: findings, matching the JSON.`;

export const dispositionContract = `Answer every requested finding ID exactly once in a readable reply plus:
\`\`\`conductor-dispositions
{"dispositions":[{"id":"TASK-F01","status":"fixed","reason":"What changed and regression evidence"}]}
\`\`\`
Statuses: fixed, rejected, deferred. Explain every disposition. A fixed claim requires a new commit.
Conductor records the actual commits made during this repair; do not invent commit hashes. Do not amend
or rebase earlier commits. Keep related bugs and test gaps separately identified.`;

export class FeedbackTracker {
    readonly records: FindingStore;
    private store: Store;
    private project: ProjectConfig;
    constructor(store: Store, directory: string, project: ProjectConfig) {
        this.store = store;
        this.project = project;
        this.records = new FindingStore(directory);
    }
    private get task(): string { return this.store.state.task!.id; }
    private source(role: 'feedback' | 'implement' | 'review', sha: string): Source {
        const ref = this.store.state.sessions[role]!;
        const agent = this.project.agents.get(ref.agent)!;
        return { agent: ref.agent, role, model: ref.model ?? agent.model, session: ref.id, sha, log: ref.logFile };
    }
    summary(): string { return findingSummary(this.records.read(this.task)); }
    export(): string { return this.records.export(this.task, this.project.logDir); }
    async prompt(role: Role, text: string): Promise<string> {
        if (!['implement', 'feedback', 'review'].includes(role)) return text;
        const state = this.store.state;
        const sha = await repo.head(this.project.root);
        const dirty = await repo.status(this.project.root);
        const gate = state.lastGate;
        const gateText = gate
            ? `${gate.ok ? 'PASSED' : 'FAILED'} at ${gate.sha} (${gate.at}); ` +
              `commands: ${(gate.commands ?? []).join('; ') || 'not recorded'}; log: ${gate.logFile ?? 'not recorded'}. ` +
              `${gate.sha === sha && !dirty && JSON.stringify(gate.commands) === JSON.stringify(this.project.gate.map((s) => s.cmd))
                  ? 'Same SHA, gate commands, and clean worktree.'
                  : 'SHA, worktree, or gate commands differ/are unknown; do not assume it covers this tree.'}`
            : 'No conductor gate result recorded.';
        const extra = [text, '\nValidation and verification ownership:', validationGuidance, `Conductor gate: ${gateText}`];
        if (role === 'implement') {
            extra.push('Before the first implementation commit, identify the modes and lifecycle transitions ' +
                'affected by the change. Test their meaningful combinations through the real caller/entry ' +
                'path, including recovery and intentional-exit behavior where relevant. Briefly report ' +
                'the combinations checked and any coverage limitations.');
        }
        if (role === 'feedback' || role === 'review') {
            extra.push(`Current SHA: ${sha}`, `Previous feedback findings and dispositions:\n${this.summary()}`);
            state.sessions[role]!.reportSha = sha;
            state.sessions[role]!.trackedFindings = true;
            this.store.save();
        }
        if (role === 'feedback' || (role === 'review' && state.sessions.review?.expectReport)) {
            extra.push(feedbackContract);
        }
        const requested = role === 'review' && state.sessions.review?.fixingFindings
            ? state.sessions.review.findingIds : role === 'implement' ? state.feedbackFindingIds : undefined;
        if (requested?.length) {
            extra.push(`Requested IDs: ${requested.join(', ')}`, this.summary(), dispositionContract);
        }
        return extra.join('\n\n');
    }
    async report(text: string, role: 'feedback' | 'review' = 'feedback'): Promise<Receipt> {
        const ref = this.store.state.sessions[role]!;
        const sha = ref.reportSha ?? ref.checkedSha ?? await repo.head(this.project.root);
        const ledger = this.records.read(this.task);
        // A verifier must actually review a tree containing the claimed fixing commits.
        let validationError: string | undefined;
        try {
            for (const f of ledger.findings.filter((f) => f.disposition === 'fixed' && f.verification === 'pending')) {
                for (const commit of f.fixCommits) {
                    if (!(await repo.isAncestor(this.project.root, commit, sha))) {
                        throw new Error(`feedback checked ${sha}, which does not contain the fix for ${f.id}`);
                    }
                }
            }
        } catch (e) { validationError = (e as Error).message; }
        const r = this.records.record(this.task, role, text, this.source(role, sha), [], [], validationError);
        this.export();
        return r;
    }
    async answer(text: string, role: 'implement' | 'review' = 'implement'): Promise<Receipt> {
        const state = this.store.state;
        const sha = await repo.head(this.project.root);
        const base = role === 'implement' ? state.feedbackFixBase! : state.sessions.review!.fixBase!;
        const ids = role === 'implement' ? state.feedbackFindingIds : state.sessions.review!.findingIds;
        const commits = await repo.commitsSince(this.project.root, base);
        const r = this.records.record(this.task, 'dispositions', text, this.source(role, sha), ids, commits);
        this.export();
        return r;
    }
    async begin(ids: string[]): Promise<void> {
        const state = this.store.state;
        state.feedbackFindingIds = ids;
        state.feedbackFixBase = await repo.head(this.project.root);
        state.feedbackDispositionRetried = undefined;
        state.feedbackDispositionPending = true;
        state.feedbackFixing = true;
        state.focus = 'implement';
        this.store.save();
    }
}
