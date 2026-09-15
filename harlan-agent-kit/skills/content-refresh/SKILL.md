---
name: content-refresh
description: "Refresh a collection of articles with verified sources, reviewed briefs, human writing, and crisp screenshots. Use for an editorial audit, article rewrite, or coordinated content refresh."
user_invocable: true
argument-hint: "[content directory] [scope or exclusions]"
---

# Content refresh

Turn a content directory into reviewed articles that answer real reader questions.
Write for humans first. Reveal complexity as the reader needs it.
Precise examples should also remain useful to agents.

## Establish scope

Inspect the target repository, its Agent instructions, content configuration, routes, navigation, and existing editorial records.
Include relevant hidden project records, such as prior SEO research under .claude/, using a bounded search.
Treat old research as leads to recheck, not current source proof.
Read its glossary through the [glossary Skill](../glossary/SKILL.md).
If no glossary exists, use that Skill to propose terms and resolve naming decisions before dependent copy.
Do not silently adopt another project's vocabulary.
Do not transfer another product's facts, terminology, source scores, or rollout claims.

Record included files, exclusions, new article candidates, target readers, and existing publication authority.
If an exclusion has two materially different meanings, clarify it before dependent work.
Preserve existing URLs unless a reviewed redirect replaces them.
Skill creation or a dry run does not authorize rewriting the target collection.

Follow the [worktree contract](../../references/worktree-isolation.md) before repository mutations.
Keep temporary evidence in ~/scratch/. Put user reports in ~/notes/ with a Mermaid diagram and browser link.

## Prepare evidence before prose

Read [foundations](references/foundations.md).
Create or update four project-owned documents before assigning article drafts:

| Document | Owns | Used by |
| --- | --- | --- |
| SOURCES.md | Approved authorities, exact URLs, discovery patterns, and evidence limits | Source researcher and brief reviewer |
| VERIFIED-CLAIMS.md | Checked assertions, scope, dates, evidence, and unresolved questions | Writer and factual reviewer |
| COPY.md | Article voice, reader level, progressive complexity, and product mention rules | Writer and humanize pass |
| SCREENSHOTS.md | Capture, annotation, privacy, sharpness, figures, and captions | Browser operator and visual reviewer |

Keep these documents in the target repository, outside its published collections.
Every brief links all four. Workers read them before drafting; reviewers check compliance.
Reuse existing equivalents instead of creating competing policies.
The Skill supplies reusable procedure. These documents carry the project's editorial decisions and evidence.
Prove these records sit outside published collections, navigation, search, and sitemap outputs.
Use explicit collection boundaries. Never assume uppercase filenames or a drafts directory are excluded.

Use the available NuxtSEO Skill for search evidence and gaps when relevant.
Discover its current name and interface; older projects may call it nuxt-seo-pro.
Record the exact Site, locale, evidence dates, and missing data.
Do not invent keyword volume, competition, or demand when access is missing.
Respect the user's allowance for paid research. Continue source verification without it.
If research tooling fails, record the command, version, error, and unavailable evidence.
Try a documented fallback once when it preserves authorization and cost boundaries.
If it still fails, continue primary-source work. Do not turn the refresh into an unrelated platform repair.

Map each article to definitive sources and its reader question.
Flag fresh features from dated primary announcements, then check current documentation and availability.
A UI release alone does not prove API support.
For source-only requests, create only unpublished candidates with sources and missing evidence.

## Run a pilot, then a bounded pool

Read [briefs and review](references/briefs-and-review.md).
Pick one representative article with a concrete example and the hardest relevant evidence boundary.
Prepare its brief, independently review it, write it, then review the rendered article.
Use the accepted pilot's reasoning and progressive complexity, without imposing identical headings on every article.
If the user already accepted a pilot, reuse it. Ask only for unresolved editorial choices.

Delegate with at most four active agents across the entire task tree, or the user's lower limit.
Count ancestors, the coordinator, and every nested child. Allocate remaining slots before a child delegates.
Use a brief reviewer, a writer, and an independent article reviewer when slots permit.
Reuse idle agents. Never let a writer approve their own article.
With fewer slots, serialize these roles. If delegation is unavailable, report the missing independent review.
One operator owns the signed-in browser. Share sanitized captures with other agents.

The coordinator owns shared records and branch dependencies.
Give each worker exact files, approved evidence, parent revision, acceptance checks, and a handoff location.
Workers submit evidence and pause. Reviewers return specific findings to the worker.
The coordinator checks each completed handoff and gives feedback before marking it complete.
A new revision invalidates affected approvals. Recheck changed claims and consumers.

## Write and verify

Read [screenshots](references/screenshots.md) before planning visual evidence.
Use the target's article voice and the [humanize-writing Skill](../humanize-writing/SKILL.md).
Run a distinct factual review before the humanize pass.
Then apply both humanize-writing passes under COPY.md, including progressive complexity.
Record the main writing changes in the brief. Recheck meaning, uncertainty, dates, and examples afterward.
The final article reviewer reads the humanized revision, not an earlier draft.
Record useful findings in the brief instead of flooding the user with every worker's writing report.

After individual articles pass, make one collection pass for natural internal links, vocabulary, and navigation.
Link only where the destination answers the next question. Check destination fragments and avoid forced product mentions.
Keep comparisons and original research under their stronger evidence rules in foundations.

Use the [pr Skill](../pr/SKILL.md) for all changes, including editorial records.
Stack only dependent changes using its stack contract. Independent article groups need not form a long chain.
Propagate shared corrections through dependent branches before reviewing their final revisions.
Record new article evidence with the article change, including its updates to shared records.
Change a reviewed parent for a foundation correction, not merely to append downstream test evidence.
Do not add automatic merge labels to Skills or Agent instructions.

Use [adversarial-review](../adversarial-review/SKILL.md) for final PR review.
Use [take-ownership](../take-ownership/SKILL.md) for authorized delivery, then [close-off](../close-off/SKILL.md).
Wait for CI using gh run watch or gh pr checks --watch, never sleep-based polling.

Verify every published route, title, description, canonical, internal link, and downloadable example.
Check representative desktop/mobile pages, native figures, image loading, and real client navigation.
Confirm unpublished records remain absent from public outputs.
A successful build or merge does not prove publication. Verify the deployed revision and live pages.
Record untested authenticated paths without implying they passed.

## Dogfood feedback

When asked to exercise or improve this Skill, keep a small papercut log alongside the task report.
Record the Skill revision and section, triggering task, observed friction, workaround, and proposed smallest correction.
Separate a missing instruction from repository defects, tool outages, and missing account access.
Send issues to the supervising agent as they occur. Do not silently change instructions during a worker's assignment.
The supervisor reviews fixes and tells workers which revised instruction applies.
Continue independent content work while a Skill correction is reviewed.
Do not expand into unrelated service repairs or invent friction to justify more instructions.

## Handoff

Report the reviewed pilot, article states, unresolved evidence, PRs, and publication state.
Keep the full ledger in the target's unpublished editorial directory.
Give the user a short report link and confidence based on checks actually performed.

For the first transfer to request-indexing, read [the transfer checklist](references/request-indexing.md).
