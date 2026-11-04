import type { Transcript, Usage } from './markdown.ts';

type Counters = Record<string, number>;
const fields = ['input_tokens', 'cached_input_tokens', 'output_tokens'] as const;

// exec resume emits thread totals, including work from earlier CLI invocations.
export function normalizeCodexUsage(transcript: Transcript): void {
    let previous: Counters | undefined;
    let thread: string | undefined;
    for (const message of transcript.messages) {
        const source = message.usageSource;
        if (source?.kind !== 'codex-turn') continue;
        let raw = source.raw;
        if (!raw && message.usage && !source.accounting) {
            const usage = message.usage;
            raw = { input_tokens: usage.input + usage.cacheRead, cached_input_tokens: usage.cacheRead, output_tokens: usage.output };
            source.raw = raw;
            source.rawReconstructed = true;
        }
        if (!raw || !fields.every((key) => Number.isFinite(raw[key]) && raw[key] >= 0)) {
            previous = undefined;
            continue;
        }
        if (source.threadId && thread && source.threadId !== thread) previous = undefined;
        if (source.threadId) thread = source.threadId;
        const reset = previous !== undefined && fields.some((key) => raw[key] < previous![key]);
        const base = reset ? undefined : previous;
        const input = raw.input_tokens - (base?.input_tokens ?? 0);
        const cached = raw.cached_input_tokens - (base?.cached_input_tokens ?? 0);
        const output = raw.output_tokens - (base?.output_tokens ?? 0);
        message.usage = { steps: 0, turns: 1, stepsKnown: false, maxContextKnown: false,
            input: Math.max(0, input - cached), output, cacheRead: cached, cacheWrite: 0,
            maxContext: 0, compactions: message.usage?.compactions ?? 0 } satisfies Usage;
        source.accounting = 'thread-delta';
        if (reset) source.counterReset = true;
        else delete source.counterReset;
        previous = raw;
    }
}
