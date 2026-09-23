# Dating a Lab drop to deploys

A Lab drop starts somewhere between the last reference Scan and the first worse Scan.
Name the production deploys in that window and the commits they shipped.

## Find the deploy workflow

Read `.github/workflows/` and pick the workflow that deploys production from the default branch.
The repository's `AGENTS.md` or `README.md` usually names it. If none deploys, say so and use merge times on the default branch instead.

## List the deploys in the window

```bash
gh run list --workflow <deploy-workflow.yml> --branch main --status success \
  --created "<last-reference-scan>..<first-worse-scan>" \
  --json headSha,createdAt,updatedAt,url --limit 50
```

Also take the last successful deploy before the window. Its `headSha` is the start of the range.

## Name the commits

```bash
git log --oneline <sha-before-window>..<last-sha-in-window>
```

Write `suspectCommits` as `<start>..<end>`, then the pull request numbers the range merged.
One deploy with one squash merge names one pull request. That is the strongest claim this Routine can make.

## When the window is empty

No deploy between the two Scans means the code did not change. Say so in the report.
Look for an outside cause: a third-party script, a CDN or cache change, or a NuxtSEO scanner change.
File the finding only if a repository change can still remove the cost, and write `suspectCommits` as `no deploy in window`.
