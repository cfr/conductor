# Conductor design

A Telegram bridge that drives the iteration loop (one agent implements, another reviews and
fixes) from one chat, so sessions no longer need manual renaming, exporting or switching between
tmux windows. Written for bane's workflow; nothing in it is bane-specific beyond the defaults.
Status: prototype (see README "Status").

## Task ids

Every task has an id `<task-number>-<few-words-description>`, e.g. `0038-capsule-primitives`:
the number is the `PLAN.md` "Next" item and the commit tag (`#0038`), the words are a short
kebab-case slug. The id names everything the task produces:

- agent session titles: `0038-capsule-primitives` (implementation), `0038-capsule-primitives
  feedback` (feedback checks), `0038-capsule-primitives review` (review and fixes)
- logs: `wlog/<id>[-<step>]-<agent-log-name>.md` (see "Logs")
- commits: tagged `#0038` as `AGENTS.md` requires

The id is the PLAN item's heading (`0038-capsule-primitives`); `/next` shows it with the item
text before work starts.

## Agents

Each project carries its own config in `CONDUCTOR.toml` at the repo root, next to `AGENTS.md`;
notes for humans are TOML comments. Commands pick an agent by name, or fall back to the role
default.

```toml
[gate]
build = "cmake --build --preset desktop"
test = "ctest --preset desktop"

[roles]
implement = "glm"
review = "opus"
plan = "opus"

[agents.glm]
harness = "opencode"
model = "zai-coding-plan/glm-5.3"
tag = "glm53"

[agents.ds]
harness = "opencode"
model = "deepseek/deepseek-v4-pro"
variant = "default"
tag = "deepseek4pro"

[agents.opus]
harness = "claude"
model = "claude-opus-5-5"
tag = "opus55"
```

- `harness` picks the adapter: `opencode` (model ids as `opencode models` prints them,
  `provider/model`) or `claude` (Claude Code model ids or aliases).
- `effort` (optional, `claude` only) sets the Claude Code effort level (`low` to `max`).
- `permission_mode` (optional, `claude` only, default `auto`): the Claude Code permission mode.
  SDK sessions would otherwise start in `default`, which asks for every write command, while
  interactive sessions run in `auto`. `bypassPermissions` is not accepted.
- `variant` (optional, `opencode` only) picks the model variant opencode offers (`default`, or
  e.g. `low`/`high`/`max` thinking); checked against opencode's model list when a session starts.
- `[prompts]` overrides the text sent at each step (`implement`, `review`, `fix`, `fix_notes`,
  `feedback`, `feedback_again`, `feedback_fix`, `continue`, `gate_failed`, `plan`, `plan_done`,
  `plan_read_only`, `plan_moved`, `chat`, `summary`; `CONDUCTOR.example.toml` lists the
  defaults); `{id}`, `{num}`, `{base}`, `{notes}`, `{step}`, `{output}`, `{findings}`, `{reply}`,
  `{topic}`, `{message}`, `{log}`, `{role}`, `{task}`, `{state}`, `{running}` and `{commits}` are
  filled in. `[logs] dir` sets the log directory (default `wlog`).
- `tag` names the model everywhere it shows: the suffix in `wlog/` file names (so existing
  names like `glm53` and `opus55` carry on) and the prefix of chat messages (`[glm53 0038]`).
- `[gate]` is the verification the bridge runs after each committing step, in order; a
  non-zero exit fails it.
- Machine-specific settings stay out of the repo, in the bridge's own gitignored
  `../conductor/config.toml`: the project path, the bot token and the allowed Telegram user id.
- The bridge checks the config at start: unknown harness, an `opencode` model missing from
  `opencode models`, duplicate tags or a role naming an unknown agent are errors.

## Flow

The same loop as today, one command per step, with the bridge doing the bookkeeping:

1. `/next [agent] [id]`: the bridge reads the first `PLAN.md` "Next" item (or the given
   id), shows the id, the item text and the agent, and on confirmation starts a session with
   that agent (default `roles.implement`) titled with the id and the prompt `please do <id>`.
2. The agent implements and commits. When the session goes idle the bridge runs the
   verification gate itself (`[gate]` in `CONDUCTOR.toml`; here desktop build + `ctest`).
   - Gate fails: the bridge sends the failure output back to the same session once ("the gate
     failed, fix it: ..."), then runs the gate again. A second failure is reported and the
     task waits for me.
   - Gate passes: the bridge posts the commit title and body, the diff stat, the gate outcome
     and the agent's final message, with the full diff attached as a file, and goes on to the
     feedback check (when configured) or straight to step 3.
   - Feedback (`roles.feedback`, one agent or a list, up to `[flow] feedback_rounds` times, default
     one per listed agent, 0 to skip): a cheaper agent checks the commits against a checklist (plan
     steps and their evidence, stale or rule-breaking comments, unsupported CHANGELOG claims,
     formatting and tests, provable bugs) and only reports, ending with `VERDICT: clean` or
     `VERDICT: findings`. Findings go to the implementing session, which fixes what holds, rejects
     the rest with a reason and commits; the gate runs and the next round checks the answer in the
     same feedback session, or, when the list names another agent for it, starts a fresh check with
     that agent. A clean verdict or an answer without commits moves on to the next listed agent, and
     to step 3 when none is left; so does the last round. Mechanical misses get fixed before the
     expensive review, and the code stays the implementer's: the checker never edits. `/feedback
     [agent]` runs one more round by hand.
3. Auto-review: the bridge starts a review session (`roles.review`) with `please review <id>`
   (the same context `AGENTS.md` gives an interactive session) and posts the findings.
   Reviewing does not touch the tree, so it needs no confirmation. `/review [agent]` starts or
   restarts a review by hand, e.g. with a different agent, or after a gate failure I fixed
   myself.
4. `/fix` (optionally with notes, e.g. `/fix skip 3, item 1 can be a follow-up`): the reviewer
   applies the fixes in the same session and commits; the bridge runs the gate again (same
   one-retry rule) and posts the result. This step always waits for me, since it commits.

`CHANGELOG.md` stays with the agents, as today: the implementing agent moves its item from
`PLAN.md` "Next" to `CHANGELOG.md` in its commit (`AGENTS.md` asks for that), and the reviewer
updates that entry with its fixes in the `/fix` commit. The bridge does not edit either file.

A turn that ends without a new commit (a question, or findings) is posted and waits; the gate
runs only after turns that committed. While an agent runs, other commands that would start a turn
are refused with the reason; questions from the running agent are still answered.

Any step can be followed by free text, which goes to the session that step talks to, so a
review can turn into a discussion before `/fix`. Logs are exported throughout (see "Logs").

## Commands

- `/next [agent] [id]`: start the next PLAN item (or a given one) with an agent from the
  config; arguments are told apart by shape (an id starts with digits)
- `/review [agent] [id]`, `/fix [notes]`, `/feedback [agent]`: as above, for the current task
  (`/review <id>` also takes a task done outside the conductor)
- `/continue [role] [notes]`: resume a turn that stopped early (an error, `/stop`, a restart)
- `/gate`: run the gate on the current session's commits by hand, then continue as after a turn
- `/todo [id]`: list the `PLAN.md` "Next" items, or show one in full
- `/plan [agent] [topic]`, `/plan done`: a planning discussion (see below)
- `/chat [new] [agent] <message>`, `/chat stop`, `/summary [role] [agent]`: see "Chat"
- `/agents`: list configured agents and role defaults
- `/status`: current task, step, which agent is running, last gate result
- `/stop [chat|plan]`: interrupt the running agent (or the chat, or the planner)
- `/log`: export the current sessions to `wlog/` now
- `/<name> [args]`, `/<name> stop`: project commands from `[commands]` (see README)
- plain text: goes to the agent of the current step; a Telegram reply to an agent's message goes
  to that message's session, whatever the current step is

## Logs

Export is automatic: the bridge rewrites the session's log file every time the session goes
idle, so `wlog/` is always current, even for a task that is abandoned halfway. The file name:

    wlog/<task-id>[-<step>]-<tag>.md

- `<step>` is empty for the implementation session, `feedback` for the feedback checks,
  `review` for review and fixes, and
  `review-plan` when the review session also edited `PLAN.md` (a `/plan` discussion inside
  the review, which is what `-review-plan-` means in today's names). A `/plan` session
  writes `wlog/<task-id>-plan-<tag>.md`, or `wlog/plan-<date>-<topic>-<tag>.md` when there is no
  current task; `/chat` writes `wlog/<task-id>-chat-<tag>.md` (`chat-<date>-<tag>.md`). A new
  chat or planning session whose name is taken gets a `-2`, `-3`, ... suffix.
- `<tag>` is the agent's `tag` from the config.
- A second session for the same step (a review restarted with another agent) gets its own file
  through its different suffix; a restart with the same agent overwrites the file, and the
  bridge says so.

Both harnesses are rendered by the bridge into one markdown shape, the one opencode's `/export`
produces today (the renderer reproduces `0047-sand-pits-glm53.md` byte for byte from the session
export):

    # <session title>
    **Session ID:** ... **Created:** ... **Updated:** ... **Tokens:** ...
    ## User / ## Assistant blocks, _Thinking:_, **Tool: <name>** with **Input:** (json)
    and the tool output; each ## User starts with its turn's **Turn tokens:**

- opencode: `opencode session export <id>` (or the server's export endpoint) gives the full
  session as JSON; the renderer turns it into the format above, so GLM logs look as they do now.
- Claude Code: the session transcript `~/.claude/projects/<project>/<session-id>.jsonl` has the
  same content (user and assistant messages, thinking, tool use and results, timestamps,
  custom title). The renderer reads it into the same format.

This changes how Opus logs look: today's are Claude Code's `/export`, a plain-text screen
render with collapsed tool calls ("Searched for 4 patterns ..."). The new ones are markdown
with every tool call and its input expanded, like the GLM logs: larger files, but greppable and
the same layout for every agent. Long tool outputs are cut to a configurable number of lines
(full output stays in the agent's own session store). Not implemented yet: the prototype keeps
full outputs, as opencode's export does.

The review step becomes `review-plan` when `PLAN.md` differs from the commit the review session
started at (committed or not); the file is renamed on the next export.

## Agent questions

Agents block in two ways and both must reach the chat:

- **Structured questions and permission prompts.** Opencode's server streams permission
  requests as events; Claude Code (through the Agent SDK) calls back on `AskUserQuestion` and
  on tool permissions. The bridge posts these with inline buttons (the offered options, or
  allow/deny) plus "answer in text"; the agent waits until I answer. No timeout: a forgotten
  question just keeps the task in a waiting state, which `/status` shows.
- **A question at the end of a turn** ("should I also ...?"). The session goes idle with a text
  reply; the bridge posts it marked as a question-or-done message and my next plain text (or a
  reply to it) continues that session. A question at the end of the implementation turn holds
  the gate and auto-review until I answer or send `/review`.

Every agent message is prefixed with the agent tag and task (`[glm53 0038]`, `[opus55 0038]`) so
one chat stays readable.

## Chat

`/chat [new] [agent] <message>` opens or continues a read-only session for questions about the
project while a task runs: Claude agents run it in plan mode (with `ExitPlanMode` and the edit
tools refused; the refusal asks for the plan in the reply, since nobody sees it), opencode agents
with its read-only `plan` agent, and its first message says another agent may be changing the
tree. It has its own busy flag, so it never waits for or blocks the task flow, and it is not reset
by `/next`. Replies to its messages reach it; plain text keeps going to the task.

`/summary [role] [agent]` asks how a session is going without disturbing it: the conductor exports
that session's log as it stands (the running one by default, else the focused one), and a fresh
read-only session of `roles.summary` (default: the chat agent) reads it from the end and answers
in a few bullets. The summary session is one-off: not kept in state, not logged, not resumed.

## Planning discussion

`/plan [agent] [topic]` opens a session (default `roles.plan`) that may read the repo and edit
only `PLAN.md` (no code). It commits on `/plan done`, or when asked to in plain text; the bridge
handles both the same way. The conversation runs in the chat like any other session.
`/plan done` asks the agent to write the agreed items into `PLAN.md` and commit it (the agent
knows what changed and follows the project's commit rules); the bridge posts the commit message
and diff, warns if the commit touches more than `PLAN.md`, and offers keep / undo commit (`git
reset --keep`, only while HEAD is still that commit).

The session runs beside the task flow and survives `/next`. While a task runs (any turn, the gate,
the steps between them, or a session waiting on its background jobs), a planning turn is read-only
(Claude plan mode with edit tools refused, opencode's `plan` agent), its message starts with
`plan_read_only`, and `/plan done` is refused: the implementer moves its item out of `PLAN.md`
and commits the tree, so the two must not edit it at once. A planning turn after other commits
landed starts with `plan_moved` (their list), so the agent re-reads `PLAN.md` before going on.

## Shape

- A small, deterministic bridge process (not an LLM session): Telegram long-polling, the agents
  config, a state file (current task, step, session ids, agent per session), and one adapter per
  harness. It relays and runs commands; it never paraphrases agent output.
- Telegram credentials (`[telegram] token`, `allowed_user_id`) live in the bridge's
  `config.toml`. Telegram allows one `getUpdates` poller per token (a second gets `409
  Conflict`), so the bridge and opencode-telegram-bot cannot run at the same time on one token.
  For now they share it: stop the old bot while the bridge runs. If both are needed at once
  later, register a second bot and give the bridge its token with the same allowed user id.
- `opencode` adapter (v2 HTTP API): turn end is `session.execution.{succeeded,failed,
  interrupted}` on `/api/event`, with a `GET /api/session/{id}` poll as fallback; questions are
  `permission.asked` and `form.created`. It talks to the shared background service the way
  `~/Code/opencode-telegram-bot/otg.sh` does (`opencode service start`,
  `http://127.0.0.1:49374`, password from `opencode service get password`), not a private
  `opencode serve`, so bridge sessions also show up in the TUI.
- `claude` adapter: Claude Code via the Agent SDK, one `query()` per turn (`sessionId` on the
  first, `resume` after), with the `claude_code` system prompt preset and the agent's
  `permission_mode` (`plan` for read-only turns). `canUseTool` receives permission prompts and
  `AskUserQuestion`, whose answers go back as `updatedInput.answers`.
- tmux stays useful for watching: the bridge runs in a pane, and sessions can still be resumed
  locally from their ids.

## Rules the bridge enforces

- Only `telegram.allowed_user_id` is accepted; everything else is ignored.
- One agent writes to the tree at a time (the "no edits during parallel agent" rule as a lock);
  a step that would overlap is refused with the reason. Auto-review starts only after the
  implementation session is idle and its gate run is done.
- Agents never push or deploy from the bridge. Project commands (`[commands]` in `CONDUCTOR.toml`,
  e.g. `/deploy`, `/serve`) run only when I send them, with a confirmation button where
  `confirm` is set, and a one-shot command never overlaps an agent turn or the gate.
- The bridge's own gate run is the result it reports, not the agent's claim.
- Long output (diffs, logs, gate failures) goes as attached files; command output is posted as
  a code block cut to its newest lines; messages stay under Telegram's 4096-character limit.

## Open questions

None right now.
