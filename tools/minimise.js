// minimise.js — delta-debug a failing fuzz case down to the smallest failing input.
// Usage: node tools/minimise.js <fail-file.json> [--candidate <module>] [--out <file>]
// The fail file holds { input } (as fuzz.mjs saves it). The candidate defaults to ./solve.js;
// the reference is always the kit baseline. Shrinks by: dropping files, dropping templates,
// halving each file's body lines, trimming front-matter lines — while the mismatch reproduces.
import { readFileSync, writeFileSync } from 'node:fs';

const KIT = process.env.KIT ?? '/home/hatch/workspace/makefun/site-generator-speed-01-run-20261122-kit/site-generator-speed-01-run-20261122-kit';
const ROOT = new URL('..', import.meta.url).pathname;

const args = process.argv.slice(2);
const failFile = args[0];
const candIdx = args.indexOf('--candidate');
const outIdx = args.indexOf('--out');
const candidatePath = candIdx === -1 ? `${ROOT}solve.js` : args[candIdx + 1];
const outFile = outIdx === -1 ? failFile.replace(/\.json$/, '.min.json') : args[outIdx + 1];

const baseline = (await import(`${KIT}/baselines/makefun-site/solve.js`)).run;
const candidate = (await import(candidatePath)).run;

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function fails(input) {
  try {
    return canonical(baseline(input)) !== canonical(candidate(input));
  } catch {
    return true; // a throw on one side and not the other is a failure too
  }
}

const { input: orig } = JSON.parse(readFileSync(failFile, 'utf8'));
if (!fails(orig)) {
  console.log('input does not fail against this candidate; nothing to minimise');
  process.exit(0);
}
let input = structuredClone(orig);

// 1. Drop files one at a time (repeat until no more can go).
let changed = true;
while (changed) {
  changed = false;
  for (let i = 0; i < input.files.length; i++) {
    const t = structuredClone(input);
    t.files.splice(i, 1);
    if (t.files.length > 0 && fails(t)) { input = t; changed = true; break; }
  }
}
// 2. Drop templates one at a time.
changed = true;
while (changed) {
  changed = false;
  for (const name of Object.keys(input.templates)) {
    const t = structuredClone(input);
    delete t.templates[name];
    if (fails(t)) { input = t; changed = true; break; }
  }
}
// 3. Halve each remaining file's lines (front matter + body together, then body only).
for (let fi = 0; fi < input.files.length; fi++) {
  let lines = input.files[fi].content.split('\n');
  let step = Math.max(1, Math.floor(lines.length / 2));
  while (step >= 1) {
    let i = 0;
    while (i < lines.length) {
      const t = structuredClone(input);
      t.files[fi].content = [...lines.slice(0, i), ...lines.slice(i + step)].join('\n');
      if (fails(t)) { lines = t.files[fi].content.split('\n'); }
      else i += step;
    }
    step = Math.floor(step / 2);
  }
  input.files[fi].content = lines.join('\n');
}
writeFileSync(outFile, JSON.stringify({ input }, null, 2));
console.log(`minimised: ${orig.files.length} files -> ${input.files.length} files, ${JSON.stringify(orig).length} B -> ${JSON.stringify(input).length} B`);
console.log(`wrote ${outFile}`);
for (const f of input.files) console.log('---', f.path, JSON.stringify(f.content));
