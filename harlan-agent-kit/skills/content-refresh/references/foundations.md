# Editorial foundations

Create or update all four project documents. Reuse existing equivalents and keep them small and specific.
These are living dependencies, not a checklist completed once.
SOURCES.md admits evidence. VERIFIED-CLAIMS.md records what that evidence actually supports.
COPY.md controls how the article teaches. SCREENSHOTS.md controls how visual evidence teaches.
A source policy alone cannot certify claims. A humanize pass cannot repair missing evidence.
The filenames below are defaults within a proven unpublished directory.

## SOURCES.md

Record source, topic scope, exact entry URL, discovery URL pattern, editorial priority, and limitations.
Scores rank editorial usefulness. They are not measured accuracy probabilities.

Prefer primary documentation for supported behavior, limits, authentication, and metric definitions.
Use dated announcements for release history, then reconcile them with current documentation.
Read original employee statements with their question and conversation context.
Use reporting outlets to discover primary evidence, not to manufacture independent corroboration.
Use studies only within their disclosed sample, method, and collection period.

Open full sources. Search snippets, existing copy, domain reputation, and a high score do not verify claims.
Cite the final supporting page beside the claim, not a homepage or discovery query.
Respect quotation limits; prefer precise paraphrases.
When sources conflict, record both dates and scopes. Narrow or defer the claim if conflict remains.
Check protocol literals against the applicable reference or schema; examples can contain stale names.

## VERIFIED-CLAIMS.md

Use one row per reusable claim:

| ID | Status | Evidence kind | Claim | Scope and qualifications | Supporting URL or evidence | Checked | Source date/version |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TOPIC-01 | Unresolved | Missing | Exact assertion requiring evidence | Product, report, account, region, API version | Pending inspection | Unchecked | Unknown |

Statuses: Documented, Observed, Unresolved, Withdrawn.
Retain equivalent statuses already used by the project; do not flatten their distinctions.
Record evidence kind separately: official documentation, external study, implementation inspection, live observation, or synthetic example.
Trace executable behavior and its callers. A code comment does not establish upstream behavior or a product guarantee.
Implementation inspection establishes what code does within that scope. Mocked tests do not establish a live integration result.
External studies establish their authors' measured findings within their sample, not our own observations.
Keep withdrawn claims with their reason, date, replacement, and affected articles so they cannot silently return.
Documented requires an inspected primary source. Observed requires saved inspection evidence.
Keep synthetic examples explicitly synthetic; they never establish observed product behavior.
A screenshot verifies visible state, not downstream calculations or universal availability.
A glossary fixes names, not facts. Marketing copy does not verify product capabilities.

Distinguish launch date, rollout date, source update, observation date, and measurement period.
Recheck changeable claims before publication. State the relevant units, denominator, time zone, and scope.
Keep UI, export, API, and storage claims separate until each interface has evidence.
For API changes, inspect changelogs, reference schemas, and discovery versions where available.
No documented API change means evidence was not found; it does not prove no change exists.

Map each article to claim IDs and definitive sources in its brief.
If a shared claim changes, reopen every dependent article's review.
Never rewrite dated test evidence to match a newer test count.
Record a new run with its own command, revision, date, and output instead.

## COPY.md

Keep article voice separate from homepage sales copy.
Start with the common case and one useful example. Add detail for the next likely question.
Keep prerequisites and qualifications beside the step they change.
Put uncommon cases later or link them. Do not require FAQs, summaries, or identical outlines.
Explain what the reader can conclude and what to check next.
Use product mentions only when a verified capability helps that task.
Attribute documentation and observations. Never invent first-person experience or speak as the owner.
Humanization must preserve evidence scope and technical meaning.

## SCREENSHOTS.md

Adapt the [screenshot procedure](screenshots.md) to the target's tools and renderer.
Record the actual capture command, sanitized asset directory, private evidence directory, and annotation method.
Record measured source density, display width caps, caption styling, and mobile checks.
Link one verified example for each image type the collection actually needs.
Do not copy a renderer path from another repository unless that dependency exists in the target.
Keep the capture date and limitations with each asset's brief.

## Keeping the four documents aligned

The coordinator owns shared changes; workers propose corrections with evidence.
Source changes update affected claims and reopen dependent briefs.
Voice changes require a new humanize pass only where they affect accepted prose.
Screenshot policy changes reopen affected asset and rendered-page checks.
Glossary corrections update terminology across the four documents and dependent articles without inventing factual support.
Preserve historical observations with their dates. New evidence gets a new check record.

## Comparisons

First check whether the vendor still operates the service being compared.
If it has closed, preserve useful existing URLs and explain the supported replacement task without inventing closure details.
Check each vendor's current official feature and pricing pages.
Compare the actual mechanism before assigning Yes/No labels; opening another tool differs from performing its action.
Record plan, currency, billing interval, trial conditions, and check date when mentioning price.
If terms remain ambiguous, omit the number and link current pricing. Do not guess currency from a dollar sign.
Verify the target product against its implementation and observed behavior.
Distinguish shipped, planned, unavailable, and unverified capabilities.
Do not turn a missing vendor page into a claim that a feature does not exist.
Represent useful competitor strengths fairly. Every comparison row needs scoped evidence.

## Original research

Require original inputs, provenance, sample selection, collection period, and reproducible calculations.
Separate publication date from the period measured.
Check units, denominators, aggregation, weighting, exclusions, and causal language.
Do not replace a missing dataset with synthetic inputs while retaining an empirical conclusion.
If prior findings lack evidence, remove unsupported claims and provide a dated correction when appropriate.
Use external research with attribution, never as a substitute for claimed first-party measurements.
Verify downloadable scripts match reviewed code before running them.
