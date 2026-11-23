// The program the harness runs: `node main.ts` (node22). It reads every case from /input/cases.json,
// answers each one alone with run() from solve.js, and writes /output/answers.json: a JSON array of
// the answers, one per case and in the cases' order. Outside a container MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.
// Round 2 (this session): the driver is re-authored here, and the self-check is extended —
// beyond the answer count, every answer must be a non-empty object (the graded output is a
// map of paths to pages, always holding build-report.txt). A corrupt answer is refused
// instead of written, so a bad solve.js fails loudly rather than scoring a silent mismatch.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its work runs under it (the rules: the house
// baseline runs with --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
// Self-check (a behaviour change vs the house driver): refuse to write a short answer file,
// and refuse any answer that is not a non-empty object — a corrupt answer must fail here,
// not silently score a mismatch downstream.
if (answers.length !== cases.length) throw new Error(`answered ${answers.length} of ${cases.length} cases`);
for (let k = 0; k < answers.length; k++) {
  const a = answers[k];
  if (a === null || typeof a !== 'object' || Object.keys(a as object).length === 0) {
    throw new Error(`answer ${k} is not a non-empty object`);
  }
}
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
