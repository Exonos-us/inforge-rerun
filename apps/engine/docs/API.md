# rerun-engine — API

Base URL: `http://localhost:3000` (configurable via `RERUN_PORT` / `RERUN_HOST`).

## Authentication

If `RERUN_API_KEY` is set, every route except `GET /health` requires:

```
Authorization: Bearer <RERUN_API_KEY>
```

If `RERUN_API_KEY` is unset, the API is open (dev mode).

## Conventions

- All request and response bodies are JSON (`Content-Type: application/json`), except `POST /agents/:id/chat` which returns an SSE stream.
- Errors return `{ "error": "<message>" }` with an appropriate status (`400` invalid body, `401` unauthorized, `404` not found, `500` internal).
- IDs are 21-char strings. Timestamps are ISO 8601.

---

## Health

### `GET /health`

No auth. Liveness, number of agents currently loaded in memory, and the data-dir migration
ladder: the version the folder is at against the one this build takes it to.

```json
{ "status": "ok", "activeAgents": 2, "commit": "e70322d", "dataVersion": 1, "dataVersionTarget": 1 }
```

### `GET /doctor`

Read-only checks of the data-dir: ladder version, agent index against agent folders, every
`config.json` readable, every `system.db` and `shared.db` at its ladder's version, connections
readable. Nothing is migrated. `agentIds` is the engine's agent index.

```json
{
  "ok": false,
  "dataVersion": 1,
  "dataVersionTarget": 1,
  "agentIds": ["a1"],
  "checks": [{ "name": "agents-on-disk", "ok": false, "detail": "folder without an index row: a2" }]
}
```

---

## Desktop

A screen per agent, for a person to watch and drive. Present when `/health` lists the `desktop`
capability, which means `openbox`, `x11vnc` and `xdotool` are installed. Every agent has its own
Xvfb display, so what one agent has open never shows on another's screen. Nothing runs until a
session is asked for, and an agent's window manager and VNC server stop five minutes after its last
viewer left, unless a takeover is still open. The screens are separate, the files are not: every
app runs as the engine's user.

Where `tint2` and `hsetroot` are installed too, the screen is a small computer: a wallpaper, a top
bar with the agent's name and the time, and a dock that opens the browser, the files and the
terminal. A screen reports it as `dock: true`; without it the caller draws its own launcher.

### `GET /desktop`

```json
{ "available": true, "screens": [{ "agentId": "researcher", "viewers": 1, "takeover": false, "dock": true, "agentDriving": false, "humanHolding": false, "recordingPaused": false }] }
```

`screens` lists the desktops that are running. `agentDriving` is true while a run of the agent has its
hands on the screen through the `computer` tools. `humanHolding` is true while a person has the
explicit hold below; `recordingPaused` while they paused the capture of the running screen session.

### `POST /agents/:id/desktop/session`

Starts the agent's desktop if it is not running. Returns the same status. An optional
`{ "timeZone": "Europe/Paris" }` sets the clock of a screen that is starting: a box keeps UTC.

### `POST /agents/:id/desktop/apps`

Opens an app on the agent's screen, or brings its window forward when it is already open.

```json
{ "app": "files" }
```

`app` is `browser`, `files` or `terminal`. The last two open on the agent's workspace. `browser`
is a takeover with no page, which also closes once nobody has watched the screen for a minute. The
dock of the screen calls this route itself.

### `POST /agents/:id/desktop/hold` / `DELETE /agents/:id/desktop/hold`

The explicit "Take over": while a person holds the screen, the agent's `computer` tools stay off it
even when the person pauses, its refusals say the user took the screen, and the screen session (and
its recording) stays open, so the sign-in or the fix the person came for is part of the same
evidence folder. One hold per agent; `POST` again renews it. A hold the caller stops renewing
expires on its own after two minutes, so a closed tab never leaves an agent waiting. Both answer
with the `GET /desktop` status. Present when `/health` lists the `desktop.hold` capability.

### `POST /agents/:id/desktop/recording`

Pauses (`{ "capturing": false }`) or resumes (`{ "capturing": true }`) the capture of the agent's
running screen session, for the moment the person on the screen types a credential. Pausing
finalizes the current segment; resuming starts the next one (`recording.mp4`, then
`recording-2.mp4`, …). What happens while paused is in no file. Answers with the `GET /desktop`
status. A session that never recorded has nothing to pause.

### `POST /agents/:id/desktop/takeover`

Opens the agent's own browser profile in a window on its screen, optionally on a page, and keeps it open so a
person can sign in or pass a check. The profile stays locked meanwhile: a `browser_navigate` of the
same agent waits. It closes on `DELETE`, when the window is closed, or after fifteen minutes.

```json
{ "url": "https://www.linkedin.com/login" }
```

### `DELETE /agents/:id/desktop/takeover`

Closes that browser and returns the page it was on.

```json
{ "url": "https://www.linkedin.com/feed/" }
```

### `GET /agents/:id/screen/sessions`

The screen sessions an agent's workspace still holds, newest first. A session is one stretch of
screen use — a run driving the `computer` tools, a takeover, or both sharing the screen — kept as a
`screen/<session id>/` folder in the agent's workspace: the screenshot of every action as `NNN.jpg`,
and `recording.mp4` when `ffmpeg` is installed and the agent's `tools.computerRecording` flag is on
(the default). The list is derived from the filesystem; the files themselves are served by the
agent's files routes (`GET /agents/:id/files/raw?path=screen/<session id>/recording.mp4`). At most
the 20 most recent sessions are kept, pruned when a session ends. `endedAt` is null while the
session is still being written. `recordings` lists the segment files of a capture that was paused
and resumed, in order; it is absent when the session has no recording.

```json
{ "sessions": [{ "id": "2026-11-09T14-30-22-ab1c", "startedAt": "2026-11-09T14:30:22.000Z", "endedAt": "2026-11-09T14:33:10.000Z", "frames": 12, "recording": true, "recordings": ["recording.mp4"] }] }
```

### `GET /desktop/ws?ticket=…` (WebSocket)

The VNC stream of one agent's screen, as a WebSocket a noVNC client speaks to directly. It is the only route
meant to be reached from a browser, so it does not take the bearer key: the ticket is
`base64url(JSON { "exp": <ms epoch>, "agent": "<agent id>", "mode": "watch" | "drive" }) + "." + base64url(HMAC-SHA256(payload, RERUN_API_KEY))`,
minted by the hub for one minute. The agent in the ticket is the screen that opens, so a ticket for
one agent never shows another. A `drive` connection keeps the agent's own `computer` tools off the
screen until it closes or sends no mouse or key event for two minutes; a `watch` connection does
not. A ticket without a mode drives. Any other upgrade path answers 404.

---

## Tools

### `GET /tools`

The static catalog of every tool family and the tools it contains (name + description). This is the source of truth for which `config.tools` flags exist. For an agent's enabled state, use `GET /agents/:id/tools`.

```json
{ "families": [ { "family": "filesystem", "description": "...", "tools": [ { "name": "fs_edit", "description": "..." } ] } ] }
```

---

## Connections

An AI provider credential held by the box, not by an agent. Plugging a subscription or an API key
once makes it available to every agent, and each agent points at one through `config.connectionId`.
Several connections can share a provider — that is the point: one Claude subscription per person.

Credentials live in `data/connections/<id>/.env` (chmod 600) and are **never returned** by any
endpoint. A Codex connection also owns `data/connections/<id>/.codex/`, so the agents sharing a
ChatGPT plan share one refresh lineage instead of racing to rotate their own copies.

The box always carries a connection with id `rerun`: the keyless free tier, proxied by the hub. It
cannot be renamed or deleted, only re-curated.

### `GET /connections`

```json
{
  "connections": [ { "id": "abc...", "name": "Claude Clement", "provider": "claude", "models": ["opus", "sonnet"], "extraModels": [], "connected": true, "createdAt": "2026-08-22T..." } ],
  "default": { "connectionId": "abc...", "model": "opus" }
}
```

`connected` says whether the credential is present, without disclosing it. `default` is the box
default model (see below), `null` when nobody set one.

### `PUT /connections/default`

The connection and model every agent that named none of its own runs on. One record for the whole
box, stored in `data/connections/default.json`.

```json
{ "connectionId": "abc...", "model": "opus" }
```

`404` when the connection is unknown, `400` when it does not offer that model. `DELETE
/connections/default` clears it, and resolution falls back to the keyless `rerun` connection until
a connection adopts the default again (see `POST /connections`).

### `POST /connections`

```json
{
  "name": "Claude Clement",
  "provider": "claude",
  "models": ["opus", "sonnet"],
  "keys": { "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat-...", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN": "..." }
}
```

`models` is the curated list this connection offers: it is what a model picker shows, and what an
automation is checked against before it runs. Response `201`, same shape as the list entries.

The first connected connection on a box adopts the box default, on its first curated model: with
no default written, every agent that named no model of its own stays on `rerun`, so plugging in a
credential would otherwise change nothing until someone set the default by hand. It only fires
while no other connection outside `rerun` holds a credential, and `PATCH /connections/:id/keys`
does the same when the credential arrives after the connection.

### `PATCH /connections/:id`

Any subset of `name`, `models`, `baseUrl`, `extraModels`, replaced wholesale. The provider is fixed
at creation: changing it would leave a credential no provider reads, which reads as "connected"
while every run fails.

`baseUrl` points an `openrouter` connection at an OpenRouter-compatible router of your own (same
wire format, different host); empty falls back to `https://openrouter.ai/api/v1`. `extraModels`
lists model ids beyond the UI's curated catalog, served through that same connection.

```json
{ "name": "Team plan", "models": ["sonnet"], "baseUrl": "https://router.example.com/v1", "extraModels": ["acme/router-large"] }
```

### OpenCode connections

`provider: "opencode"` takes one key, `OPENCODE_API_KEY` (`oc_sk_…`), valid on both OpenCode
catalogs: **Go**, a subscription, and **Console**, paid per token from the account's credits. Model
ids carry their plan: `go/deepseek-v4-pro`, `console/claude-sonnet-5-5`. The same model sold on
both sides is two ids, and only the id without its plan is sent to OpenCode.

There is no CLI: the engine runs OpenCode in its own loop, on the SDK of the format each model is
served on (Anthropic messages, OpenAI responses, OpenAI chat, Google). Every request carries
`x-opencode-session` (the conversation id, refused without it) and follows no redirect.

- The catalog is read live from `https://opencode.ai/inference/{go/,}v1/models` (public, no key):
  at boot, on `GET /connections` when older than 30 minutes, before a new connection adopts the
  default, and after a `400 Model is unavailable`. The snapshot built into `@rerun/contracts` stands
  in until it answers. `providerModels` on the summary lists what the catalog reaches today.
- `planLimits` reads `https://opencode.ai/zen/go/v1/usage`: the five-hour `session`, `weekly` and
  `monthly` windows of the Go plan, for the whole account.
- A step records its real cost: `0` on Go, OpenCode's list price on Console.
- A refusal is rewritten into a sentence the chat knows: `402` → "OpenCode Console credits used
  up", `429` on Go once the usage read taken on the spot says a window is spent → "OpenCode Go limit
  reached", `401` →
  "OpenCode key refused".
- On a model without vision, the `vision_analyze` tool asks another model of the connection that
  sees, and the computer tools are not offered.

### Custom connections

`provider: "custom"` is any server that speaks the OpenAI chat format: Ollama, LM Studio, vLLM,
LiteLLM, Groq, Together, Mistral, DeepSeek, a router of your own. `baseUrl` is required (the `/v1`
root, `/chat/completions` is appended) and the key is optional, stored as `CUSTOM_API_KEY` and sent
as `Authorization: Bearer`. The connection counts as connected as soon as it has an address.

- Requests carry nothing of OpenRouter's dialect (`reasoning`, `usage`, `provider`, `cache_control`,
  `prompt_cache_key`). A `reasoning_content` the server streams back shows as the model's thought.
- `GET {baseUrl}/models` is read at boot, on `GET /connections` when older than 30 minutes, on
  create and when `baseUrl` changes. `discoveredModels` on the summary lists what it answered, with
  the window when the server states one (`context_length`, `max_model_len`). A failed read keeps the
  previous one.
- Compaction budgets against the listed window, then the connection's `contextWindow`, then 128k.
- `vision` (default `false`) says whether the models see images: without it no screenshot is sent
  and the computer tools are not offered.
- A run that cannot reach the server fails with "Could not reach the custom endpoint at
  host:port (ECONNREFUSED)".

```json
{ "name": "Ollama", "provider": "custom", "baseUrl": "http://localhost:11434/v1", "models": ["qwen3:4b"], "contextWindow": 32768, "vision": false, "keys": {} }
```

### `POST /connections/probe`

Asks an endpoint before a connection exists, from the box rather than the hub: on a self-hosted
install the server sits on the owner's machine or network, which only the engine reaches.

```json
{ "baseUrl": "http://localhost:11434/v1", "apiKey": "optional", "model": "optional" }
```

Without `model` it reads `GET /models`; with one it also asks that model for one token, for a
server that does not list its models. A loopback address that does not answer is tried again as
`host.docker.internal`, and `baseUrl` in the answer is the address that answered.

```json
{ "baseUrl": "http://host.docker.internal:11434/v1", "models": [{ "id": "qwen3:4b", "contextWindow": null }], "problem": null, "detail": null }
```

`problem` is `unreachable`, `unauthorized`, `not_listed` or `model_refused`, with the server's
answer in `detail`. Advertised by the `connections.custom` capability on `GET /health`.

### `PATCH /connections/:id/keys`

```json
{ "set": { "ANTHROPIC_API_KEY": "sk-ant-..." }, "remove": ["OPENAI_API_KEY"] }
```

Returns the resulting key names. `400` on the keyless `rerun` connection.

### `GET /connections/:id/usage`

What a delete would move back onto the box default model.

```json
{ "agents": [ { "id": "abc...", "name": "Scout" } ], "automations": [ { "agentId": "abc...", "kind": "schedule", "slug": "weekly-digest" } ], "isBoxDefault": false }
```

An agent only counts as pointing at a connection when it also pinned a model: a `connectionId`
sitting next to `"model": null` is a leftover, and that agent already follows the box default.

### `DELETE /connections/:id`

Never refuses over usage. Every agent, schedule and trigger pointing at the connection is released
first — `connectionId`, `provider` and `model` back to `null`, which means "run whatever the box
runs" — and the box default is cleared if this connection held it. `400` for `rerun`.

```json
{ "deleted": "abc...", "released": { "agents": [ { "id": "abc...", "name": "Scout" } ], "automations": [], "isBoxDefault": true } }
```

---

## Agents

### `GET /agents`

List the agent index.

```json
{ "agents": [ { "id": "abc...", "name": "Scout", "status": "idle", "createdAt": "2026-06-02T..." } ] }
```

### `POST /agents`

Create an agent. Scaffolds `data/agents/<id>/` (SOUL.md, config.json, .env, workspace/, skills/, memory/), plus INSTALL.md when an `install` prompt is sent.

Request:

```json
{
  "config": {
    "name": "Scout",
    "description": "A research agent",
    "connectionId": "abc...",
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "tools": { "filesystem": true, "shared": true, "shell": true, "web": true, "memory": true, "skills": true, "self": true, "schedule": true },
    "mcpServers": [],
    "selfImprovement": { "enabled": true, "allowToolInstall": true, "autoSkillCreation": true, "autoMemory": true },
    "setup": { "required": true, "completedAt": null }
  },
  "soul": "You are Scout, a curious researcher.",
  "install": "Ask the user for their SERP API key with ask_user, store it, then run one test search.",
  "keys": { "ANTHROPIC_API_KEY": "sk-ant-...", "OPENAI_API_KEY": "sk-..." }
}
```

Only `config.name` is required; everything else has defaults. `keys` are written to the agent's `.env` (chmod 600) and **never returned**; they are the agent's own secrets (MCP servers, connectors, shell variables), not provider credentials — those live on a connection. Vector memory recall is handled centrally by the UI's `/api/embed` endpoint (see GUIDE.md) — no per-agent embedding key is required.

`install` is the guided setup an agent runs on its own the first time its owner opens it, and it lands in `INSTALL.md`. It is only replayed when `config.setup.required` is `true` and `config.setup.completedAt` is `null`; while that holds, the agent also gets an `install_complete` tool, which is how it closes its own setup. `required` is three-valued on purpose: `null` means nobody answered the question yet, which is not the same as "this agent needs nothing". An import resets `completedAt` to `null`, so every copy of an agent installs itself once.

Response `201`:

```json
{ "id": "abc...", "config": { ... }, "soul": "You are Scout...", "install": "Ask the user..." }
```

### `GET /agents/:id`

Return an agent's config, soul and install prompt (no keys). `404` if unknown.

### `GET /agents/:id/keys`

The names of the agent's own env variables, never their values. `screen` lists the keys saved as
screen secrets with the site each one signs in to and whether the user allowed typing it there
without asking each run.

```json
{ "keys": ["GH_PASSWORD", "STRIPE_API_KEY"], "screen": { "GH_PASSWORD": { "site": "github.com", "allowAlways": false } } }
```

### `PATCH /agents/:id/keys`

```json
{ "set": { "GH_PASSWORD": "..." }, "remove": ["OLD_KEY"], "screen": { "GH_PASSWORD": { "site": "github.com", "allowAlways": true } } }
```

Merged into the agent's `.env` and hot-reloaded; returns the resulting key names. Provider
credentials do not belong here — use `PATCH /connections/:id/keys`. `screen` marks a key as a
screen secret: the site label (normalized to a bare host) pins where the `computer` tool's
`type_secret` action may type it, and `allowAlways` skips the per-run approval there. Metadata is
only stored for a key that holds a value (sent in this `set` or already present); removing a key
drops its metadata.

### `PATCH /agents/:id`

Partially update `config.json` and hot-reload the agent. Body = any subset of `config` fields, plus `soul` and `install`. The nested `tools`, `selfImprovement` and `setup` objects are deep-merged, so you can toggle a single flag without resetting the others.

```json
{ "model": "claude-opus-4-8", "tools": { "shell": false } }
```

`install` is written wholesale, and unlike `soul` it can be cleared: sending `""` deletes `INSTALL.md`, which is what answering "no setup needed" means.

```json
{ "setup": { "required": true }, "install": "Ask for the Stripe key, then test it." }
```

Returns the updated `{ id, config, soul, install, resolvedConnectionId, resolvedProvider, resolvedModel }`. The `resolved*` fields are what the engine would actually run this agent on once its pin, the box default and the fallbacks are applied: a resolution, not a setting.

`model: null` is the switch between "this agent picked a model" and "it runs whatever the box does". A null model follows the box default and moves with it, whatever `connectionId` or `provider` is still sitting next to it. Sending `null` for the three is how a pinned agent goes back to that.

`connectionId` is the box connection a pinned agent draws its credentials from. `null` means it has none of its own, and the engine resolves one at load time: the oldest connection matching `provider`, then the box default, then the keyless `rerun` one. That fallback is what makes an imported template runnable — a connection id from another box means nothing here, so an archive carries `provider` and drops `connectionId`.

```json
{ "connectionId": "abc...", "provider": "claude", "model": "opus" }
{ "connectionId": null, "provider": null, "model": null }
```

### `POST /agents/:id/automations/activate`

Switch on every schedule and trigger of the agent that is currently off, and return the slugs that changed:

```json
{ "schedules": ["daily-digest"], "triggers": ["inbound"] }
```

This is what closes an installation. The engine calls it by itself when an agent is imported with no setup pending, and when the agent calls `install_complete`; the route exists for the third case, an install the user skipped. Already-running automations are left untouched, a one-shot whose `runAt` has passed stays off, and a cron is rebaselined to now so it fires at its next genuine occurrence rather than in catch-up. An agent with `config.enabled: false` is a no-op: the host paused its schedules on purpose.

### `GET /agents/:id/tools`

List every tool family, its tools (name + description), and whether it is currently `enabled` for this agent. Use this to drive a toggle UI.

```json
{ "families": [ { "family": "browser", "description": "...", "enabled": true, "tools": [ { "name": "browser_navigate", "description": "..." } ] } ] }
```

### `DELETE /agents/:id`

Unload, remove the index row, and delete `data/agents/<id>/` recursively.

```json
{ "deleted": "abc..." }
```

---

## Chat / Run

Both create a session if `sessionId` is omitted, append the user message, run the agent loop (multi-step tool calling until the model stops calling tools or asks the user something), persist the assistant + tool messages, and trigger the curator if `selfImprovement.enabled`.

### `POST /agents/:id/chat` — streaming

Request:

```json
{ "sessionId": "optional-existing-session", "message": "Write hello.txt in your workspace", "connectionId": "abc...", "model": "opus" }
```

`connectionId` and `model` override the agent's default for this turn only; omit them to run on
what `config.json` carries. A connection that cannot serve the model is not silently substituted
here — that repair only happens for automations.

Returns an **SSE stream** (AI SDK UI message stream protocol). The new/used session id is in the `x-session-id` response header. Event lines look like:

```
data: {"type":"start"}
data: {"type":"text-delta","id":"0","delta":"Hi"}
data: {"type":"text-end","id":"0"}
```

---

## Sessions

### `GET /agents/:id/sessions`

List the agent's sessions (newest first).

```json
{ "sessions": [ { "id": "xyz...", "agentId": "abc...", "title": "Untitled", "status": "open", "createdAt": "...", "updatedAt": "..." } ] }
```

### `GET /agents/:id/sessions/:sid/messages`

Full transcript of a session (ordered). `404` if the session does not belong to the agent.

```json
{ "messages": [ { "id": "...", "sessionId": "...", "role": "user", "contentJson": "\"hi\"", "toolCallsJson": null, "createdAt": "..." } ] }
```

`role` is `user` | `assistant` | `tool`. `contentJson` is the JSON-encoded AI SDK message content (string for user text; arrays of parts for assistant/tool).

---

## Memories

Memories are markdown files (`data/agents/<id>/memory/<id>.md`) indexed in the DB for retrieval.

### `GET /agents/:id/memories`

List all memory entries.

```json
{ "memories": [ { "id": "...", "kind": "preference", "tags": [], "createdAt": "...", "content": "The user prefers concise answers." } ] }
```

### `POST /agents/:id/memories`

Write a memory (file + index, embedded if a key is available).

```json
{ "content": "The user prefers concise answers.", "kind": "preference", "tags": ["style"] }
```

Returns `{ "id": "..." }` `201`. `kind` defaults to `note`.

### `POST /agents/:id/memories/recall`

Hybrid recall: vector KNN (if embeddings available) + FTS5 keyword, merged.

```json
{ "query": "how should I answer", "limit": 5 }
```

```json
{ "memories": [ { "content": "The user prefers concise answers.", "kind": "preference", "createdAt": "..." } ] }
```

---

## Skills

A skill is a **folder** on disk: `data/agents/<id>/skills/<slug>/`. `SKILL.md` holds the frontmatter (`name`, `description`) and the procedure; anything else in the folder is a bundled file the agent reads on demand, by convention under `references/`.

```
skills/web-research/
├── SKILL.md
└── references/sources.md
```

`files` lists those bundled files as paths relative to the skill folder.

These routes write any skill, including one a connector installed. That is deliberate: the install path itself goes through them. The read-only rule for a connector's skills is enforced one layer up, in the agent's `skill_*` tools and in the UI's own writes (see [GUIDE.md](./GUIDE.md#9-skills)).

### `GET /agents/:id/skills`

```json
{ "skills": [ { "slug": "web-research", "name": "Web Research", "description": "...", "body": "1. ...", "files": ["references/sources.md"] } ] }
```

### `POST /agents/:id/skills`

```json
{ "name": "Web Research", "description": "How to research a topic", "body": "1. Identify sources\n2. Fetch\n3. Summarize" }
```

Returns the created skill `201`. The slug is derived from the name.

### `POST /agents/:id/skills/import`

Import a whole skill from raw markdown, with its bundled files.

```json
{ "content": "---\nname: Web Research\n---\n\n1. ...", "files": [{ "path": "references/sources.md", "content": "..." }] }
```

`400` on invalid markdown or an out-of-folder path, `409` if the name is taken. Limits: 200 reference files, 10 MB per file, 50 MB total including `SKILL.md`.

### `GET /agents/:id/skills/:slug`

Return one skill (frontmatter + body + bundled `files`). `404` if unknown.

### `GET /agents/:id/skills/:slug/archive`

The whole skill folder as a `.tar.gz`, rooted at `<slug>/`.

### `PATCH /agents/:id/skills/:slug`

Update a skill. Body: `{ "description"?, "body"? }`. Bundled files are untouched.

### `/agents/:id/skills/:slug/files`

Same endpoint shape as the workspace filesystem below (`GET /`, `/read`, `/raw`, `PUT /`, `POST /move`, `POST /dir`, `DELETE /`), rooted at the skill folder. `SKILL.md` cannot be deleted through it — delete the skill instead.

---

## Files

Two filesystems, same endpoint shape:

- **Per-agent (private):** `/agents/:id/files` → the agent's `data/agents/<id>/workspace/`. This is the same jail the `fs_*` tools use. `404` if the agent is unknown.
- **Shared (global):** `/shared/files` → `data/shared/`, a common space every agent can read and write (the `shared_*` tools). Use it to move files between agents.

All paths are relative to the root. Traversal (`../…`) or absolute paths outside the root return `400 Path escapes the root`. Below, `<base>` is either prefix.

### `GET <base>?path=<dir>`

List a directory (default `path=.`). Directories sort first.

```json
{ "entries": [ { "name": "notes", "type": "dir", "size": 96, "modifiedAt": "2026-06-02T..." }, { "name": "todo.md", "type": "file", "size": 7, "modifiedAt": "..." } ] }
```

### `GET <base>/read?path=<file>&offset=<characters>`

Read a text (UTF-8) file in pages of 100,000 characters. `offset` defaults to `0`; pass the returned `nextOffset` to continue.

```json
{ "path": "notes/todo.md", "content": "# hello", "offset": 0, "nextOffset": null, "totalChars": 7, "truncated": false }
```

### `GET <base>/raw?path=<file>`

Download raw bytes. `Content-Type` is guessed from the extension (fallback `application/octet-stream`), with `Content-Disposition: inline`. Use this for images, PDFs, and other binary files.

### `PUT <base>`

Write a text file (creates parent directories). Body:

```json
{ "path": "notes/todo.md", "content": "# hello" }
```

Returns `{ "path": "notes/todo.md", "bytes": 7 }` `201`.

### `POST <base>/raw`

Upload a binary file as `multipart/form-data` with a `file` field. The target path is `?path=<file>`, or `?dir=<dir>` to keep the uploaded filename (defaults to the filename at the root).

```bash
curl -X POST "$BASE/shared/files/raw?dir=images" -F file=@photo.png
```

Returns `{ "path": "images/photo.png", "bytes": 12345 }` `201`.

Holds the whole file in memory. Prefer `PUT <base>/raw` for anything large.

### `PUT <base>/raw`

Upload a binary file as the raw request body, piped straight to disk. The target path is `?path=<file>`, or `?dir=<dir>&name=<file>`. Pass `?size=<bytes>` to be refused early when the file is over the limit (`Content-Length` is a forbidden header for `fetch`, hence the query parameter). Files are capped at 100 MB.

```bash
curl -X PUT "$BASE/shared/files/raw?dir=images&name=photo.png" --data-binary @photo.png
```

Returns `{ "path": "images/photo.png", "bytes": 12345 }` `201`, `400` over the cap, `507` when the disk is full.

### `POST <base>/move`

Move or rename. Body `{ "from": "...", "to": "..." }`.

### `POST <base>/dir`

Create a directory. Body `{ "path": "..." }`. Returns `201`.

### `DELETE <base>?path=<entry>`

Delete a file or directory (recursive). Returns `{ "path": "..." }`.

```bash
# write to one agent's private workspace, then list it
curl -X PUT $B/agents/$AID/files -H 'content-type: application/json' -d '{"path":"report.md","content":"draft"}'
curl "$B/agents/$AID/files?path=."

# hand a file to every agent via the shared space
curl -X PUT $B/shared/files -H 'content-type: application/json' -d '{"path":"datasets/users.csv","content":"id,name\n1,ana"}'
curl "$B/shared/files/read?path=datasets/users.csv"
```

---

## Schedules

Scheduled tasks are markdown files (`data/agents/<id>/schedules/<slug>.md`) scanned from disk by the in-process scheduler. A task is either **recurring** (`cron`) or **one-shot** (`runAt`). When due, the engine starts a fresh session and runs the task `body` as the agent's instruction — no user message needed. Each fire is audited in the `runs` table like any other run, and its completion is pushed to the hub (see [Notifications](#notifications)).

### `GET /agents/:id/schedules`

```json
{ "schedules": [ { "slug": "daily-digest", "name": "Daily digest", "description": "...", "enabled": true, "cron": "0 8 * * *", "runAt": null, "timezone": "Europe/Paris", "lastRunAt": null, "connectionId": "abc...", "provider": "openrouter", "model": "...", "body": "Summarize yesterday's notes.", "createdAt": "..." } ] }
```

### `POST /agents/:id/schedules`

Provide exactly one of `cron` or `runAt`. The slug is derived from the name.

```json
{ "name": "Daily digest", "description": "Morning summary", "body": "Summarize yesterday's notes and email me.", "cron": "0 8 * * *", "timezone": "Europe/Paris", "provider": "openrouter", "model": "..." }
```

One-shot:

```json
{ "name": "Reminder", "body": "Ping me about the meeting.", "runAt": "2026-06-03T15:00:00Z" }
```

Returns the created schedule `201`.

### `GET /agents/:id/schedules/:slug`

Return one schedule. `404` if unknown.

### `PATCH /agents/:id/schedules/:slug`

Update a schedule. Body: any subset of `{ "description"?, "body"?, "cron"?, "runAt"?, "timezone"?, "enabled"?, "connectionId"?, "provider"?, "model"? }`. Set `"enabled": false` to pause it without deleting.

`model: null` means "whatever the agent runs", which is itself the box default when the agent picked nothing: the routine follows instead of freezing today's pair. It is what a schedule created without a model gets.

An automation that does pin a pair keeps it. When that pair stops being runnable — the credential was removed, or the model was switched off on the connection — the engine falls back rather than failing: the agent's own model, then the box default, then the keyless `rerun` connection, then the first connection on the box that can serve something. The substitution is logged as a warning, because it changes both the bill and the answer.

### `DELETE /agents/:id/schedules/:slug`

```json
{ "deleted": "daily-digest" }
```

Agents can also manage their own schedules at runtime with the `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete` tools (gated by `config.tools.schedule`).

---

## Triggers

Triggers are the event-driven counterpart of schedules: markdown files (`data/agents/<id>/triggers/<slug>.md`) that expose a public URL. When an external service calls it, the engine starts a fresh session and runs the trigger `body` with the caller's payload attached below it.

The URL is served by the Rerun app, not by the engine: `https://app.rerun.build/api/t/<rerunAgentId>/<slug>/<token>`. It resolves the agent and forwards the payload to `POST /agents/:id/triggers/:slug/fire` with the space key. So a self-hosted engine with no hub can define triggers, but only the hub can hand out their URLs.

`triggers/` is **not** part of an agent archive: each file holds the secret of a live URL, which must not be copied into every install of a published template.

### `GET /agents/:id/triggers`

```json
{ "triggers": [ { "slug": "github-push", "name": "GitHub push", "description": "...", "enabled": true, "token": "...", "methods": ["POST"], "lastFiredAt": null, "fireCount": 0, "connectionId": "abc...", "provider": "openrouter", "model": "...", "body": "Review the incoming commit.", "createdAt": "..." } ] }
```

### `POST /agents/:id/triggers`

The slug is derived from the name and never changes afterwards, since the public URL is built from it. `methods` defaults to `["POST"]`.

```json
{ "name": "GitHub push", "description": "On main", "body": "Review the incoming commit.", "methods": ["POST"], "provider": "openrouter", "model": "..." }
```

Returns the created trigger `201`, token included.

### `GET /agents/:id/triggers/:slug` · `PATCH` · `DELETE`

Same shape as schedules, including the connection fallback. `PATCH` takes any subset of `{ "description"?, "body"?, "methods"?, "enabled"?, "connectionId"?, "provider"?, "model"? }` — never the name.

### `POST /agents/:id/triggers/:slug/rotate`

Issue a new token, which changes the public URL. Every service still calling the old one stops working.

### `POST /agents/:id/triggers/:slug/fire`

Called by the Rerun app on behalf of an anonymous caller, never by a user directly.

```json
{ "token": "...", "method": "POST", "query": "source=zapier", "contentType": "application/json", "body": "{\"ref\":\"refs/heads/main\"}", "bodyBytes": 25 }
```

Returns `202 { "runId": "...", "sessionId": "...", "triggerSlug": "..." }`.

Every rejection answers **`404`** — unknown slug, unsafe slug, wrong token, disabled trigger — so an anonymous caller cannot probe which triggers exist. The one exception is a verb the trigger does not accept, which answers **`405`** with the allowed list. The token is compared in constant time, and the payload is truncated at 64 KB before it reaches the model.

Agents can manage their own triggers at runtime with the `trigger_create` / `trigger_list` / `trigger_get` / `trigger_update` / `trigger_rotate_token` / `trigger_delete` tools (gated by `config.tools.trigger`). `trigger_get` is the only one that returns the URL.

---

## Runs

Every execution (chat, one-off run, or scheduled fire) is recorded in the `runs` table: status, step count, token usage, timings, and error. Use these endpoints to see the results of your crons.

### `GET /agents/:id/runs`

List runs for an agent (newest first). Optional `?limit=` (default `50`, max `200`).

```json
{ "runs": [ { "id": "run_...", "agentId": "abc...", "sessionId": "ses...", "status": "done", "stepCount": 4, "usageJson": "{\"inputTokens\":1200,\"outputTokens\":340}", "startedAt": "...", "finishedAt": "...", "error": null } ] }
```

`status` is `running` | `done` | `error`.

### `GET /agents/:id/runs/:rid`

Return one run plus its final assistant `output` (the text produced during the run, derived from the session transcript). `404` if the run is unknown or belongs to another agent.

```json
{ "id": "run_...", "agentId": "abc...", "sessionId": "ses...", "status": "done", "stepCount": 4, "usageJson": "...", "startedAt": "...", "finishedAt": "...", "error": null, "output": "Here is yesterday's digest: ..." }
```

To see the full transcript (tool calls included) of a scheduled run, use the run's `sessionId` with `GET /agents/:id/sessions/:sid/messages`.

---

## Notifications

The engine pushes lifecycle events to the hub it is linked to, at `POST $RERUN_HUB_BASE_URL/api/webhooks/engine`, authenticated with its own `RERUN_API_KEY`. There is no per-schedule webhook URL: everything goes to the hub, which decides what to email or show.

Events:

- `agent.session.created` — a session was opened by a schedule or a trigger.
- `agent.message.completed` — an interactive run finished.
- `agent.schedule.completed` — a scheduled run finished.
- `agent.trigger.completed` — a webhook-triggered run finished.
- `agent.notification` — the agent called `notify_user`.

Payload (`content-type: application/json`):

```json
{
  "event": "agent.trigger.completed",
  "kind": "done",
  "agentId": "abc...",
  "sessionId": "ses...",
  "runId": "run_...",
  "message": "Trigger \"GitHub push\" completed",
  "metadata": { "source": "trigger", "status": "done", "triggerSlug": "github-push", "stepCount": 4, "usage": {}, "costMicros": 0 },
  "title": null,
  "source": "trigger",
  "timestamp": "..."
}
```

On failure `kind` is `error` and `metadata.error` holds the message. Delivery is best-effort with a 5s timeout: a non-2xx response or a network error is logged and never affects the run. The hub validates `event` against a closed list, so adding one here means updating the hub first.

### Agent notifications (`notify_user`)

An agent can notify its user out-of-band by calling the `notify_user` tool (the `notify` tool family, enabled by default). This is for the cases where the user is not watching the conversation: the agent finished, spotted something they must see, or wants permission/approval before continuing. The tool does **not** pause the run — it only delivers a message, then the agent keeps going.

Delivery is configured per engine instance (one engine = one space) via two env vars:

- `RERUN_HUB_BASE_URL` — the UI base URL; the engine delivers to its `POST /api/webhooks/engine` endpoint.
- `RERUN_API_KEY` — the per-space bearer token; the receiver maps it to the space.

If either is unset the tool is a no-op (it tells the agent the notification wasn't delivered, nothing is sent). When set, the engine `POST`s to `${RERUN_HUB_BASE_URL}/api/webhooks/engine` with header `Authorization: Bearer <RERUN_API_KEY>` and payload:

```json
{
  "event": "agent.notification",
  "kind": "question",
  "agentId": "abc...",
  "sessionId": "ses...",
  "runId": "run_...",
  "message": "I need your approval before deleting these 12 files.",
  "metadata": null,
  "timestamp": "..."
}
```

`kind` is one of `info` | `question` | `approval` | `progress` | `done` | `error`. `info` is the one kind that outlives the run: the hub flags the conversation as needing an acknowledgement, and it stays flagged after the run completes until the user marks it as read or sends the next message. `progress` is its silent counterpart, for updates that flag nothing. `sessionId`/`runId`/`metadata` may be `null`. Delivery is best-effort with a ~5s timeout: non-2xx responses and network errors are logged and never fail the run.

---

## Quick smoke test

```bash
B=http://localhost:3000
# 1. create an agent with a key
AID=$(curl -s -X POST $B/agents -H 'content-type: application/json' -d '{
  "config": { "name": "Scout", "provider": "anthropic", "model": "claude-sonnet-4-6" },
  "soul": "You are Scout, concise. Use your tools when asked.",
  "keys": { "ANTHROPIC_API_KEY": "sk-ant-..." }
}' | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

# 2. stream a chat that runs a tool
curl -N -X POST $B/agents/$AID/chat -H 'content-type: application/json' \
  -d '{"message":"Create notes.txt in your workspace with the text hello, then confirm."}'

# 3. memory + skills
curl -s -X POST $B/agents/$AID/memories -H 'content-type: application/json' -d '{"content":"User likes short answers.","kind":"preference"}'
curl -s -X POST $B/agents/$AID/memories/recall -H 'content-type: application/json' -d '{"query":"answer length"}'
curl -s $B/agents/$AID/skills
```
