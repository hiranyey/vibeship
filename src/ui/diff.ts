/**
 * A line diff for the side-by-side compose comparison: longest common
 * subsequence over lines, then deletions and insertions paired into rows.
 * Compose files are small, so the O(n·m) table is fine.
 */

export type DiffRow =
  | { kind: 'same'; left: string; right: string; leftNo: number; rightNo: number }
  | { kind: 'change'; left: string | null; right: string | null; leftNo: number | null; rightNo: number | null }
  | { kind: 'fold'; count: number };

type Op = { kind: 'same' | 'del' | 'add'; line: string };

function ops(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: length of the LCS of a[i..] and b[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', line: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'del', line: a[i++]! });
    } else {
      out.push({ kind: 'add', line: b[j++]! });
    }
  }
  while (i < n) out.push({ kind: 'del', line: a[i++]! });
  while (j < m) out.push({ kind: 'add', line: b[j++]! });
  return out;
}

const lines = (text: string): string[] => {
  const l = text.replace(/\r\n/g, '\n').split('\n');
  if (l.at(-1) === '') l.pop();
  return l;
};

/**
 * Rows for a two-column diff of `before` and `after`. Unchanged runs longer
 * than `2 * context + 1` lines are folded, keeping `context` lines around
 * each change.
 */
export function sideBySide(before: string, after: string, context = 3): DiffRow[] {
  const rows: DiffRow[] = [];
  let leftNo = 0;
  let rightNo = 0;
  let dels: Array<{ line: string; no: number }> = [];
  let adds: Array<{ line: string; no: number }> = [];
  const flush = () => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const d = dels[k];
      const a = adds[k];
      rows.push({ kind: 'change', left: d?.line ?? null, right: a?.line ?? null, leftNo: d?.no ?? null, rightNo: a?.no ?? null });
    }
    dels = [];
    adds = [];
  };
  for (const op of ops(lines(before), lines(after))) {
    if (op.kind === 'del') dels.push({ line: op.line, no: ++leftNo });
    else if (op.kind === 'add') adds.push({ line: op.line, no: ++rightNo });
    else {
      flush();
      rows.push({ kind: 'same', left: op.line, right: op.line, leftNo: ++leftNo, rightNo: ++rightNo });
    }
  }
  flush();

  // Fold long unchanged runs.
  const folded: DiffRow[] = [];
  let k = 0;
  while (k < rows.length) {
    if (rows[k]!.kind !== 'same') {
      folded.push(rows[k++]!);
      continue;
    }
    let end = k;
    while (end < rows.length && rows[end]!.kind === 'same') end++;
    const keepHead = k === 0 ? 0 : context;
    const keepTail = end === rows.length ? 0 : context;
    if (end - k > keepHead + keepTail + 1) {
      folded.push(...rows.slice(k, k + keepHead), { kind: 'fold', count: end - k - keepHead - keepTail }, ...rows.slice(end - keepTail, end));
    } else {
      folded.push(...rows.slice(k, end));
    }
    k = end;
  }
  return folded;
}
