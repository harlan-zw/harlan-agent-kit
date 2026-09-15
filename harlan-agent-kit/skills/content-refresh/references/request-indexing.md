# First transfer: request-indexing

This is a starting checklist, not verified product or competitor evidence.
Reinspect the repository and sources each time the Skill runs.

## Inspected starting point

On 15 September 2026, apps/marketing/content contained six guides and three comparisons.
Its content.config.ts declares separate guides and comparisons collections.
Guides use content/guides as their source directory with the root URL prefix.
Comparisons use content/comparisons with the /comparisons prefix.
Both collections include every Markdown file under their source directory.

Place shared editorial records beside these directories only after confirming the current collection boundaries.
Keep drafts outside guides and comparisons. Verify public queries, navigation, search, and sitemap exclusion.
Inspect the renderer before using native figures or deciding whether frontmatter already supplies the H1.
Some existing comparisons contain a Markdown H1; do not assume that produces one rendered H1.

## Evidence priorities

- Inspect Google's current Indexing API quickstart, usage, quotas, and reference pages.
- Verify supported content types and the distinction between notification acceptance, crawling, and indexing.
- Check URL Inspection separately from submission APIs and Search Console UI actions.
- Check ownership, authentication, quota scope, batching, and error examples against the relevant interface.
- Verify employee quotations from original statements with their dates and context.
- Treat community anecdotes as observations, not guarantees or evidence of Google's detection algorithms.
- Check each competitor's current official pricing and feature pages, including plan and billing interval.
- Verify Request Indexing claims against its own implementation; do not import gscdump capabilities.

Useful discovery starting point: https://developers.google.com/search/apis/indexing-api/v3/quickstart
Discovery pattern: https://developers.google.com/search/apis/indexing-api/v3/*
Open and verify sources before adding any Documented claim. These addresses do not certify existing prose.

## Suggested first run

Invoke content-refresh for apps/marketing/content in the request-indexing repository.
Inventory all nine current articles, build the foundations, then review one pilot before expanding.
A supported-use or first-request guide is a useful pilot because it exercises the central evidence boundary.
Select it after source checks; retain existing URLs unless an explicit redirect is reviewed.
Do not carry the Search Console pilot's heading sequence or screenshots into this product.

For a dry run, produce only an unpublished inventory, evidence gaps, proposed brief, and check plan.
No article rewrite, authenticated submission, paid research, or publication follows from a dry run.
