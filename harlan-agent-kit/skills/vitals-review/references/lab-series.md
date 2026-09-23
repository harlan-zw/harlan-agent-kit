# Judging a Lab series

The controller applies this same rule in `packages/harlan-github-agent/src/routines/vitals-review.ts`.
If the two disagree, the code wins. Apply the rule yourself only to decide what to propose.

## Build the series

1. Take the rows from `nuxtseo scans list --json --limit 100`.
2. Drop every row whose `status` is not `complete`. A failed Scan is not a gap.
3. Group by page and strategy. The page is the URL path with the trailing slash removed, so `https://site.com` and `https://site.com/` are both `/`.
4. Sort each group by `completedAt`, oldest first.
5. Judge LCP, TBT, CLS, and FCP separately. Skip a Scan with no value for that metric.

Never merge the mobile and desktop groups. On nuxtseo.com the scheduler scans desktop on Sundays and mobile on Tuesdays. Mobile LCP sits near 8 s and desktop near 1.3 s, so a merged list flips every few days with no deploy behind it.

## Thresholds

| Metric | Poor line | A Scan is worse when it exceeds the reference by more than |
| --- | --- | --- |
| LCP | 4000 ms | 500 ms and 20 percent |
| FCP | 3000 ms | 300 ms and 20 percent |
| TBT | 600 ms | 200 ms and 50 percent |
| CLS | 0.25 | 0.05 |

## Decide, in this order

1. **Short.** Fewer than 2 Scans: ShortSeries.
2. **Poor series.** The last 2 or more Scans all sit above the Poor line: Poor series. It files, with or without a better Scan before it. When a better Scan exists before the run, date the deploys between it and the first Poor Scan.
3. **Find the drop.** Take the longest trailing run of Scans that are each worse than the median of the up to 5 Scans before the run. Call those earlier Scans the reference.
4. **Short reference.** Fewer than 2 reference Scans: ShortSeries.
5. **Unstable.** Any reference Scan is itself worse than the reference median: Unstable. The page swings without a deploy, so no drop can be dated. It files nothing.
6. **Suspect.** A run of 1 Scan: Suspect. It files nothing.
7. **Lab drop.** A run of 2 or more Scans: Lab drop. It files.
8. **Steady.** No trailing run: Steady.

A drop that recovered is Steady, because the latest Scan is not worse.
