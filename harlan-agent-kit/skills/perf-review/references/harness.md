# The harness that produces Measurements

Reference implementation: `harlan-zw/gscdump`, added in its PR #81.

## What a repository needs

| Path | Holds |
| --- | --- |
| `perf/benchmarks.json` | the Benchmark manifest: id, kind, unit, case file, and the source it exercises |
| `scripts/perf/run.mjs` | the harness. Builds nothing; it measures two checkouts that are already built |
| `scripts/perf/cases/*.mjs` | one case for each Benchmark, answering `prepare` and `sample` |
| `scripts/perf/report.mjs` | renders one Measurement as the pull request comment |
| `.github/workflows/perf.yml` | measures each merged commit against its parent, stores the note |
| `.github/workflows/perf-pull-request.yml` | measures a pull request against its base, uploads the report |
| `.github/workflows/perf-comment.yml` | posts that report, holding the write token the measuring job never gets |

## The manifest

`perf/benchmarks.json` declares `harness`, the default `repeats` and `warmups`, and one entry for each Benchmark.

| Field | Required | Means |
| --- | --- | --- |
| `id` | yes | the Benchmark name. A Fingerprint uses it, so never rename it |
| `kind` | yes | `time`, `memory`, or `count` |
| `unit` | yes | what the value counts: `ms`, `bytes`, `files` |
| `case` | yes | the case file that takes the samples |
| `source` | yes | the source file the case exercises. A Candidate targets it |
| `measures` | no | one sentence that says what the value is |
| `repeats`, `warmups` | no | override the manifest defaults. A `count` Benchmark sets `repeats: 1` and `warmups: 0` |
| `prepare` | no | `false` skips the `prepare` step |
| `thresholdPercent` | no | a `count` Benchmark only. The absolute `deltaPercent` must be above this before it counts. Default 0 |

### Choosing `thresholdPercent`

Leave it out when every change to the count is news, as for a library's built bytes. Then any change clears.

Set it when normal work grows the count, as for a site's bundle. A good value is above the growth of an ordinary feature commit and below the growth of a mistake, such as a new heavy dependency or a lost code split. Start at 1 to 3 percent for bytes. For a small count, such as a number of files, use a value that one step clears: a count of 50 with a Threshold of 1 percent clears on one added file.

A `time` or `memory` Benchmark ignores `thresholdPercent`. Its Threshold comes from its measured noise.

The pull request report reads the same field from the manifest, so the comment and the scan agree on what counts.

## Reproducing a delta locally

Both sides must exist as built checkouts. The harness does not build.

```bash
node scripts/perf/run.mjs \
  --head . \
  --parent /path/to/other-checkout \
  --only <benchmark-id> \
  --out /tmp/measurement.json
```

Read its output as `delta` against `noise`. A delta near the noise says nothing, whatever the stored Measurement said.

## Why three sides

The harness measures the head build a second time, against itself. That delta is pure measurement noise, taken in the same job on the same machine. It is the only honest answer to "is 5 percent a lot here?".

Real values, measured 2026-09-16: a GitHub hosted runner returned 0.91, 0.96 and 1.63 percent. A loaded developer desktop returned 3.4 percent and once 10.8. So a fixed threshold set from a laptop would be far too loose for CI, and one set from CI would be far too tight for a laptop.

## Why a count Benchmark is worth more than a timed one

`engine/dist-bytes` returns an identical number every run. Its control is exactly zero. Prefer a counter wherever the question allows one: bytes built, files written, API calls, rows scanned.
