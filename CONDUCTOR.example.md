# Conductor

Configuration for the conductor bridge (`../conductor`): which agents implement, review and plan,
the verification gate it runs after every committing turn, the prompts it sends, and project
commands (`/deploy`, `/serve`) that only run when sent from the chat. The bridge parses the one
`toml` block below (fenced with four backticks so prompts may contain code fences); everything else
here is for people.

````toml
[gate]
build = "cmake --build --preset desktop"
test = "ctest --preset desktop"

[roles]
implement = "dsf"
review = "opus"
plan = "opus"

[agents.glm]
harness = "opencode"
model = "zai-coding-plan/glm-5.3"
variant = "default"
tag = "glm53"

[agents.ds]
harness = "opencode"
model = "deepseek/deepseek-v4-pro"
variant = "default"
tag = "deepseek4pro"

[agents.dsf]
harness = "opencode"
model = "deepseek/deepseek-flash"
variant = "default"
tag = "deepseek41flash"

[agents.opus]
harness = "claude"
model = "claude-opus-5-5"
effort = "medium"
tag = "opus55"

[logs]
dir = "wlog"

[commands.deploy]
cmd = "deploy/deploy.sh"
description = "git push, build and upload images, update the VPS"
confirm = true

[commands.serve]
cmd = "cmake --build build-wasm && exec deploy/serve.py"
description = "rebuild wasm and serve it over https with a local game server"
background = true
ready = "open https://"

[prompts]
implement = "please do {id}"
review = "please review {id}"
fix = "please fix all issues, commit"
fix_notes = "please fix {notes}; then commit"
gate_failed = """
The verification gate failed after your last turn (step `{step}`). Fix it and commit. \
Output tail:

```
{output}
```"""
plan = """
Planning discussion{topic}. You may read the repository, but edit only PLAN.md: no code \
changes and no commits. Discuss with me first; I will say when to write the items down."""
plan_done = """
Please write the agreed items into PLAN.md now and commit only PLAN.md, following the \
project's commit message rules."""
chat = """
This is a read-only chat about the project. Another agent may be working in this tree right \
now, so uncommitted changes may be theirs. Do not edit files or run anything that changes \
state.

{message}"""
summary = """
Read {log}: the log of the {role} session for {task}, possibly still running. It can be long, \
so start from the end and read back only as far as you need. Then tell me in a few short \
bullets: the goal, what is done, what it is doing right now, and any problems or open \
questions. Change nothing."""
````
