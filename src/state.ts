import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Role, SessionRole } from './config.ts';
import type { PlanItem } from './plan.ts';

export interface SessionRef {
    agent: string;
    id: string;
    title: string;
    startSha: string;
    checkedSha?: string;
    logFile?: string;
}

export interface GateRecord {
    ok: boolean;
    step?: string;
    sha: string;
    at: string;
}

export interface State {
    task?: PlanItem;
    focus?: Role;
    sessions: Partial<Record<SessionRole, SessionRef>>;
    lastGate?: GateRecord;
    planTopic?: string;
}

export class Store {
    state: State;
    private file: string;

    constructor(file: string) {
        this.file = file;
        this.state = existsSync(file)
            ? (JSON.parse(readFileSync(file, 'utf8')) as State)
            : { sessions: {} };
    }

    save() {
        mkdirSync(dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n');
        renameSync(tmp, this.file);
    }
}
