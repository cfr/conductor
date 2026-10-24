import type { AgentConfig } from '../config.ts';
import type { Transcript } from '../logs/markdown.ts';

export interface TurnResult {
    outcome: 'succeeded' | 'failed' | 'interrupted';
    text: string;
    error?: string;
}

export type TurnState =
    | { running: true }
    | { running: false; outcome: TurnResult['outcome']; error?: string };

export interface Choice {
    label: string;
    description?: string;
}

export interface Question {
    title: string;
    detail?: string;
    choices: Choice[];
    allowText: boolean;
}

export type PermissionDecision = 'once' | 'always' | 'pattern' | 'reject';

export interface Asker {
    permission(title: string, detail: string, patterns?: string[]): Promise<PermissionDecision>;
    question(q: Question): Promise<string>;
}

export interface SessionOptions {
    title: string;
    cwd: string;
    asker: Asker;
    readOnly?: boolean;
}

export interface AgentSession {
    readonly id: string;
    readonly agent: AgentConfig;
    send(text: string): Promise<TurnResult>;
    lastReply(): Promise<string>;
    interrupt(): Promise<void>;
    transcript(): Promise<Transcript | undefined>;
    // For a turn begun at `since` (ms) whose end the conductor missed, e.g. across a restart.
    turnState(since: number): Promise<TurnState>;
    // Commands of the session's background jobs still running; the harness resumes the session when one exits.
    backgroundJobs(): Promise<string[]>;
}

export type UnsolicitedEvent =
    | { phase: 'started' }
    | { phase: 'ended'; outcome: TurnResult['outcome']; error?: string };

export interface Adapter {
    onUnsolicited?: (sessionId: string, event: UnsolicitedEvent) => void;
    create(agent: AgentConfig, opts: SessionOptions): Promise<AgentSession>;
    resume(agent: AgentConfig, id: string, opts: SessionOptions): AgentSession;
}
