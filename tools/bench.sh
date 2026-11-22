#!/bin/bash
# bench.sh — A/B timing: baseline vs this entry, 12 runs each, back-to-back, 1 CPU, full driver.
# Usage: bash tools/bench.sh [runs]   (default 12). Appends a section to BENCH.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KIT="${KIT:-/home/hatch/workspace/makefun/site-generator-speed-01-run-20261122-kit/site-generator-speed-01-run-20261122-kit}"
RUNS="${1:-12}"
OUT_BASE="$(mktemp -d)"; OUT_MINE="$(mktemp -d)"
trap 'rm -rf "$OUT_BASE" "$OUT_MINE"' EXIT

run_once() { # $1 = main.ts dir, $2 = out dir
  local t0 t1
  t0=$(date +%s%N)
  MAKEFUN_INPUT_DIR="$KIT/practice/input" MAKEFUN_OUTPUT_DIR="$2" taskset -c 0 node "$1/main.ts"
  t1=$(date +%s%N)
  echo $(( (t1 - t0) / 1000000 ))
}

echo "baseline (makefun-site 1.0.0): $RUNS runs"
BASE_TIMES=""
for _ in $(seq "$RUNS"); do BASE_TIMES="$BASE_TIMES $(run_once "$KIT/baselines/makefun-site" "$OUT_BASE")"; done
echo "entry (solve.js): $RUNS runs"
MINE_TIMES=""
for _ in $(seq "$RUNS"); do MINE_TIMES="$MINE_TIMES $(run_once "$ROOT" "$OUT_MINE")"; done

node - "$BASE_TIMES" "$MINE_TIMES" "$RUNS" <<'EOF' > /tmp/sitegen/bench-result.txt
const [baseStr, mineStr, runs] = process.argv.slice(2);
const stats = (arr) => {
  const a = arr.slice().sort((x, y) => x - y);
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  const med = a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
  const sd = Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / (a.length - 1));
  const se = sd / Math.sqrt(a.length);
  return { mean, med, sd, se, ci: 1.96 * se, min: a[0], max: a[a.length - 1] };
};
const b = stats(baseStr.trim().split(/\s+/).map(Number));
const m = stats(mineStr.trim().split(/\s+/).map(Number));
const ratio = b.mean / m.mean;
const gap = (b.mean - 1.96 * b.se) - (m.mean + 1.96 * m.se);
console.log(`baseline: mean ${b.mean.toFixed(1)} ms, median ${b.med.toFixed(1)} ms, sd ${b.sd.toFixed(1)} ms, 95%CI ±${b.ci.toFixed(1)} ms, range ${b.min}-${b.max} ms`);
console.log(`entry:    mean ${m.mean.toFixed(1)} ms, median ${m.med.toFixed(1)} ms, sd ${m.sd.toFixed(1)} ms, 95%CI ±${m.ci.toFixed(1)} ms, range ${m.min}-${m.max} ms`);
console.log(`speedup: ${ratio.toFixed(2)}x (${((ratio - 1) * 100).toFixed(1)}% faster)`);
console.log(`95% intervals ${gap > 0 ? 'DO NOT overlap' : 'overlap'} (gap ${gap.toFixed(1)} ms)`);
console.log(`verdict: ${ratio >= 1.25 && gap > 0 ? 'TARGET MET (25%+ faster at 95% confidence)' : 'target NOT met'}`);
EOF
cat /tmp/sitegen/bench-result.txt
{
  echo
  echo "## Bench — $(date -u +%Y-%m-%dT%H:%M:%SZ) — $RUNS runs each, back-to-back, taskset -c 0, full driver, node $(node --version)"
  echo
  echo '```'
  cat /tmp/sitegen/bench-result.txt
  echo '```'
  echo
  echo "baseline times (ms):$BASE_TIMES"
  echo "entry times (ms):$MINE_TIMES"
} >> "$ROOT/BENCH.md"
echo "appended to BENCH.md"
