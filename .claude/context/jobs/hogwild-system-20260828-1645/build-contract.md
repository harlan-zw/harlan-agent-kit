# Build contract: Hogwild System status

## What will be built

- A private Hogwild section inside the existing System pane.
- A WebSocket composable for the existing `/status/live` stream.
- A strict parser for host, temperature, load, and service data.
- Live sparklines for load, temperatures, and active service memory.
- Connected, connecting, and unavailable states.

## Testable behaviours

- [C1] GIVEN the dashboard runs on `hogwild.tailcad325.ts.net`, WHEN hydration finishes, THEN it opens `/status/live` on the same origin.
- [C2] GIVEN any other hostname, WHEN hydration finishes, THEN it opens no Hogwild WebSocket and shows no Hogwild section.
- [C3] GIVEN the private stream has not sent data, WHEN the socket connects, THEN the section says `Connecting`.
- [C4] GIVEN a valid private message, WHEN it arrives, THEN temperatures, load, host, and services appear.
- [C5] GIVEN an active service, WHEN it renders, THEN memory, tasks, uptime, CPU time, and restarts appear.
- [C6] GIVEN an inactive or unavailable service, WHEN it renders, THEN its exact state word appears without invented metrics.
- [C7] GIVEN a newer message, WHEN it arrives, THEN values, timestamp, and chart history update without a page reload.
- [C8] GIVEN repeated or more than 40 messages, WHEN history updates, THEN duplicate timestamps are ignored and only 40 samples remain.
- [C9] GIVEN malformed data or a disconnected socket, WHEN it occurs, THEN stale readings disappear and an unavailable reason appears.
- [C10] GIVEN fewer than three samples, WHEN a sparkline renders, THEN no misleading line appears.
- [C11] GIVEN flat or slightly noisy samples, WHEN projected, THEN the chart does not exaggerate their range.
- [C12] GIVEN a 375px viewport, WHEN the section renders, THEN values wrap and no horizontal overflow appears.
- [C13] GIVEN a 768px viewport, WHEN the section renders, THEN labels align with values and charts remain readable.
- [C14] GIVEN dark or light mode, WHEN the section renders, THEN it uses existing neutral and status tokens.
- [C15] GIVEN a screen reader, WHEN it reaches a sparkline, THEN it hears the metric, direction, and early versus recent averages.
- [C16] GIVEN server-side generation, WHEN `/` renders, THEN no private host reading exists in the HTML.

## Design expectations

- Follow `DESIGN.md`: quiet, legible, exact.
- Use hairline rows, not new card shells.
- Keep charts neutral. State colour stays on state words.
- Use pure lines with no area fill, matching the NuxtSEO sparkline pattern.
- Prioritise hierarchy over uniformity. Hogwild remains below service-level System state.

## Out of scope

- New host collectors or service credentials.
- Persistent chart storage across page reloads.
- Hogwild data on non-tailnet dashboard origins.
- Changes to Agent scheduling or GitHub runner behaviour.
