# Contributing

Thanks for wanting to help. Bug reports, fixes, translations and ideas are all welcome.

## Releasing the Windows installer

On Windows x64, run `npm ci` and `npm run package:installer`. The setup file, blockmap, and `latest.yml` are generated
in `dist/installer`. Keep the update manifest and its matching installer in the same GitHub release.

To publish a stable release, set the same new version in the root and app package manifests and update the lockfile.
After that commit is on the remote, push its matching version tag (for example `v0.2.0`). The Windows release workflow
validates the tag, builds the installer, and publishes its update files. Installed copies check GitHub Releases on startup.

## Set up

```bash
git clone https://github.com/marcj19/Big-Three.git
cd Big-Three
npm install
npm run typecheck
npm test
npm start          # opens the desktop app
```

`npm run doctor` shows which model CLIs are installed and signed in on your machine. You do not need all three to work
on most of the code.

## Try the interface without spending quota

```bash
AIO_DEMO=1 npm run web -w @aio/app
```

This serves the window in a browser against **simulated models** (no quota used). Open the address it prints. It also
lets you check the interface in the browser's developer tools.

## Layout

| Package | What it is |
|---|---|
| `packages/core` | Runs each model CLI headless behind one event stream; sign-in, model lists, sanitized environment. |
| `packages/room` | The shared transcript and the `ask_peer` MCP server that lets a lead model consult teammates. |
| `packages/db-broker` | The read-only database MCP server and the password vault access. |
| `packages/app` | The Electron app: main process, services, and the window. |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how they fit together.

## Ground rules

- **Never point tests at a real database.** Integration tests use the throwaway containers in
  `packages/db-broker/test/integration/compose.yml` (127.0.0.1, fictional data, made-up passwords).
- **Do not weaken a safety rule to make something easier**: read-only by default, confirmation for write access, the SQL
  guard, the scrubbed environment, the password never leaving the broker. If a change touches one of them, say so in the
  pull request and add a test that fails without it.
- **Tests that talk to real models spend someone's subscription quota.** Keep them out of the automated suite; use the
  stub adapters in the tests and the simulated models above.
- **Insert model output as text, never as HTML.** The window builds elements and sets `textContent`; there is a strict CSP
  that will block inline scripts and styles, so do not add them.
- **Keep changes small and tested.** A bug fix should come with a test that failed before it.

## Translating the interface

The interface strings are in Brazilian Portuguese and live in `packages/app/src/renderer` (mostly `state.ts`, `composer.ts`,
`sidebar.ts`, `chat.ts`, `connections.ts` and `appearance.ts`) and in a few messages in `packages/app/src/services`.
There is no translation layer yet; adding a small one (and an English set) would be a very welcome contribution.

## Pull requests

Describe what changed and why, and mention how you tested it (which CLIs, which operating system). Run `npm run typecheck`
and `npm test` first.
