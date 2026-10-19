import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Jobs, logTail } from '../src/jobs.ts';

test('one-shot runs to a log, background jobs stop with their children', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-jobs-'));
    const jobs = new Jobs(dir);
    const r = await jobs.run('once', 'echo one; echo two >&2; exit 3', dir);
    assert.equal(r.code, 3);
    assert.equal(logTail(r.log, 5), 'one\ntwo');

    let exit: { stopping: boolean } | undefined;
    const done = new Promise<void>((resolve) => {
        jobs.start('bg', 'echo up; sh -c "sleep 30" & sleep 30', dir, (job) => {
            exit = { stopping: job.stopping };
            resolve();
        });
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(jobs.get('bg'));
    assert.equal(await jobs.stop('bg'), true);
    await done;
    assert.deepEqual(exit, { stopping: true });
    assert.equal(jobs.get('bg'), undefined);
    assert.equal(logTail(join(dir, 'bg.log'), 1), 'up');
});

test('a later run stops the process group a lost run left behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-jobs-'));
    const lost = new Jobs(dir);
    const exited = new Promise<void>((resolve) => {
        lost.start('serve', 'sh -c "sleep 30" & sleep 30', dir, () => resolve());
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(await new Jobs(dir).reapStale(), ['serve']);
    await exited;
    assert.deepEqual(await new Jobs(dir).reapStale(), []);
});
