# Published check-in report

One check-in writes two reports. This file governs the published one.

| Report | Where | Audience | Length |
| --- | --- | --- | --- |
| Archive report | Beside the run's JSON archive | The next run, and an investigation | No limit |
| Published report | The `report` field, which becomes the issue comment | Harlan, every morning | Budgeted below |

The archive report proves the work. The published report reports the news.
Never publish the archive report. Never shorten the archive report.

## Budget

Count characters above the first `<details>` block.

| Verdict | Budget |
| --- | --- |
| GREEN, no actions | 400 |
| GREEN, AMBER, or RED with actions | 1500 |
| Incomplete coverage | 1500, plus the failed operation |

If a section does not fit, move detail into the archive report. Never drop a finding to fit.

## Shape

```markdown
## <VERDICT> <site>

<One sentence. What changed since yesterday.>

| Check | Result | Detail |
| --- | --- | --- |
| <check id> | Pass, Warn, or Fail | <under 12 words> |

**Needs you**

1. <action>. <why>. #<issue>

**Changed since yesterday**

- New: <finding> (#<issue>)
- Regressed: <finding> (#<issue>)
- Recovered: <finding> (#<issue>)

<details><summary>Unchanged work (<count>)</summary>

- <title> (#29), <state>
- <title> (#30), <state>

</details>

<details><summary>Evidence</summary>

Exit <code> | coverage <complete or incomplete> | deployment `<short sha>` | baseline <timestamp>
Archive: `<path>`

</details>
```

## Rules

1. State the verdict in the `verdict` field as well. The issue title reads that field, not this prose.
2. Give a passing check one table row. Write no prose for it.
3. Put only changes in the open body. Collapse unchanged work and count it.
4. Report what a prompt item found. Never report how it collected.
5. Keep paths, tokens, credential file names, and request counts inside `<details>`.
6. Write no confidence score. Write no untested-path line.
7. Never narrate your own process. A wrong first guess belongs in the archive report.
8. Sentry gets one table row, plus a line for each new issue. Full dispositions go in the ledger.
9. Number each action. Give it one line. Name the issue it becomes.
10. Write `**Needs you**` followed by `Nothing.` when no action needs a person.

## Worked example

A GREEN morning with two recoveries and one new Candidate:

```markdown
## GREEN unhead.unjs.io

Nothing new. Both prior defects are fixed on the live deployment.

| Check | Result | Detail |
| --- | --- | --- |
| unhead.report | Pass | All 3 required IDs present |
| unhead.sentry | Pass | 0 unresolved |

**Needs you**

Nothing.

**Changed since yesterday**

- Recovered: #61 archive persistence, verified writing
- Recovered: #60 collector pinned to 0.3.0
- New: `docs/ops/checkins` is not gitignored, so manual runs dirty the tree

<details><summary>Unchanged work (3)</summary>

- Uncached content route (#29), ready to spec
- Expected-404 noise (#30), ready to implement
- Dependabot `@vitest/mocker` 5.0.0 (#53), waiting on review

</details>

<details><summary>Evidence</summary>

Exit 0 | coverage complete | deployment `6454d402` | baseline 2026-09-15T07:35Z
Archive: `~/.local/state/daily-checkin/harlan-zw/unhead.unjs.io/2026-09-15T20-54-43-277Z.json`

</details>
```

That is 368 characters above the fold. The same run published 6,593 characters on 2026-09-15.
