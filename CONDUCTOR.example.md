# Conductor

Configuration for the conductor bridge (`../conductor`): which agents implement, review and plan,
the verification gate it runs after every committing turn, and the prompts it sends. The bridge
parses the one `toml` block below; everything else here is for people.

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

[agents.deepseek]
harness = "opencode"
model = "deepseek/deepseek-v4-pro"
tag = "deepseek4pro"

[agents.opus]
harness = "claude"
model = "claude-opus-5-5"
tag = "opus55"

[logs]
dir = "wlog"

[prompts]
implement = "please do {id}"
review = "please review {id}"
fix = "please fix all issues, commit"
```
