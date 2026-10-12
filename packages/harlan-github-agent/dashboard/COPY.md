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
| Memory Incident | Memory limit | Incident kind |
| GitHub warning | GitHub rate limit | System chip |
| GitHub section | GitHub rate limits | System pane |
| GitHub loading | Checking GitHub rate limits. | System pane |
| GitHub empty state | No controller GitHub requests paused. | System pane |
| GitHub hold | Requests using this credential are paused. | System pane |
| GitHub retry due | Retry due | System pane countdown |
| GitHub recovery | The next GitHub request checks recovery. | System pane after the deadline |
| Service data unavailable | Service data is unavailable. Reload before changing settings or work. | System pane and refused controls |
| Service state missing | The Service returned no state. | State request error |
| Service data label | Unavailable | System chip after its last update expires |
| Routine incomplete coverage | Blocked | Routine result badge |
| Routine passing checks | Clear | Routine result badge |
| Routine warning or failure | Action required | Routine result badge |
| Routine execution | Scan completed | Routine report evidence |
| Routine coverage detail | Coverage incomplete. | Routine result detail |
| Routine collapsed attention | More | Shows the remaining Routine actions |
| Routine expanded attention | Show less | Returns to the first six Routine actions |
| Routine manual control | Run now | Opens the choice for one Routine scan |
| Routine manual scope | Applies to this scan only. | Routine run dialog |
| Routine manual usage | This scan uses the selected provider's usage. Reserve applies before it starts. | Routine run dialog |
| Routine manual unavailable | The selected provider cannot start a scan now. | Routine run dialog |
| Routine manual unpublished usage | Usage is not published. | Routine run dialog |
| Routine manual failure | Could not queue the Routine run. Retry. | Routine run dialog |
| Desktop incompatible | Update required | Desktop state when protocols differ |
| Desktop warning | Desktop update required | System chip and pane summary |
| Operation recovery | The next Controller operation checks recovery. | Incident with no scheduled retry |
| Agent recovery | The next Agent request checks recovery. | Capacity after the circuit deadline |

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
