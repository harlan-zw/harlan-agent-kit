# Email Triage Heuristics

## Urgency Scale (1-5)

| Score | Meaning | Signals |
|-------|---------|---------|
| 1 | Noise, safe to delete | Newsletters, expired promos, automated notifications with no action needed |
| 2 | Low priority, route and forget | Receipts, subscription confirmations, resolved notifications |
| 3 | Moderate, action within a few days | Non-urgent client emails, project updates, billing notices |
| 4 | Important, action today | Direct client requests, time-sensitive finance, support tickets awaiting response |
| 5 | Critical, action now | Urgent client escalation, security alerts, payment failures, deadline-driven requests |

## Category Routing

| Category | Typical Senders | Default Action | Target Folder |
|----------|----------------|----------------|---------------|
| client | Client domains, known contacts | reply or move | Clients/<name> |
| finance | Stripe, PayPal, Mercury, Airwallex, banks | move | Finance/<provider> |
| notification | GitHub, NPM, Slack | move or delete | Notifications/<service> |
| newsletter | Mailing lists, marketing | delete | Trash or Auto Purge |
| spam | Unknown senders, suspicious patterns | delete | Trash |
| personal | Known personal contacts | skip (keep in inbox) | INBOX |
| project | Nuxt SEO, Request Indexing related | move | Projects/<name> |
| automated | CI/CD, monitoring, system alerts | move or delete | ZMNotification or delete |

## Signal Weighting

- **Sender recognition** -- known client/contact → higher urgency. Unknown sender + marketing language → lower.
- **Subject keywords** -- "urgent", "action required", "payment failed", "overdue" → boost urgency. "Newsletter", "digest", "weekly" → lower.
- **Age** -- unread email older than 7 days with no follow-up is likely low urgency or already handled elsewhere.
- **Reply expectation** -- direct questions, "can you", "please confirm", "when can" → suggestedAction: reply.
- **Thread depth** -- if reading full body reveals an ongoing conversation awaiting response → boost urgency.
- **Attachment presence** -- `has_attachment: true` on client/finance emails → slightly higher urgency (may contain invoices, contracts).
- **Flags** -- already `Seen` → user has glanced at it, may have mentally deprioritized. Still triage normally but note it.

## Folder Matching Heuristics

When suggesting a destination folder, match by:

1. **Sender domain** → client folder (e.g., `@odysseytraveller.com` → `Clients/odysseytraveller.com`)
2. **Sender service** → notification/finance folder (e.g., `@github.com` → `Notifications/GitHub`, `@stripe.com` → `Finance/Stripe`)
3. **Subject keywords** → project folder (e.g., "Nuxt SEO" → `Projects/Nuxt SEO Pro`)
4. **Fallback** → if no clear match, suggest `move` to most relevant parent category or `skip`
