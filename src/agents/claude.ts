import { randomUUID } from 'node:crypto';
import { query, type CanUseTool, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { AgentConfig } from '../config.ts';
import { findTranscript, readClaudeTranscript } from '../logs/claude.ts';
import { bashPatterns } from './bash-rules.ts';
import type { Transcript } from '../logs/markdown.ts';
import type { Adapter, AgentSession, SessionOptions, TurnResult } from './types.ts';

interface AskInput {
    questions?: {
        question: string;
        header?: string;
        multiSelect?: boolean;
        options: { label: string; description?: string }[];
    }[];
}

export class ClaudeAdapter implements Adapter {
    async create(agent: AgentConfig, opts: SessionOptions): Promise<AgentSession> {
        return new ClaudeSession(agent, randomUUID(), opts, false);
    }

    resume(agent: AgentConfig, id: string, opts: SessionOptions): AgentSession {
        return new ClaudeSession(agent, id, opts, true);
    }
}

class ClaudeSession implements AgentSession {
    private abort: AbortController | null = null;
    readonly agent: AgentConfig;
    readonly id: string;
    private opts: SessionOptions;
    private started: boolean;

    constructor(agent: AgentConfig, id: string, opts: SessionOptions, started: boolean) {
        this.agent = agent;
        this.id = id;
        this.opts = opts;
        this.started = started;
    }

    private canUseTool: CanUseTool = async (toolName, input, { suggestions }) => {
        if (toolName === 'AskUserQuestion') {
            const answers: Record<string, string> = {};
            for (const q of (input as AskInput).questions ?? []) {
                answers[q.question] = await this.opts.asker.question({
                    title: q.question,
                    detail: q.multiSelect ? '(multi-select: answer in text, comma-separated)' : undefined,
                    choices: q.options.map((o) => ({ label: o.label, description: o.description })),
                    allowText: true,
                });
            }
            return { behavior: 'allow', updatedInput: { ...input, answers } };
        }
        const detail = JSON.stringify(input, null, 2).slice(0, 1500);
        const patterns =
            toolName === 'Bash' && typeof input.command === 'string' ? bashPatterns(input.command) : [];
        const decision = await this.opts.asker.permission(`permission: ${toolName}`, detail, patterns);
        if (decision === 'reject') {
            return { behavior: 'deny', message: 'The user denied this tool call.' };
        }
        if (decision === 'pattern') {
            const rules = patterns.map((ruleContent) => ({ toolName: 'Bash', ruleContent }));
            return {
                behavior: 'allow',
                updatedInput: input,
                updatedPermissions: [{ type: 'addRules', rules, behavior: 'allow', destination: 'localSettings' }],
            };
        }
        return {
            behavior: 'allow',
            updatedInput: input,
            updatedPermissions: decision === 'always' ? suggestions : undefined,
        };
    };

    async send(text: string): Promise<TurnResult> {
        this.abort = new AbortController();
        const options: Options = {
            cwd: this.opts.cwd,
            model: this.agent.model,
            systemPrompt: { type: 'preset', preset: 'claude_code' },
            canUseTool: this.canUseTool,
            abortController: this.abort,
            ...(this.agent.effort ? { effort: this.agent.effort as Options['effort'] } : {}),
            ...(this.started ? { resume: this.id } : { sessionId: this.id, title: this.opts.title }),
        };
        let result: TurnResult = { outcome: 'failed', text: '', error: 'no result message' };
        try {
            for await (const m of query({ prompt: text, options })) {
                if (m.type !== 'result') {
                    continue;
                }
                this.started = true;
                if (m.subtype === 'success') {
                    result = { outcome: 'succeeded', text: m.result };
                } else {
                    result = { outcome: 'failed', text: '', error: m.subtype };
                }
            }
        } catch (e) {
            if (this.abort.signal.aborted) {
                result = { outcome: 'interrupted', text: '' };
            } else {
                result = { outcome: 'failed', text: '', error: (e as Error).message };
            }
        } finally {
            this.started ||= findTranscript(this.id) !== undefined;
            this.abort = null;
        }
        return result;
    }

    async lastReply(): Promise<string> {
        const t = readClaudeTranscript(this.id);
        const last = t?.messages.filter((m) => m.role === 'assistant').pop();
        return (last?.parts ?? [])
            .flatMap((p) => (p.kind === 'text' && p.text.trim() ? [p.text] : []))
            .join('\n\n');
    }

    async interrupt(): Promise<void> {
        this.abort?.abort();
    }

    async transcript(): Promise<Transcript | undefined> {
        return readClaudeTranscript(this.id);
    }
}
