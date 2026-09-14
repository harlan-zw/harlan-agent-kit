# Notes viewer

Read local reports at <https://notes.localhost/>. Content stays in `~/notes/` outside this repository.

```sh
pnpm --filter notes-viewer service:install
```

The installer copies the viewer into `~/.local/share/harlan-agent-kit/notes-viewer` and enables a user service.
It requires [Node.js](https://nodejs.org), [pnpm](https://pnpm.io), Portless, and systemd. The existing Portless proxy provides the local HTTPS address.
Run the installer again after pulling viewer changes. The installed service does not depend on a worktree.

Add Markdown files and relative images to `~/notes/`. The viewer refreshes every two seconds.
Find a note at `https://notes.localhost/notes/<filename-without-md>`. Nested directories keep their paths.
The home page lists notes by modification time. Search indexes the full text. Mermaid fences render diagrams.

Only Markdown, images, and PDFs enter the viewer. Hidden files and symbolic links do not enter it.
Keep credentials, temporary files, and evidence in `~/scratch/`. The viewer binds to loopback only.
The viewer disables Markdown HTML. Notes are trusted local content, not an upload service.

```sh
pnpm --filter notes-viewer dev
NOTES_DIR=/absolute/content/path pnpm --filter notes-viewer dev
pnpm --filter notes-viewer build
systemctl --user status harlan-notes-viewer
journalctl --user -u harlan-notes-viewer -n 30
```

The direct development address is `http://127.0.0.1:4173`.
The build reads the same content directory and writes `.vitepress/dist`.
Build and development use the same staging directory. Stop development before building in that checkout.
