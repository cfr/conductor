import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyNextMessage, nextReport, parseNext, summary } from '../src/plan.ts';
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
    assert.equal(summary(items[0]), '0048-antlion: a fixed ambusher');
});

test('chunks long text at newlines', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    const parts = chunk(text, 4000);
    assert.ok(parts.length > 1);
    assert.ok(parts.every((p) => p.length <= 4000));
    assert.equal(parts.join('\n'), text);
});

test('explains a Next section whose items lack ids', () => {
    assert.match(emptyNextMessage('## Next\n\n- #0060 page shell: fix\n\n## Research\n'), /1 item\(s\), none/);
    assert.equal(emptyNextMessage('## Next\n\nnothing yet\n'), 'PLAN.md "Next" is empty');
});

test('accepts an item heading with a parenthesized title', () => {
    const items = parseNext('## Next\n\n- 0064-beetle (rhinoceros beetle): the tank\n- 0065-x-y: z\n');
    assert.deepEqual(items.map((i) => i.id), ['0064-beetle', '0065-x-y']);
    assert.equal(summary(items[0]), '0064-beetle: (rhinoceros beetle): the tank');
});

test('reports parsed Next ids and items it would skip', () => {
    const report = nextReport('## Next\n\n- 0067-a: one\n- #0068 b: two\n');
    assert.equal(report, '"Next": 0067-a\nwarning: 1 "Next" item(s) do not start with `- NNNN-slug:`; /next skips them');
});
