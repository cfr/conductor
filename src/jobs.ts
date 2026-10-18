import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Job {
    name: string;
    child: ChildProcess;
    started: number;
    log: string;
    stopping: boolean;
}

export function logTail(file: string, lines: number): string {
    try {
        return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
    } catch {
        return '';
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
        job.child.on('exit', (code) => {
            this.jobs.delete(name);
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
        const pid = job.child.pid;
        const exited = new Promise<void>((r) => job.child.once('exit', () => r()));
        try {
            process.kill(-pid, 'SIGTERM');
        } catch {
            return true;
        }
        const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 5000));
        if ((await Promise.race([exited, timeout])) === 'timeout') {
            try {
                process.kill(-pid, 'SIGKILL');
            } catch {
                // already gone
            }
        }
        return true;
    }

    async stopAll() {
        await Promise.all([...this.jobs.keys()].map((n) => this.stop(n)));
    }
}
