import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sideBySide } from '../src/ui/diff.ts';

test('a changed line pairs the old and new text on one row', () => {
  const rows = sideBySide('a\nb\nc\n', 'a\nB\nc\n');
  assert.deepEqual(rows, [
    { kind: 'same', left: 'a', right: 'a', leftNo: 1, rightNo: 1 },
    { kind: 'change', left: 'b', right: 'B', leftNo: 2, rightNo: 2 },
    { kind: 'same', left: 'c', right: 'c', leftNo: 3, rightNo: 3 },
  ]);
});

test('pure additions and removals leave the other side blank', () => {
  assert.deepEqual(sideBySide('a\n', 'a\nb\n').at(-1), { kind: 'change', left: null, right: 'b', leftNo: null, rightNo: 2 });
  assert.deepEqual(sideBySide('a\nb\n', 'a\n').at(-1), { kind: 'change', left: 'b', right: null, leftNo: 2, rightNo: null });
});

test('long unchanged runs fold, keeping context around changes', () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
  const after = before.replace('l10', 'X');
  const rows = sideBySide(before, after, 2);
  assert.deepEqual(rows.map((r) => r.kind), ['fold', 'same', 'same', 'change', 'same', 'same', 'fold']);
  assert.deepEqual(rows.filter((r) => r.kind === 'fold').map((r) => r.kind === 'fold' && r.count), [8, 7]);
});

test('identical text has no changes', () => {
  assert.ok(sideBySide('x\ny\n', 'x\ny\n').every((r) => r.kind !== 'change'));
});
