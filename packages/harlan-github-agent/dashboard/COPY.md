---
scope: dashboard navigation, controls, states, and Agent sessions
owns: words; DESIGN.md owns pixels; ../GLOSSARY.md owns concepts
---

# Copy

The dashboard uses short, direct controls and specific state descriptions.

## Canonical assets

| Asset | String | Where |
| --- | --- | --- |
| Name | Agent | Navigation and document title |
| Start control | New session | Navigation and session sidebar |
| Host control | Run on | Project sidebar and mobile composer |
| Session setup | Enable Agent sessions after installing the private ingress. | Refused session requests and setup guidance |

## Register by context

| Context | Register | Example |
| --- | --- | --- |
| Navigation | Plain nouns | History |
| Controls | Short verbs | New session |
| Connection states | Specific cause | Desktop offline |
| Empty states | Direct next action | Choose a project to start. |
| Failures | Resource and action | Could not load sessions. Retry. |
| Composer | Direct instruction | Ask the Agent to work on this project. |
| Clipboard | Confirm the result | Copied |
| Activity | State the observed execution | Running commands |

## Copy principles

1. Name the affected resource.
2. Preserve the prompt when a request fails.
3. Describe observed state without promising completion.
4. Keep technical evidence inside disclosures.
5. Keep failed activity visible. Fold successful activity into one quiet line.

## Banned language

| Never | Use instead | Why |
| --- | --- | --- |
| AI-powered | Agent | The control already names the actor |
| seamless | State the observed behavior | The claim cannot be checked |

## Open questions

None.
