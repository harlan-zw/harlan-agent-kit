---
name: d1-query-review
description: Review production D1 query performance weekly across every database used by a site. Inventory bindings and tenant databases, rank measured costs, and propose evidence-backed repairs.
license: MIT
---

# D1 query review

Replace the manual review of slow production D1 queries. Keep production access read only.
Use the repository's existing credentials. Scheduled workers receive private collection values before entering their isolated home.
Approved fleet scans receive the dedicated read-only token from the controller's private `wolfstar-checkin/d1-query-review.env`.
That file supplies `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Other Routine and Repair workers never receive it.
The private credential file stays on the controller. Its absence inside the worker does not prove missing credentials.

## Inventory

Read deployment configuration, module configuration, provisioning code, and database registries.
Resolve production Workers and Pages bindings from deployment metadata. Source configuration alone cannot prove production bindings.
Include runtime-created tenant databases and shared databases. Exclude preview and development databases explicitly.
Reconcile the site inventory against the account's D1 database list and deployed bindings.
Record database ID, binding, owning site, environment, inventory source, and collection outcome in the private archive.
Never claim complete coverage when a binding or tenant registry remains unread.
If a site uses no D1 databases, report that result and the evidence that proves it.

## Collect

Use `DAILY_CHECKIN_DIR` for this Routine's private archive. Save timestamped inventory, raw analytics, and a report.
Preserve prior windows. Use the last seven complete UTC days and the preceding seven days for comparison.
Read `cf cli search 'list D1 databases'` to find the current account inventory command.
If `cf` is unavailable on the scheduled host, read `GET /accounts/{account_id}/d1/database` through Cloudflare's REST API.
Paginate until the inventory is complete. Read production Workers settings and Pages project metadata to resolve bindings.
For query analytics, use Cloudflare's GraphQL Analytics API and introspect `d1QueriesAdaptiveGroups` before selecting fields.
The API endpoint is `https://api.cloudflare.com/client/v4/graphql`. Never print authentication headers.
Read [Cloudflare's metrics contract](https://developers.cloudflare.com/d1/observability/metrics-analytics/) before interpreting metrics.
If this repository already uses Wrangler, `pnpm exec wrangler d1 insights --help` exposes its current read-only options.
Never introduce Wrangler into a repository without its configuration.

Collect query count, average duration, total duration, rows read, and rows written for every database.
Read available latency quantiles separately. Never invent p95 from an average or an error sample.
Capture high total duration, high average duration, and high row-read query groups.
Record limits, pagination, sampling, retention, and permission failures. A truncated result cannot establish absence.
Bound parameters are omitted from D1 Insights. Query literals may still contain customer data. Keep raw SQL private.
Runtime `d1.query_slow` events supplement Insights. They cover slow-request events, not every query execution.
Never use their counts as total volume or their absence as proof of health.

## Decide

Rank measured user impact, total query time, and row-read cost. Compare equal windows and traffic rates.
Trace each expensive query to its source, call frequency, indexes, schema, and existing issue work.
Distinguish low-volume slow queries from repeated scans that dominate aggregate cost.
Use local schema and representative fixtures for `EXPLAIN QUERY PLAN` and result checks.
Do not execute expensive diagnostic SQL, modify rows, apply migrations, or change indexes in production.
Only measured costs with a proven repository cause earn a Candidate. Missing telemetry earns a report limitation.
Use stable site, database role, source symbol, and cause identities. Never include dates, counts, or SQL parameters.
Reuse prior fingerprints and link existing repairs. Require fresh evidence after deployment before declaring recovery or regression.
Group repairs that share one cause. Keep every database's disposition visible in the archive.

## Report

Return `report`, `verdict`, and `candidates` through the controller's JSON response.
The report starts with the comparison windows, database coverage, and the next required action.
List ranked findings with measured cost, source, prior-window change, existing work, and verification.
List uncovered databases and the exact next read. Keep raw SQL, identifiers, and credentials out of public reports.
Use GREEN only for complete coverage with no action. Use AMBER for proven opportunities and RED for failed checks.
The archive retains exhaustive evidence. Updating it is part of the run, never separate issue work.

For repairs, prove unchanged query results and improved plans with local fixtures.
Keep deployment verification pending until production evidence confirms the published fix.
