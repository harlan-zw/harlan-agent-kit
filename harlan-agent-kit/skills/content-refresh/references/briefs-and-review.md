# Briefs and independent review

Keep a collection ledger with file, route, reader question, claim IDs, owner, parent revision, review state, and PR.
Use these states: sources needed, brief ready, brief reviewed, draft ready, article reviewed, published verified.
Each approval records reviewer, revision, evidence, and unresolved limitations.
Do not advance a state from a worker's completion message alone.

## Minimal article brief

- File and stable route; reader level; question; useful outcome; explicit exclusions.
- Current source URLs, claim IDs, dates, qualifications, contradictions, and missing evidence.
- Search evidence and its locale/date, or an explicit absence of measured demand.
- Contribution beyond existing sources: worked example, interpretation, comparison, or tested procedure.
- Progressive outline: common case, concrete example, next decision, later edge cases.
- Shot list: reader question, required UI state, figure type, capture owner, caption, and alt text.
- Natural related articles, intended navigation group, and any redirect dependency.
- Exact example artifact, runtime/client version, invocation, expected result, and checks.
- Authenticated paths that remain untested; offline fixtures must not imply a live result.
- Brief review findings, writer response, article review findings, and coordinator decision.

A source-only candidate needs the question, sources, and missing evidence. Do not fabricate an approved brief.

## Reviewer responsibilities

The brief reviewer opens definitive sources and challenges the scope before prose starts.
Check whether the promised outcome is supported and teachable at the stated reader level.
Reject invented demand, unsupported comparisons, generic announcement summaries, and hidden prerequisites.
Return concrete changes with a reason and the evidence needed to resolve them.

The writer follows the reviewed brief and updates evidence when new questions arise.
If a claim cannot be supported, narrow it or return it to review.
The writer checks examples and renders their article before handoff.
Choose checks for the behavior the example claims, not only its syntax.
A sequential loop is not multipart batching; a local counter does not enforce shared daily quota.
Record what syntax checks, mocked responses, and live calls each establish.
Keep a sanitized check or complete replay instructions outside published collections. Temporary logs alone cannot reproduce an example check.
Read examples from the articles when practical, so the check exercises the published code.

The article reviewer checks facts against sources, not against the writer's assertion of accuracy.
Check progressive complexity, glossary terms, qualifications, attribution, and useful product mentions.
Confirm humanization did not add certainty, personal experience, or remove a material caveat.
Read captions and numbered steps against actual images.
Verify every factual table cell, code example, route, and fragment introduced by the article.
Include claims repeated in descriptions, FAQs, related-page labels, and structured data.
A corrected paragraph does not repair contradictory metadata or hidden FAQ copy.

The coordinator inspects the submitted evidence and final revision.
Approve or return specific findings before the worker closes the assignment.
A reviewer and writer can exchange feedback directly; the coordinator owns final acceptance.
Before handoff, reconcile each brief with the collection ledger and the final reviewed revision.
Replace stale pending decisions, or label them as history. Distinguish commit SHAs from file digests.

## Rendered and collection checks

Read the actual content schema and page renderer before choosing frontmatter or Markdown components.
Check one H1, article-specific metadata, dates, canonical conventions, and structured data where present.
Preserve publishedAt. Update updatedAt only after reviewing and updating the article itself.
Do not refresh dates merely because shared policies changed.
Do not assume a filename maps directly to its public URL.
Wait for the destination heading after client navigation, not just a changed URL.
Check mobile overflow, tables, code blocks, figures, links, and keyboard-accessible image controls.

After all articles pass, inspect nearby opportunities for internal links once.
Use descriptive anchors at natural decision points. Avoid quotas for links or repeated promotional endings.
Check navigation groups, hub cards, related-page metadata, redirects, and old fragments.
Verify editorial records are absent from content queries, rendered navigation, search, and sitemap output.

Apply repository checks appropriate to the changed behavior.
Check whether repository lint processes Markdown and fenced examples. Include those paths in the writer's checks.
Record each command and its scope. Renderer-only lint does not verify article code.
Do not add tests that count factual claims or mirror prose.
Test content routing or exclusion behavior when changing those contracts.
Record failures in the environment separately from article defects.
