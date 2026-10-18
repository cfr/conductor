import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractTomlBlock, fill, parseEnvFile, parseProjectConfig } from '../src/config.ts';

const md = (toml: string) => `# Conductor\n\nprose\n\n\`\`\`toml\n${toml}\n\`\`\`\n`;

const base = `
[gate]
build = "make"
test = "make test"

[roles]
implement = "glm"
review = "opus"
plan = "opus"

[agents.glm]
harness = "opencode"
model = "zai-coding-plan/glm-5.3"
tag = "glm53"

[agents.opus]
harness = "claude"
model = "claude-opus-5-5"
tag = "opus55"
`;

test('parses agents, roles, ordered gate and default prompts', () => {
    const c = parseProjectConfig('/repo', md(base));
    assert.deepEqual(c.gate.map((g) => g.name), ['build', 'test']);
    assert.equal(c.agents.get('glm')?.tag, 'glm53');
    assert.equal(c.roles.review, 'opus');
    assert.equal(c.logDir, '/repo/wlog');
    assert.equal(fill(c.prompts.implement, { id: '0048-antlion' }), 'please do 0048-antlion');
});

test('rejects duplicate tags, unknown roles and bad opencode models', () => {
    assert.throws(() => parseProjectConfig('/r', md(base.replace('tag = "opus55"', 'tag = "glm53"'))), /duplicate/);
    assert.throws(() => parseProjectConfig('/r', md(base.replace('review = "opus"', 'review = "x"'))), /unknown agent/);
    assert.throws(() => parseProjectConfig('/r', md(base.replace('zai-coding-plan/glm-5.3', 'glm-5.3'))), /provider\/model/);
    assert.throws(() => parseProjectConfig('/r', md(base.replace('harness = "claude"', 'harness = "x"'))), /harness/);
});

test('effort is claude-only, variant opencode-only', () => {
    const withVariant = base.replace('tag = "glm53"', 'tag = "glm53"\nvariant = "high"');
    assert.equal(parseProjectConfig('/r', md(withVariant)).agents.get('glm')?.variant, 'high');
    const withEffort = base.replace('tag = "opus55"', 'tag = "opus55"\neffort = "medium"');
    assert.equal(parseProjectConfig('/r', md(withEffort)).agents.get('opus')?.effort, 'medium');
    assert.throws(() => parseProjectConfig('/r', md(base.replace('tag = "opus55"', 'tag = "opus55"\nvariant = "high"'))), /variant/);
    assert.throws(() => parseProjectConfig('/r', md(base.replace('tag = "glm53"', 'tag = "glm53"\neffort = "high"'))), /effort/);
    assert.throws(() => parseProjectConfig('/r', md(base.replace('tag = "opus55"', 'tag = "opus55"\neffort = "huge"'))), /effort/);
});

test('needs exactly one toml block', () => {
    assert.throws(() => extractTomlBlock('no block'), /exactly one/);
    assert.throws(() => extractTomlBlock(md('a = 1') + md('b = 2')), /exactly one/);
});

test('env file parsing', () => {
    const env = parseEnvFile('# c\nTELEGRAM_BOT_TOKEN="1:abc"\nexport TELEGRAM_ALLOWED_USER_ID=42 # me\nX=\n');
    assert.equal(env.TELEGRAM_BOT_TOKEN, '1:abc');
    assert.equal(env.TELEGRAM_ALLOWED_USER_ID, '42');
    assert.equal(env.X, '');
});

test('project commands', () => {
    const extra = `
[commands.deploy]
cmd = "deploy/deploy.sh"
description = "release"
confirm = true

[commands.serve]
cmd = "deploy/serve.py"
background = true
`;
    const c = parseProjectConfig('/r', md(base + extra));
    assert.deepEqual(
        c.commands.map((x) => [x.name, x.confirm, x.background, x.description]),
        [['deploy', true, false, 'release'], ['serve', false, true, 'serve']],
    );
    assert.throws(() => parseProjectConfig('/r', md(base + '[commands.review]\ncmd = "x"\n')), /built-in/);
    assert.throws(() => parseProjectConfig('/r', md(base + '[commands.Deploy]\ncmd = "x"\n')), /lowercase/);
});
