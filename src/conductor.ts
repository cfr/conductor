import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CodexAdapter } from './agents/codex.ts';
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
import { FeedbackTracker, feedbackContract, dispositionContract } from './feedback.ts';
import { escapeHtml } from './format.ts';
import { Jobs, logTail, readLog } from './jobs.ts';
import { renderMarkdown, usageMetadata } from './logs/markdown.ts';
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
    private stoppingWork = 0;
    private chatBusy = false;
    // A planning turn while the task runs is read-only and takes no part in `busy`.
    private planBusy = false;
    // Turns and the steps that follow them (gate, feedback, review), counting the gaps where `busy` is null.
    private flowing = 0;
    private workPoll?: ReturnType<typeof setInterval>;
    private drainingWork = false;
    private recoveringWork = false;
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
        this.adapters = { opencode: new OpencodeAdapter(local.opencodeUrl), claude: new ClaudeAdapter(), codex: new CodexAdapter(join(dirname(local.stateFile), 'codex')) };
        this.jobs = new Jobs(join(dirname(local.stateFile), 'commands'));
        chat.command('help', async () => chat.send(this.help()));
        chat.command('start', async () => chat.send(this.help()));
        for (const c of this.project.commands) {
            for (const name of [c.name, ...c.aliases]) {
                chat.command(name, (a) => this.projectCommand(c.name, a));
            }
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
            const also = c.aliases.length ? ` (also ${c.aliases.map((a) => `/${a}`).join(', ')})` : '';
            return `/${c.name}${usage} - ${c.description}${c.background ? ' (runs in the background)' : ''}${also}`;
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
        if (this.workPoll) clearInterval(this.workPoll);
        this.workPoll = undefined;
        await this.jobs.stopAll();
    }

    private get state() {
        return this.store.state;
    }

    private get feedbackTracker(): FeedbackTracker {
        return new FeedbackTracker(this.store, join(dirname(this.local.stateFile), 'findings'), this.project);
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
                const labels = q.choices.map((c) => c.label);
                const a = await this.chat.ask(lines.join('\n'), labels, q.allowText);
                if (!labels.includes(a)) {
                    await this.chat.send(`${this.prefix(role)} working…`, role);
                }
                return a;
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
            pendingWorkState: this.state.sessions[role]?.pendingWorkState,
            savePendingWork: (id, state) => {
                const current = this.state.sessions[role];
                if (current?.id !== id) return;
                current.pendingWorkState = state;
                this.store.save();
            },
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
            savePendingWork: (id, state) => {
                const current = this.state.sessions[role];
                if (current?.id !== id) return;
                current.pendingWorkState = state;
                this.store.save();
            },
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

    private waitingRole(): Role | undefined {
        const order: Role[] = ['implement', 'feedback', 'review', 'plan'];
        return order.find((role) => this.state.sessions[role]?.workWait);
    }

    private requireSettledWork() {
        if (this.state.workConflict) throw new Error(`${this.state.workConflict}; /gate to verify the current tree first`);
        const waiting = this.waitingRole();
        if (waiting) throw new Error(`${waiting} still has pending work; /status or /continue ${waiting}`);
    }

    private claim(what: Busy) {
        if (this.recoveringWork) throw new Error('recovering session work; try again after /status');
        const waiting = this.waitingRole();
        if (waiting && waiting !== what) throw new Error(`${waiting} still has pending work; /status or /continue ${waiting}`);
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
        this.requireSettledWork();
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
            this.state.sessions = this.keepSideSessions();
            this.state.focus = 'implement';
            this.state.lastGate = undefined;
            this.state.feedbackRound = undefined;
            this.state.feedbackFixing = undefined;
            this.state.feedbackFindingIds = undefined;
            this.state.feedbackFixBase = undefined;
            this.state.feedbackDispositionPending = undefined;
            this.state.workConflict = undefined;
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
        this.requireSettledWork();
        const items = parseNext(readFileSync(join(this.project.root, 'PLAN.md'), 'utf8'));
        const found = items.find((i) => i.id === id || i.number === idNumber(id));
        const fullId = found?.id ?? (id.includes('-') ? id : this.findLoggedId(idNumber(id))) ?? id;
        this.dropTaskSessions();
        this.state.task = found ?? { id: fullId, number: idNumber(id), text: '(done outside the conductor)' };
        this.state.sessions = this.keepSideSessions();
        this.state.lastGate = undefined;
        this.state.feedbackRound = undefined;
        this.state.feedbackFixing = undefined;
        this.state.feedbackFindingIds = undefined;
        this.state.feedbackFixBase = undefined;
        this.state.feedbackDispositionPending = undefined;
        this.state.workConflict = undefined;
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

    // the agent of round done + 1 in roles.feedback, the last one repeating
    private feedbackAgentAt(done: number): string | undefined {
        const list = this.project.roles.feedback;
        return done < this.project.feedbackRounds ? list[Math.min(done, list.length - 1)] : undefined;
    }

    private nextFeedbackAgent(): string | undefined {
        return this.feedbackAgentAt(this.state.feedbackRound ?? 0);
    }

    private async afterImplementGate() {
        const next = this.nextFeedbackAgent();
        if (next) {
            await this.runFeedback(next);
        } else {
            await this.startReview(this.project.roles.review);
        }
    }

    // Nothing to recheck: the current agent's remaining rounds are skipped and the next listed agent checks afresh.
    private async afterSettledCheck(why: string) {
        const current = this.state.sessions.feedback?.agent;
        let done = this.state.feedbackRound ?? 0;
        while (done < this.project.feedbackRounds && this.feedbackAgentAt(done) === current) {
            done++;
        }
        const next = this.feedbackAgentAt(done);
        if (next) {
            this.state.feedbackRound = done;
            this.store.save();
            await this.chat.send(`${why}; next check by ${this.agent(next).tag}`);
            await this.runFeedback(next);
            return;
        }
        await this.chat.send(`${why}; on to the review`);
        await this.startReview(this.project.roles.review);
    }

    private async feedbackCommand(args: string) {
        this.reload();
        const { agent } = this.parseArgs(args);
        const name = agent ?? this.nextFeedbackAgent() ?? this.project.roles.feedback.at(-1);
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
        this.requireSettledWork();
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
            this.state.feedbackReportRetried = undefined;
            this.state.sessions.feedback!.trackedFindings = true;
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
        let verdict = [...report.matchAll(/^\W*VERDICT:\W*(clean|findings)\b/gim)].pop()?.[1].toLowerCase();
        let invalid: string | undefined;
        let findingIds: string[] | undefined;
        if (this.state.sessions.feedback?.trackedFindings) {
            const receipt = await this.feedbackTracker.report(report);
            invalid = receipt.error;
            findingIds = receipt.findingIds;
            if (invalid) verdict = undefined;
            else verdict = findingIds.length ? 'findings' : 'clean';
        }
        if (verdict === 'clean') {
            await this.afterSettledCheck(`feedback: ${task.id} is clean`);
            return;
        }
        if (!verdict) {
            this.state.focus = 'feedback';
            if (this.state.feedbackReportRetried) {
                this.store.save();
                await this.chat.send(
                    `feedback: incomplete report after one retry${invalid ? ` (${invalid})` : ': no VERDICT'}; task flow paused. ` +
                    'Use /continue feedback to finish the report, /feedback <agent> for another check, ' +
                    'or /review to proceed to review.',
                );
                return;
            }
            this.state.feedbackReportRetried = true;
            this.store.save();
            await this.chat.send('feedback: incomplete report; asking the checker to finish it once');
            await this.turn(
                'feedback',
                `Finish the complete feedback report now. ${invalid ?? 'Your previous reply had no VERDICT line.'} ` +
                'Report only: do not edit files or commit. If blocked, explain why; do not claim a clean review.\n\n' +
                (this.state.sessions.feedback?.trackedFindings ? feedbackContract :
                    'Include actionable findings with file:line and evidence, or state none. End with VERDICT: clean or VERDICT: findings.'),
                `completing feedback ${this.state.feedbackRound ?? 1} on ${task.id}`,
            );
            return;
        }
        if (findingIds) await this.feedbackTracker.begin(findingIds);
        else {
            this.state.feedbackFixing = true;
            this.state.focus = 'implement';
            this.store.save();
        }
        await this.turn(
            'implement',
            fill(this.project.prompts.feedbackFix, this.vars({ findings: report })),
            `answering feedback ${this.state.feedbackRound ?? 1} on ${task.id}`,
        );
    }

    private async recordFeedbackAnswer(text: string, role: 'implement' | 'review' = 'implement'): Promise<boolean> {
        const receipt = await this.feedbackTracker.answer(text, role);
        const retried = role === 'implement' ? this.state.feedbackDispositionRetried : this.state.sessions.review!.dispositionRetried;
        if (role === 'implement') this.state.feedbackDispositionPending = !!receipt.error;
        else this.state.sessions.review!.dispositionPending = !!receipt.error;
        this.store.save();
        if (!receipt.error) return true;
        if (retried) {
            await this.chat.send(`finding answer pending: ${receipt.error}; task flow paused. Use /continue ${role} to complete dispositions.`);
            return false;
        }
        if (role === 'implement') this.state.feedbackDispositionRetried = true;
        else this.state.sessions.review!.dispositionRetried = true;
        this.store.save();
        await this.turn(role,
            `Your disposition report is incomplete: ${receipt.error}. Return the complete dispositions for the requested IDs. ` +
            `Do not edit files or commit during this correction.\n\n${dispositionContract}`,
            'completing feedback dispositions');
        return false;
    }

    private async recordReviewReport(report: string) {
        const ref = this.state.sessions.review!;
        const receipt = await this.feedbackTracker.report(report, 'review');
        if (!receipt.error) {
            ref.findingIds = receipt.findingIds;
            ref.expectReport = undefined;
            ref.reportRetried = undefined;
            this.store.save();
            return;
        }
        if (ref.reportRetried) {
            await this.chat.send(`review report pending: ${receipt.error}; use /continue review to finish the report.`);
            return;
        }
        ref.reportRetried = true;
        this.store.save();
        await this.turn('review', `Complete your review report: ${receipt.error}. Do not edit or commit.\n\n${feedbackContract}`,
            'completing review report');
    }

    private async startReview(agentName: string) {
        this.requireSettledWork();
        const task = this.state.task!;
        this.claim('review');
        try {
            this.live.delete('review');
            await this.createSession('review', agentName, `${task.id} review`);
            this.state.sessions.review!.trackedFindings = true;
            this.state.sessions.review!.expectReport = true;
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
        if (this.busy) throw new Error(`busy: ${this.busy} is running (/status, /stop)`);
        const ref = this.state.sessions.review;
        if (ref.findingIds?.length) {
            ref.fixBase = await repo.head(this.project.root);
            ref.fixingFindings = true;
            ref.dispositionPending = true;
            ref.dispositionRetried = undefined;
            this.store.save();
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
        if (this.planBusy || this.busy === 'plan') {
            throw new Error('the planning session is answering; wait for it or /stop plan');
        }
        this.live.delete('plan');
        const date = new Date().toISOString().slice(0, 10);
        const name = agent ?? this.project.roles.plan;
        const base = this.state.task ? `${this.state.task.id}-plan` : `plan-${date}-${slug(topic)}`;
        await this.createSession('plan', name, this.freshTitle(base, name));
        this.state.planTopic = topic;
        // replies reach it through their routes; plain text keeps going to the running task
        if (!this.taskRunning()) {
            this.state.focus = 'plan';
        }
        this.store.save();
        const t = rest ? `: ${rest}` : '';
        await this.turn('plan', fill(this.project.prompts.plan, this.vars({ topic: t })), `planning ${topic}`);
    }

    private async planDone() {
        if (!this.state.sessions.plan) {
            await this.chat.send('no planning session; /plan first');
            return;
        }
        const running = this.runningTask();
        if (running) {
            await this.chat.send(`${running} is running; /plan done writes PLAN.md once the task is idle`);
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
        const kept = this.state.sessions.plan?.planCommits ?? [];
        const earlier = kept.length ? (await git(root, 'log', '--no-walk=unsorted', '--format=%h %s', ...kept)).trim() : '';
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
            const kept = this.state.sessions.plan;
            if (kept) {
                kept.planCommits = [...(kept.planCommits ?? []), ...[...commits].reverse()];
                this.store.save();
            }
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

    // the chat and the planning session run beside the tasks and outlive them
    private keepSideSessions(): State['sessions'] {
        const { chat, plan } = this.state.sessions;
        return { ...(chat ? { chat } : {}), ...(plan ? { plan } : {}) };
    }

    private freshTitle(base: string, agentName: string): string {
        const tag = this.agent(agentName).tag;
        let title = base;
        for (let n = 2; existsSync(join(this.project.logDir, `${title}-${tag}.md`)); n++) {
            title = `${base}-${n}`;
        }
        return title;
    }

    private dropTaskSessions() {
        for (const role of [...this.live.keys()]) {
            if (role !== 'chat' && role !== 'plan') {
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
            this.live.delete('chat');
            await this.createSession('chat', wanted, this.freshTitle(base, wanted));
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
            const running = this.busy === target || (target === 'chat' && this.chatBusy) || (target === 'plan' && this.planBusy);
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
        if (role === 'plan') {
            await this.planTurn(text, doing, quote);
            return;
        }
        this.claim(role);
        this.flowing++;
        try {
            let r: TurnResult;
            let settled: { waiting: boolean; from?: string };
            try {
                this.state.sessions[role]!.model = this.session(role).agent.model;
                this.store.save();
                text = await this.feedbackTracker.prompt(role, text);
                const head = `${this.prefix(role)} ${doing}…`;
                await (quote ? this.chat.sendQuoted(head, text, role) : this.chat.send(head, role));
                this.markTurn(role, { since: Date.now(), doing, gateAttempt });
                r = await this.session(role).send(text);
                settled = await this.settle(role, r);
            } finally {
                this.markTurn(role, undefined);
                this.busy = null;
            }
            if (!settled.waiting) {
                await this.afterTurn(role, r, settled.from, gateAttempt);
            }
        } finally {
            this.flowing--;
        }
    }

    private runningTask(): string | undefined {
        if (this.busy && this.busy !== 'plan') {
            return this.busy;
        }
        const waiting = this.waitingRole();
        if (waiting) {
            return `${waiting} (pending work)`;
        }
        if (this.state.workConflict) return 'concurrent work awaiting verification';
        return this.flowing > 0 ? 'the task flow' : undefined;
    }

    private taskRunning(): boolean {
        return this.runningTask() !== undefined;
    }

    // Read-only while a task runs, so the planner never edits PLAN.md under an implementer that moves its item.
    private async planTurn(text: string, doing: string, quote: boolean) {
        if (this.planBusy) {
            throw new Error('the planning session is answering; wait for it or /stop plan');
        }
        const running = this.runningTask();
        if (!running) {
            this.claim('plan');
        }
        this.planBusy = true;
        let r: TurnResult;
        let settled: { waiting: boolean; from?: string };
        try {
            const root = this.project.root;
            const ref = this.state.sessions.plan!;
            const seen = ref.checkedSha ?? ref.startSha;
            const head = await repo.head(root);
            const notes: string[] = [];
            if (head !== seen) {
                const commits = (await git(root, 'log', '--format=%h %s', `${seen}..${head}`)).trim();
                notes.push(fill(this.project.prompts.planMoved, { commits }));
            }
            if (running) {
                notes.push(fill(this.project.prompts.planReadOnly, { running }));
            }
            ref.checkedSha = head;
            this.store.save();
            const message = [...notes, text].join('\n\n');
            const line = `${this.prefix('plan')} ${doing}${running ? ' (read-only while the task runs)' : ''}…`;
            await (quote ? this.chat.sendQuoted(line, message, 'plan') : this.chat.send(line, 'plan'));
            this.markTurn('plan', { since: Date.now(), doing });
            const session = this.session('plan');
            await session.setReadOnly(running !== undefined);
            r = await session.send(message);
            settled = await this.settle('plan', r, running !== undefined);
        } finally {
            this.markTurn('plan', undefined);
            this.planBusy = false;
            if (!running) {
                this.busy = null;
            }
        }
        if (!settled.waiting) {
            await this.afterTurn('plan', r, settled.from, 0);
        }
    }

    private async afterTurn(role: Role, r: TurnResult, gateFrom: string | undefined, gateAttempt: number) {
        if (role === 'feedback') {
            if (this.state.workConflict) {
                await this.chat.send(`${this.state.workConflict}; feedback is stale. Wait for pending work, then /gate.`);
                return;
            }
            if (r.outcome === 'succeeded') {
                await this.afterFeedback(r.text);
            }
            return;
        }
        if (role === 'implement' && this.state.feedbackFixing && this.state.feedbackFindingIds?.length) {
            if (r.outcome !== 'succeeded') return;
            if (!(await this.recordFeedbackAnswer(r.text))) return;
            const base = this.state.feedbackFixBase!;
            if ((await repo.commitsSince(this.project.root, base)).length) gateFrom = base;
            if (gateFrom === undefined) this.state.feedbackFindingIds = undefined;
            this.store.save();
        }
        if (role === 'review' && this.state.sessions.review?.trackedFindings) {
            const ref = this.state.sessions.review;
            if (!ref.fixingFindings && gateFrom !== undefined && ref.findingIds?.length) {
                ref.fixingFindings = true;
                ref.fixBase = gateFrom;
                this.store.save();
            }
            if (ref.fixingFindings) {
                if (r.outcome !== 'succeeded' || !(await this.recordFeedbackAnswer(r.text, 'review'))) return;
                if ((await repo.commitsSince(this.project.root, ref.fixBase!)).length) gateFrom = ref.fixBase;
                else {
                    ref.fixingFindings = undefined;
                    ref.findingIds = undefined;
                    this.store.save();
                }
            } else if (!this.state.workConflict && r.outcome === 'succeeded' && gateFrom === undefined &&
                (ref.expectReport || r.text.includes('```conductor-feedback'))) {
                await this.recordReviewReport(r.text);
                return;
            }
        }
        if (role !== 'plan' && this.state.workConflict) {
            await this.chat.send(`${this.state.workConflict}; automatic flow paused. Wait for pending work, then /gate.`);
            return;
        }
        if (gateFrom !== undefined) {
            await this.afterCommits(role, gateFrom, gateAttempt);
            return;
        }
        if (role === 'implement' && this.state.feedbackFixing && r.outcome === 'succeeded') {
            this.state.feedbackFixing = undefined;
            this.store.save();
            await this.afterSettledCheck('the implementer changed nothing for the feedback');
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

    private async recoverPendingWork() {
        for (const role of roles as Role[]) {
            const ref = this.state.sessions[role];
            if (!ref || ref.workWait) continue;
            let detail: string;
            try {
                const work = await this.session(role).pendingWork();
                if (!work.length) continue;
                detail = work.map((w) => `${w.kind}: ${w.description}`).join('\n');
            } catch (e) { detail = `pending-work status unknown: ${describeError(e)}`; }
            ref.workWait = { since: ref.turn?.since ?? 0, result: { outcome: 'succeeded', text: '' },
                gateAttempt: ref.turn?.gateAttempt ?? 0, readOnly: false, detail };
            this.store.save();
        }
        const knownPending = (roles as Role[]).filter((role) => role !== 'plan' && this.state.sessions[role]?.workWait);
        if (knownPending.length > 1) {
            this.state.workConflict = `Recovered overlapping work: ${knownPending.join(', ')}`;
            this.state.focus = this.state.sessions.implement ? 'implement' : knownPending[0];
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
    private async settle(role: Role, r: TurnResult, readOnly = false, postReply = true): Promise<{ waiting: boolean; from?: string }> {
        await this.exportLog(role).catch((e: Error) => this.chat.send(`log export failed: ${e.message}`));
        const p = this.prefix(role);
        if (r.text && postReply) {
            await this.chat.sendMarkdown(p, r.text, role);
        }
        let detail: string;
        try {
            const work = await this.session(role).pendingWork();
            detail = work.map((w) => `  ${w.kind}: ${w.description.split('\n')[0].slice(0, 160)}`).join('\n');
        } catch (e) {
            detail = `pending-work status unknown: ${describeError(e)}`;
        }
        if (detail) {
            const ref = this.state.sessions[role]!;
            const old = ref.workWait;
            ref.workWait = { since: old?.since ?? ref.turn?.since ?? Date.now() - 1,
                result: r, readOnly, gateAttempt: old?.gateAttempt ?? ref.turn?.gateAttempt ?? 0, detail };
            this.store.save();
            this.watchWork();
            if (old?.detail !== detail) await this.chat.send(`${p} waiting for pending work before advancing:\n${detail}`, role);
            return { waiting: true };
        }
        if (this.state.sessions[role]?.workWait) {
            delete this.state.sessions[role]!.workWait;
            this.store.save();
        }
        if (r.outcome !== 'succeeded') {
            await this.chat.send(`${p} turn ${r.outcome}${r.error ? `: ${r.error}` : ''}; /continue to resume it`, role);
            return { waiting: false };
        }
        if (readOnly) {
            return { waiting: false };
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
            const otherWaiting = this.waitingRole();
            if (role !== 'plan' && ((this.busy && this.busy !== role) ||
                (otherWaiting && otherWaiting !== role && otherWaiting !== 'plan'))) {
                this.state.workConflict = `${role} resumed during ${this.busy ?? otherWaiting}`;
                this.state.focus = this.state.sessions.implement ? 'implement' : role;
            }
            const ref = this.state.sessions[role]!;
            ref.workWait ??= { since: Date.now() - 1, result: { outcome: 'succeeded', text: '' },
                readOnly: role === 'plan' && this.taskRunning(), gateAttempt: 0, detail: 'session resumed' };
            this.store.save();
            this.watchWork();
            const clash = this.busy && this.busy !== role ? `; warning: ${this.busy} is running too, so two agents are in the tree` : '';
            await this.chat.send(`${p} resumed on its own (e.g. a background job finished)…${clash}`, role);
            return;
        }
        const ref = this.state.sessions[role]!;
        ref.workWait ??= { since: ref.turn?.since ?? Date.now() - 1,
            result: { outcome: ev.outcome, error: ev.error, text: '' }, readOnly: false,
            gateAttempt: ref.turn?.gateAttempt ?? 0, detail: 'waiting for resumed session to settle' };
        this.markTurn(role, undefined);
        this.store.save();
        this.watchWork();
        await this.drainWork();
    }

    private watchWork() {
        if (this.workPoll) return;
        this.workPoll = setInterval(() => this.detach(this.drainWork()), 2000);
        this.workPoll.unref();
    }

    private async drainWork() {
        if (this.drainingWork || this.recoveringWork || this.busy || this.planBusy || this.stoppingWork) return;
        const role = this.waitingRole();
        if (!role) {
            if (this.workPoll) clearInterval(this.workPoll);
            this.workPoll = undefined;
            return;
        }
        this.drainingWork = true;
        this.flowing++;
        this.claim(role);
        const wait = this.state.sessions[role]!.workWait!;
        try {
            const session = this.session(role);
            const st = await session.turnState(wait.since);
            if (st.running) return;
            const work = await session.pendingWork();
            if (work.length) {
                const detail = work.map((w) => `${w.kind}: ${w.description.split('\n')[0].slice(0, 160)}`).join('\n');
                if (wait.detail !== detail) {
                    wait.detail = detail;
                    this.store.save();
                    await this.chat.send(`${this.prefix(role)} waiting for pending work:\n${detail}`, role);
                }
                return;
            }
            const r: TurnResult = { outcome: wait.result.outcome === 'interrupted' ? 'interrupted' : st.outcome,
                error: st.error, text: await session.lastReply() };
            const settled = await this.settle(role, r, wait.readOnly, r.text !== wait.result.text);
            this.busy = null;
            if (!settled.waiting) await this.afterTurn(role, r, settled.from, wait.gateAttempt);
        } catch (e) {
            // Preserve the wait/lock when a status lookup fails; never infer an idle tree.
            const ref = this.state.sessions[role];
            if (!ref?.workWait) throw e;
            const detail = `pending-work status unknown: ${describeError(e)}`;
            if (ref.workWait.detail !== detail) await this.chat.send(`${this.prefix(role)} ${detail}`, role);
            ref.workWait.detail = detail;
            this.store.save();
        } finally {
            this.busy = null;
            this.flowing--;
            this.drainingWork = false;
        }
    }

    private async gateCommand() {
        const role = this.state.focus;
        const ref = role ? this.state.sessions[role] : undefined;
        if (!role || !ref || role === 'plan' || role === 'feedback') {
            await this.chat.send('no implementation or review session to gate');
            return;
        }
        if ((role === 'implement' && this.state.feedbackDispositionPending) || ref.dispositionPending) {
            await this.chat.send(`finding dispositions are pending; use /continue ${role} before /gate`);
            return;
        }
        const waiting = this.waitingRole();
        if (waiting) throw new Error(`${waiting} still has pending work; wait before /gate`);
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
        const gateFile = join(this.project.logDir, `${this.state.task?.id ?? 'task'}-gate.log`);
        mkdirSync(this.project.logDir, { recursive: true });
        const at = new Date().toISOString();
        const record = { ok: g.ok, step: g.failedStep, sha, at,
            commands: this.project.gate.map((s) => s.cmd), seconds: g.seconds, logFile: gateFile };
        const gateEntry = `${JSON.stringify(record)}\n${g.log}\n`;
        writeFileSync(gateFile, (existsSync(gateFile) ? readFileSync(gateFile, 'utf8') : '') + gateEntry);
        this.state.lastGate = record;
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
        if (this.state.workConflict) {
            this.state.workConflict = undefined;
            this.state.feedbackRound = undefined;
            this.store.save();
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
            this.state.feedbackFindingIds = undefined;
            this.state.feedbackFixBase = undefined;
            this.state.feedbackDispositionRetried = undefined;
            this.state.feedbackDispositionPending = undefined;
            this.state.feedbackFixing = undefined;
            this.store.save();
            await this.afterImplementGate();
        } else if (role === 'review') {
            const ref = this.state.sessions.review!;
            ref.fixingFindings = undefined;
            ref.dispositionPending = undefined;
            ref.findingIds = undefined;
            this.store.save();
            await this.chat.send(`${task?.id ?? 'task'} done; /next when ready`);
        }
    }

    private logName(role: SessionRole, ref: SessionRef, planTouched: boolean): string {
        const tag = this.agent(ref.agent).tag;
        if (role === 'chat' || role === 'plan') {
            return `${ref.title}-${tag}.md`;
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
            const previousUsage = ref.logFile.replace(/\.md$/, '.usage.json');
            if (existsSync(previousUsage)) renameSync(previousUsage, file.replace(/\.md$/, '.usage.json'));
        }
        writeFileSync(file, renderMarkdown(t));
        writeFileSync(file.replace(/\.md$/, '.usage.json'), JSON.stringify({
            ...usageMetadata(t) as object, agent: this.session(role).agent,
        }, null, 2) + '\n');
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
        if (this.state.task && existsSync(join(dirname(this.local.stateFile), 'findings', `${this.state.task.id}.json`))) {
            done.push(this.feedbackTracker.export());
        }
        await this.chat.sendHtml(done.length ? `exported:\n${done.map(code).join('\n')}` : 'no sessions');
    }

    private async stop(args = '') {
        const busy = this.busy ?? this.waitingRole();
        if (this.chatBusy && (args === 'chat' || !busy)) {
            await this.interruptSession('chat');
            await this.chat.send(`interrupt sent to ${this.prefix('chat')}`);
            return;
        }
        if (this.planBusy && (args === 'plan' || !busy || busy === 'plan')) {
            await this.interruptSession('plan');
            await this.chat.send(`interrupt sent to ${this.prefix('plan')}`);
            return;
        }
        if (!busy || !roles.includes(busy)) {
            await this.chat.send(busy ? `${busy} is running; it cannot be stopped yet` : 'nothing is running');
            return;
        }
        const role = busy as Role;
        await this.interruptSession(role);
        await this.chat.send(`interrupt sent to ${this.prefix(role)}`);
    }

    private async interruptSession(role: SessionRole) {
        this.stoppingWork++;
        const markStopped = () => {
            const wait = this.state.sessions[role]?.workWait;
            if (wait) {
                wait.result = { ...wait.result, outcome: 'interrupted' };
                this.store.save();
            }
        };
        markStopped();
        try {
            await this.session(role).interrupt();
        } finally {
            markStopped();
            this.stoppingWork--;
        }
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
            `running: ${escapeHtml(this.runningTask() ?? 'nothing')}${this.planBusy ? ' (plan answering)' : ''}${this.chat.pendingQuestions() ? ` (${this.chat.pendingQuestions()} question(s) waiting)` : ''}`,
            `focus: ${s.focus ?? '-'}${this.chatBusy ? ' (chat answering)' : ''}`,
            ...(s.workConflict ? [`verification required: ${escapeHtml(s.workConflict)}`] : []),
        ];
        for (const [role, ref] of Object.entries(s.sessions)) {
            lines.push(`${role}: ${this.agent(ref.agent).tag} ${ref.id}${ref.workWait ? `\n  pending: ${escapeHtml(ref.workWait.detail)}` : ''}${ref.logFile ? `\n  log ${code(ref.logFile)}` : ''}`);
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
        this.recoveringWork = true;
        try {
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
            await this.recoverPendingWork();
            await this.recoverTurns();
        } finally { this.recoveringWork = false; }
        if (this.waitingRole()) this.watchWork();
        await this.drainWork();
    }
}

function code(text: string): string {
    return `<code>${escapeHtml(text)}</code>`;
}
