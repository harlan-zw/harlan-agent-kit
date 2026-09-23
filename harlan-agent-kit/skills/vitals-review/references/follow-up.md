# Following up a merged fix

Every scan checks the fixes this Routine already produced.

## Find them

```bash
gh issue list --label routine:vitals-review --state closed --limit 30 \
  --json number,title,body,closedAt,closedByPullRequestsReferences
```

Read the fingerprint marker in each body. Keep an issue whose closing pull request merged.

## Start a post-deploy Scan

Start one only when all of these hold:

1. The deploy workflow ran successfully on a commit that contains the merge. `references/deploy-window.md` gives the command.
2. `scans list` shows no complete Scan of that page, on the issue's strategy, after that deploy finished.
3. No `page scan` for that page started in the last 24 hours, by this Routine or anyone else. A pending Scan shows in `scans list`.

Then run:

```bash
nuxtseo page scan <absolute-url> --site <site-id> --yes --json
```

It starts a mobile and a desktop Scan and spends the Team Lighthouse limit.
Start at most 5 per run, oldest merge first. Name the rest in the report.

## Judge the result

| Evidence | Outcome |
| --- | --- |
| Lab issue, and the series is Steady after the deploy | Confirmed |
| Lab issue, and the series is still Poor or still a Lab drop | Not holding |
| Field issue, and the finding is gone or no longer `poor` | Confirmed |
| Field issue, and fewer than 28 days passed since deploy | Pending: field data covers 28 days |
| Field issue, still `poor` after 28 days | Not holding |

Report each fix with its issue, pull request, deploy, and outcome.
The ledger keeps a fingerprint once filed, so a fix that is not holding never files a second issue.
Name Harlan as the next actor, and ask him to reopen the issue number you give.
