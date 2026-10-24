import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parse } from 'smol-toml';

export type Harness = 'opencode' | 'claude';
export type Role = 'implement' | 'review' | 'plan';
export type SessionRole = Role | 'chat';

export interface AgentConfig {
    name: string;
    harness: Harness;
    model: string;
    tag: string;
    effort?: string;
    variant?: string;
    permissionMode?: string;
}

const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const permissionModes = ['auto', 'default', 'acceptEdits', 'dontAsk', 'plan'];

export interface ProjectCommand {
    name: string;
    cmd: string;
    description: string;
    confirm: boolean;
    background: boolean;
    ready?: RegExp;
}

export const builtinCommands = [
    'help', 'start', 'next', 'review', 'fix', 'continue', 'gate', 'todo', 'plan', 'chat', 'summary', 'agents', 'status',
    'stop', 'log',
];

export interface GateStep {
    name: string;
    cmd: string;
}

export interface Prompts {
    implement: string;
    review: string;
    fix: string;
    fixNotes: string;
    continue: string;
    gateFailed: string;
    plan: string;
    planDone: string;
    chat: string;
    summary: string;
}

export interface ProjectConfig {
    root: string;
    logDir: string;
    gate: GateStep[];
    roles: Record<Role | 'chat' | 'summary', string>;
    agents: Map<string, AgentConfig>;
    prompts: Prompts;
    commands: ProjectCommand[];
}

export interface LocalConfig {
    file: string;
    project: string;
    stateFile: string;
    telegram: { token: string; allowedUserId: number };
    opencodeUrl: string;
}

const defaultPrompts: Prompts = {
    implement: 'please do {id}',
    review: 'please review {id}',
    fix: 'please fix all issues, commit',
    fixNotes: 'please fix {notes}; then commit',
    continue:
        'Your last turn stopped before it finished (an error, an interruption or a restart). Check where ' +
        'the work stands and carry on from there.',
    gateFailed:
        'The verification gate failed after your last turn (step `{step}`). Fix it and commit. ' +
        'Output tail:\n\n```\n{output}\n```',
    plan:
        'Planning discussion{topic}. You may read the repository, but edit only PLAN.md: no code ' +
        'changes and no commits. Discuss with me first; I will say when to write the items down.',
    planDone:
        'Please write the agreed items into PLAN.md now and commit only PLAN.md, following the ' +
        "project's commit message rules.",
    chat:
        'This is a read-only chat about the project. Another agent may be working in this tree right ' +
        'now, so uncommitted changes may be theirs. Do not edit files or run anything that changes ' +
        'state.\n\n{message}',
    summary:
        'Read {log}: the log of the {role} session for {task}, which is {state}. It can be long, ' +
        'so start from the end and read back only as far as you need. Then tell me in a few short ' +
        'bullets: the goal, what is done, what it is doing right now, and any problems or open ' +
        'questions. Change nothing.',
};

export function expandHome(p: string): string {
    return p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p;
}

type Table = Record<string, unknown>;

function table(v: unknown, what: string): Table {
    if (v === undefined) {
        return {};
    }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        throw new Error(`${what} must be a table`);
    }
    return v as Table;
}

function str(t: Table, key: string, what: string, fallback?: string): string {
    const v = t[key];
    if (v === undefined && fallback !== undefined) {
        return fallback;
    }
    if (typeof v !== 'string' || v === '') {
        throw new Error(`${what}.${key} must be a non-empty string`);
    }
    return v;
}

export function parseEnvFile(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m || line.startsWith('#')) {
            continue;
        }
        let value = m[2];
        if (/^(['"]).*\1$/.test(value)) {
            value = value.slice(1, -1);
        } else {
            value = value.replace(/\s+#.*$/, '');
        }
        out[m[1]] = value;
    }
    return out;
}

export function loadLocalConfig(file: string): LocalConfig {
    const t = parse(readFileSync(file, 'utf8')) as Table;
    const base = dirname(file);
    const tg = table(t.telegram, 'telegram');
    const envFile = expandHome(str(tg, 'env', 'telegram'));
    const env = parseEnvFile(readFileSync(envFile, 'utf8'));
    const token = env.TELEGRAM_BOT_TOKEN;
    const user = Number(env.TELEGRAM_ALLOWED_USER_ID);
    if (!token || !Number.isSafeInteger(user) || user <= 0) {
        throw new Error(`${envFile} must define TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID`);
    }
    const oc = table(t.opencode, 'opencode');
    return {
        file,
        project: resolve(base, expandHome(str(t, 'project', 'config'))),
        stateFile: resolve(base, expandHome(str(t, 'state', 'config', 'state/state.json'))),
        telegram: { token, allowedUserId: user },
        opencodeUrl: str(oc, 'url', 'opencode', 'http://127.0.0.1:49374'),
    };
}

export function extractTomlBlock(markdown: string): string {
    const blocks = [...markdown.matchAll(/^(`{3,})toml[^\n]*\n([\s\S]*?)^\1\s*$/gm)];
    if (blocks.length !== 1) {
        throw new Error(`CONDUCTOR.md must contain exactly one \`\`\`toml block, found ${blocks.length}`);
    }
    return blocks[0][2];
}

export function parseProjectConfig(root: string, markdown: string): ProjectConfig {
    const t = parse(extractTomlBlock(markdown)) as Table;

    const gate = Object.entries(table(t.gate, 'gate')).map(([name, cmd]) => {
        if (typeof cmd !== 'string' || cmd === '') {
            throw new Error(`gate.${name} must be a command string`);
        }
        return { name, cmd };
    });
    if (gate.length === 0) {
        throw new Error('[gate] needs at least one command');
    }

    const agents = new Map<string, AgentConfig>();
    const tags = new Set<string>();
    for (const [name, raw] of Object.entries(table(t.agents, 'agents'))) {
        const a = table(raw, `agents.${name}`);
        const harness = str(a, 'harness', `agents.${name}`);
        if (harness !== 'opencode' && harness !== 'claude') {
            throw new Error(`agents.${name}.harness must be "opencode" or "claude"`);
        }
        const model = str(a, 'model', `agents.${name}`);
        if (harness === 'opencode' && !model.includes('/')) {
            throw new Error(`agents.${name}.model must be provider/model for opencode`);
        }
        const tag = str(a, 'tag', `agents.${name}`);
        if (!/^[a-z0-9.]+$/.test(tag)) {
            throw new Error(`agents.${name}.tag may only use a-z, 0-9 and dots`);
        }
        if (tags.has(tag)) {
            throw new Error(`duplicate agent tag "${tag}"`);
        }
        tags.add(tag);
        const effort = a.effort === undefined ? undefined : str(a, 'effort', `agents.${name}`);
        if (effort !== undefined && (harness !== 'claude' || !efforts.includes(effort))) {
            throw new Error(`agents.${name}.effort is for claude agents: ${efforts.join(', ')}`);
        }
        const variant = a.variant === undefined ? undefined : str(a, 'variant', `agents.${name}`);
        if (variant !== undefined && harness !== 'opencode') {
            throw new Error(`agents.${name}.variant is for opencode agents (claude agents use effort)`);
        }
        const mode = a.permission_mode === undefined ? undefined : str(a, 'permission_mode', `agents.${name}`);
        if (mode !== undefined && (harness !== 'claude' || !permissionModes.includes(mode))) {
            throw new Error(`agents.${name}.permission_mode is for claude agents: ${permissionModes.join(', ')}`);
        }
        agents.set(name, { name, harness, model, tag, effort, variant, permissionMode: mode });
    }
    if (agents.size === 0) {
        throw new Error('no [agents.*] defined');
    }

    const r = table(t.roles, 'roles');
    const roles = {} as Record<Role | 'chat' | 'summary', string>;
    for (const role of ['implement', 'review', 'plan'] as const) {
        roles[role] = str(r, role, 'roles');
        if (!agents.has(roles[role])) {
            throw new Error(`roles.${role} names unknown agent "${roles[role]}"`);
        }
    }
    roles.chat = r.chat === undefined ? roles.plan : str(r, 'chat', 'roles');
    roles.summary = r.summary === undefined ? roles.chat : str(r, 'summary', 'roles');
    for (const role of ['chat', 'summary'] as const) {
        if (!agents.has(roles[role])) {
            throw new Error(`roles.${role} names unknown agent "${roles[role]}"`);
        }
    }

    const p = table(t.prompts, 'prompts');
    const prompts: Prompts = {
        implement: str(p, 'implement', 'prompts', defaultPrompts.implement),
        review: str(p, 'review', 'prompts', defaultPrompts.review),
        fix: str(p, 'fix', 'prompts', defaultPrompts.fix),
        fixNotes: str(p, 'fix_notes', 'prompts', defaultPrompts.fixNotes),
        continue: str(p, 'continue', 'prompts', defaultPrompts.continue),
        gateFailed: str(p, 'gate_failed', 'prompts', defaultPrompts.gateFailed),
        plan: str(p, 'plan', 'prompts', defaultPrompts.plan),
        planDone: str(p, 'plan_done', 'prompts', defaultPrompts.planDone),
        chat: str(p, 'chat', 'prompts', defaultPrompts.chat),
        summary: str(p, 'summary', 'prompts', defaultPrompts.summary),
    };

    const commands: ProjectCommand[] = [];
    for (const [name, raw] of Object.entries(table(t.commands, 'commands'))) {
        const what = `commands.${name}`;
        if (!/^[a-z][a-z0-9_]*$/.test(name) || builtinCommands.includes(name)) {
            throw new Error(`${what}: the name must be lowercase a-z, 0-9, _ and not a built-in command`);
        }
        const c = table(raw, what);
        const flag = (key: string, fallback: boolean) => {
            if (c[key] !== undefined && typeof c[key] !== 'boolean') {
                throw new Error(`${what}.${key} must be true or false`);
            }
            return (c[key] as boolean | undefined) ?? fallback;
        };
        let ready: RegExp | undefined;
        if (c.ready !== undefined) {
            try {
                ready = new RegExp(str(c, 'ready', what), 'm');
            } catch (e) {
                throw new Error(`${what}.ready: ${(e as Error).message}`);
            }
        }
        const background = flag('background', false);
        if (ready && !background) {
            throw new Error(`${what}.ready only applies to background commands`);
        }
        commands.push({
            name,
            cmd: str(c, 'cmd', what),
            description: str(c, 'description', what, name),
            confirm: flag('confirm', false),
            background,
            ready,
        });
    }

    const logDir = resolve(root, str(table(t.logs, 'logs'), 'dir', 'logs', 'wlog'));
    return { root, logDir, gate, roles, agents, prompts, commands };
}

export function loadProjectConfig(root: string): ProjectConfig {
    return parseProjectConfig(root, readFileSync(resolve(root, 'CONDUCTOR.md'), 'utf8'));
}

export function fill(template: string, vars: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}
