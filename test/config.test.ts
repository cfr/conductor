import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fill, parseProjectConfig } from '../src/config.ts';

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
    const c = parseProjectConfig('/repo', base);
    assert.deepEqual(c.gate.map((g) => g.name), ['build', 'test']);
    assert.equal(c.agents.get('glm')?.tag, 'glm53');
    assert.equal(c.roles.review, 'opus');
    assert.equal(c.roles.summary, c.roles.chat);
    assert.equal(c.logDir, '/repo/wlog');
    assert.equal(fill(c.prompts.implement, { id: '0048-antlion' }), 'please do 0048-antlion');
});

test('rejects duplicate tags, unknown roles and bad opencode models', () => {
    assert.throws(() => parseProjectConfig('/r', base.replace('tag = "opus55"', 'tag = "glm53"')), /duplicate/);
    assert.throws(() => parseProjectConfig('/r', base.replace('review = "opus"', 'review = "x"')), /unknown agent/);
    assert.throws(() => parseProjectConfig('/r', base.replace('zai-coding-plan/glm-5.3', 'glm-5.3')), /provider\/model/);
    assert.throws(() => parseProjectConfig('/r', base.replace('harness = "claude"', 'harness = "x"')), /harness/);
});

test('effort is claude-only, variant opencode-only', () => {
    const withVariant = base.replace('tag = "glm53"', 'tag = "glm53"\nvariant = "high"');
    assert.equal(parseProjectConfig('/r', withVariant).agents.get('glm')?.variant, 'high');
    const withEffort = base.replace('tag = "opus55"', 'tag = "opus55"\neffort = "medium"');
    assert.equal(parseProjectConfig('/r', withEffort).agents.get('opus')?.effort, 'medium');
    assert.throws(() => parseProjectConfig('/r', base.replace('tag = "opus55"', 'tag = "opus55"\nvariant = "high"')), /variant/);
    assert.throws(() => parseProjectConfig('/r', base.replace('tag = "glm53"', 'tag = "glm53"\neffort = "high"')), /effort/);
    assert.throws(() => parseProjectConfig('/r', base.replace('tag = "opus55"', 'tag = "opus55"\neffort = "huge"')), /effort/);
    const withMode = base.replace('tag = "opus55"', 'tag = "opus55"\npermission_mode = "acceptEdits"');
    assert.equal(parseProjectConfig('/r', withMode).agents.get('opus')?.permissionMode, 'acceptEdits');
    assert.throws(() => parseProjectConfig('/r', base.replace('tag = "opus55"', 'tag = "opus55"\npermission_mode = "bypassPermissions"')), /permission_mode/);
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
ready = "open https://"
`;
    const c = parseProjectConfig('/r', base + extra);
    assert.deepEqual(
        c.commands.map((x) => [x.name, x.confirm, x.background, x.description]),
        [['deploy', true, false, 'release'], ['serve', false, true, 'serve']],
    );
    assert.equal(c.commands[1].ready?.test('  open https://x:9443/'), true);
    assert.throws(() => parseProjectConfig('/r', base + '[commands.d]\ncmd = "x"\nready = "y"\n'), /background/);
    assert.throws(() => parseProjectConfig('/r', base + '[commands.review]\ncmd = "x"\n'), /built-in/);
    assert.throws(() => parseProjectConfig('/r', base + '[commands.Deploy]\ncmd = "x"\n'), /lowercase/);
});

test('the example spells out every prompt as its default', () => {
    const example = readFileSync(new URL('../CONDUCTOR.example.toml', import.meta.url), 'utf8');
    const bare = example.replace(/^\[prompts\][\s\S]*?(?=^\[|(?![\s\S]))/m, '');
    assert.notEqual(bare, example);
    assert.equal(parseProjectConfig('/p', example).prompts.fixNotes, 'please fix {notes}; then commit');
    assert.deepEqual(parseProjectConfig('/p', example).prompts, parseProjectConfig('/p', bare).prompts);
    const keys = [...example.matchAll(/^(\w+) = /gm)].map((m) => m[1]);
    for (const k of ['implement', 'review', 'fix', 'fix_notes', 'feedback', 'feedback_again', 'feedback_fix', 'continue', 'gate_failed', 'plan', 'plan_done', 'plan_read_only', 'plan_moved', 'chat', 'summary']) {
        assert.ok(keys.includes(k), k);
    }
});

test('feedback rounds need a feedback agent and default to one', () => {
    const withFeedback = base.replace('plan = "opus"', 'plan = "opus"\nfeedback = "glm"');
    assert.equal(parseProjectConfig('/r', base).feedbackRounds, 0);
    assert.equal(parseProjectConfig('/r', withFeedback).feedbackRounds, 1);
    assert.equal(parseProjectConfig('/r', `${withFeedback}\n[flow]\nfeedback_rounds = 3`).feedbackRounds, 3);
    assert.equal(parseProjectConfig('/r', `${withFeedback}\n[flow]\nfeedback_rounds = 0`).feedbackRounds, 0);
    assert.throws(() => parseProjectConfig('/r', `${base}\n[flow]\nfeedback_rounds = 2`), /needs roles.feedback/);
    assert.throws(() => parseProjectConfig('/r', `${withFeedback}\n[flow]\nfeedback_rounds = -1`), /whole number/);
    assert.throws(() => parseProjectConfig('/r', base.replace('plan = "opus"', 'plan = "opus"\nfeedback = "x"')), /unknown agent/);
});

test('feedback takes a list of agents, one round each by default', () => {
    const list = (v: string) => base.replace('plan = "opus"', `plan = "opus"\nfeedback = ${v}`);
    assert.deepEqual(parseProjectConfig('/r', base).roles.feedback, []);
    assert.deepEqual(parseProjectConfig('/r', list('"glm"')).roles.feedback, ['glm']);
    const two = parseProjectConfig('/r', list('["glm", "opus"]'));
    assert.deepEqual(two.roles.feedback, ['glm', 'opus']);
    assert.equal(two.feedbackRounds, 2);
    assert.equal(parseProjectConfig('/r', `${list('["glm", "opus"]')}\n[flow]\nfeedback_rounds = 3`).feedbackRounds, 3);
    assert.throws(() => parseProjectConfig('/r', list('[]')), /non-empty list/);
    assert.throws(() => parseProjectConfig('/r', list('["glm", 3]')), /non-empty list/);
    assert.throws(() => parseProjectConfig('/r', list('["glm", "x"]')), /unknown agent "x"/);
});
