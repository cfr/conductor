import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from 'grammy';
import { describeError, retryNetwork } from '../src/telegram.ts';

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
