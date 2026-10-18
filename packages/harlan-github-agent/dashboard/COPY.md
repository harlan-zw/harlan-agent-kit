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
| Public password policy | Configure one public browser origin before disabling password login. | Configuration error |
| Public Passkey setup | Public Passkey login requires an enrolled Passkey | Startup error |
| Public Passkey storage | Public Passkey login requires persistent storage and an HTTPS private origin. | Configuration and startup error |
| Final Passkey | Add another Passkey before removing the last Passkey. | Passkey management without password login |
| Public terminals | Public terminals require private Agent sessions and public Passkey-only login. | Configuration and startup error |
| Start control | New session | Navigation and session sidebar |
| Terminal start | Start session | Submit a launch when regular capacity is available |
| Terminal uncertain start | The host may have started this session. Retry the same request to confirm. | Unconfirmed session admission, not terminal input delivery |
| Terminal earlier start | An earlier start is unconfirmed. Retry it before starting another session. Your edited prompt is saved. | Edited launch fields while the previous request remains uncertain |
| Terminal retry earlier | Retry earlier start | Recover the original launch without overwriting edited fields |
| Terminal retry start | Retry start | Recover an unresolved launch with the same request ID |
| Terminal retry explanation | This retries the same request. It does not create another session. | Explicit retry after a launch acknowledgment is uncertain |
| Terminal queue | Queue session | Submit a launch that may wait for capacity |
| Terminal slots full | All session slots are in use. | Regular admission has no free slot |
| Terminal maintenance reserve | The remaining slot is reserved for host maintenance. | Regular admission preserves the maintenance slot |
| Terminal memory full | The host needs more available memory. | Regular admission is limited by memory |
| Terminal queue explanation | Queue a session to start automatically when capacity is available. | Full-capacity launch form |
| Terminal queue heading | Waiting for capacity | Selected queued session |
| Terminal queue checking | The host is checking capacity. | Queued session without a current capacity reason |
| Terminal queue continuity | It will start automatically when there is room. You can leave this view. | Selected queued session |
| Terminal view sessions | View sessions | Return from a queued session to the phone session list |
| Terminal cancel recovery | The Agent did not start. You can edit the prompt and try again. | Cancelled queued session |
| Terminal launch notice | Session added. | Launch completed after the person left the launch form |
| Terminal open launch | Open session | Open an acknowledged launch without moving the current view automatically |
| Terminal saved initial draft | A new-session draft is already saved. Your earlier input is still in the previous session. | Recovery preserves an existing initial prompt |
| Terminal ended draft | Your draft is saved in this session. | Ended session with retained input |
| Terminal ended initial prompt | Your initial prompt is saved. | Ended launch with its initial prompt saved in this browser |
| Terminal recover initial prompt | Review initial prompt | Open the previous launch prompt for editing before explicitly starting another session |
| Terminal ended work | Your work remains in the project. | Ended session without a draft |
| Terminal recover draft | Use draft in new session | Review unsent input in a new launch form |
| Terminal clean exit | Session ended. | Provider reported exit code zero; does not imply task completion |
| Terminal error exit | Agent exited with code {code}. | Provider reported a nonzero exit code |
| Terminal signal exit | Agent stopped by signal {signal}. | Provider reported termination by a signal |
| Terminal host memory | Host memory | Terminal host memory and session admission |
| Terminal waiting | Waiting to start | Session waiting for host admission |
| Terminal cancellation | Cancel session | Cancel a session waiting to start |
| Terminal cancelled | Session cancelled | Cancelled session heading |
| Terminal force new | Force new session | Explicit manual host admission |
| Terminal force waiting | Force start | Explicit manual admission for the same waiting session |
| Terminal force warning | This session reserves 8 GiB of host memory. Total reserved: {total} GiB. Force can still be refused. | Manual host admission confirmation |
| Terminal initial prompt | Initial prompt | Optional initial provider prompt |
| Host control | Run on | Project sidebar and mobile composer |
| Session setup | Enable Agent sessions after installing the private ingress. | Refused session requests and setup guidance |
| Terminal empty | Choose a project to start. | Sessions with no selected Agent session |
| Diff private ingress | Connect through private ingress to view the diff. | Refused public diff access |
| Diff incomplete | GitHub returned the first 3,000 files. This diff is incomplete. | Pull request file limit |
| Terminal pairing | Open the pairing link from the terminal host. | Local authentication guidance |
| Terminal writer | Terminal connected | Agent session with input authority |
| Terminal exited | Agent session exited. | Exited terminal process |
| Terminal ended without screen | This terminal has ended. Its work remains in the project. | Ended terminal without a screen cached in this browser |
| Terminal interrupted | Agent session interrupted. | Interrupted terminal process |
| Terminal stopping | Stopping Agent. | Stop in progress |
| Terminal observer | Read-only viewer | Agent session without input authority |
| Terminal reconnect | Reconnecting to the terminal. | Detached Agent session |
| Terminal offline | Offline. Your draft is saved. | Browser reports no network connection |
| Terminal uncertain input | Input delivery is unknown. Check the terminal before sending again. | Disconnect with unconfirmed input |
| Terminal input control | Use terminal | Acquire available input authority |
| Terminal release control | Release terminal | Release input authority |
| Terminal split control | Split terminal | Show two Agent sessions |
| Terminal single control | Show one terminal | Return to the active Agent session |
| Terminal tab close | Close tab | Detach a view without stopping its Agent session |
| Terminal show control | Show terminal | Return from Diff to the terminal |
| Terminal diff control | Show diff | Open Diff for the active Agent session |
| Terminal inventory failure | Could not load projects or sessions. Reload. | Inventory request failure |
| Sessions loading | Opening Sessions… | Lazy Sessions screen is loading |
| Sessions screen failure | Could not open Sessions. Retry. | Lazy Sessions screen failed or timed out |
| Sessions screen retry | Retry | Retry loading the Sessions screen |
| Terminal launch failure | Could not start the Agent session. Retry. | Failed start |
| Terminal stop failure | Could not stop the Agent session. Retry. | Failed Stop |
| Terminal screen label | Agent terminal | Accessible terminal input name |
| Terminal phone submit | Send | Send the edited phone draft and press Enter |
| Terminal phone enter | Enter | Press Enter with an empty phone draft |
| Terminal phone escape | Esc | Send the Escape key |
| Terminal phone interrupt | Ctrl+C | Send the terminal interrupt key |
| Terminal phone keys | Keys | Open arrow and Tab keys for a phone terminal |
| Terminal phone arrow up | Arrow up | Send the ArrowUp terminal key |
| Terminal phone arrow down | Arrow down | Send the ArrowDown terminal key |
| Terminal phone arrow left | Arrow left | Send the ArrowLeft terminal key |
| Terminal phone arrow right | Arrow right | Send the ArrowRight terminal key |
| Terminal phone tab | Tab | Send the Tab terminal key |
| Terminal phone reverse tab | Shift+Tab | Send the reverse Tab terminal key |
| Terminal draft placeholder | Message the Agent… | Editable phone input |
| Terminal send pending | Sending… | Waiting for terminal input receipts |
| Terminal send acknowledged | Sent to terminal | Both paste and Enter acknowledged, not task completion |
| Terminal paste acknowledged | Text pasted. Press Enter to submit. | Enter was refused after a confirmed paste |
| Terminal delivery confirmed | Already sent | Clear an uncertain draft after checking the terminal |
| Terminal delivery not sent | Not sent | Restore an uncertain draft after checking the terminal |
| Terminal earlier output | Earlier output | Open and page terminal scrollback |
| Terminal latest output | Latest | Return to the live terminal screen |
| Terminal history expired | Earlier output expired. Refresh to read the retained output. | Saved reading copy expired or was evicted |
| Terminal ended history expired | Earlier output expired. This session has ended. | Ended Session cannot create a fresh reading copy |
| Terminal history refresh | Refresh earlier output | Explicitly replace an expired reading copy |
| Terminal history legacy | This session uses live history. New output can move older lines. | Older running helper without stable reading copies |
| Terminal history failure | Could not load earlier output. Retry. | Failed scrollback read |
| Project packages | Packages | Project picker for pkg folders |
| Project sites | Sites | Project picker for sites folders |
| Project other | Other projects | Projects outside pkg and sites |
| Project recent | Recent projects | Up to eight recent or active projects, plus the selected project |
| Project all | All projects | Full project inventory |
| Project show all | Show all | Expand the project inventory |
| Project show recent | Show recent | Return to recent projects |
| Project recent empty | No recent projects. Search or show all. | No recent starts or local visits |
| Terminal copy output | Copy output | Terminal output menu without a terminal selection |
| Terminal copy selection | Copy selection | Terminal output menu when the selected text belongs to terminal output |
| Terminal copied | Copied | Terminal clipboard success status |
| Session search | Find a project or session | Project, provider and state search |
| Session search label | Find a session | Accessible search name |
| Session search empty | No projects or sessions match. | Empty filtered list |
| Session return | Back to session | Close phone project navigation |
| Session actions | Session actions | Close tab and Stop controls |
| Terminal controls | Terminal controls | Terminal input ownership menu |
| Session launch close | Close new session | Collapse launch options |
| Session stop heading | Stop Agent? | Stop confirmation |
| Session stop consequence | This stops the Agent. The session and its work remain available. | Stop confirmation consequence |
| Terminal copy failure | Could not copy terminal text. Select it and use the browser menu. | Clipboard write failure |
| Terminal invalid data | The terminal returned invalid data. Reload. | Invalid terminal frame |
| Terminal authentication | Open the pairing link from the terminal host. | Authentication failure |
| Terminal origin | Open the terminal through its configured address. | Refused browser address |
| Terminal protocol | Update the terminal host before connecting. | Protocol mismatch |
| Terminal stale generation | The Agent session changed. Reload. | Old process generation |
| Terminal writer busy | Another viewer controls this terminal. Release it there before taking control. | Busy writer |
| Terminal stale writer | Terminal input authority expired. Select Use terminal to reconnect. | Expired writer |
| Terminal duplicate input | The terminal refused repeated input. Check the screen before sending again. | Duplicate sequence |
| Terminal input limit | Terminal input exceeds the size limit. Paste less text. | Input size refusal |
| Terminal provider missing | Install the selected Agent provider on this host. | Missing provider |
| Terminal project missing | The Project is unavailable on this host. Reload. | Missing Project |
| Terminal capacity unavailable | Shared host capacity is unavailable. Check the host setup. | Unavailable admission authority |
| Terminal capacity refused | The host has no capacity for another Agent. Stop a session or wait. | Refused admission |
| Terminal launch conflict | The session request conflicts with saved work. Reload before starting another. | Conflicting launch intent |
| Terminal ownership unknown | The host cannot confirm process ownership. Check the session before starting another. | Unknown process ownership |
| Terminal unavailable | The terminal is unavailable. Reload. | Missing terminal process |
| Terminal project filter | Filter projects | Project search label |
| Terminal checking | Connecting to the terminal host. | Initial host discovery |
| Legacy Session input | Start new Agent sessions from the terminal. | Refused structured Session input |
| Legacy Session empty | Choose an Agent session from History. | Read-only Session history empty state |
| Diff empty | No changed files. | Empty diff inventory |
| Diff failure | Could not load the diff. Reload. | Diff request failure |
| Diff changed | The file changed. Reload. | Working file changed after inventory |
| Diff binary | Binary file. | Binary diff refusal |
| Diff size | File exceeds the diff limit. | Bounded diff refusal |
| Diff close | Close diff | Diff dock close control |
| Memory Incident | Memory limit | Incident kind |
| GitHub warning | GitHub rate limit | System chip |
| GitHub section | GitHub rate limits | System pane |
| GitHub loading | Checking GitHub rate limits. | System pane |
| GitHub empty state | No controller GitHub requests paused. | System pane |
| GitHub hold | Requests using this credential are paused. | System pane |
| GitHub retry due | Retry due | System pane countdown |
| GitHub recovery | The next GitHub request checks recovery. | System pane after the deadline |
| Service data unavailable | Service data is unavailable. Reload before changing settings or work. | System pane and refused controls |
| Service read only | Read-only Service connection. | Remote Service badge and refused controls |
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
| Routine result | Last result | Last completed or failed scan |
| Routine filter empty | No Routines match the filters. | Filtered schedule |
| Routine filters reset | Clear filters | Restore all Routines |
| Routine older runs | View History | Open stored runs with the same repository and Routine filters |
| Routine waiting | Queued scans | Shared start blockers |
| Routine exhausted | Usage limit reached. | Capacity blocker |
| Routine Reserve | Reserve reached. | Capacity blocker |
| Desktop memory label | Desktop memory | Hosts memory budget |
| Desktop memory sharing | Shared by Agents and GitHub Actions. | Hosts memory budget |
| Desktop memory configuration | Change Desktop memory in the host configuration. | Refused memory budget writes |
| Desktop incompatible | Update required | Desktop state when protocols differ |
| Desktop warning | Desktop update required | System chip and pane summary |
| Operation recovery | The next Controller operation checks recovery. | Incident with no scheduled retry |
| Agent recovery | The next Agent request checks recovery. | Capacity after the circuit deadline |
| Host power off | Power off Hogwild | System pane power control |
| Host power-off acknowledgement | I understand someone must physically turn Hogwild back on. | Required power-off confirmation |
| Host power-off consequence | This stops all work and takes agent.harlanzw.com and hogwild.harlanzw.com offline. Someone must physically turn Hogwild back on. | Power-off dialog |

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

## Browser authentication assets

| Asset | String |
| --- | --- |
| Browser sign in | Sign in to Agent |
| Browser opening | Opening Agent |
| Passkey sign in | Sign in with Passkey |
| Password sign in | Sign in with password |
| Browser password label | Password |
| Browser sign-in checking | Checking sign-in access. |
| Browser access retry | Retry |
| Passkey management | Manage Passkeys |
| Passkey heading | Passkeys |
| Passkey management description | Manage Passkeys for this address. |
| Passkey loading | Loading Passkeys. |
| Passkey empty | No Passkeys added. |
| Passkey name | Passkey name |
| Passkey add | Add Passkey |
| Passkey remove | Remove |
| Passkey remove accessible | Remove Passkey: {name} |
| Passkey default name | Passkey |
| Browser sign out | Sign out |
| Passkey unsupported | This browser does not support Passkeys. |
| Passkey recovery | Use the password or pairing link if you lose a Passkey. |
| Passkey cancelled | Passkey request was cancelled. Retry. |
| Browser password failure | Could not sign in. Check the password and retry. |
| Browser access failure | Could not check sign-in access. Retry. |
| Browser sign-out failure | Could not sign out. Retry. |
| Passkey request failure | The Passkey request failed. Retry. |
| Browser pairing failure | The pairing link is invalid. Open a new pairing link. |
| Passkey preparing | Preparing the Passkey request. |
| Passkey browser waiting | Waiting for the browser Passkey prompt. |
| Passkey verifying | Verifying the Passkey response. |
| Passkey cancel | Cancel |
| Passkey request timeout | The Passkey request timed out. Retry. |
| Passkey browser timeout | The browser Passkey prompt did not finish. Retry or check your password manager. |

## Open questions

None.
