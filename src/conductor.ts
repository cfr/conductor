import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeAdapter } from './agents/claude.ts';
import { OpencodeAdapter } from './agents/opencode.ts';
import type { Adapter, AgentSession, Asker, Question } from './agents/types.ts';
import {
    fill,
    loadProjectConfig,
    type AgentConfig,
    type LocalConfig,
    type ProjectConfig,
    type Role,
} from './config.ts';
import { renderMarkdown } from './logs/markdown.ts';
import { idNumber, parseNext, type PlanItem } from './plan.ts';
import { git, tail } from './proc.ts';
import * as repo from './repo.ts';
import type { SessionRef, Store } from './state.ts';
import type { Messenger } from './telegram.ts';

type Busy = Role | 'gate' | null;

const help = `/next-task [agent] [id] - start the next PLAN item (or a given one)
/review [agent] - start a review of the current task
/fix [notes] - reviewer applies fixes and commits
/plan [agent] [topic] - planning discussion (edits PLAN.md only)
/plan done - write the agreed items, then commit / keep / discard
/agents - configured agents and role defaults
/status - current task, step, sessions, last gate
/stop - interrupt the running agent
/log - export session logs now
Plain text goes to the current session; reply to an agent message to reach that session.`;

function slug(text: string): string {
    return (
        text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 40) || 'topic'
    );
}

export class Conductor {
    private project: ProjectConfig;
    private adapters: Record<AgentConfig['harness'], Adapter>;
    private live = new Map<Role, AgentSession>();
    private busy: Busy = null;
    private local: LocalConfig;
    private store: Store;
    private chat: Messenger;

    constructor(local: LocalConfig, store: Store, chat: Messenger) {
        this.local = local;
        this.store = store;
        this.chat = chat;
        this.project = loadProjectConfig(local.project);
        this.adapters = { opencode: new OpencodeAdapter(local.opencodeUrl), claude: new ClaudeAdapter() };
        chat.command('help', async () => chat.send(help));
        chat.command('start', async () => chat.send(help));
        chat.command('next-task', (a) => this.nextTask(a));
        chat.command('nexttask', (a) => this.nextTask(a));
        chat.command('review', (a) => this.review(a));
        chat.command('fix', (a) => this.fix(a));
        chat.command('plan', (a) => this.plan(a));
        chat.command('agents', async () => chat.send(this.agentList()));
        chat.command('status', async () => chat.send(this.status()));
        chat.command('stop', () => this.stop());
        chat.command('log', () => this.exportAll());
        chat.onText = (text, route) => this.text(text, route as Role | undefined);
    }

    private get state() {
        return this.store.state;
    }

    private reload() {
        this.project = loadProjectConfig(this.local.project);
    }

    private agent(name: string): AgentConfig {
        const a = this.project.agents.get(name);
        if (!a) {
            throw new Error(`unknown agent "${name}"; see /agents`);
        }
        return a;
    }

    private prefix(role: Role): string {
        const ref = this.state.sessions[role];
        const tag = ref ? this.agent(ref.agent).tag : '?';
        const num = role === 'plan' ? 'plan' : (this.state.task?.number ?? '');
        return `[${tag} ${num}]`.replace(' ]', ']');
    }

    private asker(role: Role): Asker {
        return {
            permission: async (title, detail) => {
                const a = await this.chat.ask(
                    `${this.prefix(role)} ${title}\n\n${detail}`,
                    ['allow once', 'allow always', 'deny'],
                    false,
                );
                return a === 'allow once' ? 'once' : a === 'allow always' ? 'always' : 'reject';
            },
            question: async (q: Question) => {
                const lines = [`${this.prefix(role)} ${q.title}`];
                if (q.detail) {
                    lines.push('', q.detail);
                }
                q.choices.forEach((c, i) => {
                    if (c.description) {
                        lines.push(`${i === 0 ? '\n' : ''}${c.label}: ${c.description}`);
                    }
                });
                return this.chat.ask(lines.join('\n'), q.choices.map((c) => c.label), q.allowText);
            },
        };
    }

    private session(role: Role): AgentSession {
        let s = this.live.get(role);
        if (s) {
            return s;
        }
        const ref = this.state.sessions[role];
        if (!ref) {
            throw new Error(`no ${role} session`);
        }
        const agent = this.agent(ref.agent);
        s = this.adapters[agent.harness].resume(agent, ref.id, {
            title: ref.title,
            cwd: this.project.root,
            asker: this.asker(role),
        });
        this.live.set(role, s);
        return s;
    }

    private async createSession(role: Role, agentName: string, title: string) {
        const agent = this.agent(agentName);
        const s = await this.adapters[agent.harness].create(agent, {
            title,
            cwd: this.project.root,
            asker: this.asker(role),
        });
        this.live.set(role, s);
        this.state.sessions[role] = {
            agent: agentName,
            id: s.id,
            title,
            startSha: await repo.head(this.project.root),
        };
        this.store.save();
    }

    private claim(what: Busy) {
        if (this.busy) {
            throw new Error(`busy: ${this.busy} is running (/status, /stop)`);
        }
        this.busy = what;
    }

    private parseArgs(args: string): { agent?: string; id?: string; rest: string } {
        const words = args.split(/\s+/).filter(Boolean);
        let agent: string | undefined;
        let id: string | undefined;
        while (words.length) {
            if (!id && /^\d{4}/.test(words[0])) {
                id = words.shift();
            } else if (!agent && this.project.agents.has(words[0])) {
                agent = words.shift();
            } else {
                break;
            }
        }
        return { agent, id, rest: words.join(' ') };
    }

    private async nextTask(args: string) {
        this.reload();
        const { agent: agentArg, id } = this.parseArgs(args);
        const agentName = agentArg ?? this.project.roles.implement;
        const agent = this.agent(agentName);
        const items = parseNext(readFileSync(join(this.project.root, 'PLAN.md'), 'utf8'));
        let item: PlanItem | undefined;
        if (id) {
            item = items.find((i) => i.id === id || i.number === idNumber(id));
            if (!item && /^\d{4}-[a-z0-9-]+$/.test(id)) {
                item = { id, number: idNumber(id), text: `(not in PLAN.md "Next")` };
            }
        } else {
            item = items[0];
        }
        if (!item) {
            await this.chat.send(id ? `no PLAN item ${id}` : 'PLAN.md "Next" is empty');
            return;
        }
        this.claim('implement');
        try {
            const go = await this.chat.ask(
                `Start ${item.id} with ${agent.tag} (${agent.model})?\n\n${item.text}`,
                ['start', 'cancel'],
                false,
            );
            if (go !== 'start') {
                return;
            }
            this.live.clear();
            this.state.task = item;
            this.state.sessions = {};
            this.state.focus = 'implement';
            this.state.lastGate = undefined;
            await this.createSession('implement', agentName, item.id);
        } finally {
            this.busy = null;
        }
        await this.turn('implement', fill(this.project.prompts.implement, this.vars()));
    }

    private vars(extra: Record<string, string> = {}): Record<string, string> {
        return { id: this.state.task?.id ?? '', num: this.state.task?.number ?? '', ...extra };
    }

    private async review(args: string) {
        this.reload();
        const task = this.state.task;
        if (!task) {
            await this.chat.send('no current task; /next-task first');
            return;
        }
        const { agent } = this.parseArgs(args);
        await this.startReview(agent ?? this.project.roles.review);
    }

    private async startReview(agentName: string) {
        const task = this.state.task!;
        this.claim('review');
        try {
            this.live.delete('review');
            await this.createSession('review', agentName, `${task.id} review`);
            this.state.focus = 'review';
            this.store.save();
        } finally {
            this.busy = null;
        }
        await this.turn('review', fill(this.project.prompts.review, this.vars()));
    }

    private async fix(notes: string) {
        if (!this.state.sessions.review) {
            await this.chat.send('no review session; /review first');
            return;
        }
        const p = this.project.prompts;
        const text = notes ? fill(p.fixNotes, this.vars({ notes })) : fill(p.fix, this.vars());
        this.state.focus = 'review';
        await this.turn('review', text);
    }

    private async plan(args: string) {
        this.reload();
        if (args.trim() === 'done') {
            await this.planDone();
            return;
        }
        const { agent, rest } = this.parseArgs(args);
        const topic = rest || 'next';
        this.claim('plan');
        try {
            this.live.delete('plan');
            const date = new Date().toISOString().slice(0, 10);
            await this.createSession('plan', agent ?? this.project.roles.plan, `plan-${date}-${slug(topic)}`);
            this.state.planTopic = topic;
            this.state.focus = 'plan';
            this.store.save();
        } finally {
            this.busy = null;
        }
        const t = rest ? `: ${rest}` : '';
        await this.turn('plan', fill(this.project.prompts.plan, this.vars({ topic: t })));
    }

    private async planDone() {
        if (!this.state.sessions.plan) {
            await this.chat.send('no planning session; /plan first');
            return;
        }
        await this.turn('plan', this.project.prompts.planDone);
        const root = this.project.root;
        const d = await repo.fileDiff(root, 'PLAN.md');
        if (!d.trim()) {
            await this.chat.send('PLAN.md is unchanged');
            return;
        }
        await this.chat.sendFile('PLAN.diff', d, 'PLAN.md changes');
        const topic = this.state.planTopic ?? 'next';
        const num = this.state.task?.number;
        const message = `Plan ${topic}${num ? ` #${num}` : ''}`;
        const a = await this.chat.ask(`PLAN.md: commit as "${message}"?`, ['commit', 'keep uncommitted', 'discard'], false);
        if (a === 'commit') {
            await git(root, 'commit', '-m', message, '--', 'PLAN.md');
            await this.chat.send(`committed ${(await repo.head(root)).slice(0, 7)}`);
        } else if (a === 'discard') {
            await git(root, 'checkout', '--', 'PLAN.md');
            await this.chat.send('PLAN.md changes discarded');
        }
    }

    private async text(text: string, route: Role | undefined) {
        const role = route ?? this.state.focus;
        if (!role || !this.state.sessions[role]) {
            await this.chat.send('no session to talk to; /next-task, /review or /plan');
            return;
        }
        await this.turn(role, text);
    }

    private async turn(role: Role, text: string, gateAttempt = 0) {
        this.claim(role);
        let committed = false;
        let before = '';
        try {
            const s = this.session(role);
            before = await repo.head(this.project.root);
            const r = await s.send(text);
            await this.exportLog(role).catch((e: Error) => this.chat.send(`log export failed: ${e.message}`));
            const p = this.prefix(role);
            if (r.text) {
                await this.chat.send(`${p} ${r.text}`, role);
            }
            if (r.outcome !== 'succeeded') {
                await this.chat.send(`${p} turn ${r.outcome}${r.error ? `: ${r.error}` : ''}`, role);
                return;
            }
            committed = (await repo.commitsSince(this.project.root, before)).length > 0;
            if (role === 'plan') {
                await this.checkPlanOnly();
            }
        } finally {
            this.busy = null;
        }
        if (committed && role !== 'plan') {
            await this.gate(role, before, gateAttempt);
        }
    }

    private async checkPlanOnly() {
        const st = await repo.status(this.project.root);
        const others = st
            .split('\n')
            .filter(Boolean)
            .filter((l) => !l.endsWith(' PLAN.md'));
        if (others.length) {
            await this.chat.send(`warning: the planning session touched more than PLAN.md:\n${others.join('\n')}`);
        }
    }

    private async gate(role: Role, before: string, attempt: number) {
        const root = this.project.root;
        this.claim('gate');
        let g: repo.GateResult;
        try {
            await this.chat.send(`gate: running ${this.project.gate.map((s) => s.name).join(' + ')}…`);
            g = await repo.runGate(root, this.project.gate);
        } finally {
            this.busy = null;
        }
        const sha = await repo.head(root);
        this.state.lastGate = { ok: g.ok, step: g.failedStep, sha, at: new Date().toISOString() };
        this.store.save();
        const task = this.state.task;
        if (!g.ok) {
            await this.chat.sendFile('gate.log', g.log, `gate failed at ${g.failedStep} (${g.seconds.toFixed(0)} s)`);
            if (attempt === 0) {
                await this.chat.send(`${this.prefix(role)} handing the failure back once`);
                const text = fill(this.project.prompts.gateFailed, this.vars({ step: g.failedStep ?? '', output: tail(g.log, 60) }));
                await this.turn(role, text, 1);
            } else {
                await this.chat.send('gate failed twice; waiting for you (plain text to the agent, or fix it yourself and /review)');
            }
            return;
        }
        const from = this.state.sessions[role]?.startSha ?? before;
        const messages = await repo.commitMessages(root, from);
        const stat = await repo.diffStat(root, from);
        const dirty = await repo.status(root);
        await this.chat.send(
            [
                `gate passed (${g.seconds.toFixed(0)} s) at ${sha.slice(0, 7)}`,
                '',
                messages,
                '',
                stat,
                ...(dirty ? ['', `uncommitted:\n${dirty}`] : []),
            ].join('\n'),
        );
        await this.chat.sendFile(`${task?.id ?? 'task'}-${role}.diff`, await repo.diff(root, from));
        if (role === 'implement') {
            await this.startReview(this.project.roles.review);
        } else if (role === 'review') {
            await this.chat.send(`${task?.id ?? 'task'} done; /next-task when ready`);
        }
    }

    private logName(role: Role, ref: SessionRef, planTouched: boolean): string {
        const tag = this.agent(ref.agent).tag;
        if (role === 'plan') {
            return `${ref.title}-${tag}.md`;
        }
        const id = this.state.task?.id ?? ref.title;
        if (role === 'implement') {
            return `${id}-${tag}.md`;
        }
        return `${id}-review${planTouched ? '-plan' : ''}-${tag}.md`;
    }

    private async exportLog(role: Role) {
        const ref = this.state.sessions[role];
        if (!ref) {
            return;
        }
        const t = await this.session(role).transcript();
        if (!t) {
            return;
        }
        let planTouched = false;
        if (role === 'review') {
            planTouched = (await repo.changedSince(this.project.root, ref.startSha)).includes('PLAN.md');
        }
        const dir = this.project.logDir;
        mkdirSync(dir, { recursive: true });
        const file = join(dir, this.logName(role, ref, planTouched));
        if (ref.logFile && ref.logFile !== file && existsSync(ref.logFile)) {
            renameSync(ref.logFile, file);
        }
        writeFileSync(file, renderMarkdown(t));
        if (ref.logFile !== file) {
            ref.logFile = file;
            this.store.save();
        }
    }

    private async exportAll() {
        const done: string[] = [];
        for (const role of Object.keys(this.state.sessions) as Role[]) {
            await this.exportLog(role);
            const f = this.state.sessions[role]?.logFile;
            if (f) {
                done.push(f);
            }
        }
        await this.chat.send(done.length ? `exported:\n${done.join('\n')}` : 'no sessions');
    }

    private async stop() {
        const role = this.busy;
        if (!role || role === 'gate') {
            await this.chat.send(role === 'gate' ? 'the gate is running; it cannot be stopped yet' : 'nothing is running');
            return;
        }
        await this.session(role).interrupt();
        await this.chat.send(`interrupt sent to ${this.prefix(role)}`);
    }

    private agentList(): string {
        const lines = [...this.project.agents.values()].map(
            (a) => `${a.name}: ${a.tag} (${a.harness} ${a.model}${a.effort ? `, effort ${a.effort}` : ''})`,
        );
        const r = this.project.roles;
        lines.push('', `roles: implement=${r.implement} review=${r.review} plan=${r.plan}`);
        return lines.join('\n');
    }

    private status(): string {
        const s = this.state;
        const lines = [
            `project: ${this.project.root}`,
            `task: ${s.task?.id ?? '-'}`,
            `running: ${this.busy ?? 'nothing'}${this.chat.pendingQuestions() ? ` (${this.chat.pendingQuestions()} question(s) waiting)` : ''}`,
            `focus: ${s.focus ?? '-'}`,
        ];
        for (const [role, ref] of Object.entries(s.sessions)) {
            lines.push(`${role}: ${this.agent(ref.agent).tag} ${ref.id}${ref.logFile ? `\n  log ${ref.logFile}` : ''}`);
        }
        if (s.lastGate) {
            const g = s.lastGate;
            lines.push(`last gate: ${g.ok ? 'passed' : `failed at ${g.step}`} at ${g.sha.slice(0, 7)} (${g.at})`);
        }
        return lines.join('\n');
    }

    async announce() {
        const s = this.state;
        await this.chat.send(`conductor up: ${this.project.root}${s.task ? `, task ${s.task.id}` : ''}. /help`);
    }
}
