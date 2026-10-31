import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editRoleDefaults } from '../src/roles.ts';
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
