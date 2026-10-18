# conductor

opencode/Claude Code/Telegram orchestration tool.

From one Telegram chat, one agent implements a `PLAN.md` item, the bridge runs the project's
verification gate, a second agent reviews, and `/fix` applies the review. Agents run through
opencode (its background service) or Claude Code (the Agent SDK); every session is exported to
markdown after each turn. See `DESIGN.md` for the flow and its reasons.

## Setup

Node 24 or newer (TypeScript runs directly through Node's type stripping, no build step).

    npm install
    cp conductor.example.toml conductor.toml   # set project and the Telegram env file

The project needs a `CONDUCTOR.md` at its root with one `toml` block: gate commands, agents,
roles and optional prompts. `CONDUCTOR.example.md` is the one for bane.

Telegram credentials come from the env file named in `conductor.toml` (`TELEGRAM_BOT_TOKEN`,
`TELEGRAM_ALLOWED_USER_ID`); messages from any other user are ignored. Only one process may poll a
bot token, so stop opencode-telegram-bot while the conductor runs on the same token (the
conductor exits with a message on `409 Conflict`).

## Run

    npm start

Then `/help` in the chat. The usual loop:

- `/next [agent] [id]`: confirm, and the implementing agent starts on the first `PLAN.md` "Next"
  item (or the given one)
- after a turn that committed, the gate runs; a failure goes back to the agent once
- when the gate passes, the review starts by itself and its findings are posted
- `/fix [notes]`: the reviewer fixes and commits, the gate runs again
- `/review [agent] <id>` reviews work done outside the conductor, e.g. a task GLM finished in the
  TUI
- plain text goes to the current session; reply to an agent's message to reach that session
- `/gate` runs the gate on the current session's commits by hand and continues from there (the
  review starts after an implementation), e.g. after fixing something yourself

When opencode resumes a session by itself (a background job the agent started finished), the
conductor posts that and handles the end of that turn like any other: reply, log, gate, review.
Commits are checked against the last commit the conductor saw for the session, so a commit made
in a turn it missed is still picked up at the end of the next one.

`/todo` lists the `PLAN.md` "Next" items (`/todo <id>` shows one in full) without an agent.
`/plan [agent] [topic]` opens a discussion that may edit only `PLAN.md`; `/plan done` writes the
items and offers commit / keep / discard. `/status`, `/stop`, `/agents` and `/log` do what they
say.

Project commands come from `[commands.<name>]` in `CONDUCTOR.md` (`cmd`, `description`,
`confirm` for a yes/no button first, `background` for long-running ones). Text after the command
is appended to `cmd`. A one-shot command reports its exit status and output tail (full log
attached when long) and waits for no agent turn or gate to be running; a background one starts
with `/<name>`, shows its status when sent again and stops with `/<name> stop` (the whole process
group). Output logs are in `state/commands/`. Agents never run these.

Agent replies are rendered from markdown to Telegram HTML (headings, bold, code blocks, lists,
links, quotes, tables as preformatted text); a chunk Telegram rejects is resent as plain text.

Logs land in the project's `wlog/` as `<task-id>-<tag>.md`, `<task-id>-review[-plan]-<tag>.md`
and `<task-id>-plan-<tag>.md` (`plan-<date>-<topic>-<tag>.md` with no current task), in
opencode's `/export` layout for both harnesses.

## Checks

    npm run check   # tsc --noEmit
    npm test        # node --test

## Status

Prototype. Driven end to end headlessly (a fake chat) against a throwaway repo: implement with
GLM-5.3 flash, gate, gate failure handed back and fixed, auto-review and `/fix` with Haiku 5.5
(including a permission prompt), log export. Not yet run against Telegram itself.

Known gaps:

- the gate cannot be interrupted, and a bridge restart in the middle of a turn loses that turn
  (sessions themselves resume)
- the planning session's "PLAN.md only" rule is checked after each turn, not enforced
- tool outputs in logs are not shortened
