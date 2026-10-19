# Conductor

Configuration for the conductor bridge (`../conductor`): which agents implement, review and plan,
the verification gate it runs after every committing turn, the prompts it sends, and project
commands (`/deploy`, `/serve`) that only run when sent from the chat. The bridge parses the one
`toml` block below; everything else here is for people.

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
```
