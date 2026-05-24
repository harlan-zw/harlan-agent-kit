---
name: release-notes
description: Generate release notes for major/minor releases. Use when user says "release notes", "write release notes", "draft changelog", "prepare release announcement", "what changed since last release", or "generate upgrade guide".
user_invocable: true
context: fork
argument-hint: "[version]"
effort: high
---

Generate Nuxt-style release notes with highlights, categorized changelog, and LLM upgrade prompts for breaking changes.

## Current State

- **Repo:** !`gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo 'unknown'`
- **Recent tags:** !`git tag --sort=-v:refname | head -10 | tr '\n' ', '`
- **Current version:** !`cat package.json 2>/dev/null | jq -r '.version // "unknown"'`
- **Prior release style:** !`gh release view --json body --jq '.body' 2>/dev/null | head -40 || echo 'no prior releases'`

## Gotchas

- **Only for significant releases** -- this skill is overkill for patch bumps. Use for minor/major releases where a narrative is warranted.
- **Tag detection can miss pre-releases** -- `git tag --sort=-v:refname` may interleave `v1.2.0-beta.1` with stable tags. Filter with `grep -v '\-'` when needed.
- **Conventional commits required** -- changelog categorization depends on `feat:`, `fix:`, `perf:`, etc. prefixes. If commits are freeform, infer category from the diff: new files/exports = Enhancement, changed test assertions = Fix, `package.json` dep changes = Chore, etc.
- **Breaking changes hide in feat commits** -- look for `!` suffix (`feat!:`, `fix!:`) AND `BREAKING CHANGE:` in commit bodies, not just type prefixes.
- **PR bodies have context commit messages lack** -- always fetch PR descriptions for highlight-worthy features. The one-line commit message is rarely enough.
- **Contributors from squash merges** -- `git log` only shows the merge author. Use `gh pr list --search` to find actual PR authors.
- **Commit messages lie about breaking changes** -- devs forget `!` suffix constantly. Always cross-reference with the export diff (Step 1b) to catch unlabeled breaking changes.
- **Prior releases set expectations** -- if the repo already has GitHub releases, match the existing tone and structure. The Nuxt format is the default, not a mandate.

## Data Storage

Track release note history:

```bash
echo "$(date -I) VERSION TAG" >> "${CLAUDE_PLUGIN_DATA}/release-notes-history.log"
```

## Step 0: Determine Range

From the preprocessed state above, determine:
- **Previous tag**: the most recent stable version tag (skip pre-releases unless user specifies)
- **Target version**: from `$ARGUMENTS` if provided, otherwise from current version, otherwise ask
- **Tag range**: `PREV_TAG..HEAD`

## Step 1: Analyze Changes

### 1a. Git & PR Analysis

Run IN PARALLEL:

```bash
# Full commit log with bodies (for BREAKING CHANGE detection)
git log PREV_TAG..HEAD --format='%H|%s|%b' --no-merges

# Stat summary
git log PREV_TAG..HEAD --stat --no-merges

# All PRs merged since last tag
gh pr list --state merged --search "merged:>=PREV_TAG_DATE" --limit 100 --json number,title,body,author,labels

# Breaking changes (! suffix or BREAKING CHANGE in body)
git log PREV_TAG..HEAD --format='%H %s' --no-merges | grep -E '!:|BREAKING CHANGE'
```

### 1b. Public API Surface Diff

Commit messages in most cases miss breaking changes. Diff the actual exports to catch unlabeled ones:

```bash
# Compare exports between tags (adapt paths to project structure)
# For packages with src/index.ts or similar entry point:
git diff PREV_TAG..HEAD -- src/index.ts src/exports.ts src/public.ts index.ts

# For Nuxt modules, also check runtime/ and composables/:
git diff PREV_TAG..HEAD -- src/runtime/ src/module.ts

# Check for removed or renamed exports
git diff PREV_TAG..HEAD -- '*.d.ts' | grep -E '^\-export'
```

Flag any removed exports, renamed functions, changed type signatures, or removed config options as **potential breaking changes** even if commits don't label them.

### 1c. Documentation & Migration Context

Analyze docs changes to enrich highlights and catch migration notes already written:

```bash
# Docs changes since last tag
git diff PREV_TAG..HEAD --stat -- docs/ README.md MIGRATION.md UPGRADING.md '*.md'

# Read any migration or upgrade docs that were added/modified
git diff PREV_TAG..HEAD --name-only -- docs/ '*.md' | grep -iE 'migrat|upgrad|breaking|changelog'
```

Read any modified migration docs in full. These in most cases contain context that commit messages lack and should inform both the Highlights narrative and the upgrade prompt.

### 1d. Dependency Bumps

Major dependency upgrades in most cases introduce transitive breaking changes:

```bash
# Diff package.json dependencies
git diff PREV_TAG..HEAD -- package.json | grep -E '^\+.*"(dependencies|peerDependencies)"' -A 50 | grep -E '^\+\s+"'
```

If any dependency had a **major version bump**, note it as a potential source of breaking changes and check that dep's own changelog for migration notes.

## Step 1.5: Semver Sanity Check

Compare the target version against findings:
- **Breaking changes found + minor version bump**: warn the user that this should likely be a major bump (or document why semver is intentionally violated, e.g., pre-1.0)
- **No new features + minor version bump**: suggest this Will be a patch instead
- **Pre-1.0 packages** (`0.x.y`): minor bumps can contain breaking changes per semver spec, but still note them clearly

## Step 2: Categorize & Prioritize

### Categorization

Parse conventional commit prefixes into changelog sections. See [references/changelog-categories.md](references/changelog-categories.md) for the full mapping.

### Identify Highlights

Select 3-7 changes that deserve narrative treatment in the Highlights section. Criteria:
- New user-facing features (`feat:`)
- Performance improvements with measurable impact (`perf:`)
- Breaking changes that affect upgrade path
- Changes with significant PR descriptions explaining motivation

For each highlight, fetch the full PR body if not already available:
```bash
gh pr view NUMBER --json body,title --jq '.title + "\n" + .body'
```

## Step 3: Write Release Notes

Check the preprocessed "Prior release style" above. If the repo has existing GitHub releases, match that structure and tone. If no prior releases exist (or user requests it), follow the Nuxt release format. See [references/nuxt-release-format.md](references/nuxt-release-format.md) for the exact structure.

Structure:

```markdown
# vX.Y.Z

## 👀 Highlights

[1-2 sentence intro: what this release focuses on, tone should be enthusiastic but not breathless]

### EMOJI Feature Title
[2-3 sentences explaining the feature, why it matters, what it enables]

[Code example if applicable]

... repeat for each highlight ...

## ⚠️ Breaking Changes
[Only if breaking changes exist. List each with migration steps.]

## ✅ Upgrading

[Package manager commands + brief notes]

## 👉 Changelog

> [Compare link: PREV_TAG...vX.Y.Z](REPO_URL/compare/PREV_TAG...vX.Y.Z)

### 🚀 Enhancements
- Description of change ([#NUMBER](REPO_URL/pull/NUMBER))

### 🔥 Performance
...

### 🩹 Fixes
...

### 💅 Refactors
...

### 📖 Documentation
...

### 🏡 Chore
...

### ❤️ Contributors
[List of contributors]
```

### Writing Guidelines

- Highlights are **narrative prose**, not bullet lists. Explain the "why" and "what it enables", not just "what".
- Code examples should be minimal, showing the new API or config change.
- Changelog items are **one-line bullets** with PR links.
- Skip empty categories (if no perf changes, omit 🔥 Performance).
- Contributors: deduplicate, use GitHub usernames with profile links.

## Step 4: LLM Upgrade Prompt (Breaking Changes Only)

If breaking changes exist, generate an upgrade prompt that helps users migrate. Read the template at `${CLAUDE_SKILL_DIR}/templates/upgrade-prompt.md`.

The upgrade prompt should be:
- A standalone markdown file users can paste into any LLM
- Self-contained with all context needed to migrate
- Specific about what changed, what breaks, and how to fix it
- Include before/after code examples for each breaking change
- Include grep patterns so the LLM can find affected code in the user's codebase

Write the upgrade prompt to a standalone file:
```bash
echo "PROMPT_CONTENT" > upgrade-prompt-vX.Y.Z.md
```

Also embed it in the release notes as a collapsible section after ⚠️ Breaking Changes:

```markdown
<details>
<summary>🤖 LLM Upgrade Prompt — paste this into Claude, ChatGPT, etc. to migrate your codebase</summary>

UPGRADE_PROMPT_CONTENT

</details>
```

This way users discover the prompt directly in the GitHub release page.

## Step 5: Output

Present the release notes in full. Then:

1. Ask if the user wants to create a GitHub release draft:
   ```bash
   gh release create vX.Y.Z --draft --title "vX.Y.Z" --notes "$(cat <<'EOF'
   RELEASE_NOTES
   EOF
   )"
   ```
   Use `--draft` so the user can review before publishing.

2. Report the file path of the standalone upgrade prompt (if generated).

3. Log to history:
   ```bash
   echo "$(date -I) vX.Y.Z PREV_TAG" >> "${CLAUDE_PLUGIN_DATA}/release-notes-history.log"
   ```
