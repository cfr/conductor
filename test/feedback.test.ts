import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Conductor } from '../src/conductor.ts';
import type { State } from '../src/state.ts';
import type { Role } from '../src/config.ts';
import type { TurnResult } from '../src/agents/types.ts';

// Exercise the feedback transition without Telegram, git, or live model turns.
interface FeedbackHarness {
    store: { state: State; save(): void };
    chat: { send(text: string): Promise<void> };
    project: { prompts: { feedbackFix: string } };
    afterFeedback(report: string): Promise<void>;
    afterTurn(role: Role, result: TurnResult, from: undefined, attempt: number): Promise<void>;
    afterSettledCheck(why: string): Promise<void>;
    turn(role: Role, text: string, doing: string): Promise<void>;
}

function fixture(retry: TurnResult) {
    const state: State = {
        task: { id: '0166-player-cap', number: '0166', text: 'player cap' },
        sessions: {}, feedbackRound: 3, focus: 'feedback',
    };
    const notices: string[] = [];
    const turns: { role: Role; text: string }[] = [];
    const settled: string[] = [];
    const snapshots: State[] = [];
    const conductor = Object.create(Conductor.prototype) as FeedbackHarness;
    conductor.store = { state, save() { snapshots.push(structuredClone(state)); } };
    conductor.chat = { async send(text) { notices.push(text); } };
    conductor.project = { prompts: { feedbackFix: 'Fix the valid findings:\n{findings}' } };
    conductor.afterSettledCheck = async (why) => { settled.push(why); };
    conductor.turn = async (role, text) => {
        turns.push({ role, text });
        if (role === 'feedback') await conductor.afterTurn(role, retry, undefined, 0);
    };
    return { conductor, state, notices, turns, settled, snapshots };
}

test('missing verdict retries in feedback and a clean report settles the check', async () => {
    const f = fixture({ outcome: 'succeeded', text: 'Checked everything.\nVERDICT: clean' });
    await f.conductor.afterFeedback("I'll start by examining the repository.");
    assert.deepEqual(f.turns.map((t) => t.role), ['feedback']);
    assert.match(f.turns[0].text, /do not edit files or commit/);
    assert.equal(f.settled.length, 1);
    assert.equal(f.state.feedbackRound, 3);
    assert.equal(f.state.feedbackFixing, undefined);
    assert.equal(f.snapshots[0].feedbackReportRetried, true);
});

test('retry findings go to the implementer with only the completed report', async () => {
    const report = 'server.cpp:40: repeated notices; suppress duplicates.\nVERDICT: findings';
    const f = fixture({ outcome: 'succeeded', text: report });
    await f.conductor.afterFeedback('');
    assert.deepEqual(f.turns.map((t) => t.role), ['feedback', 'implement']);
    assert.equal(f.turns[1].text, `Fix the valid findings:\n${report}`);
    assert.equal(f.state.feedbackFixing, true);
    assert.equal(f.state.focus, 'implement');
});

test('second missing verdict pauses and persisted retry budget prevents another automatic turn', async () => {
    const f = fixture({ outcome: 'succeeded', text: '' });
    await f.conductor.afterFeedback('No final report.');
    assert.deepEqual(f.turns.map((t) => t.role), ['feedback']);
    assert.equal(f.settled.length, 0);
    assert.equal(f.state.feedbackFixing, undefined);
    assert.equal(f.state.focus, 'feedback');
    assert.match(f.notices.at(-1)!, /task flow paused/);
    assert.match(f.notices.at(-1)!, /\/continue feedback/);
    f.conductor.store.state = structuredClone(f.state);
    await f.conductor.afterFeedback('Still incomplete.');
    assert.equal(f.turns.length, 1);
    await f.conductor.afterFeedback('Finally finished.\nVERDICT: clean');
    assert.equal(f.settled.length, 1);
});

for (const outcome of ['failed', 'interrupted'] as const) {
    test(`a ${outcome} retry cannot advance to fixes or review`, async () => {
        const f = fixture({ outcome, text: 'VERDICT: clean', error: 'stopped' });
        await f.conductor.afterFeedback('');
        assert.deepEqual(f.turns.map((t) => t.role), ['feedback']);
        assert.equal(f.settled.length, 0);
        assert.equal(f.state.feedbackReportRetried, true);
        assert.equal(f.state.feedbackFixing, undefined);
    });
}

test('a valid initial findings report goes directly to the implementer', async () => {
    const f = fixture({ outcome: 'failed', text: '' });
    await f.conductor.afterFeedback('Bug at file.cpp:10.\nVERDICT: findings');
    assert.deepEqual(f.turns.map((t) => t.role), ['implement']);
    assert.equal(f.state.feedbackReportRetried, undefined);
});
