# Big Three

**One chat for Claude, Gemini and Codex.** Pick a model, talk to it like you would in Claude Code, and it consults the
other two when it needs a second opinion, or when you ask it to ("ask Gemini to review this").

English · [Português](README.pt-BR.md)

[![CI](https://github.com/marcj19/Big-Three/actions/workflows/ci.yml/badge.svg)](https://github.com/marcj19/Big-Three/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![Big Three: Claude consulting Gemini inside one conversation](docs/screenshots/chat-dark.png)

Big Three is a desktop app that drives the **official command-line tools** you already use (Claude Code, the Antigravity
CLI for Gemini, and the Codex CLI), each with its own sign-in and its own subscription limits. It never extracts tokens
and never asks for API keys.

## What it does

- **One conversation, three models.** Choose who you talk to (and the model and effort), then just write. That model
  works on its own and, when a second opinion or an independent review would clearly help, consults a teammate.
  Each consultation shows up in the chat as a card with the question and the answer.
- **You stay in charge of the team.** Choose which colleagues can be consulted and which model each one answers with.
  Colleagues only read and answer; **only the lead changes files**, and only with the access you gave it.
- **Safe by default.** Models start read-only. Letting one edit files or run commands asks you in a native dialog
  first, every time.
- **Real model choice.** Claude (Opus, Sonnet, Haiku, pinned versions, effort), Gemini (everything your Antigravity
  account offers, including Claude and GPT-OSS models) and Codex (any model name, effort).
- **Database access without exposing credentials.** Connect PostgreSQL, MySQL or Oracle. Models can run `SELECT`
  queries through a broker; the password lives in your system vault and never reaches a model.
- **Accessible and light.** Light, dark or automatic theme, four text sizes, reduced motion, keyboard navigation, screen
  reader labels.

<table>
  <tr>
    <td><img src="docs/screenshots/home-light.png" alt="Start screen in the light theme"></td>
    <td><img src="docs/screenshots/team-dark.png" alt="Choosing which colleagues can be consulted, and on which model"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/chat-light.png" alt="A conversation in the light theme"></td>
    <td><img src="docs/screenshots/database-light.png" alt="Connecting a database: PostgreSQL, MySQL or Oracle"></td>
  </tr>
</table>

## Requirements

- **Windows 10 or 11** (developed and tested on Windows 11; macOS and Linux are not tested yet, see
  [Platform support](#platform-support)).
- **[Node.js](https://nodejs.org) 20 or newer.**
- **At least one of these CLIs, installed and signed in with your own account** (the more, the better the team):
  - **Claude Code** (`claude`), with a Claude subscription.
  - **Antigravity CLI** (`agy`), for Gemini, with a Google account.
  - **Codex CLI** (`codex`), with a ChatGPT account: `npm i -g @openai/codex`.

## Install and run

**Easiest on Windows:** download the project (green **Code** button, then **Download ZIP**, and unzip it), then
double-click **`Big-Three.cmd`**. The first run installs what it needs (a few minutes, including a one-time download of
the Electron runtime, about 110 MB). After that it opens right away.

**From a terminal:**

```bash
git clone https://github.com/marcj19/Big-Three.git
cd Big-Three
npm install
npm start
```

**Not sure which CLIs are ready?** Run `npm run doctor`. It lists each one, its version and whether it is signed in:

```text
Claude  ok  2.1.162 (Claude Code)  signed in: true
Gemini (Antigravity) ok  1.4.12  signed in: true
Codex   ok  codex-cli 0.166.0  signed in: true
```

You can also sign in from inside the app: the sidebar shows each model's status and an **Enter** button when one is
signed out.

## Using it

1. Click **New conversation** (`Ctrl+N`) and choose the folder the models may work in. They can see that folder and its
   subfolders, so start with the smallest scope that does the job.
2. Under the text field, pick **who you talk to**, **what it may do** (read, edit, or full access) and **the team**.
3. Write. Press `Enter` to send, `Shift+Enter` for a new line.
4. Ask for help in plain words whenever you like: *"ask Gemini to review this"*, *"get a second opinion from Codex before
   you change anything"*.

### Connecting a database

Create a database user that can **only `SELECT`** what the models may see, then open **Databases** in the sidebar,
choose the engine, fill in the connection and press **Save and test**. The password goes straight to the system vault
(Windows Credential Manager) and is never shown back or sent to a model. In each conversation you choose which
connections the models may query.

## How it stays safe

- **Read-only unless you say otherwise**, and write access is confirmed by a native dialog the page cannot answer. It is
  not remembered between sessions, and a usage limit never moves a job that may change files to another model.
- **Colleagues cannot change anything.** A consulted model runs read-only and gets neither the room tools nor the database tools,
  so questions cannot fan out.
- **Database defence in depth:** a `SELECT`-only database user (the layer that matters), a SQL guard, read-only
  transactions, timeouts, row limits, sanitized errors and an audit log.
- **The window is sandboxed:** no Node in the page, a strict content security policy, model output always inserted as
  text, every call from the page validated by the main process.
- **Model CLIs run with a scrubbed environment**, without API keys or anything that looks like a credential.

One honest limit: the system vault belongs to your Windows user. A model that is allowed to run arbitrary commands as you
could read it the same way the broker does. That is why the database user should only have `SELECT`, and why models start
read-only. Details in [SECURITY.md](SECURITY.md).

## Platform support

Developed and tested on **Windows 11**. The code avoids Windows-only assumptions where it can (config folders follow each
platform's convention, and the password vault is cross-platform), but macOS and Linux have not been tried: for example,
stopping a model on those systems signals only the process it started, not its children. Reports and fixes are welcome.

## Known limits

- **The interface is in Brazilian Portuguese** for now. Translations are welcome (see [CONTRIBUTING.md](CONTRIBUTING.md)).
- **Gemini can be consulted but cannot consult others or query databases.** The Antigravity CLI offers no clean way to
  attach tools to a single session yet, and changing its global configuration without asking would not be polite.
- **Codex has no model list** to choose from; use *Other…* and type a model name.
- **No installer yet.** The app runs from the source folder; packaging is planned.

## Not affiliated

Big Three is an independent, unofficial project. It is not affiliated with, endorsed by or sponsored by Anthropic,
Google or OpenAI. *Claude*, *Gemini*, *Codex* and the other product names belong to their owners. The app drives the
official CLIs on your own accounts: you are responsible for following each provider's terms of use and for the
usage your subscriptions allow. The model and database icons are simplified originals in each product's colours, not
the official logos. Big Three itself sends nothing anywhere; the CLIs talk to their providers as they normally do.

## Contributing, security, license

- [CONTRIBUTING.md](CONTRIBUTING.md): how to run the tests and what to keep in mind.
- [SECURITY.md](SECURITY.md): how to report a vulnerability, and the threat model.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pieces fit together.
- Released under the [MIT License](LICENSE).
