import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editRoleDefaults, onlyRoleChanges, swapRoleDefaults } from '../src/roles.ts';
import { parseProjectConfig } from '../src/config.ts';

const config = `# keep this header
[gate]
all = "true"
[roles] # keep table comment
implement = "a" # old implementer
feedback = [
    "a", # first reviewer
    "b",
]
review = "b"
plan = "a"
# keep this comment
[agents.a]
harness = "codex"
model = "model-a"
tag = "a"
[agents.b]
harness = "codex"
model = "model-b"
tag = "b"
`;

test('role editing preserves other tables and comments and replaces multiline feedback', () => {
    const updated = editRoleDefaults('/repo', config, 'feedback', ['b', 'a']);
    assert.deepEqual(parseProjectConfig('/repo', updated).roles.feedback, ['b', 'a']);
    assert.ok(updated.includes('# keep this header'));
    assert.ok(updated.includes('[roles] # keep table comment'));
    assert.ok(updated.includes('implement = "a" # old implementer'));
    assert.ok(updated.includes('# keep this comment'));
    assert.equal(updated.split('[agents.a]')[1], config.split('[agents.a]')[1]);
    const added = editRoleDefaults('/repo', updated, 'chat', ['b']);
    assert.equal(parseProjectConfig('/repo', added).roles.chat, 'b');
});

test('role editing rejects invalid roles, aliases and scalar arity', () => {
    assert.throws(() => editRoleDefaults('/repo', config, 'unknown', ['a']), /unknown role/);
    assert.throws(() => editRoleDefaults('/repo', config, 'implement', ['unknown']), /unknown agent/);
    assert.throws(() => editRoleDefaults('/repo', config, 'review', ['a', 'b']), /exactly one/);
    assert.throws(() => editRoleDefaults('/repo', config, 'review', []), /at least one/);
});

test('role-only comparison permits batches but protects other config and unknown settings', () => {
    const first = editRoleDefaults('/repo', config, 'implement', ['b']);
    const second = editRoleDefaults('/repo', first, 'feedback', ['b', 'a']);
    assert.equal(onlyRoleChanges(config, second), true);
    assert.equal(onlyRoleChanges(config, second.replace('all = "true"', 'all = "false"')), false);
    assert.equal(onlyRoleChanges(config, second + '\n# unrelated edit\n'), false);
    assert.equal(onlyRoleChanges(config, second.replace('[roles] # keep table comment', '[roles] # keep table comment\ncustom = 1')), false);
});

const unique = config.replace('review = "b"', 'review = "c"').replace('plan = "a"', 'plan = "c"')
    .replace('    "a", # first reviewer\n', '') + '\n[agents.c]\nharness = "codex"\nmodel = "model-c"\ntag = "c"\n';

test('swap exchanges unique scalar/feedback bindings and preserves other slots and models', () => {
    const result = swapRoleDefaults('/repo', unique, 'a', 'b');
    const before = parseProjectConfig('/repo', unique);
    const after = parseProjectConfig('/repo', result);
    assert.equal(after.roles.implement, 'b');
    assert.deepEqual(after.roles.feedback, ['a']);
    assert.equal(after.roles.plan, 'c');
    assert.equal(after.roles.chat, 'c');
    assert.equal(result.split('[agents.a]')[1], unique.split('[agents.a]')[1]);
    assert.deepEqual(parseProjectConfig('/repo', swapRoleDefaults('/repo', result, 'a', 'b')).roles, before.roles);
    const bothFeedback = editRoleDefaults('/repo', editRoleDefaults('/repo', unique, 'implement', ['c']), 'feedback', ['a', 'c', 'b']);
    assert.deepEqual(parseProjectConfig('/repo', swapRoleDefaults('/repo', bothFeedback, 'a', 'b')).roles.feedback, ['b', 'c', 'a']);
});

test('swap rejects missing, repeated and inherited ambiguous assignments', () => {
    assert.throws(() => swapRoleDefaults('/repo', unique, 'a', 'a'), /different agents/);
    assert.throws(() => swapRoleDefaults('/repo', unique, 'a', 'unknown'), /unknown agent/);
    assert.throws(() => swapRoleDefaults('/repo', unique, 'a', 'c'), /exactly one role assignment.*review.*plan.*chat.*summary/);
    const repeated = editRoleDefaults('/repo', unique, 'feedback', ['b', 'b']);
    assert.throws(() => swapRoleDefaults('/repo', repeated, 'a', 'b'), /feedback\[1\].*feedback\[2\]/);
    const absent = editRoleDefaults('/repo', unique, 'feedback', ['c']);
    assert.throws(() => swapRoleDefaults('/repo', absent, 'a', 'b'), /found none/);
});
