# dsh-mcp-manager

[简体中文](README.zh-CN.md) | English

**MCP server manager for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)** — a Settings → MCP page where you add MCP servers once (remote HTTP or local stdio process), authenticate HTTP servers with **OAuth in the browser**, and expose their tools either directly or through a compact on-demand broker.

The built-in `@deepseek-ai/dsh-mcp-client` only accepts a static `headers` config — it has no OAuth support and no local stdio transport. This plugin fills that gap:

- **OAuth (authorization code + PKCE)** with RFC 7591 dynamic client registration, `refresh_token` rotation, and auto-reconnect across restarts — one browser login, then it keeps working.
- **Static Bearer token** mode for servers without OAuth — stored as an environment-variable **name** (Codex-style `tokenEnv`), never as plaintext in the config.
- **Custom HTTP headers** (`headers` for direct values, `headerEnv` for values read from environment variables) — matches Codex's `http_headers` / `env_http_headers`.
- **stdio local processes**: run `npx` / `uvx` / `python` etc. directly; the plugin speaks JSON-RPC over the child's stdin/stdout (spawns the process, reconnects, and reaps it on exit) — no remote server or auth required. Windows `.cmd` shims (e.g. `npx.cmd`) are resolved through `cmd.exe`.
- **Edit-in-place**: rename a server, switch stdio ↔ HTTP, or change auth/headers without deleting and re-adding it.
- **Tool registration** with the same `mcp__<server>__<rawName>` naming convention as the built-in client, including strict-schema sanitization for the DSH tool registry and `isConcurrencySafe` marking.
- **Workspace isolation**: declare per-project servers in `<workspace>/.dsh/dshmm/mcp.json` — their tools register only into that workspace's sessions, and you can mask specific global servers per workspace.
- **Opt-in on-demand broker**: keep the model-facing MCP surface fixed at `mcp_search_tools`, `mcp_describe_tool`, and `mcp_execute_tool` instead of sending every `mcp__*` schema on every Native-mode request. It is disabled by default.
- **Stable tool refresh**: `notifications/tools/list_changed` refreshes only added, removed, or schema-changed registrations for both stdio and Streamable HTTP servers.

## Requirements

- DeepSeek Harness with the `web` profile (`npx @deepseek-ai/dsh web`)
- Node.js `^22.19` or `>=24`; pnpm on your `PATH`
- Windows 10/11: stdio commands are launched via `cmd.exe` so `.cmd` shims (`npx`, `uvx`) resolve correctly

## Install

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:hyqhyq3/dsh-mcp-manager
```

Then restart `dsh --profile web` and refresh the page. The package declares a `dsh.bundle.patch`, so the plugin activates automatically — no manual `cordis.patch.yml` editing.

> The MCP server's OAuth provider must allow a loopback redirect (`http://127.0.0.1:<port>/mcp-manager/callback/<id>`), which is where the DSH GUI webserver receives the code. The origin is derived from your browser's own address, so any host/port the GUI is served on works.

## Usage

1. Open **Settings → MCP** in the DSH web UI.
2. **＋ Add MCP server** (and later **编辑 / Edit** to change it):
   - **Scope (作用域)**: `user` — a global server available in every workspace; or `workspace` — a server bound to one workspace (its config lives in that workspace's `.dsh/dshmm/mcp.json`). Pick the workspace from the second dropdown.
   - **HTTP**: name (becomes the `mcp__<name>__*` prefix), URL, auth mode (OAuth or static token), and optional headers (`headers` direct values, `headerEnv` values read from env vars).
   - **stdio**: name, command (e.g. `npx`), args (one per row), env vars (key/value rows), and optional working directory.
3. OAuth servers: click **去认证 (Authenticate)** → the browser opens the server's login page → after consent you are redirected back and the tools are registered immediately.
4. Static-token servers: enter the **name of an environment variable** that holds the token (e.g. `MCP_BEARER_TOKEN`) — the token itself is never written to disk; stdio servers spawn and connect immediately on save.
5. Optional: turn on **On-demand MCP tool calls** at the top of the page. The setting is profile-wide, persists across restarts, and affects existing sessions on their next request.

Status badges: `connected (N tools)` / `needs-auth` / `authorizing` / `error` / `disabled`. Buttons: authenticate, edit, enable/disable (switch), delete. **Disable** unregisters that server's tools and drops its connection (config and OAuth tokens persist); **Enable** reconnects without re-authenticating. Disabled servers stay dormant across restarts. The toggle is global: it affects every session in this profile. State persists at `~/.dsh/mcp-manager.json` (server configs + OAuth client registrations + tokens; static tokens are referenced by env-var name, not stored).

### What the agent sees

With on-demand mode off (the default), every connected server's tools appear as first-class tools, e.g. for a server named `odin`:

```
mcp__odin__search_tools     mcp__odin__describe_tool
mcp__odin__execute_tool     mcp__odin__list_tool_scopes
```

Tool results are projected back as native DSH content blocks; MCP `isError` results surface through the registry's error path. Image blocks (`{ type: 'image', data, mimeType }`) are never forwarded raw — a raw MCP image block has no `attachment`, so it would crash the session on the next turn. Rendering is text-first: when the routed model declares image input, the host stores the image in DSH's durable attachment store and the block becomes a real `{ type: 'image', attachment }`; in every other case (no attachment store, model without image input, non-canonical base64, or a media type outside PNG/JPEG/WebP/GIF) the image degrades to an `[image unavailable: …]` text placeholder. Text blocks are preserved in order, and the same sanitizing applies to results returned through `mcp_execute_tool`.

With on-demand mode on, a Native-mode agent sees only these three MCP broker tools:

- `mcp_search_tools({ query, server?, limit? })` returns up to 10 lightweight matches by default (hard-capped at 20). It scores each query term against server name `+2`, tool name `+3`, and description `+1`.
- `mcp_describe_tool({ name })` returns the exact registered description and input schema for one tool visible in that session.
- `mcp_execute_tool({ name, arguments })` executes any currently visible MCP tool through the normal DSH tool pipeline. Calling `describe` first is recommended but not required.

Raw `mcp__*` names are removed from the model request and direct calls to them are denied; only the nested dispatch owned by `mcp_execute_tool` is allowed. Search, describe, and execute all resolve the calling agent's live registry view, so workspace isolation and `exclude` masks remain effective.

### Workspace isolation

Global servers (added in **Settings → MCP**) are visible in every workspace. Use the **workspace dropdown** at the top of the Settings → MCP page to switch between "global" and a specific workspace; when a workspace is selected you see both its own servers and the global servers (with a **隐藏 / Hide** toggle to mask each global server). Workspace servers live in `<workspace>/.dsh/dshmm/mcp.json` (Claude/Codex-style):

```json
{
  "mcpServers": {
    "filesystem": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "unity-mcp": { "type": "http", "url": "http://localhost:8090/", "authMode": "static", "tokenEnv": "UNITY_MCP_TOKEN" }
  },
  "exclude": ["github"]
}
```

- Workspace servers can be **added / edited / deleted in the UI** for workspaces registered in DSH (the **＋** button while a workspace is selected writes to that workspace's `mcp.json`). Hand-editing the file also works — creating or changing it is hot-reloaded. Invalid JSON is shown as an error while the last valid live configuration stays active.
- `type` defaults to `http`; a stdio server's `cwd` defaults to the workspace root. `headers` / `headerEnv` / `env` / `args` follow the same shapes as the Settings form.
- A workspace server's tools register **only** into sessions whose working directory resolves to that workspace; another workspace's agents never see them. Global servers stay visible everywhere unless masked.
- `exclude` lists global servers to hide in this workspace (their tools are masked through the tool registry's per-agent restriction). Toggle it via the **隐藏 / Hide** checkbox on each global server in the workspace view.
- `serverName` must be unique across global + all workspace sources; a later duplicate is flagged as a conflict and skipped (shown in the UI).
- Config is re-read on each new session and hot-reloaded via a file watcher.
- Workspace servers support **stdio**, **HTTP static-token** (`tokenEnv`), and **HTTP OAuth** — the same PKCE + dynamic client registration flow as global servers. Workspace OAuth tokens persist in `~/.dsh/mcp-manager.json` (never in the declarative `mcp.json`); each workspace server row exposes a **去认证 / Authenticate** button for OAuth servers.

## How it works

| Piece | Mechanism |
|---|---|
| Settings page | Client half registers a `settings.section` slot entry (MCP tab) |
| OAuth flow | Host half does dynamic client registration + PKCE; the redirect lands on a route mounted on the DSH GUI webserver itself |
| Token storage | `~/.dsh/mcp-manager.json`; OAuth tokens refreshed automatically on 401. Static tokens are read from the environment variable named by `tokenEnv` — never persisted |
| MCP transport (HTTP) | Streamable HTTP (JSON-RPC over POST, `Mcp-Session-Id`, SSE or JSON responses); custom `headers`/`headerEnv` merged into every request |
| MCP transport (stdio) | `child_process.spawn` a local command, JSON-RPC over stdin/stdout (newline-delimited); reconnect reaps the old process first. On Windows it spawns through `cmd.exe` so `.cmd` shims resolve |
| Tool schema | Server JSON Schemas are sanitized to the registry's supported raw subset (unsupported vocabulary degrades to unconstrained) |
| Image results | `output.render` is text-first; `execute(args, exec)` stages a projection and `finalizeContent` installs durable DSH attachments only when the routed model declares image input — every other case degrades to a text placeholder |
| On-demand broker | A profile setting installs three broker tools, filters raw `mcp__*` schemas after prompt assembly, and guards execution so only `mcp_execute_tool` may dispatch a hidden MCP tool |
| Tool list changes | stdio notifications and the Streamable HTTP SSE channel refresh the live `tools/list`; unchanged registrations remain mounted |
| Workspace isolation | `agents.create`/`resume` are decorated to compose a per-agent setup that registers `<workspace>/.dsh/dshmm/mcp.json` tools into the agent scope and applies `tools.restrict({ deny })` for `exclude` |
| Hot path | Same-origin JSON API under `/mcp-manager/api/*` between the settings page and the host half |

## Limitations

- `resources` and `prompts` MCP capabilities are not bridged (tools only).
- On-demand filtering currently targets DSH's default `native` presentation. Agents using `code` or `both` keep the full MCP catalog to avoid advertising an incomplete generated SDK or blocking valid Code Mode sub-dispatches.
- OAuth tokens live in a plain JSON file under `~/.dsh` — treat the file as a secret. Static bearer tokens and `headerEnv` values are read from environment variables and never persisted. Workspace OAuth tokens live in the same state file, never in the workspace's `mcp.json`.
- stdio servers run as long-lived child processes tied to the plugin lifecycle. On POSIX `args` are whitespace-tokenized (quotes protect args with spaces) with no shell expansion; on Windows the command line is passed to `cmd.exe`, so shell metacharacters (`&`, `|`, `>`, `%VAR%`) are interpreted — prefer absolute paths and quote args containing spaces there.
- One OAuth client registration per server per GUI origin; moving the GUI to a new origin re-registers automatically on the next login.

## License

MIT
