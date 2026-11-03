# Security

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private reporting instead:
**Security** tab of this repository, then **Report a vulnerability**. Include what you found, how to reproduce it and
what you think the impact is. I will reply as soon as I can and credit you in the fix if you wish.

## What Big Three is designed to protect, and what it is not

Big Three lets AI models act on your computer and query your databases, so its safety rules matter more than usual.

**Protected by design**

- **Your database password never reaches a model.** It is stored in the system vault (Windows Credential Manager) and read
  only by the database broker process. It is not in the config file, the MCP configuration, the models' environment or the
  audit log.
- **Models cannot write to your database.** Queries pass a SQL guard (a single `SELECT` or `WITH ... SELECT`; writes, DDL,
  locking and dangerous functions are rejected) and run in read-only transactions with timeouts and row limits. The
  strongest layer is yours to provide: **use a database user that only has `SELECT`**.
- **Models start read-only.** Editing files or running commands needs a native confirmation, which the page cannot answer,
  and is not remembered between sessions.
- **Consulted models cannot change anything.** They run read-only, without the room or database tools.
- **The window is sandboxed.** Context isolation, no Node in the page, a strict content security policy, model output
  inserted as text, and every call from the page validated by the main process.
- **Model CLIs run with a scrubbed environment**, and model and effort names are checked before they reach a command line.
- **The development web server** (`npm run web -w @aio/app`) listens on 127.0.0.1 only, needs a random per-start token and
  rejects foreign hosts and origins.

**Not protected, so you know**

- The system vault belongs to your operating-system user. A model that is allowed to run arbitrary commands as you (the
  "full access" level, or a model that talks you into it) could read the vault the same way the broker does. Keep models
  read-only, and keep database users `SELECT`-only.
- A model with edit or full access can do what that access allows inside the folder you chose. Treat the folder as the
  boundary and start with the smallest one.
- Big Three drives third-party CLIs. Their own behaviour, permissions and data handling are theirs.
- There is no sandbox beyond what each CLI offers (for example, Codex's own sandbox modes).

## Supported versions

Only the latest commit on the default branch receives fixes while the project is young.
