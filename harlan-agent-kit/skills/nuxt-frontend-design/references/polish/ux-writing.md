# UX Writing

Interface copy that's clear, actionable, and human.

---

## Button Labels

Replace vague labels with specific verb-object pairs:

| Bad | Good |
|-----|------|
| OK | Save changes |
| Submit | Create account |
| Yes | Delete 5 items |
| Cancel | Keep editing |

Destructive actions should name what's being destroyed. Confirmation buttons should describe the outcome, not just confirm the dialog.

---

## Error Messages

Every error needs three parts: what happened, why, and how to fix it.

| Bad | Good |
|-----|------|
| Invalid input | Email address isn't valid — include an @ symbol |
| Error 403 | You don't have permission. Ask your admin for access |
| Something went wrong | Couldn't save — check your connection and try again |

Never blame the user ("You entered an invalid email"). Reframe as the system's perspective ("Email address isn't valid").

---

## Empty States

Transform empty screens into onboarding moments:

1. **Acknowledge** the empty state
2. **Explain** the value of what will go here
3. **Provide** a clear next action

```vue
<UEmpty
  icon="i-lucide-inbox"
  title="No messages yet"
  description="When customers reach out, their messages will appear here."
  :actions="[{ label: 'Import contacts', click: importContacts }]"
/>
```

---

## Voice vs Tone

- **Voice** stays constant — your brand personality
- **Tone** shifts with context — celebratory for success, empathetic for errors

Humor doesn't belong in error contexts — users are already frustrated.

---

## Microcopy Rules

- **Loading states**: Be specific. "Uploading 3 files..." not "Loading..."
- **Confirmations**: Brief. "Saved" not "Your changes have been successfully saved"
- **Tooltips**: One line max. If you need more, it's not a tooltip
- **Links**: Text must stand alone meaningfully — "Read the migration guide" not "Click here"
- **Numbers**: "3 items" not "3 item(s)". Handle pluralization properly

---

## Internationalization

Plan for text expansion — German adds ~30%, Chinese is much more compact. Avoid:
- Hardcoded string concatenation (use ICU message format or i18n templates)
- Text embedded in images
- Layouts that break with longer strings
- Date/number formats that assume locale

Use consistent terminology throughout — one word for one concept. A "project" shouldn't become a "workspace" on another page.

---

## Anti-Patterns

- Placeholder text as the only label
- "Are you sure?" without explaining consequences
- Walls of text in modals
- Jargon or technical language in user-facing copy
- Inconsistent terminology across pages
- Error messages that only show error codes
