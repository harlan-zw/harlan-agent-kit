# Auto merge

One label decides who merges a pull request.

`harlan-agent-auto-merge` lets `harlan-github-agent` hand the pull request to GitHub's own auto-merge after a `READY` review. GitHub performs the merge once its branch protection is satisfied. Without the label, Harlan merges it.

The label never changes whether a pull request is reviewed. Automated review runs either way.

## When to add the label

Add it for a change with no judgement in it:

- comments or wording inside non-Markdown files, with no behaviour change
- Markdown that nothing executes: a README, docs, or a blog post
- dependency bump or lockfile refresh
- formatting, lint autofix, or generated file refresh
- changelog or version bump

Never add it for a change a reviewer must judge: source behaviour, public API, configuration, CI workflow, authentication, authorization, payments, data migrations, deletes, or user-visible copy.

Markdown an agent reads as instructions is source behaviour. That covers Skills, `agent-context/`, `CLAUDE.md`, `AGENTS.md`, `GLOSSARY.md`, and `.github` issue or pull request templates. A change there alters what every agent does in every repository, so Harlan merges it.

When unsure, leave it off. A missing label costs one human merge. A wrong label ships an unreviewed change.

Remove the label when a pull request grows past the change it was added for.

## Dependency updates

The controller adds the label itself to a pull request from the dependency-updates Routine. It reads the published commit, never the Agent's description. It adds the label only when all of these hold:

- Every issue the pull request closes came from the dependency-updates Routine.
- The repository is `owned`.
- Every changed file is a modified `package.json`, `pnpm-lock.yaml`, or `pnpm-workspace.yaml`.
- A `package.json` changes only versions in `dependencies`, `devDependencies`, or `optionalDependencies`. A `pnpm-workspace.yaml` changes only versions in `catalog` or `catalogs`.
- Each changed version is a plain `x.y.z`, with the same `^`, `~`, or no prefix, and moves forward inside its major. A `0.x` minor and a `0.0.x` patch count as major.

Otherwise the pull request publishes without the label. The Task evidence says why in one sentence. The Review still runs, and the bar for a labelled pull request still applies at merge time.

## Merge risk

A repository on `auto_merge.pull_requests: contained` does not need the label for a low risk code change. Every Review returns a Merge risk, and a `Contained` verdict merges on its own.

| Verdict | Means | Goes to |
| --- | --- | --- |
| `Contained` | a mistake costs one revert commit | Auto merge |
| `Reviewable` | a person should read it | Harlan |
| `Sensitive` | a mistake is expensive or hard to undo | Harlan |

Two independent answers produce it and the more dangerous wins, so `Contained` needs both. The controller computes a floor from the changed paths and counts. The Review Agent claims the rest from the diff, which is the only part that sees blast radius.

A file an agent reads as instructions is always `Sensitive`, and a repository cannot widen its own path list to cover one.

This changes what the label is for, on those repositories. The label used to be the only way a pull request merged itself. It is now an override a person applies when they have read the change and disagree with the verdict. The controller also applies it to a clean dependency update, as [Dependency updates](#dependency-updates) describes. Set `merge_risk.label_overrides_risk: false` to stop even that beating a `Sensitive` verdict.

Merge risk routes the merge and never the Review. Every tracked pull request is still reviewed.

## Repository scope

A repository can set its own bar for labelled pull requests:

```yaml
- github: nuxt-modules/sitemap
  auto_merge:
    pull_requests: labelled
    minimum_confidence: 100
```

Without `minimum_confidence`, a labelled pull request clears the service-wide bar. Set a higher bar on a repository other people depend on, and a lower one on a site where a revert is cheap.

A repository can widen Auto merge from labelled pull requests to every pull request:

```yaml
- github: harlan-zw/melbjs-clone
  auto_merge:
    pull_requests: every
    minimum_confidence: 80
```

With `pull_requests: every`, no label is needed and the repository's own `minimum_confidence` replaces the service-wide one. Every other condition below still holds: owned repository, trusted author, published `READY` review for the exact head commit, no open finding. The block requires an owned repository with `pr_review: true`.

Use it only where a wrong merge costs little, such as a demo site. Leave it off every repository Harlan would want to read first. Without the block, or with `pull_requests: labelled`, the label decides.

## When the service hands over

The service enables GitHub auto-merge on a labelled pull request only when every
condition holds:

1. Auto merge is enabled in the service configuration.
2. The repository owner matches the authenticated GitHub login.
3. The pull request author is a trusted author for that repository.
4. Automated review returned `READY` for the exact current head commit.
5. Review confidence meets the configured minimum: the repository's own with `pull_requests: every`, else `auto_merge.minimum_confidence`.
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
