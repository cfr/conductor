import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parse } from 'smol-toml';

export type Harness = 'opencode' | 'claude' | 'codex';
export type Role = 'implement' | 'feedback' | 'review' | 'plan';
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
    // other names it answers to, kept out of the command menu
    aliases: string[];
}

export const builtinCommands = [
    'help', 'start', 'next', 'review', 'fix', 'feedback', 'continue', 'gate', 'todo', 'plan', 'chat', 'summary', 'agents',
    'status', 'stop', 'skip', 'log', 'roles', 'agent',
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
    feedback: string;
    feedbackAgain: string;
    feedbackFix: string;
    continue: string;
    gateFailed: string;
    plan: string;
    planDone: string;
    planReadOnly: string;
    planMoved: string;
    chat: string;
    summary: string;
}

export interface ProjectConfig {
    root: string;
    logDir: string;
    gate: GateStep[];
    roles: Record<Exclude<Role, 'feedback'> | 'chat' | 'summary', string> & { feedback: string[] };
    // checks before the review, round n by roles.feedback[n - 1] (the last one repeats); 0 skips them
    feedbackRounds: number;
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
    feedback:
        'Check the work on {id}: the commits after {base} in this tree, made by another agent. Report ' +
        'only: do not edit files or commit. Go through:\n' +
        '- each requirement and validation step of {id} in PLAN.md (or its CHANGELOG.md entry if it ' +
        'moved there): done or not, with evidence from the diff or a command you ran\n' +
        "- comments in or next to the changed code that are out of date or break the project's rules\n" +
        '- claims in the commit messages or CHANGELOG.md that nothing in the diff, tests or logs backs up\n' +
        '- formatting of the touched files, and the tests covering them\n' +
        '- bugs you can show with a concrete input or a failing test\n\n' +
        'Give each finding a file:line and the change it needs. Skip style preferences and guesses. ' +
        'End with a line `VERDICT: clean` when nothing needs fixing, otherwise `VERDICT: findings`.',
    feedbackAgain:
        'The implementer answered your findings: its reply is below and its new commits are in the ' +
        'tree. Check the fixes and whether anything you raised is still open; drop findings it ' +
        'rejected for a sound reason. Same rules, same VERDICT line.\n\n{reply}',
    feedbackFix:
        'Another agent checked your work on {id} and reported the findings below. Fix the ones that ' +
        'hold in a new commit (do not amend); for each one you reject, say why in a line.\n\n{findings}',
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
    planReadOnly:
        'A task is running in this tree right now ({running}), so this turn is read-only: draft the ' +
        'items in your reply instead of editing PLAN.md. They get written once the task is idle and ' +
        'I ask for it.',
    planMoved:
        'Commits landed since your last turn:\n{commits}\nRe-read PLAN.md (a finished task moves its ' +
        'item to CHANGELOG.md) and check these changes against what we planned; point out any ' +
        'adjustments the items need.',
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

// one name or a non-empty list of them
function strList(t: Table, key: string, what: string): string[] {
    const v = t[key];
    if (typeof v === 'string') {
        return [str(t, key, what)];
    }
    if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string' || x === '')) {
        throw new Error(`${what}.${key} must be a name or a non-empty list of names`);
    }
    return v as string[];
}

export function loadLocalConfig(file: string): LocalConfig {
    const t = parse(readFileSync(file, 'utf8')) as Table;
    const base = dirname(file);
    const tg = table(t.telegram, 'telegram');
    const token = str(tg, 'token', 'telegram');
    const user = tg.allowed_user_id;
    if (typeof user !== 'number' || !Number.isSafeInteger(user) || user <= 0) {
        throw new Error(`${file}: telegram.allowed_user_id must be your numeric Telegram user id`);
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

export function parseProjectConfig(root: string, toml: string): ProjectConfig {
    const t = parse(toml) as Table;

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
        if (harness !== 'opencode' && harness !== 'claude' && harness !== 'codex') {
            throw new Error(`agents.${name}.harness must be "opencode", "claude" or "codex"`);
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
        if (effort !== undefined && (!['claude', 'codex'].includes(harness) || !(harness === 'codex' ? ['minimal', 'low', 'medium', 'high', 'xhigh'] : efforts).includes(effort))) {
            throw new Error(`agents.${name}.effort is invalid for this harness; claude supports: ${efforts.join(', ')}`);
        }
        const variant = a.variant === undefined ? undefined : str(a, 'variant', `agents.${name}`);
        if (variant !== undefined && harness !== 'opencode') {
            throw new Error(`agents.${name}.variant is for opencode agents (claude and codex agents use effort)`);
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
    const roles = {} as ProjectConfig['roles'];
    for (const role of ['implement', 'review', 'plan'] as const) {
        roles[role] = str(r, role, 'roles');
        if (!agents.has(roles[role])) {
            throw new Error(`roles.${role} names unknown agent "${roles[role]}"`);
        }
    }
    roles.chat = r.chat === undefined ? roles.plan : str(r, 'chat', 'roles');
    roles.summary = r.summary === undefined ? roles.chat : str(r, 'summary', 'roles');
    roles.feedback = r.feedback === undefined ? [] : strList(r, 'feedback', 'roles');
    for (const role of ['chat', 'summary'] as const) {
        if (!agents.has(roles[role])) {
            throw new Error(`roles.${role} names unknown agent "${roles[role]}"`);
        }
    }
    for (const name of roles.feedback) {
        if (!agents.has(name)) {
            throw new Error(`roles.feedback names unknown agent "${name}"`);
        }
    }

    const p = table(t.prompts, 'prompts');
    const prompts: Prompts = {
        implement: str(p, 'implement', 'prompts', defaultPrompts.implement),
        review: str(p, 'review', 'prompts', defaultPrompts.review),
        fix: str(p, 'fix', 'prompts', defaultPrompts.fix),
        fixNotes: str(p, 'fix_notes', 'prompts', defaultPrompts.fixNotes),
        feedback: str(p, 'feedback', 'prompts', defaultPrompts.feedback),
        feedbackAgain: str(p, 'feedback_again', 'prompts', defaultPrompts.feedbackAgain),
        feedbackFix: str(p, 'feedback_fix', 'prompts', defaultPrompts.feedbackFix),
        continue: str(p, 'continue', 'prompts', defaultPrompts.continue),
        gateFailed: str(p, 'gate_failed', 'prompts', defaultPrompts.gateFailed),
        plan: str(p, 'plan', 'prompts', defaultPrompts.plan),
        planDone: str(p, 'plan_done', 'prompts', defaultPrompts.planDone),
        planReadOnly: str(p, 'plan_read_only', 'prompts', defaultPrompts.planReadOnly),
        planMoved: str(p, 'plan_moved', 'prompts', defaultPrompts.planMoved),
        chat: str(p, 'chat', 'prompts', defaultPrompts.chat),
        summary: str(p, 'summary', 'prompts', defaultPrompts.summary),
    };

    const commands: ProjectCommand[] = [];
    const taken = new Set<string>();
    const claim = (name: string, what: string) => {
        if (!/^[a-z][a-z0-9_]*$/.test(name) || builtinCommands.includes(name)) {
            throw new Error(`${what}: the name must be lowercase a-z, 0-9, _ and not a built-in command`);
        }
        if (taken.has(name)) {
            throw new Error(`${what}: /${name} is already taken by another command`);
        }
        taken.add(name);
    };
    for (const name of Object.keys(table(t.commands, 'commands'))) {
        claim(name, `commands.${name}`);
    }
    for (const [name, raw] of Object.entries(table(t.commands, 'commands'))) {
        const what = `commands.${name}`;
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
        const aliases = c.aliases === undefined ? [] : strList(c, 'aliases', what);
        for (const alias of aliases) {
            claim(alias, `${what}.aliases`);
        }
        commands.push({
            name,
            cmd: str(c, 'cmd', what),
            description: str(c, 'description', what, name),
            confirm: flag('confirm', false),
            background,
            ready,
            aliases,
        });
    }

    const logDir = resolve(root, str(table(t.logs, 'logs'), 'dir', 'logs', 'wlog'));
    const flow = table(t.flow, 'flow');
    let feedbackRounds = roles.feedback.length;
    if (flow.feedback_rounds !== undefined) {
        const n = flow.feedback_rounds;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
            throw new Error('flow.feedback_rounds must be a whole number, 0 or more');
        }
        if (n > 0 && roles.feedback.length === 0) {
            throw new Error('flow.feedback_rounds needs roles.feedback');
        }
        feedbackRounds = n;
    }

    return { root, logDir, gate, roles, feedbackRounds, agents, prompts, commands };
}

export function loadProjectConfig(root: string): ProjectConfig {
    return parseProjectConfig(root, readFileSync(resolve(root, 'CONDUCTOR.toml'), 'utf8'));
}

export function fill(template: string, vars: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}
