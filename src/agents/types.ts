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

export interface PendingWork {
    kind: 'shell' | 'subagent' | 'session' | 'inbox';
    id?: string;
    description: string;
}

export interface PendingWorkState {
    sessions: Record<string, {
        assistantCursor?: string;
        syntheticCursor?: string;
        children: { id: string; toolId: string; description: string; launchedAt: number; returnedAt?: number }[];
        notifications: Record<string, { id: string; created: number }>;
    }>;
}

export interface SessionOptions {
    title: string;
    cwd: string;
    asker: Asker;
    readOnly?: boolean;
    pendingWorkState?: PendingWorkState;
    savePendingWork?: (id: string, state: PendingWorkState) => void;
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
    // Includes child sessions and completion notifications the parent has not processed.
    pendingWork(): Promise<PendingWork[]>;
    // Applies from the next turn on.
    setReadOnly(on: boolean): Promise<void>;
}

export type UnsolicitedEvent =
    | { phase: 'started' }
    | { phase: 'ended'; outcome: TurnResult['outcome']; error?: string };

export interface Adapter {
    onUnsolicited?: (sessionId: string, event: UnsolicitedEvent) => void;
    create(agent: AgentConfig, opts: SessionOptions): Promise<AgentSession>;
    resume(agent: AgentConfig, id: string, opts: SessionOptions): AgentSession;
}
