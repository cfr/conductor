import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentConfig } from './config.ts';
import { readCodexLimits } from './limits-codex.ts';

const exec = promisify(execFile);
type Data = Record<string, unknown>;
export interface LimitWindow { name: string; usedPercent: number; resetsAt?: number; }
export interface AccountLimits { windows: LimitWindow[]; plan?: string; balances?: string[]; }
export interface Credential { integrationID: string; active: boolean; value: { type: string; key?: string }; }
interface LimitGroup { harness: AgentConfig['harness']; provider: string; label: string; aliases: string[]; }
interface LimitSources {
    codex: () => Promise<unknown>;
    credentials: (url: string) => Promise<Credential[]>;
    fetch: typeof fetch;
}

function object(value: unknown): Data {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function number(value: unknown): number | undefined {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}
function percent(value: unknown): number | undefined {
    const n = number(value);
    return n !== undefined && n >= 0 && n <= 100 ? n : undefined;
}
function timestamp(value: unknown): number | undefined {
    const n = typeof value === 'string' ? Date.parse(value) : number(value);
    return n !== undefined && Number.isFinite(n) && n > 0 && n <= 8640000000000000 ? n : undefined;
}
function windowName(minutes: number | undefined, fallback: string): string {
    if (minutes === 10080) return 'weekly';
    if (minutes === undefined || minutes <= 0) return fallback;
    return minutes % 1440 === 0 ? `${minutes / 1440}-day` : minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;
}
function counter(detail: Data): number | undefined {
    const limit = number(detail.limit);
    const used = number(detail.used);
    const remaining = number(detail.remaining);
    if (limit === undefined || limit <= 0) return;
    return percent(100 * (used ?? (remaining === undefined ? NaN : limit - remaining)) / limit);
}
function add(windows: LimitWindow[], name: string, usedPercent: number | undefined, resetsAt?: number) {
    if (usedPercent !== undefined) windows.push({ name, usedPercent, ...(resetsAt === undefined ? {} : { resetsAt }) });
}
function checked(limits: AccountLimits): AccountLimits {
    if (!limits.windows.length && !limits.balances?.length) throw new Error('No recognizable quota data reported');
    return limits;
}

export function parseCodexLimits(value: unknown): AccountLimits {
    const data = object(value);
    const buckets = Object.values(object(data.rateLimitsByLimitId));
    if (!buckets.length) buckets.push(data.rateLimits);
    const windows: LimitWindow[] = [];
    let plan: string | undefined;
    for (const raw of buckets) {
        const bucket = object(raw);
        if (typeof bucket.planType === 'string') plan = bucket.planType;
        const label = String(bucket.limitName ?? bucket.limitId ?? 'quota');
        for (const kind of ['primary', 'secondary']) {
            const w = object(bucket[kind]);
            const name = windowName(number(w.windowDurationMins), kind);
            add(windows, buckets.length > 1 ? `${label} ${name}` : name, percent(w.usedPercent),
                timestamp(typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : undefined));
        }
    }
    return checked({ windows, plan });
}

export function parseZaiLimits(value: unknown): AccountLimits {
    const response = object(value);
    if (response.success === false || (response.code !== undefined && response.code !== 200)) throw new Error('Z.ai rejected the quota request');
    const data = object(response.data);
    const windows: LimitWindow[] = [];
    for (const raw of array(data.limits)) {
        const w = object(raw);
        const unit = number(w.unit);
        const count = number(w.number);
        const minutes = count === undefined ? undefined : unit === 3 ? count * 60 : unit === 6 ? count * 10080 : undefined;
        const quota = w.type === 'CREDIT_LIMIT' || w.type === 'TOKENS_LIMIT';
        const fallback = quota ? 'other quota' : 'tool quota';
        const name = windowName(minutes, fallback);
        const total = number(w.usage);
        const used = number(w.currentValue);
        const usage = total !== undefined && total > 0 && used !== undefined ? percent(used / total * 100) : percent(w.percentage);
        add(windows, quota ? name : `MCP ${name}`, usage, timestamp(w.nextResetTime));
    }
    return checked({ windows, plan: typeof data.level === 'string' ? data.level : undefined });
}

export function parseKimiLimits(value: unknown): AccountLimits {
    const data = object(value);
    const windows: LimitWindow[] = [];
    for (const raw of array(data.limits)) {
        const item = object(raw);
        const w = object(item.window);
        const detail = object(item.detail);
        const duration = number(w.duration);
        const minutes = duration === undefined ? undefined : w.timeUnit === 'TIME_UNIT_MINUTE' ? duration :
            w.timeUnit === 'TIME_UNIT_HOUR' ? duration * 60 : w.timeUnit === 'TIME_UNIT_DAY' ? duration * 1440 : undefined;
        add(windows, windowName(minutes, 'other quota'), counter(detail), timestamp(detail.resetTime));
    }
    // Counters take priority: some gateways return zeroed ratio fields beside live counters.
    if (!windows.some((w) => w.name === 'weekly')) {
        const weekly = object(data.usage);
        add(windows, 'weekly', counter(weekly), timestamp(weekly.resetTime));
    }
    const ratios = object(data.usages);
    for (const [key, name] of [['limit_5h', '5-hour'], ['limit_7d', 'weekly'],
        ['limit_month_code', 'monthly']]) {
        if (windows.some((w) => w.name === name)) continue;
        const w = object(ratios[key]);
        const ratio = number(w.used_ratio);
        add(windows, name, percent(ratio === undefined ? undefined : ratio * 100), timestamp(w.reset_time));
    }
    return checked({ windows });
}

export function parseMinimaxLimits(value: unknown): AccountLimits {
    const data = object(value);
    const status = object(data.base_resp).status_code;
    if (status !== 0) throw new Error('MiniMax rejected the quota request');
    const windows: LimitWindow[] = [];
    const models = array(data.model_remains);
    for (const raw of models) {
        const model = object(raw);
        const label = models.length > 1 ? `${String(model.model_name ?? 'quota')} ` : '';
        for (const [kind, fallback, start, end] of [['interval', 'rolling', 'start_time', 'end_time'],
            ['weekly', 'weekly', 'weekly_start_time', 'weekly_end_time']]) {
            const remaining = percent(model[`current_${kind}_remaining_percent`]);
            const from = timestamp(model[start]);
            const to = timestamp(model[end]);
            const minutes = from !== undefined && to !== undefined && to > from ? (to - from) / 60000 : undefined;
            add(windows, `${label}${windowName(minutes, fallback)}`, remaining === undefined ? undefined : 100 - remaining, to);
        }
    }
    return checked({ windows });
}

export function parseDeepseekLimits(value: unknown): AccountLimits {
    const data = object(value);
    const balances = array(data.balance_infos).flatMap((raw) => {
        const b = object(raw);
        return (b.currency === 'USD' || b.currency === 'CNY') && typeof b.total_balance === 'string' && /^\d+(?:\.\d+)?$/.test(b.total_balance)
            ? [`${b.total_balance} ${b.currency}`] : [];
    });
    return checked({ windows: [], balances });
}

const providers: Record<string, { label: string; url: string; parse: (value: unknown) => AccountLimits }> = {
    'zai-coding-plan': { label: 'GLM Coding Plan', url: 'https://api.z.ai/api/monitor/usage/quota/limit', parse: parseZaiLimits },
    'kimi-code-plan-global': { label: 'Kimi Coding Plan', url: 'https://api.kimi.com/coding/v1/usages', parse: parseKimiLimits },
    'minimax-coding-plan': { label: 'MiniMax Coding Plan', url: 'https://www.minimax.io/v1/token_plan/remains', parse: parseMinimaxLimits },
    deepseek: { label: 'DeepSeek', url: 'https://api.deepseek.com/user/balance', parse: parseDeepseekLimits },
};

export async function readCredentials(url: string, executable = 'opencode'): Promise<Credential[]> {
    try {
        const options = { timeout: 10000, killSignal: 'SIGKILL' as const, maxBuffer: 1048576 };
        const password = process.env.OPENCODE_PASSWORD ?? (await exec(executable, ['service', 'get', 'password'], options)).stdout.trim();
        const { stdout } = await exec(executable, ['auth', 'export', '--server', url], {
            ...options, env: { ...process.env, OPENCODE_PASSWORD: password },
        });
        const data: unknown = JSON.parse(stdout);
        if (!Array.isArray(data)) throw new Error();
        return data as Credential[];
    } catch {
        // exec errors can contain stdout (credentials); never forward the raw error.
        throw new Error('Could not read OpenCode credentials; check opencode auth');
    }
}

async function fetchLimits(provider: string, saved: Credential[], request: typeof fetch): Promise<AccountLimits> {
    const reader = providers[provider];
    const credential = saved.find((c) => c.integrationID === provider && c.active);
    if (!credential || credential.value?.type !== 'key' || !credential.value.key) throw new Error('No active OpenCode API-key credential');
    let response: Response;
    try {
        response = await request(reader.url, { headers: { authorization: `Bearer ${credential.value.key}` },
            redirect: 'error', signal: AbortSignal.timeout(15000) });
    } catch { throw new Error('Quota request failed or timed out'); }
    if (!response.ok) throw new Error(`Quota request returned HTTP ${response.status}`);
    let data: unknown;
    try { data = await response.json(); } catch { throw new Error('Invalid quota response'); }
    return reader.parse(data);
}

export function limitGroups(agents: Iterable<AgentConfig>): LimitGroup[] {
    const groups = new Map<string, LimitGroup>();
    for (const agent of agents) {
        if (agent.harness === 'claude') continue;
        const provider = agent.harness === 'opencode' ? agent.model.split('/')[0] : agent.harness;
        const key = `${agent.harness}:${provider}`;
        const group = groups.get(key) ?? { harness: agent.harness, provider, label: agent.harness === 'codex' ? 'Codex' :
            providers[provider]?.label ?? provider, aliases: [] };
        group.aliases.push(agent.name);
        groups.set(key, group);
    }
    return [...groups.values()];
}

function resetText(at: number, now: number): string {
    const minutes = Math.max(0, Math.ceil((at - now) / 60000));
    const duration = minutes >= 1440 ? `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h` :
        minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
    return `resets in ${duration}`;
}

export function formatLimits(group: LimitGroup, limits: AccountLimits, now = Date.now()): string {
    const lines = [`${group.label} (${group.aliases.join(' ')})${limits.plan ? ` — ${limits.plan}` : ''}`];
    for (const w of limits.windows) {
        const reset = w.resetsAt === undefined ? '' : `; ${resetText(w.resetsAt, now)}`;
        lines.push(`  ${w.name}: ${Number(w.usedPercent.toFixed(1))}% used${reset}`);
    }
    if (limits.balances?.length) lines.push(`  balance: ${limits.balances.join(', ')}`);
    return lines.join('\n');
}

export class AgentLimits {
    private pending?: Promise<string>;
    private url: string;
    private sources: LimitSources;
    constructor(opencodeUrl: string, sources: Partial<LimitSources> = {}) {
        this.url = opencodeUrl;
        this.sources = { codex: readCodexLimits, credentials: readCredentials, fetch, ...sources };
    }

    read(agents: Iterable<AgentConfig>): Promise<string> {
        if (this.pending) return this.pending;
        const groups = limitGroups(agents);
        const request = this.collect(groups);
        this.pending = request;
        void request.finally(() => { if (this.pending === request) this.pending = undefined; }).catch(() => {});
        return request;
    }

    private async collect(groups: LimitGroup[]): Promise<string> {
        const needCredentials = groups.some((g) => g.harness === 'opencode' && providers[g.provider]);
        const saved = needCredentials ? this.sources.credentials(this.url).then((value) => ({ value }), (error: Error) => ({ error })) : Promise.resolve({ value: [] });
        const replies = await Promise.all(groups.map(async (group) => {
            try {
                let limits: AccountLimits;
                if (group.harness === 'codex') limits = parseCodexLimits(await this.sources.codex());
                else if (group.harness === 'opencode' && providers[group.provider]) {
                    const result = await saved;
                    if ('error' in result) throw result.error;
                    limits = await fetchLimits(group.provider, result.value, this.sources.fetch);
                } else throw new Error('Quota querying is not supported for this provider');
                return formatLimits(group, limits);
            } catch (error) {
                return `${group.label} (${group.aliases.join(' ')})\n  unavailable: ${(error as Error).message}`;
            }
        }));
        return replies.length ? replies.join('\n\n') : 'No usage data available for configured agents';
    }
}
