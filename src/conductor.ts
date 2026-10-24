import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ClaudeAdapter } from './agents/claude.ts';
import { OpencodeAdapter } from './agents/opencode.ts';
import type { Adapter, AgentSession, Asker, Question, TurnResult, TurnState, UnsolicitedEvent } from './agents/types.ts';
import {
    fill,
    loadProjectConfig,
    type AgentConfig,
    type LocalConfig,
    type ProjectCommand,
    type ProjectConfig,
    type Role,
    type SessionRole,
} from './config.ts';
import { escapeHtml } from './format.ts';
import { Jobs, logTail, readLog } from './jobs.ts';
import { renderMarkdown } from './logs/markdown.ts';
import { emptyNextMessage, idNumber, nextReport, parseNext, summary, type PlanItem } from './plan.ts';
import { git, tail } from './proc.ts';
import * as repo from './repo.ts';
import type { SessionRef, State, Store } from './state.ts';
import { describeError, type Messenger } from './telegram.ts';

type Busy = Role | 'gate' | `/${string}` | null;

const roles: readonly string[] = ['implement', 'feedback', 'review', 'plan'];

const help = `/next [agent] [id] - start the next PLAN item (or a given one)
/review [agent] [id] - review the current task (or a task done outside the conductor)
/fix [notes] - reviewer applies fixes and commits
/feedback [agent] - run a feedback check of the current task now (one more round)
/continue [role] [notes] - resume a turn that stopped early (error, /stop, restart)
/gate - run the gate on the current session's commits now, then continue as after a turn
/todo [id] - list PLAN.md "Next" items (or show one in full)
/plan [agent] [topic] - planning discussion (edits PLAN.md only)
/chat [new] [agent] <message> - read-only chat about the project, alongside running work
/chat stop - close the chat session (its log stays)
/summary [role] [agent] - an agent reads the running (or focused) session's log and sums it up
/plan done - write the agreed items, then commit / keep / discard
/agents - configured agents and role defaults
/status - current task, step, sessions, last gate
/stop [chat] - interrupt the running agent (or the chat)
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
    private live = new Map<SessionRole, AgentSession>();
    private busy: Busy = null;
    private chatBusy = false;
    private summaryBusy = false;
    private jobs: Jobs;
    private local: LocalConfig;
    private store: Store;
    private chat: Messenger;

    constructor(local: LocalConfig, store: Store, chat: Messenger) {
        this.local = local;
        this.store = store;
        this.chat = chat;
        this.project = loadProjectConfig(local.project);
        this.adapters = { opencode: new OpencodeAdapter(local.opencodeUrl), claude: new ClaudeAdapter() };
        this.jobs = new Jobs(join(dirname(local.stateFile), 'commands'));
        chat.command('help', async () => chat.send(this.help()));
        chat.command('start', async () => chat.send(this.help()));
        for (const c of this.project.commands) {
            chat.command(c.name, (a) => this.projectCommand(c.name, a));
        }
        chat.command('next', (a) => this.nextTask(a));
        chat.command('review', (a) => this.review(a));
        chat.command('fix', (a) => this.fix(a));
        chat.command('feedback', (a) => this.feedbackCommand(a));
        chat.command('continue', (a) => this.continueTurn(a));
        chat.command('gate', () => this.gateCommand());
        chat.command('plan', (a) => this.plan(a));
        chat.command('todo', (a) => this.todo(a));
        chat.command('chat', (a) => this.chatCommand(a));
        chat.command('summary', (a) => this.summary(a));
        chat.command('agents', async () => chat.send(this.agentList()));
        chat.command('status', async () => chat.sendHtml(this.status()));
        chat.command('stop', (a) => this.stop(a));
        chat.command('log', () => this.exportAll());
        chat.onText = (text, route) => this.text(text, route as SessionRole | undefined);
        for (const adapter of Object.values(this.adapters)) {
            adapter.onUnsolicited = (id, ev) => this.detach(this.unsolicited(id, ev));
        }
        for (const role of Object.keys(this.state.sessions) as SessionRole[]) {
            try {
                this.session(role);
            } catch (e) {
                console.error(`resume ${role}:`, (e as Error).message);
            }
        }
    }

    private help(): string {
        const extra = this.project.commands.map((c) => {
            const usage = c.background ? ` [stop]` : '';
            return `/${c.name}${usage} - ${c.description}${c.background ? ' (runs in the background)' : ''}`;
        });
        return extra.length ? `${help}\n\nProject commands:\n${extra.join('\n')}` : help;
    }

    private async projectCommand(name: string, args: string) {
        this.reload();
        const c = this.project.commands.find((x) => x.name === name);
        if (!c) {
            await this.chat.send(`/${name} is no longer in CONDUCTOR.toml`);
            return;
        }
        if (c.background) {
            await this.backgroundCommand(c, args);
        } else {
            await this.oneShotCommand(c, args);
        }
    }

    private commandLine(c: ProjectCommand, args: string): string {
        return args ? `${c.cmd} ${args}` : c.cmd;
    }

    private async oneShotCommand(c: ProjectCommand, args: string) {
        const cmd = this.commandLine(c, args);
        if (c.confirm && (await this.chat.ask(`Run /${c.name}?\n\n$ ${cmd}`, ['run', 'cancel'], false)) !== 'run') {
            return;
        }
        this.claim(`/${c.name}`);
        try {
            await this.chat.send(`/${c.name}: running…`);
            const started = Date.now();
            const r = await this.jobs.run(c.name, cmd, this.project.root);
            const secs = ((Date.now() - started) / 1000).toFixed(0);
            const outcome = r.code === 0 ? 'done' : `failed (exit ${r.code})`;
            await this.chat.sendLog(`/${c.name}: ${outcome} in ${secs} s`, logTail(r.log, 20));
            const full = readFileSync(r.log, 'utf8');
            if (full.split('\n').length > 21) {
                await this.chat.sendFile(`${c.name}.log`, full);
            }
        } finally {
            this.busy = null;
        }
    }

    private async backgroundCommand(c: ProjectCommand, args: string) {
        const running = this.jobs.get(c.name);
        if (args === 'stop') {
            if (!(await this.jobs.stop(c.name))) {
                await this.chat.send(`/${c.name} is not running`);
            }
            return;
        }
        if (running) {
            const mins = ((Date.now() - running.started) / 60000).toFixed(0);
            const note = args && args !== 'status' ? '\n(already running; /' + c.name + ' stop first)' : '';
            await this.chat.sendLog(`/${c.name}: running for ${mins} min (pid ${running.child.pid})${note}`, logTail(running.log, 15));
            return;
        }
        const cmd = this.commandLine(c, args === 'status' ? '' : args);
        if (c.confirm && (await this.chat.ask(`Start /${c.name}?\n\n$ ${cmd}`, ['start', 'cancel'], false)) !== 'start') {
            return;
        }
        await this.chat.send(`/${c.name}: starting…`);
        const job = this.jobs.start(c.name, cmd, this.project.root, (j, code) => {
            const how = j.stopping ? 'stopped' : `exited (code ${code})`;
            void this.chat.sendLog(`/${c.name}: ${how}`, logTail(j.log, 15));
        });
        if (!c.ready) {
            setTimeout(() => {
                if (this.jobs.get(c.name) === job) {
                    void this.chat.sendLog(`/${c.name}: running (pid ${job.child.pid})`, logTail(job.log, 15));
                }
            }, 5000);
            return;
        }
        const ready = c.ready;
        const poll = setInterval(() => {
            if (this.jobs.get(c.name) !== job) {
                clearInterval(poll);
                return;
            }
            const log = readLog(job.log);
            const m = ready.exec(log);
            if (m) {
                clearInterval(poll);
                // the matched line and what follows it, e.g. a URL list
                const fromMatch = log.slice(log.lastIndexOf('\n', m.index) + 1).trimEnd().split('\n').slice(0, 15);
                void this.chat.sendLog(`/${c.name}: ready (pid ${job.child.pid})`, fromMatch.join('\n'));
            }
        }, 1000);
    }

    async shutdown() {
        await this.jobs.stopAll();
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

    private prefix(role: SessionRole): string {
        const ref = this.state.sessions[role];
        const tag = ref ? this.agent(ref.agent).tag : '?';
        const num = role === 'plan' || role === 'chat' ? role : (this.state.task?.number ?? '');
        return `[${tag} ${num}]`.replace(' ]', ']');
    }

    private asker(role: SessionRole): Asker {
        return {
            permission: async (title, detail, patterns = []) => {
                const broad = patterns.length ? `always: ${patterns.join(', ')}` : undefined;
                const exact = patterns.length ? 'always: this exact command' : 'allow always';
                const choices = ['allow once', exact, ...(broad ? [broad] : []), 'deny'];
                const rules = patterns.length ? `\n\nbroader rules: ${patterns.map((p) => `Bash(${p})`).join(' ')}` : '';
                const a = await this.chat.ask(`${this.prefix(role)} ${title}\n\n${detail}${rules}`, choices, false);
                if (a === 'allow once') {
                    return 'once';
                }
                if (a === exact) {
                    return 'always';
                }
                return a === broad ? 'pattern' : 'reject';
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

    private session(role: SessionRole): AgentSession {
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
            readOnly: role === 'chat',
        });
        this.live.set(role, s);
        return s;
    }

    private async createSession(role: SessionRole, agentName: string, title: string) {
        const agent = this.agent(agentName);
        const s = await this.adapters[agent.harness].create(agent, {
            title,
            cwd: this.project.root,
            asker: this.asker(role),
            readOnly: role === 'chat',
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
        const plan = readFileSync(join(this.project.root, 'PLAN.md'), 'utf8');
        const items = parseNext(plan);
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
            await this.chat.send(id ? `no PLAN item ${id}` : emptyNextMessage(plan));
            return;
        }
        this.claim('implement');
        try {
            const go = await this.chat.ask(
                `Start ${item.id} with ${agent.tag} (${agent.model}${agent.variant ? `, variant ${agent.variant}` : ''})?\n\n${item.text}`,
                ['start', 'cancel'],
                false,
            );
            if (go !== 'start') {
                return;
            }
            this.dropTaskSessions();
            this.state.task = item;
            this.state.sessions = this.keepChat();
            this.state.focus = 'implement';
            this.state.lastGate = undefined;
            this.state.feedbackRound = undefined;
            this.state.feedbackFixing = undefined;
            await this.createSession('implement', agentName, item.id);
        } finally {
            this.busy = null;
        }
        await this.turn('implement', fill(this.project.prompts.implement, this.vars()), `implementing ${item.id}`);
    }

    private async todo(args: string) {
        const plan = readFileSync(join(this.project.root, 'PLAN.md'), 'utf8');
        const items = parseNext(plan);
        const id = args.trim();
        if (id) {
            const item = items.find((i) => i.id === id || i.number === idNumber(id));
            await this.chat.send(item ? item.text : `no PLAN item ${id}`);
            return;
        }
        await this.chat.send(items.length ? items.map(summary).join('\n\n') : emptyNextMessage(plan));
    }

    private vars(extra: Record<string, string> = {}): Record<string, string> {
        const base = (this.state.sessions.implement?.startSha ?? '').slice(0, 7);
        return { id: this.state.task?.id ?? '', num: this.state.task?.number ?? '', base, ...extra };
    }

    private async review(args: string) {
        this.reload();
        const { agent, id } = this.parseArgs(args);
        if (id && id !== this.state.task?.id && idNumber(id) !== this.state.task?.number) {
            if (this.busy) {
                throw new Error(`busy: ${this.busy} is running (/status, /stop)`);
            }
            this.adoptTask(id);
        }
        if (!this.state.task) {
            await this.chat.send('no current task; /next, or /review <id> for work done outside');
            return;
        }
        await this.startReview(agent ?? this.project.roles.review);
    }

    private adoptTask(id: string) {
        const items = parseNext(readFileSync(join(this.project.root, 'PLAN.md'), 'utf8'));
        const found = items.find((i) => i.id === id || i.number === idNumber(id));
        const fullId = found?.id ?? (id.includes('-') ? id : this.findLoggedId(idNumber(id))) ?? id;
        this.dropTaskSessions();
        this.state.task = found ?? { id: fullId, number: idNumber(id), text: '(done outside the conductor)' };
        this.state.sessions = this.keepChat();
        this.state.lastGate = undefined;
        this.state.feedbackRound = undefined;
        this.state.feedbackFixing = undefined;
        this.store.save();
    }

    private findLoggedId(num: string): string | undefined {
        const dir = this.project.logDir;
        if (!existsSync(dir)) {
            return undefined;
        }
        for (const name of readdirSync(dir)) {
            const m = /^(\d{4}-[a-z0-9-]+?)-(?:review-(?:plan-)?)?[a-z0-9.]+\.md$/.exec(name);
            if (m && name.startsWith(`${num}-`)) {
                return m[1];
            }
        }
        return undefined;
    }

    private async afterImplementGate() {
        const done = this.state.feedbackRound ?? 0;
        if (this.project.roles.feedback && done < this.project.feedbackRounds) {
            await this.runFeedback(this.project.roles.feedback);
        } else {
            await this.startReview(this.project.roles.review);
        }
    }

    private async feedbackCommand(args: string) {
        this.reload();
        const { agent } = this.parseArgs(args);
        const name = agent ?? this.project.roles.feedback;
        if (!name) {
            await this.chat.send('no feedback agent: set roles.feedback in CONDUCTOR.toml, or /feedback <agent>');
            return;
        }
        if (!this.state.task || !this.state.sessions.implement) {
            await this.chat.send('no implementation to check; /next first');
            return;
        }
        await this.runFeedback(name);
    }

    private async runFeedback(agentName: string) {
        const task = this.state.task!;
        const round = (this.state.feedbackRound ?? 0) + 1;
        const first = !this.state.sessions.feedback || this.state.sessions.feedback.agent !== agentName;
        this.claim('feedback');
        let text: string;
        try {
            if (first) {
                this.live.delete('feedback');
                await this.createSession('feedback', agentName, `${task.id} feedback`);
                text = fill(this.project.prompts.feedback, this.vars());
            } else {
                const reply = await this.session('implement').lastReply();
                text = fill(this.project.prompts.feedbackAgain, this.vars({ reply }));
            }
            this.state.sessions.feedback!.checkedSha = await repo.head(this.project.root);
            this.state.feedbackRound = round;
            this.state.focus = 'feedback';
            this.store.save();
        } finally {
            this.busy = null;
        }
        const of = Math.max(this.project.feedbackRounds, round);
        await this.turn('feedback', text, `checking ${task.id} (feedback ${round}/${of})`);
    }

    private async afterFeedback(report: string) {
        const task = this.state.task!;
        const verdict = [...report.matchAll(/^\W*VERDICT:\W*(clean|findings)\b/gim)].pop()?.[1].toLowerCase();
        if (verdict === 'clean') {
            await this.chat.send(`feedback: ${task.id} is clean; on to the review`);
            await this.startReview(this.project.roles.review);
            return;
        }
        if (!verdict) {
            await this.chat.send('feedback: no VERDICT line; taking the reply as findings');
        }
        this.state.feedbackFixing = true;
        this.state.focus = 'implement';
        this.store.save();
        await this.turn(
            'implement',
            fill(this.project.prompts.feedbackFix, this.vars({ findings: report })),
            `answering feedback ${this.state.feedbackRound ?? 1} on ${task.id}`,
        );
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
        await this.turn('review', fill(this.project.prompts.review, this.vars()), `reviewing ${task.id}`);
    }

    private async continueTurn(args: string) {
        const words = args.trim().split(/\s+/).filter(Boolean);
        const role = words[0] && roles.includes(words[0]) ? (words.shift() as Role) : this.state.focus;
        if (!role || !this.state.sessions[role]) {
            await this.chat.send(role ? `no ${role} session` : 'no session to continue');
            return;
        }
        const notes = words.join(' ');
        const text = this.project.prompts.continue + (notes ? `\n\n${notes}` : '');
        this.state.focus = role;
        await this.turn(role, text, 'continuing');
    }

    private async fix(notes: string) {
        if (!this.state.sessions.review) {
            await this.chat.send('no review session; /review first');
            return;
        }
        const p = this.project.prompts;
        const text = notes ? fill(p.fixNotes, this.vars({ notes })) : fill(p.fix, this.vars());
        this.state.focus = 'review';
        await this.turn('review', text, `fixing ${this.state.task?.id ?? 'review findings'}`);
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
        await this.turn('plan', fill(this.project.prompts.plan, this.vars({ topic: t })), `planning ${topic}`);
    }

    private async planDone() {
        if (!this.state.sessions.plan) {
            await this.chat.send('no planning session; /plan first');
            return;
        }
        const root = this.project.root;
        const before = await repo.head(root);
        await this.turn('plan', this.project.prompts.planDone, 'writing and committing PLAN.md');
        if ((await repo.commitsSince(root, before)).length > 0) {
            return;
        }
        if ((await repo.fileDiff(root, 'PLAN.md')).trim()) {
            await this.chat.send('PLAN.md changed but nothing was committed');
            return;
        }
        const start = this.state.sessions.plan?.startSha;
        const earlier = start ? (await git(root, 'log', '--reverse', '--format=%h %s', `${start}..HEAD`, '--', 'PLAN.md')).trim() : '';
        if (!earlier) {
            await this.chat.send('no commit; PLAN.md is unchanged');
            return;
        }
        await this.chat.send(
            [
                'nothing new to commit; this planning session already committed PLAN.md in:',
                earlier,
                '',
                nextReport(readFileSync(join(root, 'PLAN.md'), 'utf8')),
                this.nextHint(),
            ]
                .join('\n')
                .trimEnd(),
        );
    }

    private nextHint(): string {
        const first = parseNext(readFileSync(join(this.project.root, 'PLAN.md'), 'utf8'))[0];
        return first ? `/next to start ${first.id}` : '';
    }

    private async planCommitted(before: string) {
        const root = this.project.root;
        const files = (await git(root, 'diff', '--name-only', before, 'HEAD')).split('\n').filter(Boolean);
        const others = files.filter((f) => f !== 'PLAN.md');
        await this.chat.send(
            [
                await repo.commitMessages(root, before),
                ...(others.length ? ['', `warning: the commit also touches ${others.join(', ')}`] : []),
                '',
                nextReport(readFileSync(join(root, 'PLAN.md'), 'utf8')),
            ].join('\n'),
        );
        await this.chat.sendFile('PLAN.diff', await repo.diff(root, before), 'PLAN.md changes');
        const commits = await repo.commitsSince(root, before);
        if ((await this.chat.ask('Keep the planning commit?', ['keep', 'undo commit'], false)) !== 'undo commit') {
            const hint = this.nextHint();
            if (hint) {
                await this.chat.send(hint);
            }
            return;
        }
        if ((await repo.head(root)) !== commits[0]) {
            await this.chat.send('HEAD moved since the planning commit; undo it by hand');
            return;
        }
        // --keep refuses instead of overwriting uncommitted changes to the same files
        await git(root, 'reset', '--keep', before);
        const ref = this.state.sessions.plan;
        if (ref) {
            ref.checkedSha = before;
            this.store.save();
        }
        await this.chat.send(`planning commit undone; HEAD is back at ${before.slice(0, 7)}`);
    }

    private keepChat(): State['sessions'] {
        return this.state.sessions.chat ? { chat: this.state.sessions.chat } : {};
    }

    private dropTaskSessions() {
        for (const role of [...this.live.keys()]) {
            if (role !== 'chat') {
                this.live.delete(role);
            }
        }
    }

    private async chatCommand(args: string) {
        this.reload();
        let rest = args.trim();
        if (rest === 'stop') {
            await this.closeChat();
            return;
        }
        const fresh = /^new\b/.test(rest);
        if (fresh) {
            rest = rest.replace(/^new\s*/, '');
        }
        const first = rest.split(/\s+/)[0];
        let agentName: string | undefined;
        if (first && this.project.agents.has(first)) {
            agentName = first;
            rest = rest.slice(first.length).trim();
        }
        let ref = this.state.sessions.chat;
        const wanted = agentName ?? (ref && !fresh ? ref.agent : this.project.roles.chat);
        if (!ref || fresh || wanted !== ref.agent) {
            if (this.chatBusy) {
                throw new Error('the chat is answering; wait for it or /stop');
            }
            const date = new Date().toISOString().slice(0, 10);
            const base = this.state.task ? `${this.state.task.id}-chat` : `chat-${date}`;
            const tag = this.agent(wanted).tag;
            let title = base;
            for (let n = 2; existsSync(join(this.project.logDir, `${title}-${tag}.md`)); n++) {
                title = `${base}-${n}`;
            }
            this.live.delete('chat');
            await this.createSession('chat', wanted, title);
            ref = this.state.sessions.chat!;
            if (!rest) {
                await this.chat.send(`${this.prefix('chat')} new read-only chat; /chat <message> or reply to its messages`);
                return;
            }
            rest = fill(this.project.prompts.chat, { message: rest });
        } else if (!rest) {
            await this.chat.send(`${this.prefix('chat')} chat session ${ref.id}; /chat <message> or reply to its messages`);
            return;
        }
        await this.chatTurn(rest);
    }

    private async summary(args: string) {
        this.reload();
        let target: SessionRole | undefined;
        let agentName = this.project.roles.summary;
        for (const word of args.trim().split(/\s+/).filter(Boolean)) {
            if ([...roles, 'chat'].includes(word)) {
                target = word as SessionRole;
            } else if (this.project.agents.has(word)) {
                agentName = word;
            } else {
                throw new Error(`/summary [implement|feedback|review|plan|chat] [agent]: unknown "${word}"`);
            }
        }
        target ??= this.busy && roles.includes(this.busy) ? (this.busy as Role) : this.state.focus;
        const ref = target ? this.state.sessions[target] : undefined;
        if (!target || !ref) {
            await this.chat.send(target ? `no ${target} session` : 'no session to summarize');
            return;
        }
        if (this.summaryBusy) {
            throw new Error('a summary is already being written');
        }
        this.summaryBusy = true;
        try {
            await this.exportLog(target);
            const log = this.state.sessions[target]?.logFile;
            if (!log) {
                await this.chat.send(`${this.prefix(target)} has no transcript yet`);
                return;
            }
            const agent = this.agent(agentName);
            const p = `[${agent.tag} summary]`;
            await this.chat.send(`${p} reading the ${target} session (${ref.title})…`);
            const s = await this.adapters[agent.harness].create(agent, {
                title: `${ref.title} summary`,
                cwd: this.project.root,
                asker: this.asker(target),
                readOnly: true,
            });
            const task = this.state.task?.id ?? ref.title;
            const running = this.busy === target || (target === 'chat' && this.chatBusy);
            const state = running ? 'still running' : 'idle (its last turn has ended)';
            const r = await s.send(fill(this.project.prompts.summary, { log, role: target, task, state }));
            if (r.text) {
                await this.chat.sendMarkdown(p, r.text);
            }
            if (r.outcome !== 'succeeded') {
                await this.chat.send(`${p} turn ${r.outcome}${r.error ? `: ${r.error}` : ''}`);
            }
        } finally {
            this.summaryBusy = false;
        }
    }

    private async closeChat() {
        const ref = this.state.sessions.chat;
        if (!ref) {
            await this.chat.send('no chat session');
            return;
        }
        const p = this.prefix('chat');
        if (this.chatBusy) {
            await this.session('chat').interrupt();
            for (let i = 0; i < 100 && this.chatBusy; i++) {
                await new Promise((r) => setTimeout(r, 100));
            }
        }
        await this.exportLog('chat').catch((e: Error) => this.chat.send(`log export failed: ${e.message}`));
        const log = this.state.sessions.chat?.logFile;
        delete this.state.sessions.chat;
        this.live.delete('chat');
        this.store.save();
        await this.chat.sendHtml(`${escapeHtml(p)} chat closed${log ? `; log: ${code(log)}` : ''}`);
    }

    private async chatTurn(text: string) {
        if (this.chatBusy) {
            throw new Error('the chat is answering; wait for it or /stop');
        }
        this.chatBusy = true;
        try {
            const p = this.prefix('chat');
            await this.chat.send(`${p} thinking…`, 'chat');
            const r = await this.session('chat').send(text);
            await this.exportLog('chat').catch((e: Error) => this.chat.send(`log export failed: ${e.message}`));
            if (r.text) {
                await this.chat.sendMarkdown(p, r.text, 'chat');
            }
            if (r.outcome !== 'succeeded') {
                await this.chat.send(`${p} turn ${r.outcome}${r.error ? `: ${r.error}` : ''}`, 'chat');
            }
        } finally {
            this.chatBusy = false;
        }
    }

    private async text(text: string, route: SessionRole | undefined) {
        if (route === 'chat') {
            await this.chatTurn(text);
            return;
        }
        const role = route ?? this.state.focus;
        if (!role || !this.state.sessions[role]) {
            await this.chat.send('no session to talk to; /next, /review or /plan');
            return;
        }
        await this.turn(role, text, 'working', 0, false);
    }

    private detach(p: Promise<void>) {
        p.catch((e: unknown) => {
            console.error('error:', describeError(e));
            this.chat.send(`error: ${describeError(e)}`).catch(() => {});
        });
    }

    private async turn(role: Role, text: string, doing: string, gateAttempt = 0, quote = true) {
        this.claim(role);
        let r: TurnResult;
        let settled: { waiting: boolean; from?: string };
        try {
            const head = `${this.prefix(role)} ${doing}…`;
            await (quote ? this.chat.sendQuoted(head, text, role) : this.chat.send(head, role));
            this.markTurn(role, { since: Date.now(), doing });
            r = await this.session(role).send(text);
            settled = await this.settle(role, r);
        } finally {
            this.markTurn(role, undefined);
            this.busy = null;
        }
        if (!settled.waiting) {
            await this.afterTurn(role, r, settled.from, gateAttempt);
        }
    }

    private async afterTurn(role: Role, r: TurnResult, gateFrom: string | undefined, gateAttempt: number) {
        if (role === 'feedback') {
            if (r.outcome === 'succeeded') {
                await this.afterFeedback(r.text);
            }
            return;
        }
        if (gateFrom !== undefined) {
            await this.afterCommits(role, gateFrom, gateAttempt);
            return;
        }
        if (role === 'implement' && this.state.feedbackFixing && r.outcome === 'succeeded') {
            this.state.feedbackFixing = undefined;
            this.store.save();
            await this.chat.send('the implementer changed nothing for the feedback; on to the review');
            await this.startReview(this.project.roles.review);
        }
    }

    private async afterCommits(role: Role, from: string, gateAttempt: number) {
        if (role === 'plan') {
            await this.planCommitted(from);
        } else {
            await this.gate(role, from, gateAttempt);
        }
    }

    private markTurn(role: Role, turn: SessionRef['turn']) {
        const ref = this.state.sessions[role];
        if (ref && (turn || ref.turn)) {
            ref.turn = turn;
            this.store.save();
        }
    }

    private async recoverTurns() {
        for (const role of roles as Role[]) {
            const ref = this.state.sessions[role];
            if (!ref?.turn) {
                continue;
            }
            const { since, doing } = ref.turn;
            const p = this.prefix(role);
            const what = `its turn (${doing}, from ${new Date(since).toTimeString().slice(0, 5)})`;
            let st: TurnState;
            try {
                st = await this.session(role).turnState(since);
            } catch (e) {
                await this.chat.send(`${p} could not check ${what}: ${describeError(e)}`, role);
                continue;
            }
            if (st.running) {
                await this.chat.send(`${p} ${what} is still running; its end is handled as usual`, role);
                continue;
            }
            await this.chat.send(`${p} ${what} ended while the conductor was down`, role);
            await this.unsolicited(ref.id, { phase: 'ended', outcome: st.outcome, error: st.error });
        }
    }

    // `from`: the commit before the session's new commits, when it committed since it was last checked.
    private async settle(role: Role, r: TurnResult): Promise<{ waiting: boolean; from?: string }> {
        await this.exportLog(role).catch((e: Error) => this.chat.send(`log export failed: ${e.message}`));
        const p = this.prefix(role);
        if (r.text) {
            await this.chat.sendMarkdown(p, r.text, role);
        }
        if (r.outcome !== 'succeeded') {
            await this.chat.send(`${p} turn ${r.outcome}${r.error ? `: ${r.error}` : ''}; /continue to resume it`, role);
            return { waiting: false };
        }
        const jobs = await this.session(role).backgroundJobs().catch(() => []);
        if (jobs.length) {
            const list = jobs.map((j) => `  ${j.split('\n')[0].slice(0, 120)}`).join('\n');
            await this.chat.send(`${p} ended its turn with background jobs running; waiting for it to resume when they exit:\n${list}`, role);
            return { waiting: true };
        }
        const root = this.project.root;
        const ref = this.state.sessions[role]!;
        const from = ref.checkedSha ?? ref.startSha;
        const committed = (await repo.commitsSince(root, from)).length > 0;
        ref.checkedSha = await repo.head(root);
        this.store.save();
        if (role === 'plan') {
            await this.checkPlanOnly();
        }
        if (role === 'feedback' && committed) {
            await this.chat.send(`warning: the feedback check committed (it should only report):\n${await repo.commitMessages(root, from)}`);
        }
        return { waiting: false, from: committed ? from : undefined };
    }

    private async unsolicited(sessionId: string, ev: UnsolicitedEvent) {
        const found = (Object.keys(this.state.sessions) as SessionRole[]).find(
            (r) => this.state.sessions[r]?.id === sessionId,
        );
        if (!found) {
            return;
        }
        if (found === 'chat') {
            if (ev.phase === 'ended' && !this.chatBusy) {
                await this.exportLog('chat');
                await this.chat.sendMarkdown(this.prefix('chat'), await this.session('chat').lastReply(), 'chat');
            }
            return;
        }
        const role: Role = found;
        const p = this.prefix(role);
        if (ev.phase === 'started') {
            const clash = this.busy && this.busy !== role ? `; warning: ${this.busy} is running too, so two agents are in the tree` : '';
            await this.chat.send(`${p} resumed on its own (e.g. a background job finished)…${clash}`, role);
            return;
        }
        this.markTurn(role, undefined);
        if (this.busy) {
            await this.exportLog(role).catch((e: Error) => this.chat.send(`log export failed: ${e.message}`));
            const text = await this.session(role).lastReply();
            if (text) {
                await this.chat.sendMarkdown(p, text, role);
            }
            await this.chat.send(`${p} finished a turn it started itself; ${this.busy} is running, so its commits are checked after the next turn`, role);
            return;
        }
        this.claim(role);
        let r: TurnResult;
        let settled: { waiting: boolean; from?: string };
        try {
            r = { outcome: ev.outcome, error: ev.error, text: await this.session(role).lastReply() };
            settled = await this.settle(role, r);
        } finally {
            this.busy = null;
        }
        if (!settled.waiting) {
            await this.afterTurn(role, r, settled.from, 0);
        }
    }

    private async gateCommand() {
        const role = this.state.focus;
        const ref = role ? this.state.sessions[role] : undefined;
        if (!role || !ref || role === 'plan' || role === 'feedback') {
            await this.chat.send('no implementation or review session to gate');
            return;
        }
        const root = this.project.root;
        if ((await repo.commitsSince(root, ref.startSha)).length === 0) {
            await this.chat.send(`${this.prefix(role)} has no commits since its session started`);
            return;
        }
        if (this.busy) {
            throw new Error(`busy: ${this.busy} is running (/status, /stop)`);
        }
        ref.checkedSha = await repo.head(root);
        this.store.save();
        await this.gate(role, ref.startSha, 0);
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
                const text = fill(this.project.prompts.gateFailed, this.vars({ step: g.failedStep ?? '', output: tail(g.log, 60) }));
                await this.turn(role, text, `fixing the gate failure`, 1);
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
            this.state.feedbackFixing = undefined;
            this.store.save();
            await this.afterImplementGate();
        } else if (role === 'review') {
            await this.chat.send(`${task?.id ?? 'task'} done; /next when ready`);
        }
    }

    private logName(role: SessionRole, ref: SessionRef, planTouched: boolean): string {
        const tag = this.agent(ref.agent).tag;
        if (role === 'chat') {
            return `${ref.title}-${tag}.md`;
        }
        if (role === 'plan') {
            return this.state.task ? `${this.state.task.id}-plan-${tag}.md` : `${ref.title}-${tag}.md`;
        }
        const id = this.state.task?.id ?? ref.title;
        if (role === 'implement') {
            return `${id}-${tag}.md`;
        }
        if (role === 'feedback') {
            return `${id}-feedback-${tag}.md`;
        }
        return `${id}-review${planTouched ? '-plan' : ''}-${tag}.md`;
    }

    private async exportLog(role: SessionRole) {
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
        for (const role of Object.keys(this.state.sessions) as SessionRole[]) {
            await this.exportLog(role);
            const f = this.state.sessions[role]?.logFile;
            if (f) {
                done.push(f);
            }
        }
        await this.chat.sendHtml(done.length ? `exported:\n${done.map(code).join('\n')}` : 'no sessions');
    }

    private async stop(args = '') {
        const busy = this.busy;
        if (this.chatBusy && (args === 'chat' || !busy)) {
            await this.session('chat').interrupt();
            await this.chat.send(`interrupt sent to ${this.prefix('chat')}`);
            return;
        }
        if (!busy || !roles.includes(busy)) {
            await this.chat.send(busy ? `${busy} is running; it cannot be stopped yet` : 'nothing is running');
            return;
        }
        const role = busy as Role;
        await this.session(role).interrupt();
        await this.chat.send(`interrupt sent to ${this.prefix(role)}`);
    }

    private agentList(): string {
        const lines = [...this.project.agents.values()].map(
            (a) =>
                `${a.name}: ${a.tag} (${a.harness} ${a.model}` +
                `${a.effort ? `, effort ${a.effort}` : ''}${a.variant ? `, variant ${a.variant}` : ''})`,
        );
        const r = this.project.roles;
        lines.push('', `roles: implement=${r.implement} review=${r.review} plan=${r.plan}`);
        return lines.join('\n');
    }

    private status(): string {
        const s = this.state;
        const lines = [
            `project: ${code(this.project.root)}`,
            `task: ${escapeHtml(s.task?.id ?? '-')}`,
            `running: ${escapeHtml(this.busy ?? 'nothing')}${this.chat.pendingQuestions() ? ` (${this.chat.pendingQuestions()} question(s) waiting)` : ''}`,
            `focus: ${s.focus ?? '-'}${this.chatBusy ? ' (chat answering)' : ''}`,
        ];
        for (const [role, ref] of Object.entries(s.sessions)) {
            lines.push(`${role}: ${this.agent(ref.agent).tag} ${ref.id}${ref.logFile ? `\n  log ${code(ref.logFile)}` : ''}`);
        }
        for (const c of this.project.commands) {
            const job = this.jobs.get(c.name);
            if (job) {
                lines.push(`/${c.name}: running for ${((Date.now() - job.started) / 60000).toFixed(0)} min`);
            }
        }
        if (s.lastGate) {
            const g = s.lastGate;
            lines.push(`last gate: ${g.ok ? 'passed' : `failed at ${escapeHtml(g.step ?? '?')}`} at ${g.sha.slice(0, 7)} (${g.at})`);
        }
        return lines.join('\n');
    }

    async announce() {
        const reaped = await this.jobs.reapStale();
        if (reaped.length) {
            await this.chat.send(`stopped leftover ${reaped.map((n) => `/${n}`).join(', ')} from a previous run`);
        }
        const s = this.state;
        const text = `conductor up: ${this.project.root}${s.task ? `, task ${s.task.id}` : ''}. /help`;
        const commands = new Map<string, string>();
        for (const line of this.help().split('\n')) {
            const m = /^\/([a-z0-9_-]+)\b.*? - (.*)$/.exec(line);
            if (m && !commands.has(m[1])) {
                commands.set(m[1].replace(/-/g, '_'), m[2].slice(0, 256));
            }
        }
        commands.set('help', 'commands');
        await this.chat.takeOver(text, [...commands].map(([command, description]) => ({ command, description })));
        await this.recoverTurns();
    }
}

function code(text: string): string {
    return `<code>${escapeHtml(text)}</code>`;
}
