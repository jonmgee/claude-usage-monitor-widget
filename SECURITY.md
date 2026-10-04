# Security & privacy

This widget is designed to be verifiable in one sitting: five small source files,
one dependency, no build step.

## What it does — and provably doesn't do

- **No network access.** There is no `fetch`, HTTP client, socket, or telemetry
  anywhere in the code. Nothing is sent anywhere, ever. Verify yourself:

  ```bash
  grep -rnE "fetch\(|require\(.(https?|net|tls|dgram|ws)" *.js renderer/
  ```

- **Reads only local files**, all belonging to the user running it:
  - the Claude desktop app's own usage cache (`plan-usage-history.json`) — the
    source of the session/weekly percentages
  - Claude Code's session logs (`~/.claude/projects/**/*.jsonl`) — timestamps and
    token counts only, for the reset countdown
  - `~/.claude.json` — plan tier for the header pill
  Message content is never displayed, stored elsewhere, or transmitted.

- **Writes exactly two things:**
  1. its own config (in Electron's per-app userData folder)
  2. the `model` key in `~/.claude/settings.json` — only if you enable the
     opt-in auto step-down feature. Read-merge-write; no other key is touched;
     your original value is auto-restored on window reset, on disable, and on quit.

- **Runs exactly three external commands**, all with hard-coded arguments (no
  config or user input is ever interpolated into a command line):
  1. the Claude Code CLI, for the opt-in auto-ping — a one-word Haiku message
     that spends a sliver of *your own* quota to start a usage window
  2. `pmset displaysleepnow` (macOS only), for the opt-in screen-off mode
  3. `security find-generic-password -s "Claude Code-credentials" -w` (macOS
     only), once an hour, to read the CLI login's expiry date — see below

### The login-expiry check

The CLI's OAuth refresh token lasts about 30 days. When it lapses, every auto-ping
fails until you sign in again, so the widget warns you a week ahead.

The expiry date is stored with the credentials: in the login keychain on macOS,
in `~/.claude/.credentials.json` elsewhere. Reading it means the credentials pass
through the widget's memory, so to be explicit about what happens to them:

- **Only `refreshTokenExpiresAt` is kept** — a single number. The access and
  refresh tokens are parsed past and discarded with the rest of the response.
- They are never written to the config, never logged, never shown in the UI, and
  (like everything else here) never sent anywhere — there is still no network code.
- The check is read-only and runs at most once an hour.
- Any failure is silent: no expiry, no warning, no error. The feature degrades to
  nothing rather than nagging you.

If you would rather it never touched the keychain at all, delete
`refreshLoginExpiry()` in `main.js` — nothing else depends on it.

## App hardening

- Renderer is isolated: `contextBridge` preload, no `nodeIntegration`, no remote
  content loaded — the window renders local files only.
- Electron is **pinned to an exact version** and `package-lock.json` is
  committed, so `npm install` is reproducible.
- The only dependency is Electron itself.

## Reporting

Spotted something? Open a GitHub issue on this repo.
