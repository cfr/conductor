import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNext } from '../src/plan.ts';
import { chunk } from '../src/telegram.ts';

const plan = `# plan

## Next

Each item stays small.

- 0048-antlion: a fixed ambusher
  - detail one

  Files: \`a.cpp\`

- 0049-antlion-flick: flicks sand
- not an item

## Research

- 0099-nope: research
`;

test('parses Next items with continuation lines', () => {
    const items = parseNext(plan);
    assert.deepEqual(items.map((i) => i.id), ['0048-antlion', '0049-antlion-flick']);
    assert.equal(items[0].number, '0048');
    assert.match(items[0].text, /Files: `a.cpp`$/);
    assert.equal(items[1].text, '- 0049-antlion-flick: flicks sand');
});

test('chunks long text at newlines', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    const parts = chunk(text, 4000);
    assert.ok(parts.length > 1);
    assert.ok(parts.every((p) => p.length <= 4000));
    assert.equal(parts.join('\n'), text);
});
