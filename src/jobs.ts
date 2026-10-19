import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Job {
    name: string;
    child: ChildProcess;
    started: number;
    log: string;
    stopping: boolean;
}

export function readLog(file: string): string {
    try {
        return readFileSync(file, 'utf8');
    } catch {
        return '';
    }
}

export function logTail(file: string, lines: number): string {
    try {
        return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
    } catch {
        return '';
    }
}

function groupAlive(pgid: number): boolean {
    try {
        process.kill(-pgid, 0);
        return true;
    } catch {
        return false;
    }
}

async function killGroup(pgid: number, exited: Promise<unknown>) {
    try {
        process.kill(-pgid, 'SIGTERM');
    } catch {
        return;
    }
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 5000));
    if ((await Promise.race([exited, timeout])) === 'timeout') {
        try {
            process.kill(-pgid, 'SIGKILL');
        } catch {
            // already gone
        }
    }
}

async function groupGone(pgid: number) {
    while (groupAlive(pgid)) {
        await new Promise((r) => setTimeout(r, 100));
    }
}

function spawnToLog(cmd: string, cwd: string, log: string): ChildProcess {
    const fd = openSync(log, 'w');
    try {
        // detached gives the job its own process group, so stop() reaches its children too
        return spawn('sh', ['-c', cmd], { cwd, detached: true, stdio: ['ignore', fd, fd] });
    } finally {
        closeSync(fd);
    }
}

export class Jobs {
    private jobs = new Map<string, Job>();
    private dir: string;

    constructor(dir: string) {
        this.dir = dir;
    }

    private logFile(name: string): string {
        mkdirSync(this.dir, { recursive: true });
        return join(this.dir, `${name}.log`);
    }

    // a job's process group outlives the conductor if it exits without stop() (SIGKILL, crash)
    private pidFile(name: string): string {
        return join(this.dir, `${name}.pid`);
    }

    async reapStale(): Promise<string[]> {
        let files: string[];
        try {
            files = readdirSync(this.dir).filter((f) => f.endsWith('.pid'));
        } catch {
            return [];
        }
        const reaped: string[] = [];
        for (const f of files) {
            const name = f.slice(0, -'.pid'.length);
            const file = join(this.dir, f);
            const pgid = Number(readLog(file).trim());
            if (!this.jobs.has(name) && Number.isSafeInteger(pgid) && pgid > 1 && groupAlive(pgid)) {
                await killGroup(pgid, groupGone(pgid));
                reaped.push(name);
            }
            if (!this.jobs.has(name)) {
                rmSync(file, { force: true });
            }
        }
        return reaped;
    }

    get(name: string): Job | undefined {
        return this.jobs.get(name);
    }

    run(name: string, cmd: string, cwd: string): Promise<{ code: number; log: string }> {
        const log = this.logFile(name);
        const child = spawnToLog(cmd, cwd, log);
        return new Promise((resolve, reject) => {
            child.on('error', reject);
            child.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 128 : -1), log }));
        });
    }

    start(name: string, cmd: string, cwd: string, onExit: (job: Job, code: number | null) => void): Job {
        const log = this.logFile(name);
        const job: Job = { name, child: spawnToLog(cmd, cwd, log), started: Date.now(), log, stopping: false };
        this.jobs.set(name, job);
        if (job.child.pid) {
            writeFileSync(this.pidFile(name), `${job.child.pid}\n`);
        }
        job.child.on('exit', (code) => {
            this.jobs.delete(name);
            rmSync(this.pidFile(name), { force: true });
            onExit(job, code);
        });
        return job;
    }

    async stop(name: string): Promise<boolean> {
        const job = this.jobs.get(name);
        if (!job?.child.pid) {
            return false;
        }
        job.stopping = true;
        await killGroup(job.child.pid, new Promise<void>((r) => job.child.once('exit', () => r())));
        return true;
    }

    async stopAll() {
        await Promise.all([...this.jobs.keys()].map((n) => this.stop(n)));
    }
}
