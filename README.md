# conductor

opencode/Claude Code/Telegram orchestration tool.

From one Telegram chat, one agent implements a `PLAN.md` item, the bridge runs the project's
verification gate, a second agent reviews, and `/fix` applies the review. Agents run through
opencode (its background service) or Claude Code (the Agent SDK); every session is exported to
markdown after each turn. See `DESIGN.md` for the flow and its reasons.

## Setup

Node 24 or newer (TypeScript runs directly through Node's type stripping, no build step).

    npm install
    cp config.example.toml config.toml   # project path, bot token, your Telegram user id

`config.toml` is gitignored: it holds the bot token. Messages from anyone but
`telegram.allowed_user_id` are ignored. Only one process may poll a bot token, so stop
opencode-telegram-bot while the conductor runs on the same token (the conductor exits with a
message on `409 Conflict`).

The project needs a `CONDUCTOR.toml` at its root: gate commands, agents, roles, flow, project
commands and optional prompts. `CONDUCTOR.example.toml` is the one for bane.

## Run

    npm start

Console lines carry a local timestamp. Ctrl-C stops the conductor (its background commands too); a
second Ctrl-C, or 15 seconds without finishing, forces the exit.

Then `/help` in the chat. The usual loop:

- `/next [agent] [id]`: confirm, and the implementing agent starts on the first `PLAN.md` "Next"
  item (or the given one)
- after a turn that committed, the gate runs; a failure goes back to the agent once
- when the gate passes, the feedback agent (`roles.feedback`, if set) checks the work and reports;
  the implementer fixes and commits, the gate runs, and this repeats up to `[flow]
  feedback_rounds` times (default: one per agent); a list such as `["glm", "glm", "mm"]` gives each
  round the next agent, a repeat rechecks the fixes in the same session, and a new agent checks the
  work afresh; a clean verdict skips the current agent's remaining rechecks and moves on to the
  next agent; `/feedback [agent]` adds a round
- then the review starts by itself and its findings are posted
- `/fix [notes]`: the reviewer fixes and commits, the gate runs again
- `/continue [role] [notes]` resumes a turn that stopped early (a provider error, `/stop`, a
  restart); a failed or interrupted turn says so with this hint
- `/review [agent] <id>` reviews work done outside the conductor, e.g. a task GLM finished in the
  TUI
- plain text goes to the current session; reply to an agent's message to reach that session
- `/gate` runs the gate on the current session's commits by hand and continues from there (the
  review starts after an implementation), e.g. after fixing something yourself

Every turn the conductor starts posts its prompt under the "implementing…", "fixing…" line as a
collapsed quote (cut at one message), so you can see what the agent was told.

If the conductor stops during a turn (a crash, Ctrl-C), the next start reports how that turn went:
one still running in opencode is followed as usual; one that ended while the conductor was down gets
its reply, log, gate and review as if nothing happened; a Claude Code turn dies with the conductor
and is reported as interrupted, ready for `/continue`.

When opencode resumes a session by itself (a background job the agent started finished), the
conductor posts that and handles the end of that turn like any other: reply, log, gate, review. A
turn that ends while its own background jobs still run (an agent waiting on a test run it started)
is not taken as finished: the conductor names the jobs and waits for that resume instead of moving
on to the gate, feedback or review. If another turn is running when a session resumes, only the
reply and the log are handled, with a warning that two agents are in the tree. Commits are checked
against the last commit the conductor saw for the session, so a commit made in such a turn (or one
it missed) is still picked up at the end of the next one.

`/chat [new] [agent] <message>` talks about the project in a separate read-only session (Claude Code
plan mode, opencode's `plan` agent) that runs alongside the task flow: reply to its messages to
continue, `/chat new` starts over, `/stop chat` interrupts it, `/chat stop` closes it (the log
stays). It uses `roles.chat` (default: the planning agent), survives `/next`, and logs to
`<task-id>-chat-<tag>.md` (`chat-<date>-<tag>.md` with no task). A Claude Code agent that tries to
hand in a plan there (`ExitPlanMode`) is told nobody sees it and asked to put it in its reply.

`/summary [implement|feedback|review|plan|chat] [agent]` has a one-off read-only session
(`roles.summary`, default: the chat agent) read the running session's log, or the focused one's, and
post what is going on: goal, progress, the current step, problems.

`/todo` lists the `PLAN.md` "Next" items (`/todo <id>` shows one in full) without an agent.
`/plan [agent] [topic]` opens a discussion that may edit only `PLAN.md`; `/plan done` has the agent
write the items and commit `PLAN.md` with a message following the project's rules. Whenever a
planning turn commits (also when you asked for the commit in plain text), the conductor shows the
commit, warns about files other than `PLAN.md`, offers to undo it and, when kept, names the `/next`
item. A `/plan done` with nothing left to write lists the session's earlier planning commits.
`/plan` also works while a task runs (implementation, feedback, the gate, the review, or an agent
waiting on its background jobs): its turns are then read-only, so the agent drafts items in its
replies, and `/plan done` is refused until the task is idle. Each planning turn after commits
landed starts with their list and asks the agent to re-read `PLAN.md` and point out adjustments.
The planning session runs beside the task flow (reply to its messages; plain text keeps going to
the task, `/stop plan` interrupts it) and survives `/next`.
`/status`, `/stop`, `/agents` and `/log` do what they say.

Project commands come from `[commands.<name>]` in `CONDUCTOR.toml` (`cmd`, `description`,
`confirm` for a yes/no button first, `background` for long-running ones, `ready` a regular
expression: a background command reports its output from the first matching line, e.g. its URL,
instead of a snapshot five seconds after the start). Text after the command
is appended to `cmd`. A one-shot command reports its exit status and output tail (full log
attached when long) and waits for no agent turn or gate to be running; a background one starts
with `/<name>`, shows its status when sent again and stops with `/<name> stop` (the whole process
group). The conductor stops its background commands when it exits (Ctrl-C, SIGTERM, a closed
terminal, a `409`); one left over from a run that could not (killed, crashed) is stopped at the
next start through its `state/commands/<name>.pid`. Output logs are in `state/commands/`. Agents
never run these.

Agent replies are rendered from markdown to Telegram HTML (headings, bold, code blocks, lists,
links, quotes, tables as preformatted text); a chunk Telegram rejects is resent as plain text.
Command output is posted as a code block, cut to its newest lines. Telegram calls that fail on the
network are retried for about three minutes.

Logs land in the project's `wlog/` as `<task-id>-<tag>.md`, `<task-id>-feedback-<tag>.md`,
`<task-id>-review[-plan]-<tag>.md`, `<task-id>-chat-<tag>.md` and `<task-id>-plan-<tag>.md` (named
after the task current when `/plan` opened it; `plan-<date>-<topic>-<tag>.md` with none), in
opencode's `/export` layout for both harnesses. A new chat or planning session whose log name is
taken gets a `-2`, `-3`, ... suffix. The header carries a `**Tokens:**` line for the session and
each user turn a `**Turn tokens:**` line (steps, input, output with reasoning, cache reads and
writes, the largest context one step sent, compactions), so token use survives the sessions.

## Checks

    npm run check   # tsc --noEmit
    npm test        # node --test

## Status

Prototype, in daily use on bane over Telegram: GLM-5.3 implements, DeepSeek V4.1 Flash runs the
feedback check, Opus 5.5 reviews, chats and plans.

Known gaps:

- the gate cannot be interrupted
- a turn that fails on a provider network error stays failed: `/continue` resumes it, nothing
  retries by itself
- the planning session's "PLAN.md only" rule is checked after each turn, not enforced (its
  read-only turns while a task runs are)
- tool outputs in logs are not shortened
