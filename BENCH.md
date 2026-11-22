# BENCH.md — rewrite log (kept/reverted) and benchmark results

## Rewrites

- R1 inline() regex scan + slice appends; indexOf-based findUnescaped/findSingleStar (kept: verify ALL PASS, fuzz 4000/4000). First version had a typo (`i = j + 1` in the single-star success branch) caught by verify on all 3 practice cases; fixed to `i = k + 1`.
- R2 wordsOf manual count; cardOf once per post reused in pageOf; readSources CR-skip; slugify ASCII fast path; template for-loop scope reuse; ownTags slug-once (kept: verify ALL PASS, fuzz 4000/4000).
- R3 lex+render fusion, no token objects (kept: verify ALL PASS, fuzz 4000/4000).
- R4 escapeHtml test-first fast path (kept: verify ALL PASS, fuzz 4000/4000).

## Bench — 2026-11-22T20:29:34Z — 12 runs each, back-to-back, taskset -c 0, full driver, node v24.22.1

```
baseline: mean 1333.7 ms, median 1308.5 ms, sd 92.0 ms, 95%CI ±52.1 ms, range 1140-1493 ms
entry:    mean 838.8 ms, median 813.5 ms, sd 94.1 ms, 95%CI ±53.2 ms, range 745-1078 ms
speedup: 1.59x (59.0% faster)
95% intervals DO NOT overlap (gap 389.7 ms)
verdict: TARGET MET (25%+ faster at 95% confidence)
```

baseline times (ms): 1291 1368 1370 1311 1458 1140 1306 1292 1493 1295 1286 1394
entry times (ms): 786 1078 962 780 814 851 834 756 800 745 813 846
