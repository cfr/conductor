import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from 'grammy';
import { Chat, describeError, retryNetwork } from '../src/telegram.ts';

const dropped = () =>
    new HttpError(
        "Network request for 'sendMessage' failed!",
        new Error('request to https://api.telegram.org/bot123:SECRET/sendMessage failed, reason: ECONNRESET'),
    );

test('network failures are retried, then given up on', async () => {
    let calls = 0;
    const flaky = async () => {
        if (++calls < 3) {
            throw dropped();
        }
        return { ok: true as const, result: true };
    };
    const call = retryNetwork([0, 0]) as (...a: unknown[]) => Promise<unknown>;
    assert.deepEqual(await call(flaky, 'sendMessage', {}), { ok: true, result: true });
    assert.equal(calls, 3);

    calls = -10;
    await assert.rejects(call(flaky, 'sendMessage', {}), HttpError);
    assert.equal(calls, -7);

    calls = 0;
    await assert.rejects(call(flaky, 'getUpdates', {}), HttpError);
    assert.equal(calls, 1);
});

test('error descriptions hide the bot token', () => {
    const text = describeError(dropped());
    assert.match(text, /ECONNRESET/);
    assert.doesNotMatch(text, /SECRET/);
});

test('empty attachments send a routed explanation instead of an invalid document', async () => {
    const chat = new Chat('123:test', 123);
    const messages: string[] = [];
    const documents: unknown[][] = [];
    Object.assign(chat, { bot: { api: {
        async sendMessage(_user: number, text: string) {
            messages.push(text);
            return { message_id: messages.length };
        },
        async sendDocument(...args: unknown[]) {
            documents.push(args);
            return { message_id: 100 };
        },
    } } });
    await chat.sendFile('task-implement.diff', '', 'Gate passed', 'implement');
    await chat.sendFile('gate.log', '');
    assert.deepEqual(messages, ['Gate passed\ntask-implement.diff: no file changes', 'gate.log: file is empty']);
    assert.equal(documents.length, 0);
    assert.equal((chat as unknown as { routes: Map<number, string> }).routes.get(1), 'implement');
    await chat.sendFile('task.diff', 'diff --git a/file b/file\n', 'Changes', 'review');
    assert.equal(documents.length, 1);
    assert.deepEqual(documents[0][2], { caption: 'Changes' });
    assert.equal((chat as unknown as { routes: Map<number, string> }).routes.get(100), 'review');
});
