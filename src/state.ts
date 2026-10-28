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
    // set while a turn runs, so a restart can tell how it ended
    turn?: { since: number; doing: string };
    // planning commits kept so far; other commits land beside a planning session
    planCommits?: string[];
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
    // feedback checks run for the current task, and whether the implementer is answering one
    feedbackRound?: number;
    feedbackFixing?: boolean;
    // Persist the retry budget across restarts and failed retry turns.
    feedbackReportRetried?: boolean;
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
