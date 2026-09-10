# AGENTS.md

DSH plugin: MCP server manager for DeepSeek Harness (web profile). Settings → MCP page for HTTP (OAuth PKCE + RFC 7591 dynamic client registration, or static Bearer token) and local stdio MCP servers, whose tools are registered as `mcp__<name>__<rawName>` native tools.

## Layout

Plugin **source** is two files — keep it that way unless a refactor is explicitly requested (tests live under `test/`):

- `lib/index.js` — **host half** (Node.js): HTTP API on the DSH GUI webserver under `/mcp-manager/api/*`, OAuth flow (redirect receiver at `/mcp-manager/callback/:id`), both MCP transports, tool registration into `ctx.tools`, state persistence.
- `lib/client.js` — **client half** (browser): a `window.__ModuleLoader__.load(...)` factory using `react.createElement` (no JSX, no bundler). Registers the Settings → MCP tab via the `settings.section` slot. **UI is bilingual** (Simplified Chinese and English; default follows system/browser language) — every user-visible string is resolved through the `STRINGS` table, never hardcoded.
- `cordis.patch.yml` — bundle patch that activates the plugin row (`dsh.bundle.patch` in package.json).
- `test/*.test.js` — `node --test` unit tests over the host half's exported helpers plus a stubbed-context `apply()` API smoke test (not shipped: `files` lists only `lib/*`).
- `README.md` / `README.zh-CN.md` — keep both in sync on behavior changes.

## Architecture rules

- Two halves talk only through the same-origin JSON API `/mcp-manager/api/*`; the client never touches Node APIs and the host never renders UI.
- OAuth redirect origin is derived per-request from the `Host` header — never hardcode a host/port. Client registration is bound to the exact redirect URI and re-registers if the origin changes.
- Token state (`~/.dsh/mcp-manager.json`) contains secrets — never log tokens; treat the file as sensitive.
- Tool name convention `mcp__<server>__<raw>` with `[^A-Za-z0-9_-]` → `_` normalization and a 64-char cap (sha256 suffix on overflow) — must match the built-in `@deepseek-ai/dsh-mcp-client`.
- Tool schemas must pass through `sanitizeValue`/`convParams` (registry accepts only a raw JSON-Schema subset; unsupported vocabulary degrades to unconstrained).
- stdio transport: `child_process.spawn`, newline-delimited JSON-RPC over stdin/stdout. Reconnect must reap the old child first; `ctx.effect` teardown kills all children on unload. `args` are quote-aware tokenized with **no shell expansion**. On Windows `shell: true` makes Node join command + args with bare spaces and add no quoting, so every token must pass through `quoteWindowsToken` (idempotent for already-quoted values) or `cmd.exe` truncates paths containing spaces.
- Loaded state is migrated once in `apply()` via `migrateLoadedState`: missing or duplicate `server.id` values are backfilled (live status and `/servers/:id/*` are id-keyed, so a missing id 404s every id-addressed API) and legacy `[{ name, value }]` env/header arrays are normalized to maps. Persist immediately when it reports a change.
- HTTP transport: streamable HTTP (JSON-RPC POST, `Mcp-Session-Id` header, SSE-or-JSON response fallback in `parseRpc`). A 401 triggers one `refresh_token` retry, then reconnect.
- Disable/enable is global per profile: disable unregisters tools + drops the connection but persists config and tokens; enable reconnects without re-auth.
- UI is bilingual: `STRINGS` holds a `zh` and an `en` table with the **same key set** — add new strings to both (the translator falls back to `zh`, then to the raw key). Language precedence is **explicit choice > system/browser language > `zh`**: use `navigator.language` with `navigator.languages[0]` as fallback (`zh*` → `zh`, any other locale → `en`); unavailable or empty locale → `zh`. `GET /settings` returns `language: null` when no valid explicit choice is saved, otherwise `zh`/`en`; automatic detection is not persisted. Language is never chosen in the palette: the client reads it from `GET /mcp-manager/api/settings`, writes it via `POST /mcp-manager/api/settings/language` (`zh`|`en`, 400 otherwise), and it persists as `state.language` in `~/.dsh/mcp-manager.json`. Server-supplied diagnostics (MCP error text, tool descriptions) stay in their original language.

## Commands

No build/lint scripts. It's plain ESM with zero dependencies (Node built-ins only; Node `^22.19 || >=24`). `package.json` declares exactly one script, `test`:

```sh
npm test             # = node --test; default discovery picks up test/*.test.js
node --test test/mcp-image-projection.test.js   # single file
```

Verify behavior changes by installing into a live DSH web profile:

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile web add <path-or-repo>
```

then restart `dsh --profile web` and reload the page. The API liveness probe is `GET /mcp-manager/api/ping`. Always set both `HOME` and `DSH_HOME` to a scratch directory for `dsh`/`dsh plugin` runs — never let a test touch the real `~/.dsh`.

Optional static audit — [build-dsh-plugin](https://github.com/AI-Scarlett/build-dsh-plugin) is a third-party Agent Skill used as a checklist, not a dependency:

```sh
node <build-dsh-plugin>/build-dsh-plugin/scripts/audit-plugin.mjs "$PWD"
```

Two of its hard blockers are reviewed false positives here and must not be "fixed" by obfuscating the code: `lib/index.js:123` and `:1085` quote the text `shell: true` inside doc comments (the real `spawn` call uses `shell: isWin`, guarded by `quoteWindowsToken`), and `lib/index.js:402` logs a server *name* on the legacy-plaintext path and never a credential value. Re-read the flagged lines; treat the *unmet checks* (test script, pinned source, verification/next-gate docs) as real. Runtime points require `--evidence <file>`, a self-reported record — never claim them without a real disposable-profile run.

## Conventions

- No TypeScript, no bundler, no framework — plain modern JavaScript in both files.
- Host half: `ctx.logger` (`info`/`warn`/`error`) with `mcp-manager:` prefix; never `console.log`.
- Client half: `react` obtained via the factory's `require("react")`; styles in the injected `<style>` string using `--dsw-alias-*` CSS variables with hardcoded fallbacks.
- Bump `version` in package.json on user-visible changes (recent history: 0.1.0 OAuth, 0.2.0 stdio, 0.3.0 enable/disable, 0.4.0 Windows stdio + edit + Codex-style HTTP config, 0.5.0 workspace isolation, 0.6.0 on-demand broker, 0.7.0 MCP image-block projection, 0.7.1 legacy-state migration + Windows command quoting, 0.7.2 agent-setup contract + lazy webserver injection, 0.7.3 DSH/Node compatibility matrix, 0.7.4 declared test script + verification/next-gate docs, 0.8.0 zero-dependency lexical tool search + browse fallback, 0.9.0 English UI — bilingual `STRINGS` table + language selector).

## Release

Every user-visible change ships as a versioned release: bump the version, sync the docs, commit, then **tag** so consumers can pin `dsh plugin add <repo>#<ref>`. Steps:

1. Bump `version` in `package.json` (semver).
2. Update `README.md` and `README.zh-CN.md` — keep both in sync with the behavior change.
3. Commit on `main`, then create an **annotated** tag on that exact commit and push both:

   ```sh
   git tag -a v0.5.0 -m "dsh-mcp-manager v0.5.0: <one-line summary>"
   git push origin main v0.5.0
   ```

- Tags are **annotated**, not lightweight — match the existing `v0.2.0` style (a `tagger` plus a one-line message).
- The tag must point at the commit that actually carries the release (on `main`).
- Every `vX.Y.Z` gets a tag — never ship a version without one.

## Gotchas

- Changing the client registration/redirect logic requires re-testing a full OAuth round trip — the provider must allow loopback redirects (`http://127.0.0.1:<port>/mcp-manager/callback/<id>`).
- Only `tools` capability is bridged; `resources`/`prompts` are intentionally not.
- Client half is hand-written inside a module factory — no JSX transform available; edit carefully or regenerate deliberately.
