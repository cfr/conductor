import type { AgentConfig } from '../config.ts';
import type { Transcript } from '../logs/markdown.ts';

export interface TurnResult {
    outcome: 'succeeded' | 'failed' | 'interrupted';
    text: string;
    error?: string;
}

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
}

export interface AgentSession {
    readonly id: string;
    readonly agent: AgentConfig;
    send(text: string): Promise<TurnResult>;
    interrupt(): Promise<void>;
    transcript(): Promise<Transcript | undefined>;
}

export interface Adapter {
    create(agent: AgentConfig, opts: SessionOptions): Promise<AgentSession>;
    resume(agent: AgentConfig, id: string, opts: SessionOptions): AgentSession;
}
