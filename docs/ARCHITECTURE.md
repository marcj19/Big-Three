# Big Three: architecture and developer reference

How the pieces fit together, the rules each one enforces, and how to work on them. For installing and using the app,
see the [README](../README.md).

## Packages

- `packages/db-broker`: MCP server that lets models run `SELECT` queries against Postgres, MySQL and Oracle
  without ever seeing credentials.

- `packages/core`: runs the model CLIs headless behind one event stream (`claude`, `agy`, `codex`), with sign-in
  status and in-app login, sanitized child environment, and cancellation.

- `packages/room`: a shared transcript the models take turns in, the `ask_peer` MCP server that lets a lead model consult
  teammates, per-provider usage tracking and fallback when one runs out of quota. It also holds an older engine for
  fixed workflows (cross-review, plan then execute, debate, step lists) that the window no longer uses.

- `packages/app`: the Electron desktop app (chat, model sign-in, model and team choice, database connections).

## app

```bash
npm start                     # builds, then opens the desktop app
npm run doctor                # which model CLIs are installed and signed in
```

Conversations are rooms stored under the config folder (`%APPDATA%\ai-orchestrator` on Windows, `~/Library/Application Support/ai-orchestrator` on macOS, `$XDG_CONFIG_HOME` or `~/.config/ai-orchestrator` elsewhere; override with `AIO_CONFIG_DIR`). The
window never touches files, processes or passwords itself: it talks to the main process through a two-function bridge
(`invoke`, `onEvent`), and the main process validates every call.

Safety rules the app enforces on its own, not in the window:

- Models run read-only by default. Choosing "edit" or "full" makes the main process show a native confirmation (with
  the folder) before anything starts; the window cannot answer it. Access levels are not remembered between sessions.
  A usage limit never moves a run that may change files to another model.
- Database passwords go from the form straight to the Windows vault and are never sent back to the window. Selecting
  connections for a run hands the models only the broker's name, the config folder and the connection names.
- The window runs sandboxed with context isolation, no Node, and a Content-Security-Policy that blocks inline script
  and styles; model output is always inserted as text.

Chat: like Claude Code, Gemini or Codex, you pick a model (and its effort) and talk. That model leads: it reads, plans,
edits and, when it decides a second opinion or an independent review would help, or when you ask in the chat ("ask
Gemini to review this"), it consults a colleague through the `ask_peer` tool. Each consultation shows up in the
conversation as a card ("Claude consulted Gemini": question and answer). The team (who can be consulted and on which
model) is set from the Team chip; colleagues are read-only, so only the lead changes files, and only with the access you
chose. The lead's own CLI session is continued between turns, so it remembers what it read and did. Claude and Codex
can lead a team; Antigravity's CLI has no per-session MCP injection, so Gemini can be consulted but cannot consult.

The step-list engine (`runFlow`, review/plan/debate patterns) is still in `@aio/room` and the `flow` run kind, but the
window no longer uses it.

Models: Claude offers the aliases `opus`/`sonnet`/`haiku` (always the newest) and pinned versions, plus an effort level;
Gemini lists exactly what `agy models` reports for your Antigravity account (reasoning level is part of each id, and it
includes models from other vendors); Codex takes a typed model and an effort. "Outro…" accepts any plain model name.
Names are checked before they reach a command line.

Interface: light/dark/auto theme, four text sizes and a "reduce motion" switch (Appearance button, top of the sidebar).
Keyboard: `Ctrl+N` new conversation, `Enter` sends, `Shift+Enter` new line, `Esc` closes
dialogs (focus stays inside while one is open and returns to where it came from). Everything has an accessible name,
the message list is a live region, and the app honours the Windows reduced-motion and high-contrast settings. The model
and database icons are simplified originals in each product's colours, not the official logos (trademarks, not
bundled); to use the real artwork replace the matching `<symbol>` in `src/renderer/icons.ts`.

Without Electron, for trying the interface: `AIO_DEMO=1 npm run web -w @aio/app` serves it in a browser against fake
models (no quota used). It listens on 127.0.0.1, requires the token printed at startup, and refuses other hosts and
origins.

Not covered yet: packaging into an installer, and giving Gemini the database or `ask_peer` tools (Antigravity's CLI has
no per-session MCP injection; `--settings` rejects MCP servers and `agy mcp add` would change global configuration).

## core

| Provider | CLI | Verified live |
|---|---|---|
| Claude | `claude -p --output-format stream-json` | yes |
| Gemini | Antigravity CLI `agy -p=<prompt> --output-format stream-json` | yes (the standalone Gemini CLI now rejects personal accounts) |
| Codex | `codex exec --json` | yes (answers, session resume and the room MCP tools) |

Developer commands: `npm run dev -w @aio/core -- detect | login <provider> | run <provider> [--raw] "prompt"`.

## room

The models never talk to each other directly (the lead calls `ask_peer`, which runs the teammate's CLI itself). The app owns one transcript (a JSONL file) and gives each model the
relevant part of it on its turn, so it works with every CLI, including the ones that cannot take MCP servers yet.

| Pattern | What happens |
|---|---|
| `crossReview` | A answers, B reviews critically (`VERDICT: APPROVE/CHANGES`), A rewrites once, B checks again. A model never reviews its own answer. |
| `planExecute` | A plans read-only, B carries it out, C optionally checks the actual files. The executor's access (`read-only`/`edit`/`full`) is a required argument, never a default. |
| `debate` | Everyone answers independently from the same snapshot, then each reads the others and refines; one closes with a synthesis. A participant that fails sits out. |

Rules the room enforces:

- Everything is `read-only` unless the caller asks otherwise for a specific turn.
- Messages from other models are framed as opinions, not instructions from the user.
- A turn can name several providers (`['claude', 'codex']`). On a limit, sign-in or other failure the next one answers,
  the message is signed by whoever answered, and a provider that hit its limit is skipped for 15 minutes.
- A failed turn is recorded as a `system` note, never as the model's words.

`ask_peer` / `read_room` / `post_to_room` are served by `peer-main` (a stdio MCP server). A peer that is asked runs
read-only with no MCP servers of its own, so questions cannot fan out, and each turn has a question cap (default 6). Each
teammate answers on the model chosen for it in the app, which the lead cannot change.
Only Claude and Codex can receive it for now; Antigravity's CLI has no MCP injection wired up, so Gemini takes part
through the patterns but cannot call `ask_peer`.

Verified live: `review claude gemini` (Gemini approved Claude's draft) and Claude calling `ask_peer` to reach Gemini
through the room server. Real runs: Claude and Codex each led a conversation, consulted Gemini on their own and resumed their sessions. `planExecute` and the flow runner have only run end to end with simulated models.

Developer commands (each model call uses your subscription quota):

```bash
npm run dev -w @aio/room -- review claude gemini "Explain what a mutex is in two sentences"
npm run dev -w @aio/room -- debate claude,gemini "Is SQLite enough for a single-user desktop app?"
npm run dev -w @aio/room -- plan claude codex gemini "Add a --verbose flag" --access edit --cwd path/to/project
```

## db-broker

Connection profiles (no passwords) live in `connections.json` inside the config folder (see above; override with
`AIO_CONFIG_DIR`):

```json
[{ "name": "crm", "engine": "postgres", "host": "localhost", "database": "crm", "user": "readonly_svc" }]
```

The password for `crm` lives in the system vault (Windows Credential Manager, macOS Keychain or the Secret Service, entry `ai-orchestrator` / `db:crm`) and
the broker reads it itself, so it works even when a model CLI starts the broker with a scrubbed environment. Store it
without it ever touching a command line or a file:

```bash
npm run secret -w @aio/db-broker -- set crm       # hidden prompt; the app can pipe the password on stdin instead
npm run secret -w @aio/db-broker -- status crm    # says whether one is stored, never shows it
npm run secret -w @aio/db-broker -- delete crm
```

`AIO_SECRET_<NAME>` in the broker's environment still works as a fallback for development and tests.

What the vault does and does not protect: the password is not in `connections.json`, the MCP config, the model's
environment or the audit log. But the vault belongs to your Windows user, so a model that can run arbitrary commands
as you could read it the same way the broker does. That is why the database user must only have `SELECT`, and why
models should run read-only unless you decide otherwise.

Always create a database user that only has `SELECT` on what the models may see. The SQL guard, read-only
transactions, timeouts and row limits are extra layers on top of that, not a replacement.

Tools exposed: `list_connections`, `list_schema`, `describe_table`, `run_select`. Every call is appended to
`audit.jsonl` in the config directory.

### Tests

```bash
npm test                      # unit tests, no database needed
docker compose -f packages/db-broker/test/integration/compose.yml up -d --wait
AIO_INTEGRATION=1 npm run test:integration -w @aio/db-broker
docker compose -f packages/db-broker/test/integration/compose.yml down -v
```

`test/integration/vault.test.ts` additionally starts the broker as a separate process with no password in its
environment and checks that it reads it from the real vault (it writes and removes one throwaway entry,
`db:aio-vault-test`).

Integration tests only talk to the throwaway containers in `compose.yml` (127.0.0.1, fictional data).
