# Verifying a fix with local Unlighthouse

Use this only when the issue says the metric reproduces in the lab.
That covers LCP, FCP, and TBT, and CLS only when lab CLS is at or above 0.1.
It never covers INP, which needs a real interaction.

## Build and serve both sides

Measure the default branch and the fix on the same machine, in the same session.
A local number never predicts production. Only the difference between the two runs means anything.

```bash
pnpm install --frozen-lockfile
pnpm build
PORT=4173 node .output/server/index.mjs &
```

Use the repository's own preview command instead when it has one, for example `pnpm preview`.
Stop the server after each run.
Use a preview that supports the repository's production preset and local bindings.

Keep before and after caches separate. Seed local databases from identical fixtures.
Record each sample's document bytes and asset URLs. Confirm they match that side's build.
If cached HTML or different content enters the comparison, correct the fixture before attributing an improvement.

## Scan the route

```bash
pnpm dlx unlighthouse-ci --site http://localhost:4173 \
  --urls <route> --<mobile|desktop> --throttle --samples 3 \
  --reporter jsonExpanded --output-path "$HOME/scratch/vitals-review/<run>/<before|after>"
```

- Pass the strategy the issue names. A mobile issue needs `--mobile --throttle`, or the number is a desktop number.
- `--urls` takes the one route. Never crawl the Site.
- `--samples 3` takes the median of three runs.

Read `ci-result.json` in the output path. Record the metric for the route from both runs.

## Report it

Return both values, the commands, and each side's commit in the result's `checks`.
Include measured benchmarks in the pull request body.
Compare the target metric with run-to-run variation and the Threshold in `lab-series.md`.
If the comparison does not establish the claimed benefit, return blocked with measurements. Do not retain the unproved experiment.
Report other metric changes and HTML size beside the target result.
Never raise a Threshold, skip a route, or change the strategy to make the number move.
