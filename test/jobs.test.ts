import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

async function until(check: () => boolean) {
    for (let n = 0; n < 150; n++) {
        if (check()) return;
        await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(check(), 'process fixture did not settle');
}

test('one-shot commands are tracked and stopped during shutdown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-one-shot-'));
    const jobs = new Jobs(dir);
    try {
        const running = jobs.run('deploy', 'sleep 30', dir);
        assert.ok(jobs.get('deploy'));
        assert.ok(existsSync(join(dir, 'deploy.pid')));
        await jobs.stopAll();
        assert.notEqual((await running).code, 0);
        assert.equal(jobs.get('deploy'), undefined);
        assert.equal(existsSync(join(dir, 'deploy.pid')), false);
    } finally { await jobs.stopAll(); rmSync(dir, { recursive: true, force: true }); }
});

test('stop escalates when the shell exits but a descendant ignores SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-stubborn-'));
    const jobs = new Jobs(dir);
    const pidFile = join(dir, 'child.pid');
    const script = join(dir, 'child.cjs');
    writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
    const job = jobs.start('serve', `node '${script}' & wait`, dir, () => {});
    try {
        await until(() => existsSync(pidFile));
        const pid = readFileSync(pidFile, 'utf8');
        await jobs.stop('serve');
        await until(() => {
            if (process.platform === 'linux') {
                try {
                    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
                    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
                } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true; throw e; }
            }
            try { return execFileSync('ps', ['-p', pid, '-o', 'stat='], { encoding: 'utf8' }).trim().startsWith('Z'); }
            catch (e) { if ((e as { status?: number }).status === 1) return true; throw e; }
        });
        assert.equal(jobs.get('serve'), undefined);
    } finally {
        try { process.kill(-job.child.pid!, 'SIGKILL'); } catch {}
        await jobs.stopAll(); rmSync(dir, { recursive: true, force: true });
    }
});

test('duplicate job names cannot replace tracked process ownership', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-job-name-'));
    const jobs = new Jobs(dir);
    try {
        const job = jobs.start('serve', 'sleep 30', dir, () => {});
        assert.throws(() => jobs.start('serve', 'sleep 30', dir, () => {}), /already running/);
        assert.equal(jobs.get('serve'), job);
    } finally { await jobs.stopAll(); rmSync(dir, { recursive: true, force: true }); }
});
