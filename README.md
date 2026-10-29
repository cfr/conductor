# conductor

A Telegram bridge for developing a local project with opencode, Codex CLI, and Claude Code.
Agents implement `PLAN.md` tasks, check each other's work, review changes, and apply fixes.
Conductor runs the project's verification gate, tracks findings and repair commits, and exports
session logs and token usage. Agents and role defaults belong to the project; models can be mixed
across harnesses. See [DESIGN.md](DESIGN.md) for the architecture.

## Setup

Use Node 24 or newer. Node runs the TypeScript source directly; there is no build step.

```sh
npm install
cp config.example.toml config.toml
```

Edit `config.toml` with the project path, Telegram bot token, and your numeric Telegram user ID.
It is gitignored because it contains the token. Only the configured user can control the bot.
One process may poll a bot token at a time; stop any other bot using it. Conductor exits on a
Telegram `409 Conflict`.

Install and authenticate the harnesses you intend to use:

| Harness | Execution |
| --- | --- |
| `opencode` | Connects to its shared local background service; sessions also appear in its TUI. |
| `codex` | Uses `codex exec --json` and `exec resume`. Sign in with `codex login`. |
| `claude` | Runs Claude Code through the Anthropic Agent SDK. |

Conductor can start without a separate Claude Code installation and does not launch a Claude
process merely because the adapter exists. A Claude process starts only when a Claude session
gets a turn. The Anthropic SDK npm dependency is still required because it is imported at startup.
Saved sessions refer to configured agent names; keep those definitions while using the sessions.

The target project needs `PLAN.md` with a `## Next` list and `CONDUCTOR.toml` at its root.
[CONDUCTOR.example.toml](CONDUCTOR.example.toml) is a starting template based on bane, rather than
a copy of its current live configuration. Adjust its models, gate, and commands for your project.

## Configuration

The two configuration files serve different purposes:

| File | Contents |
| --- | --- |
| Conductor's `config.toml` | Project path, Telegram credentials, state path and opencode URL. |
| Project's `CONDUCTOR.toml` | Gate, agents, roles, feedback rounds, commands and prompts. |

Each `[agents.<name>]` selects a `harness`, `model`, and unique `tag`. The name selects the agent
in commands; the tag prefixes replies and names logs. For opencode, model IDs use `provider/model`
and `variant` optionally selects a model variant. Claude and Codex accept optional `effort`.
Claude also accepts `permission_mode`; see the example and [DESIGN.md](DESIGN.md).

Roles reference those names. For example, using agents defined in the example configuration:

```toml
[roles]
implement = "glm"
feedback = ["glm", "dsf"]
review = "codex"
plan = "codex"
chat = "codex"
summary = "codex"
```

`implement`, `review`, and `plan` are required. `feedback` is optional: one agent name or an ordered
list. `chat` defaults to `plan`; `summary` defaults to `chat`. Commands can override the default
agent, for example `/next glm`, `/review codex`, or `/chat codex explain this subsystem`.

Gate entries run in order; the first nonzero exit fails the gate. Use the project's complete
verification command. Bane, for example, checks both debug and release builds and test suites:

```toml
[gate]
all = "tools/check all"
```

Conductor reloads project configuration when commands such as `/next`, `/review`, and `/plan`
start. Existing sessions retain their selected agent. Restart conductor after adding command
names or aliases because Telegram handlers are registered at startup. Machine settings and code
changes also require a restart.

## Run and task flow

```sh
npm start
```

Set `CONDUCTOR_CONFIG` to use a different local config file. Console messages carry local
timestamps. Ctrl-C stops conductor and its managed project commands; a second Ctrl-C or a
15-second shutdown timeout forces exit.

The normal loop is:

1. `/next [agent] [id]` shows the selected `PLAN.md` item and asks for confirmation. Without an
   ID it takes the first item under `## Next`. The agent implements and commits.
2. Conductor runs the gate after a committing turn. A failure goes back to the agent once;
   a second failure waits for you. A turn without a commit normally waits for your response.
3. Feedback agents check in the configured order. Actionable findings go to the implementer,
   which records dispositions and commits repairs. Conductor gates those commits before the next
   check. Later checkers receive earlier findings, rejection reasons, repairs, and gate evidence.
4. The review agent checks the combined result. `/fix [notes]` asks that reviewer to apply fixes
   and commit; conductor runs the gate again. Review fixes require your instruction, normally `/fix`.

`[flow] feedback_rounds` defaults to the number of feedback agents; `0` skips feedback. Repeated
names allow rechecks in the same session. A clean verdict or an answer without commits skips
remaining consecutive rounds for that agent and moves to the next listed agent. If more rounds
are configured than names, the last agent repeats. `/feedback [agent]` adds a check manually.

Agents follow the project's instructions for commits and for moving completed tasks from
`PLAN.md` to `CHANGELOG.md`. Conductor does not edit those files. Gate output, commit summaries,
and diffs are posted to Telegram; long outputs are attached as files. Prompts are shown as
collapsed quotes so you can inspect what the agent received.

## Commands

| Command | Purpose |
| --- | --- |
| `/next [agent] [id]` | Start the next or specified task, with confirmation. |
| `/review [agent] [id]` | Review the current task or adopt work done outside conductor. |
| `/fix [notes]` | Apply review fixes in the reviewer session. |
| `/feedback [agent]` | Run another feedback check. |
| `/continue [role] [notes]` | Resume a stopped turn or complete a pending report. |
| `/gate` | Verify the focused implementation/review session's commits and continue the flow. |
| `/todo [id]` | List Next items or show one in full, without an agent. |
| `/plan [agent] [topic]` | Start or continue planning. |
| `/plan done` | Write agreed items and commit `PLAN.md`. |
| `/chat [new] [agent] <message>` | Start or continue a separate read-only chat. |
| `/chat stop` | Close that chat; its log stays. |
| `/summary [role] [agent]` | Ask a fresh read-only session to summarize a session log. |
| `/status` | Show the task, running/pending work, sessions, and last gate. |
| `/stop [chat\|plan]` | Interrupt a running agent, chat, or planner. |
| `/agents` | List configured agents and main role defaults. |
| `/log` | Export session logs and the current finding summary. |
| `/help` | Show commands, including configured project commands. |

Roles accepted by `/continue` are `implement`, `feedback`, `review`, and `plan`; `/summary` also
accepts `chat`. Plain text goes to the focused task session. Reply to an agent's Telegram message
to reach that session directly. Markdown replies are rendered as Telegram HTML, with plain-text
fallback; network failures are retried for about three minutes.

## Planning, chat, and summaries

Planning may read the repository and edit only `PLAN.md`. `/plan done` asks the agent to commit
that file; conductor shows the changes, warns about other touched files, and offers keep/undo.
While task work or its gate is running, planning turns are read-only and `/plan done` waits.
New commits are listed at the next planning turn so the planner can reread the plan. Planning
survives `/next` and has its own session.

Chat is a separate read-only session that can run alongside task work and also survives `/next`.
Claude uses plan mode with edit tools refused; opencode uses its `plan` agent; Codex uses the
read-only sandbox. `/chat new` starts a fresh session. Replies to chat messages reach it, while
ordinary text keeps going to the task.

Summaries use a fresh read-only session to read an exported log. They use `roles.summary`, default
to the running session or otherwise the focused session, and do not disturb it. Summary sessions
are not retained for later conversation.

## Project commands and aliases

Commands in `[commands.<name>]` run when you send them, independently of agent tool calls.
For example:

```toml
[commands.serve]
cmd = "cmake --build build-wasm && exec tools/serve.py"
description = "rebuild wasm and serve the client"
background = true
ready = "open https://"
aliases = ["server"]
```

`/serve` and `/server` control the same process; either name accepts `stop`. Aliases appear in
help but are omitted from the command menu. Text after a command is appended to its shell command.

`confirm = true` adds a confirmation button. One-shot commands wait for agent/gate work to be
idle and report exit status and output. Background commands return their status when sent again;
`ready` is an optional output regex used to report readiness, otherwise output is sampled after
five seconds. Conductor stops process groups on exit and reaps leftover managed processes at
startup using PID records. Logs and PID records live under `commands/` beside the state file.

## Pending work and recovery

An idle parent session can still have background work. For opencode, conductor checks shell jobs,
subagents and their descendants, queued inbox work, and completion processing. It waits until
notifications are delivered and the parent has processed them and become idle again. Foreground
subagent results can acknowledge completion inline.

The gate, a new task, and another feedback/review session cannot start while this work is pending.
`/status` names the outstanding work. Conductor rechecks every two seconds without sending model
prompts. Failed status lookups hold the workflow as unknown; they never imply that work finished.
`/continue <role>` can send instructions to the same waiting session.

Child IDs, message cursors, and waiting turns persist in state. Startup also rediscovers work
from opencode's durable transcript. If an unexpected writer resume overlaps another phase,
automation pauses. After pending work settles, `/gate` verifies the current tree and restarts
feedback; an older green result does not clear the conflict.

After a restart, opencode turns can still be running and are followed through completion. Claude
turns are reported as interrupted because their SDK process stops with conductor. Unfinished
Codex turns are also marked interrupted; `/continue` resumes the saved thread. Codex exec does
not expose detached-job notifications to this adapter.

## Findings and verification

Conductor appends validation guidance and report contracts even when project prompts are overridden.
Agents should demonstrate a regression failing without the fix, test real caller paths across
components, and exercise maximum supported bounds. If a demonstration is impractical, they must
explain why. These instructions help reviewers assess evidence; a green gate alone does not prove
test quality.

Conductor owns the full gate after commits. Checkers receive its SHA, commands, result, time, and
log path, plus whether it still matches the current tree. They should use that evidence and
focused experiments instead of repeating a green full gate on unchanged code.

Feedback and review return a readable report plus one fenced `conductor-feedback` JSON block:

```conductor-feedback
{
  "verdict": "findings",
  "findings": [{
    "key": "routing",
    "category": "bug",
    "summary": "Prediction is skipped",
    "location": "client.cpp:234",
    "evidence": "Late tick 99 completes after part 0 of tick 100"
  }],
  "verifications": []
}
```

The reply ends with matching `VERDICT: findings` or `VERDICT: clean`. Categories are `bug`,
`test_gap`, `docs`, and `process`. Conductor assigns IDs such as `0169-F01`. `relatedTo` links a
coverage gap to its bug; `duplicateOf` identifies a repeated finding. Both can reference a local
key or an existing ID. A clean report has no new, reopened, or unresolved actionable findings.

The implementer, or reviewer answering `/fix`, records a disposition for every requested ID:

```conductor-dispositions
{
  "dispositions": [{
    "id": "0169-F01",
    "status": "fixed",
    "reason": "Changed routing; the regression fails without the fix"
  }]
}
```

Dispositions are `fixed`, `rejected`, or `deferred`, with reasons. Fixed claims are linked to actual
repair commits. A later checker separately assesses them in `verifications`, using `id`, `status`
(`verified`, `open`, or `accepted_rejection`), and `reason`. Verification requires a different
session and a SHA containing the fixing commits. A clean verdict alone does not verify repairs;
fixes made through `/fix` remain pending verification until another review checks them.

Malformed or incomplete reports get one correction turn, then pause. Partial JSON is not applied;
the raw reply remains recorded as pending. Retry budgets survive restarts. Use `/continue feedback`,
`/continue implement`, or `/continue review` to finish the corresponding report. `/gate` cannot
advance while dispositions are incomplete.

## Logs, usage, and state

The local `state` setting defaults to `state/state.json` beside conductor's config. Keep that state
directory to resume sessions and preserve finding history. Related directories such as `findings/`,
`codex/`, and `commands/` are stored beside the state file.

Project logs default to `wlog/`, configurable through `[logs] dir`:

| File | Contents |
| --- | --- |
| `<task>-<tag>.md` | Implementation transcript. |
| `<task>-feedback-<tag>.md` | Feedback transcript. |
| `<task>-review[-plan]-<tag>.md` | Review and fixes; `-plan` when review also touched `PLAN.md`. |
| `<task>-plan-<tag>.md`, `<task>-chat-<tag>.md` | Planning and chat transcripts. |
| `<log-basename>.usage.json` | Exact token counters and measurement provenance. |
| `<task>-findings.md` | Ledger summary, reports, session links, and checker outcome counts. |
| `<task>-gate.log` | Gate history, including SHA, commands, result, duration, and full output. |

Planning/chat names without a current task use a date; names are tied to the task when the session
opens. New planning/chat sessions get numeric suffixes if a filename is already taken.

The canonical ledger is `findings/<task>.json` beside conductor's state file. It preserves source
model/role/session/SHA, stable finding IDs, relationships, dispositions, repair commits, and
verification history. Markdown summaries are regenerated from it, including by `/log`. Related test
gaps and duplicates are counted separately from defect groups. Historical logs are not backfilled.

Markdown token totals are rounded. `.usage.json` preserves exact reported counts and turn indices;
`unmeteredTurns` marks missing usage data. Cached input is separate from uncached input, and output
includes reasoning where reported by the harness. Codex supplies aggregate turn usage, so its
model-step count and maximum single-request context are unavailable (`null` in JSON). Old saved
Codex sessions receive this correction when resumed. Historical Markdown is not automatically
rewritten.

## Codex permissions

Read-only turns deny escalation. Writable turns use the workspace-write sandbox with on-request
approvals routed through Codex's automatic approval reviewer. This allows approved Git operations
on the protected `.git` directory while keeping denied operations blocked. Exec cannot relay
interactive permission prompts to Telegram; questions in agent replies can be answered next turn.

## Checks and current limits

```sh
npm run check  # TypeScript
npm test       # Node test runner
```

Conductor is a prototype used for bane's development. Current limits include:

- The verification gate cannot be interrupted through `/stop`.
- Provider failures require `/continue`; they are not retried automatically. Report-format
  correction retries and pending-work status rechecks are separate mechanisms.
- The planner's `PLAN.md`-only write rule is checked after the turn rather than enforced as a
  file-specific permission boundary. Planning during task work is read-only.
- Tool output in exported transcripts is not shortened.
- Pending subagent/inbox inspection currently depends on opencode's v2 API; other adapters do not
  expose the same detached-work lifecycle.
