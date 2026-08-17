# Auto merge

One label decides who merges a pull request.

`harlan-agent-auto-merge` lets `harlan-github-agent` hand the pull request to GitHub's own auto-merge after a `READY` review. GitHub performs the merge once its branch protection is satisfied. Without the label, Harlan merges it.

The label never changes whether a pull request is reviewed. Automated review runs either way.

## When to add the label

Add it for a change with no judgement in it:

- documentation, comments, or wording with no code change
- dependency bump or lockfile refresh
- formatting, lint autofix, or generated file refresh
- changelog or version bump

Never add it for a change a reviewer must judge: source behaviour, public API, configuration, CI workflow, authentication, authorization, payments, data migrations, deletes, or user-visible copy.

When unsure, leave it off. A missing label costs one human merge. A wrong label ships an unreviewed change.

Remove the label when a pull request grows past the change it was added for.

## When the service hands over

The service enables GitHub auto-merge on a labelled pull request only when every
condition holds:

1. Auto merge is enabled in the service configuration.
2. The repository owner matches the authenticated GitHub login.
3. The pull request author is a trusted author for that repository.
4. Automated review returned `READY` for the exact current head commit.
5. Review confidence meets the configured minimum.
6. The pull request is open, is not a draft, and GitHub reports it mergeable.

The handover pins the reviewed head commit as `expectedHeadOid`, so GitHub
cancels its own auto-merge when a new commit lands. A review can never merge a
commit it did not read.

GitHub refuses auto-merge on a pull request with nothing left to wait for, which
is what a repository with no required checks looks like. The service then merges
at the same pinned head commit, because GitHub has already said every
requirement it knows about is met.

Everything else waits for Harlan.

## Label

```bash
gh label create harlan-agent-auto-merge --color 0e8a16 --description "Lets harlan-github-agent merge this after a READY review"
```
