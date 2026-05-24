---
name: email-triage
description: Triage inbox emails with himalaya. Use when user says "check email", "triage email", "email triage", "check inbox", "process email", "email me", "what emails do I have", "clear inbox", "inbox zero", "follow ups", "awaiting reply", "who hasn't replied", or "chase up".
user_invocable: true
context: fork
---

Triage inbox emails, classify by urgency, and batch action them (delete, move, draft reply, skip).

## Accounts

Two accounts are configured in himalaya. Use `-a <name>` to target a specific account:

| Name | Email | Default |
|------|-------|---------|
| harlanzw | harlan@harlanzw.com | yes |
| hotmail | harlan103@hotmail.com | no |

When no `--account` is specified, triage **both** accounts sequentially (harlanzw first, then hotmail). The hotmail account uses OAuth2 via Thunderbird's public client ID; if the token expires, re-auth with `ortie auth get -a hotmail`.

## Gotchas

- **IMAP connection timeouts** -- himalaya connects over IMAP. If commands hang, the connection may have dropped. Retry once before reporting failure.
- **Hotmail OAuth2 token expiry** -- the hotmail access token expires after ~1 hour. If you get a keyring/auth error, run `ortie auth get -a hotmail` to re-authenticate, then re-store tokens with the himalaya keyring attributes (service=himalaya-cli, username=hotmail-oauth2-access-token/refresh-token, target=default, application=rust-keyring).
- **Envelope IDs are session-volatile** -- IDs change after moves/deletes. Always action emails in a single pass; do not cache IDs across steps.
- **Delete = move to Trash** -- `himalaya message delete` moves to Trash unless already in Trash. Safe for triage.
- **template send is irreversible** -- never send a reply without explicit user confirmation. Always save drafts first using `himalaya template save -f Drafts`.
- **Large inboxes** -- default page size is 50. If inbox has hundreds of unread, triage in batches using `--page` and `--page-size`.
- **Folder names with spaces/slashes** -- quote folder names in commands: `himalaya message move "Finance/Stripe" 1234`.

## Data Storage

Track triage sessions:

```bash
echo "$(date -I) FOLDER TOTAL DELETED MOVED REPLIED SKIPPED" >> "${CLAUDE_PLUGIN_DATA}/email-triage-history.log"
```

On subsequent runs, show time since last triage.

## Available Folders

These are the known folders for routing:

| Category | Folders |
|----------|---------|
| Core | INBOX, Drafts, Sent, Spam, Trash |
| Clients | Clients/inbound, Clients/odysseytraveller.com, Clients/harlanzw.com, Clients/massivemonster.co, Clients/Paspaley, Clients/Forgd, Clients/U7BUY, Clients/SuperDesign, Clients/old.harlanzw.com |
| Notifications | Notifications/GitHub, Notifications/NPM, Notifications/Slack |
| Finance | Finance/Airwallex, Finance/Kraken, Finance/Stripe, Finance/DigitalOcean, Finance/Porkbun, Finance/Personal, Finance/Anthropic, Finance/Misc Business, Finance/PayPal, Finance/Mercury |
| Projects | Projects/Nuxt SEO Pro, Projects/Request Indexing |
| Travel | Travel/NZ 2025, Travel/Chile 2025 |
| Other | Archives, House, Auto Purge, ZMNotification, ZMNewsLetter |

## Workflow

### Step 0: Parse arguments and check last triage

- If `$ARGUMENTS` provided, parse:
  - `--account <name>` = triage a specific account (default: both)
  - `--folder <name>` = triage a specific folder (default: INBOX)
  - `--unread` = only unread messages (filter: `not flag seen`)
  - `--limit <n>` = override page size (default: 50)
  - `--from <pattern>` = filter by sender
  - `--follow-ups` = switch to follow-up detection mode (see Step 8)
- Check `${CLAUDE_PLUGIN_DATA}/email-triage-history.log` for last triage timestamp
- If `--follow-ups` flag is set, skip to Step 8

### Step 1: Fetch envelopes

```bash
himalaya envelope list -o json -s <limit> -f <folder> [QUERY]
```

Query examples:
- Unread only: `not flag seen`
- Recent: `after 2026-03-20`
- From specific sender: `from github`

### Step 2: Parallel batch classification

Split envelopes into batches of 10. Spawn parallel **haiku** agents.

Each agent receives a batch of envelopes (id, subject, from, date, flags) and classifies using [references/heuristics.md](references/heuristics.md).

```
Task(model: haiku, prompt: "Classify these emails. Return JSON array:
  { id, urgency (1-5), category, suggestedAction, suggestedFolder, reason }

  Categories: client, finance, notification, newsletter, spam, personal, project, automated
  Actions: reply, move, delete, skip

  Emails: [JSON batch]")
```

### Step 3: Read high-urgency emails

For any email classified as urgency 4-5 or `suggestedAction: reply`, read the full message body to provide better context:

```bash
himalaya message read <id> -f <folder> --no-headers
```

Limit to 5 full reads per triage to keep things fast. Spawn these reads in parallel.

### Step 4: Present triage table

Display merged results sorted by urgency (descending):

| # | From | Subject | Age | Urgency | Action | Destination | Reason |
|---|------|---------|-----|---------|--------|-------------|--------|
| 5129 | CodeRabbit | Trial nearing... | 1d | 2 | delete | Trash | Automated trial notice |
| 5128 | GitHub Support | Report Abuse... | 2d | 3 | move | Notifications/GitHub | Support ticket update |

Group by suggested action:
1. **Delete** (spam, expired promos, automated noise)
2. **Move** (sorted by destination folder)
3. **Reply needed** (show message preview)
4. **Skip** (keep in inbox, needs manual attention)

### Step 5: User confirmation

Present action summary and ask for confirmation:

```
📬 Triage Summary:
  Delete: 12 emails
  Move: 8 emails (3→Notifications/GitHub, 2→Finance/Stripe, 3→Clients/inbound)
  Reply: 2 emails
  Skip: 3 emails

Proceed? You can also:
  - Remove specific IDs from actions: "skip 5129, 5130"
  - Change action for an ID: "move 5129 to Finance/Stripe"
  - "delete all newsletters"
  - "show me 5128" to read a specific email
```

Allow iterating until user says "go", "proceed", or "do it".

### Step 6: Execute actions

Execute in this order (to handle ID volatility):

1. **Draft replies first** -- for each reply email:
   ```bash
   himalaya template reply <id> -f <folder>
   ```
   Show the generated template. Let user edit the body. Save to Drafts:
   ```bash
   himalaya template save -f Drafts "<edited template>"
   ```
   Only send if user explicitly says "send" for that reply.

2. **Move messages** -- batch by destination:
   ```bash
   himalaya message move "<target_folder>" <id1> <id2> <id3> -f <folder>
   ```

3. **Delete messages** -- batch delete:
   ```bash
   himalaya message delete <id1> <id2> <id3> -f <folder>
   ```

### Step 7: Log and summarize

```bash
echo "$(date -I) <folder> <total> <deleted> <moved> <replied> <skipped>" >> "${CLAUDE_PLUGIN_DATA}/email-triage-history.log"
```

Show final summary with counts. If replies were drafted, remind user to review Drafts folder.

### Step 8: Follow-up detection (when `--follow-ups` or trigger words used)

Detect sent emails that never got a reply. Useful for chasing up clients, support tickets, etc.

1. **Fetch recent sent emails**:
   ```bash
   himalaya envelope list -o json -s <limit> -f Sent after <date>
   ```
   Default: last 14 days. Override with `--since <yyyy-mm-dd>`.

2. **For each sent email, check for replies in INBOX**:
   Search for responses by matching subject (strip "Re: "/"Fwd: " prefix) and recipient:
   ```bash
   himalaya envelope list -o json -f INBOX subject "<stripped subject>" from "<original recipient>"
   ```
   Also check Trash and relevant subfolders in case the reply was already triaged.

   Spawn parallel **haiku** agents in batches of 10 to do this matching.

3. **Filter to unanswered only** -- emails where no matching reply envelope was found.

4. **Classify staleness**:

   | Days since sent | Status | Suggested action |
   |----------------|--------|-----------------|
   | 1-3 | Fresh | skip, too early to chase |
   | 4-7 | Due | gentle follow-up |
   | 8-14 | Overdue | direct follow-up |
   | 15+ | Stale | flag for manual decision, may no longer be relevant |

5. **Present follow-up table**:

   | To | Subject | Sent | Days ago | Status | Action |
   |----|---------|------|----------|--------|--------|
   | client@example.com | Invoice #42 | 2026-03-18 | 7 | Due | draft follow-up |
   | support@github.com | Abuse report | 2026-03-15 | 10 | Overdue | draft follow-up |

6. **User picks which to chase** -- for each selected email:
   ```bash
   himalaya template reply <original_sent_id> -f Sent
   ```
   Pre-fill with a polite follow-up nudge referencing the original subject. Save to Drafts. Only send on explicit confirmation.
