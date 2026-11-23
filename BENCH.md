# BENCH.md — rewrite log (kept/reverted) and benchmark results

## Rewrites

- R1 inline() regex scan + slice appends; indexOf-based findUnescaped/findSingleStar (kept: verify ALL PASS, fuzz 4000/4000). First version had a typo (`i = j + 1` in the single-star success branch) caught by verify on all 3 practice cases; fixed to `i = k + 1`.
- R2 wordsOf manual count; cardOf once per post reused in pageOf; readSources CR-skip; slugify ASCII fast path; template for-loop scope reuse; ownTags slug-once (kept: verify ALL PASS, fuzz 4000/4000).
- R3 lex+render fusion, no token objects (kept: verify ALL PASS, fuzz 4000/4000).
- R4 escapeHtml test-first fast path (kept: verify ALL PASS, fuzz 4000/4000).
- R5 (round 2) wordsOf: Uint8Array whitespace table (kept: verify ALL PASS, fuzz 4000/4000). run() 243 -> ~187 ms/set (warm loop).
- R6 (round 2) inline(): range-based + one accumulator, nested content rendered in place (kept: verify ALL PASS, fuzz 4000/4000). run() ~185 ms/set.
- R7 (round 2) renderMarkdown: manual line dispatch (no per-line regexes), manual trimLine, block assembly by join; front matter: body as lines (no join then re-split), manual "key: value" parse, wordsOf over lines (kept: verify ALL PASS, fuzz 4000/4000). run() ~165 ms/set.
- R8 (round 2) templates: tokenize+parse fused into one pass (no token objects); renderNodes: accumulator array joined once (kept: verify ALL PASS, fuzz 4000/4000). run() ~167 ms/set.
- Rejected: wordsOf via match(/\S+/g) — 34.3 ms/set vs 16.8 ms/set for the per-char loop (array allocation dominates). Slugify regex version — skipped: profile shows slugify is small, and the toLowerCase-expansion Unicode equivalence risk is not worth it.
- Item 8 (fused range-based markdown renderer) evaluated and NOT done: the cross-line inline constructs + per-line trim semantics make it high-risk, and the remaining gap to 3x is structural — the driver is ~half fixed costs (node startup, JSON parse of 2.8 MB, JSON stringify of 7.4 MB answers) no entry-side optimisation can remove. Profile (warm loop): markdown ~40%, layouts ~45% of run(); wordsOfLines is the largest single self-time (~15%) and the per-char loop already beats the regex alternative.

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

## Bench — 2026-11-23T05:17:01Z — 12 runs each, back-to-back, taskset -c 0, full driver, node v24.22.1

```
baseline: mean 1305.5 ms, median 1283.0 ms, sd 107.6 ms, 95%CI ±60.9 ms, range 1191-1566 ms
entry:    mean 746.5 ms, median 700.5 ms, sd 136.5 ms, 95%CI ±77.2 ms, range 642-1049 ms
speedup: 1.75x (74.9% faster)
95% intervals DO NOT overlap (gap 420.9 ms)
verdict: TARGET MET (25%+ faster at 95% confidence)
```

baseline times (ms): 1340 1373 1201 1332 1295 1239 1191 1400 1566 1192 1266 1271
entry times (ms): 695 1013 661 670 642 752 706 1049 694 653 711 712
