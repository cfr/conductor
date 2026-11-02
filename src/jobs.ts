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

export function groupAlive(pgid: number): boolean {
    try {
        process.kill(-pgid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

export async function killGroup(pgid: number, graceMs = 3000) {
    try {
        process.kill(-pgid, 'SIGTERM');
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
        return;
    }
    const deadline = Date.now() + graceMs;
    while (groupAlive(pgid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    if (groupAlive(pgid)) {
        try {
            process.kill(-pgid, 'SIGKILL');
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
        }
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
                await killGroup(pgid);
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
        return new Promise((resolve, reject) => {
            const job = this.start(name, cmd, cwd, (j, code) => resolve({ code: code ?? 128, log: j.log }));
            job.child.once('error', reject);
        });
    }

    start(name: string, cmd: string, cwd: string, onExit: (job: Job, code: number | null) => void): Job {
        if (this.jobs.has(name)) throw new Error(`/${name} is already running`);
        const log = this.logFile(name);
        const job: Job = { name, child: spawnToLog(cmd, cwd, log), started: Date.now(), log, stopping: false };
        this.jobs.set(name, job);
        if (job.child.pid) {
            writeFileSync(this.pidFile(name), `${job.child.pid}\n`);
        }
        const forget = () => {
            if (this.jobs.get(name) !== job) return;
            this.jobs.delete(name);
            rmSync(this.pidFile(name), { force: true });
        };
        job.child.once('error', () => forget());
        job.child.on('exit', (code) => {
            // Keep ownership while stop() finishes cleaning up surviving descendants.
            if (!job.stopping && (!job.child.pid || !groupAlive(job.child.pid))) forget();
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
        await killGroup(job.child.pid);
        if (this.jobs.get(name) === job) {
            this.jobs.delete(name);
            rmSync(this.pidFile(name), { force: true });
        }
        return true;
    }

    async stopAll() {
        await Promise.all([...this.jobs.keys()].map((n) => this.stop(n)));
    }
}
