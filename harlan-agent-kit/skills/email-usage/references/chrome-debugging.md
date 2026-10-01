# Chrome debugging

## Connect to existing sessions

For Chrome 144+, use the built-in setting at `chrome://inspect/#remote-debugging`.
Use `dev-browser --connect` to discover its current WebSocket endpoint.
Read `dev-browser --help` before connecting.
Chrome requests permission for each new connection. Do not try to bypass that permission.

```bash
dev-browser --browser <task-name> --connect <<'JS'
console.log(await browser.listPages());
JS
```

Choose an existing tab opened in the intended Chrome profile.
Select its target ID with `browser.getPage(targetId)`.
Verify the target site's signed-in email before private reads or changes.
Use a new task-owned tab in that profile when the user does not want existing tabs touched.
If the tool cannot establish the intended profile, report the limitation before the dependent action.
Close only task-owned tabs. Do not close a user's existing tab.

`--browser <task-name>` names automation state. It does not choose a Chrome profile.
Connected page creation can use the default browser context.
A tab title or URL alone does not prove its signed-in identity.
The built-in debugging setting applies to the whole Chrome instance, across its profiles.

## Recover a connection

1. Check whether Chrome is running.
2. Check the built-in setting at `chrome://inspect/#remote-debugging`.
3. Inspect only `devtools.remote_debugging.user-enabled` in Chrome's Local State if needed.
4. Reconnect with `--connect` so discovery reads the current `DevToolsActivePort` file.
5. Honor Chrome's connection approval prompt.
6. If attachment still fails, report the tool error and relevant readiness checks.

The dynamic port can change after Chrome restarts. Never pin that port in global instructions.
A port file alone does not prove Chrome is reachable or that approval was granted.
Built-in mode uses the discovered WebSocket endpoint.
A 404 response from `/json/version` alone does not prove built-in debugging is unavailable.

Never repair attachment by killing Chrome, stopping the shared daemon, clearing sessions, or rewriting preferences.
Do not keep adding classic debugging flags to the standard Chrome profile directory.

## Unattended isolation

For unattended browser isolation, use one nonstandard user-data directory per identity.
Use explicit localhost debugging endpoints and durable launchers for those directories.
Treat this as a separate browser setup change.
Separate profile directories within one shared user-data directory do not provide independent browser processes.
New user-data directories need their own sign-ins.
Never copy live cookies or profiles to manufacture an authenticated session.

Chrome 136+ ignores classic debugging flags against its standard user-data directory.
`--profile-directory` does not remove that restriction.
Classic debugging requires `--user-data-dir` pointing to a nonstandard directory.

## Sources

- [Chrome built-in debugging and connection approval](https://developer.chrome.com/docs/devtools/agents/get-started/configuration)
- [Chrome 144 debugging existing sessions](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)
- [Chrome 136 debugging flag changes](https://developer.chrome.com/blog/remote-debugging-port)
- [Chromium debugging server](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/devtools/remote_debugging_server.cc)
- [Application-wide debugging preference](https://chromium.googlesource.com/chromium/src/+/main/chrome/common/pref_names.h)
- [Chromium user-data directory contract](https://chromium.googlesource.com/chromium/src/+/main/docs/user_data_dir.md)

Verify the installed browser tool's behavior before relying on context selection or connection caching.
