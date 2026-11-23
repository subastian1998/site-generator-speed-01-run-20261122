# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/subastian1998/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/subastian1998/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in for make.fun's own makefun-site 1.0.0: it builds the same
static sites and answers byte-identically on every case — same front-matter
refusals, same Markdown dialect, same template rendering, same permalinks,
collections, tags, neighbours and build report — but roughly twice as fast
as the house baseline (about 1.1s vs about 1.9s CPU on the practice set).

The reference reads one character at a time; this one lets the engine do
the scanning: front matter is closed by one `indexOf` scan, Markdown
paragraphs are walked by segment with `indexOf` finders instead of
per-character loops, fence bodies are escaped in one pass, slugs are cached
per case with an ASCII fast path that skips NFKD, template scopes are
prototype chains instead of copied objects, template output is joined from
arrays, and templates that read only the case constants (`site`, `tags`,
`recent`) are rendered once per case and reused for every page.

## Run it

```sh
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=./out node main.ts
```

`main.ts` (Node 22) reads every case from `$MAKEFUN_INPUT_DIR/cases.json`,
answers each with `run` from `solve.js`, and writes `$MAKEFUN_OUTPUT_DIR/answers.json`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=7gw1p7j6&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
