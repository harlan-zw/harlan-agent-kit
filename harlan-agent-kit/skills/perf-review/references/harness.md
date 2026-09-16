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
