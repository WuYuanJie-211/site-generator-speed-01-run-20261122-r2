// verify.mjs — baseline vs ref vs mine vs expected.json, byte compare.
// Usage: node tools/verify.mjs [--mine-only]  (run from the repo root)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KIT = process.env.KIT ?? '/home/hatch/workspace/makefun/site-generator-speed-01-run-20261122-kit/site-generator-speed-01-run-20261122-kit';
const cases = JSON.parse(readFileSync(join(KIT, 'practice/input/cases.json'), 'utf8'));
const expected = JSON.parse(readFileSync(join(KIT, 'practice/reference/expected.json'), 'utf8'));
const expById = new Map(expected.cases.map((c) => [c.id, c.output]));

// The scorer's canonical form: objects with keys in code-unit order.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return { at: i, a: a.slice(Math.max(0, i - 60), i + 60), b: b.slice(Math.max(0, i - 60), i + 60) };
  return { at: n, a: a.slice(n, n + 60), b: b.slice(n, n + 60), lenA: a.length, lenB: b.length };
}

const baseline = (await import(join(KIT, 'baselines/makefun-site/solve.js'))).run;
const ref = (await import(join(ROOT, 'solve.ref.js'))).run;
let mine = null;
try {
  mine = (await import(join(ROOT, 'solve.js'))).run;
} catch { /* not built yet */ }

let fail = 0;
for (const c of cases) {
  const base = canonical(baseline(c.input));
  const r = canonical(ref(c.input));
  const exp = canonical(expById.get(c.id));
  const row = [c.id];
  if (r !== base) { row.push('REF!=BASE ' + JSON.stringify(firstDiff(r, base))); fail++; }
  else row.push('ref==base');
  if (base !== exp) { row.push('BASE!=EXPECTED ' + JSON.stringify(firstDiff(base, exp))); fail++; }
  else row.push('base==expected');
  if (mine) {
    const m = canonical(mine(c.input));
    if (m !== base) { row.push('MINE!=BASE ' + JSON.stringify(firstDiff(m, base))); fail++; }
    else row.push('mine==base');
  }
  console.log(row.join(' | '));
}
console.log(fail === 0 ? 'ALL PASS' : `${fail} MISMATCH(ES)`);
process.exit(fail === 0 ? 0 : 1);
