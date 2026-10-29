import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyFeedback, applyDispositions, findingStats, FindingStore, type Ledger, type Source } from '../src/findings.ts';

const checker: Source = { agent: 'dsf', model: 'deepseek/flash', session: 'check', sha: 'abc', log: '/project/wlog/task-check.md' };
const implementer: Source = { ...checker, agent: 'kimi', model: 'kimi/pro', session: 'impl', sha: 'def' };
const ledger = (): Ledger => ({ version: 1, task: '0169-late-events', findings: [], reports: [] });
const finding = (key = 'bug1') => ({ key, category: 'bug', summary: 'Prediction skipped', location: 'client.cpp:234', evidence: '100-part0 then 99-part0/1 reproduces it' });
const report = (findings: unknown[], verifications: unknown[] = [], verdict = findings.length ? 'findings' : 'clean') =>
    'Readable explanation.\n```conductor-feedback\n' + JSON.stringify({ verdict, findings, verifications }) + '\n```\nVERDICT: ' + verdict;
const answers = (dispositions: unknown[]) => '```conductor-dispositions\n' + JSON.stringify({ dispositions }) + '\n```';

test('stable IDs, related coverage, disposition and independent verification remain distinct', () => {
    const l = ledger();
    const ids = applyFeedback(l, report([finding(), { ...finding('coverage'), category: 'test_gap', relatedTo: 'bug1' }]), checker);
    assert.deepEqual(ids, ['0169-F01', '0169-F02']);
    assert.equal(l.findings[1].relatedTo, '0169-F01');
    const text = answers(ids.map((id) => ({ id, status: 'fixed', reason: 'Fixed and regression fails on old routing' })));
    applyDispositions(l, text, implementer, ids, ['def']);
    assert.equal(l.findings[0].disposition, 'fixed');
    assert.equal(l.findings[0].verification, 'pending');
    assert.deepEqual(l.findings[0].fixCommits, ['def']);
    const checks = ids.map((id) => ({ id, status: 'verified', reason: 'Reverted routing and confirmed test fails' }));
    applyFeedback(l, report([], checks), { ...checker, sha: 'def' });
    assert.equal(l.findings[0].verification, 'verified');
    assert.equal(l.findings[0].history.length, 2);
    const stats = findingStats(l);
    assert.equal(stats[0].defects, 1);
    assert.equal(stats[0].testGaps, 1);
    assert.equal(stats[0].verified, 1);
});

test('invalid reports are atomic; missing fixes cannot be silently verified by a clean verdict', () => {
    const l = ledger();
    const ids = applyFeedback(l, report([finding()]), checker);
    applyDispositions(l, answers([{ id: ids[0], status: 'fixed', reason: 'fixed' }]), implementer, ids, ['def']);
    const before = structuredClone(l);
    assert.throws(() => applyFeedback(l, report([]), checker), /verify pending fix/);
    assert.throws(() => applyFeedback(l, report([finding('another')], [{ id: 'unknown', status: 'verified', reason: 'yes' }]), checker), /unknown verification/);
    assert.deepEqual(l, before);
    assert.throws(() => applyFeedback(l, report([], [{ id: ids[0], status: 'verified', reason: 'yes' }]), implementer), /another session/);
});

test('duplicate links preserve provenance; unresolved bugs stay actionable; cycles are rejected', () => {
    const l = ledger();
    applyFeedback(l, report([finding()]), checker);
    assert.throws(() => applyFeedback(l, report([]), checker), /verdict disagrees/);
    applyDispositions(l, answers([{ id: '0169-F01', status: 'rejected', reason: 'Requires prohibited history rewrite' }]), implementer, ['0169-F01'], []);
    assert.deepEqual(applyFeedback(l, report([{ ...finding('repeat'), duplicateOf: '0169-F01' }], [], 'clean'), checker), []);
    assert.equal(l.findings[1].disposition, 'duplicate');
    assert.equal(l.findings[1].duplicateOf, '0169-F01');
    assert.throws(() => applyFeedback(l, report([
        { ...finding('a'), relatedTo: 'b' }, { ...finding('b'), relatedTo: 'a' },
    ]), checker), /cycles/);
    assert.equal(l.findings.length, 2);
});

test('dispositions require every requested ID, explanations, and real commits for fixed claims', () => {
    const l = ledger();
    const ids = applyFeedback(l, report([finding(), finding('second')]), checker);
    const before = structuredClone(l);
    assert.throws(() => applyDispositions(l, answers([{ id: ids[0], status: 'rejected', reason: 'not a bug' }]), implementer, ids, []), /every requested/);
    assert.throws(() => applyDispositions(l, answers(ids.map((id) => ({ id, status: 'fixed', reason: 'fixed' }))), implementer, ids, []), /requires a new commit/);
    assert.deepEqual(l, before);
});

test('records survive restart, preserve malformed reports, deduplicate replay and export readable logs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'findings-'));
    try {
        const store = new FindingStore(join(dir, 'state'));
        const task = '0169-late-events';
        const invalid = store.record(task, 'feedback', 'No JSON\nVERDICT: clean', checker);
        assert.match(invalid.error!, /conductor-feedback/);
        assert.equal(store.read(task).findings.length, 0);
        const text = report([finding()]);
        const first = store.record(task, 'feedback', text, checker);
        const restarted = new FindingStore(join(dir, 'state'));
        assert.deepEqual(restarted.record(task, 'feedback', text, checker), first);
        const saved = restarted.read(task);
        assert.equal(saved.findings.length, 1);
        assert.equal(saved.reports.length, 2);
        const file = restarted.export(task, join(dir, 'wlog'));
        const md = readFileSync(file, 'utf8');
        assert.match(md, /0169-F01/);
        assert.match(md, /Pending: include exactly one/);
        assert.match(md, /\[Session log\]\(\.\/task-check.md\)/);
        assert.throws(() => restarted.read('../escape'), /invalid task/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('JSON and verdict must agree and duplicate report blocks are rejected', () => {
    const l = ledger();
    assert.throws(() => applyFeedback(l, report([finding()]).replace('VERDICT: findings', 'VERDICT: clean'), checker), /agree/);
    assert.throws(() => applyFeedback(l, report([]) + '\n' + report([]), checker), /exactly one/);
});
