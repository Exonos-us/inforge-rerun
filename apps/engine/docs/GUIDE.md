# rerun-engine — Complete Guide

This document explains the whole project: what it is, how it is built, how data is stored, how to run it, and how every part (agents, the run loop, tools, skills, memory, self-improvement) works together. For the exact HTTP contract see [API.md](./API.md).

---

## 1. What it is

`rerun-engine` is a small, self-hostable server that runs **autonomous AI agents**. A single process manages **many independent agents** and exposes everything over HTTP. There is no UI here on purpose — a separate project (the `rerun` app) is the front end.

Each agent is fully self-contained: its own personality, its own memory, its own skills, its own enabled tools, and its own API keys. You start the server once (`rerun run`), then create agents and talk to them over the API.

It is a lighter, TypeScript replacement for a Hermes-style agent host, built on the **Vercel AI SDK** (`ai` + `@ai-sdk/*`).

### Design principles

- **File-first.** Everything an agent "is" lives in real files on disk you can open and read: personality, config, keys, skills, memories, workspace. The database is only used for things that genuinely need queries or retrieval.
- **One server, many agents.** Agents are addressed by URL (`/agents/:id/...`), not by separate ports or processes.
- **Self-improving.** Agents can write their own memories, create their own skills, install tools, and register MCP servers — so they get better over time.
- **Contained.** Each agent's filesystem and shell tools are jailed to its own `workspace/`. Run the whole engine in a container so anything an agent does stays inside it.

---

## 2. Architecture at a glance

```
HTTP (Hono)
  └── /agents/:id/{chat,sessions,memories,skills,schedules}
        │
        ▼
  Agent registry  ──reads──►  data/agents/<id>/   (files = source of truth)
        │                        SOUL.md, config.json, .env,
        ▼                        workspace/, skills/, memory/
  Run loop (AI SDK streamText)        ◄── HTTP chat  OR  scheduler (cron)
        │  multi-step tool calling (stopWhen stepCountIs)
        ├── tools: filesystem, shared, shell, web, memory, skills, self, schedule, delegate, browser, vision, MCP
        ├── persists transcript ──►  libSQL (sessions, messages)
        ├── memory recall/write  ──►  files + libSQL (vector + FTS index)
        └── curator (after run)  ──►  new memories / new skills

  Scheduler (every ~30s)  ──reads──►  data/agents/<id>/schedules/<slug>.md
        └── due task ──► fresh session ──► same Run loop
```

- **Files** are canonical for anything readable: identity, config, keys, skills, memories, the workspace.
- **libSQL** (`data/rerun.db`) stores only: conversation `sessions` + `messages`, the `memories` retrieval index (embedding + FTS, each row points back to its `.md` file), a light `agents` index, and `runs` audit logs.

---

## 3. Storage layout

Everything lives under `RERUN_DATA_DIR` (default `~/.rerun`):

```
data/
  rerun.db                      libSQL database (transcripts + indexes + audit)
  shared/                       common space every agent can read and write (shared tools)
  shared-db/
    shared.db                   SQL database every agent shares (shared_db_* tools)
  agents/
    <agentId>/
      SOUL.md                   personality / system prompt
      INSTALL.md                guided setup replayed once on a new owner's account (optional)
      config.json               AgentConfig (model, tools, MCP, self-improvement, setup)
      .env                      per-agent API keys (chmod 600, never returned)
      workspace/                jail for filesystem + shell tools (private to this agent)
      skills/
        <slug>/SKILL.md         a reusable procedure (frontmatter + markdown)
      schedules/
        <slug>.md               a scheduled task (cron/one-shot frontmatter + prompt)
      memory/
        <memId>.md              a durable memory (frontmatter + markdown)
```

Two filesystems coexist: each agent's private `workspace/` (the `filesystem` / `fs_*` tools), and the global `shared/` space (the `shared` / `shared_*` tools) that every agent can read and write to hand files to each other.

Two SQL databases coexist the same way: each agent's private `data/agent.db` (the `db` / `db_*` tools), and the engine-wide `shared-db/shared.db` (the `sharedDb` / `shared_db_*` tools) that every agent reads and writes. The shared file sits outside `shared/` on purpose, so no file tool can truncate it. A script reaches them through `RERUN_AGENT_DB` and `RERUN_SHARED_DB`.

### What is in the database (and why)

| Table | Why it is in the DB, not a file |
| --- | --- |
| `sessions` | needs ordering, status, listing per agent |
| `messages` | append + ordered read per session, plus full-text search |
| `memories` | retrieval index only: embedding vector + FTS; `path` points to the `.md` |
| `agents` | a light index for fast listing and as a foreign-key target |
| `runs` | audit log of each run (status, steps, usage, errors) |

Skills and the canonical memory text are **not** in the database — they are the `.md` files. The `memories` table is just an index that makes those files searchable.

---

## 4. Install and run

```bash
pnpm install
pnpm build                 # compiles to dist/
node dist/cli/bin.js run   # starts the server (runs migrations first)
# during development:
pnpm dev                   # tsx watch, same as `rerun run`
```

Check it:

```bash
curl localhost:3000/health     # {"status":"ok","activeAgents":0}
```

### The CLI (`rerun`)

After `pnpm build`, the `rerun` bin is `dist/cli/bin.js`:

```
rerun run                       Start the API server (migrates first)
rerun migrate                   Create or update the database
rerun agent create --name X     Create an agent  (--provider, --model, --key KEY=VALUE)
rerun agent list                List agents
rerun agent delete <id>         Delete an agent and its files
rerun skill list <agentId>      List an agent's skills
rerun schedule list <agentId>   List an agent's scheduled tasks
rerun doctor                    Check env, database and vector support
```

`rerun doctor` is the fastest way to confirm a machine is healthy:

```
data dir: /…/data ok
api key: open (no auth)
embed key: unset (memory recall falls back to FTS only)
db: /…/data/rerun.db ok
tables: agents, memories, messages, runs, sessions
vector support: yes
```

---

## 5. Configuration

Instance-level env (parsed and validated at startup, see `src/config/env.ts`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `RERUN_DATA_DIR` | `~/.rerun` | Root for the database and agent files |
| `RERUN_PORT` | `3000` | HTTP port |
| `RERUN_HOST` | `0.0.0.0` | Bind address |
| `RERUN_API_KEY` | _unset_ | Bearer token for the API (open if unset); also used to authenticate to the UI's `/api/embed` |
| `RERUN_HUB_BASE_URL` | _unset_ | Public UI base URL for embeddings and agent notifications |
| `RERUN_LOG_LEVEL` | `info` | pino log level |

Per-agent provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) are **not** global — they live in each agent's `.env` and are supplied when you create the agent.

---

## 6. Agents

### The agent model (`config.json`)

```json
{
  "name": "Scout",
  "description": "",
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "tools": { "filesystem": true, "shared": true, "shell": true, "web": true, "memory": true, "skills": true, "self": true, "schedule": true, "delegate": true, "browser": true, "vision": true },
  "mcpServers": [],
  "selfImprovement": { "enabled": true, "allowToolInstall": true, "autoSkillCreation": true, "autoMemory": true }
}
```

- `provider` is one of `rerun`, `anthropic`, `claude`, `codex`, `openai`, `google`, `openrouter`, `opencode`. The credentials live on the box connection the agent points at (`connectionId`), see `docs/API.md`.
- `tools` switches whole tool families on/off.
- `selfImprovement` controls the curator and whether the agent may install tools / register MCP servers.

### Creating an agent

Via API:

```bash
curl -X POST localhost:3000/agents -H 'content-type: application/json' -d '{
  "config": { "name": "Scout", "provider": "anthropic", "model": "claude-sonnet-4-6" },
  "soul": "You are Scout, a concise research assistant.",
  "keys": { "ANTHROPIC_API_KEY": "sk-ant-...", "OPENAI_API_KEY": "sk-..." }
}'
```

Only `config.name` is required. `soul` becomes `SOUL.md`, and an optional `install` becomes `INSTALL.md`, the setup the agent walks a new owner through when `config.setup.required` is true. `keys` are written to `.env`. Vector memory recall is enabled automatically when the engine can reach the UI's `/api/embed` (set `RERUN_HUB_BASE_URL` + `RERUN_API_KEY`); no per-agent embedding key is needed.

Via CLI:

```bash
rerun agent create --name Scout --provider anthropic --model claude-sonnet-4-6 --key "ANTHROPIC_API_KEY=sk-ant-..."
```

### The system prompt

On each run the system prompt is assembled (`src/agents/systemPrompt.ts`) from: the agent's `SOUL.md`, a compact **index of its skills**, the **most relevant memories** for the incoming message, and short operating notes. Full skill bodies are loaded only when the agent calls `skill_read`, which keeps the context small. An agent whose guided setup is still pending also gets a `setup` section and the `install_complete` tool, both of which disappear the moment it closes its installation.

---

## 7. The run loop

A "run" is one turn: you send a message, the agent thinks and calls tools until it is done, and you get a reply. It uses the AI SDK `streamText` with multi-step tool calling that runs until the model stops calling tools or calls a HITL tool such as `ask_user` (`src/runtime/loop.ts`). There is no step cap.

Lifecycle of a run:

1. Load the session history and append the user message.
2. Build the system prompt (soul + skills index + recalled memories).
3. Build the tool set for this agent (enabled builtins + MCP).
4. Start a `runs` audit row, mark the agent `busy`.
5. Stream the model, executing tools each step.
6. On finish: persist the assistant + tool messages, close MCP, mark `idle`, finish the audit row, and run the **curator**.
7. On error: record it on the `runs` row and clean up.

`POST /agents/:id/chat` drives the loop over HTTP: **streaming** (SSE; AI SDK UI message stream). The session id is returned in the `x-session-id` header.

If you omit `sessionId`, a new session is created; pass it back to continue the same conversation.

---

## 8. Tools

Tools are built per run and gated by `config.tools` (`src/tools/`). Each is a typed AI SDK `tool()` with a Zod input schema.

| Family | Tools | Notes |
| --- | --- | --- |
| `filesystem` | `fs_read`, `fs_write`, `fs_list`, `fs_edit`, `fs_search` | Jailed to the agent's private `workspace/`; `fs_edit` is a surgical string-replace, `fs_search` is a regex content grep |
| `shared` | `shared_read`, `shared_write`, `shared_list`, `shared_edit`, `shared_search` | Same operations against the global `shared/` space every agent can read and write — use it to pass files between agents |
| `shell` | `shell_exec` | Runs in `workspace/`, with a command-policy denylist |
| `web` | `web_fetch`, `web_search`, `download` | Fetch/strip a URL (a page the site refuses is read through the Rerun hub instead), search the web (through the Rerun hub), download a file into the workspace |
| `memory` | `memory_write`, `memory_recall` | Writes `.md` files + index; hybrid recall |
| `skills` | `skill_list`, `skill_read`, `skill_create`, `skill_update`, `skill_delete` | Reads/writes/deletes `SKILL.md` files. A connector's own skills are read-only |
| `self` | `tool_install`, `mcp_register` | `npm install` into the workspace; add an MCP server |
| `schedule` | `schedule_list`, `schedule_create`, `schedule_update`, `schedule_delete` | Reads/writes schedule `.md` files; the agent can plan its own recurring tasks |
| `delegate` | `delegate_task` | Spawns a fresh ephemeral sub-agent (inherits config/keys), runs a subtask to completion, returns its answer, then deletes it. Sub-agents cannot delegate further |
| `browser` | `browser_navigate`, `request_takeover` | Chromium driven by patchright, windowed on the agent's own Xvfb display, which the engine starts (headless when there is none), with a persistent profile per agent: renders JS, waits out bot-protection challenges, accepts cookie banners, returns visible text, optional full-page screenshot into the workspace. Requires `rerun install-browser`. `request_takeover` pauses the run and hands that browser to the user for a sign-in or a captcha; it only exists on a box with the desktop packages (see Desktop in `API.md`) |
| `computer` | `computer`, `computer_open_app` | The agent's own hands on its screen (see Desktop in `API.md`): `computer` takes a screenshot, clicks, drags, scrolls, types and presses keys with `xdotool`, and answers every action with a fresh screenshot scaled to 1280x720; `computer_open_app` opens the browser, the file manager or the terminal. Only exists on a box with the desktop packages and `maim`, for an agent that is neither a delegate nor the foreman. Screenshots never enter the stored conversation: the run keeps the latest in memory and attaches them to each model call (inside the tool result, in a user message for `rerun` and `openrouter`, as an MCP image block for `claude`); `codex` gets the path of a temporary file to open with its own `view_image`. One run drives an agent's screen at a time, capped at 200 actions (60 on `claude` and `codex`), and it is refused while a person drives that screen or holds it through the explicit hold (`POST /agents/:id/desktop/hold`), and when a person drove or held the screen between two of its actions the next result says so. The `type_secret` action types a saved screen secret (a coworker variable labeled with a site through `PATCH /agents/:id/keys` `screen`, usually from the `request_secret` chat card) without the value ever reaching the model: the engine refuses it unless the live browser window is on the secret's own site, and unless the user pre-authorized that site or approved the exact `request_approval` line in the current run; its result carries no screenshot, so a value typed into the wrong field can never enter model context. Each screen session also leaves evidence in the workspace: the action screenshots under `screen/<session id>/NNN.jpg`, named in every tool result as `screenSession` (see `GET /agents/:id/screen/sessions` in `API.md`) |
| `computerRecording` | — | No tools of its own: the flag that records the agent's screen sessions (runs, takeovers and explicit holds) to `screen/<session id>/recording.mp4` in the workspace, when `ffmpeg` is installed. On by default; the 20 most recent sessions are kept. A person on the screen can pause the capture (`POST /agents/:id/desktop/recording`); each resume starts the next segment file |
| `vision` | `vision_analyze` | Analyzes a workspace image with the agent's multimodal model (e.g. a screenshot from `browser_navigate`) |

A few tools sit outside those families because they answer to a state rather than a setting: the human-in-the-loop ones (`ask_user`, `request_approval`, `suggest_service`, `request_secret`) follow `config.tools` flags of their own (`request_takeover` is the exception and rides with `browser`), and `install_complete` only exists while the agent still has a guided setup to run (`config.setup.required` true, `completedAt` null, `INSTALL.md` present). Calling it also switches on the schedules and triggers the agent carries, because a captured template usually arrives with its crons off and this is the moment its folder is finally configured (see `POST /agents/:id/automations/activate` in API.md).

### MCP

Each agent can declare MCP servers in `config.mcpServers`. On a run they are connected (stdio or SSE) via the official `@modelcontextprotocol/sdk`, and their tools are merged into the agent's tool set under `"<server>_<tool>"` names (`src/tools/mcp.ts`). `mcp_register` lets an agent add one to its own config at runtime.

A server that needs a credential never carries it inline: it references an agent variable as `${KEY}`, resolved from the agent `.env` at connect time (`src/tools/mcp-resolve.ts`). The agent gets that value into the `.env` by calling `request_secret`, which pauses the run and shows the user a masked form; the UI writes the values through `PATCH /agents/:id/keys` and the agent is told only which variable names were filled. The secret never enters the conversation.

---

## 9. Skills

A skill is a **folder**. `SKILL.md` carries the frontmatter and the procedure; everything else in the folder is a bundled file loaded only when the procedure calls for it, by convention under `references/`:

```
data/agents/<id>/skills/web-research/
├── SKILL.md
└── references/source-quality.md
```

```markdown
---
name: Web Research
description: How to research a topic on the web
---

1. Identify sources — read `references/source-quality.md` before ranking them
2. Fetch the pages with web_fetch
3. Summarize the findings
```

How they are used, in three layers of progressive disclosure:

- The system prompt only contains a **one-line index** of each skill (name + description).
- When relevant, the agent calls `skill_read <slug>` to load the full procedure and the list of bundled files.
- It calls `skill_read_file <slug> <path>` for a bundled file only at the step that names it. This is what keeps a large corpus out of the context until it is needed.

The agent writes its own skills: `skill_create` / `skill_edit` for the procedure, `skill_write_file` / `skill_delete_file` for the bundled files, `skill_import` to adopt a markdown file or a whole skill folder sitting in its workspace. A skill can read a sibling skill's file (`../other-skill/references/x.md`); it cannot write outside its own folder, nor read outside `skills/`.

A skill installed by a **connector** is the exception: the agent reads it, never writes it. The UI records each install's footprint in the agent workspace at `.rerun/services.json`, and `src/services/registry.ts` turns the `skills` of that footprint into a slug → connector map. Every writing skill tool consults it at call time, so a connector attached mid-conversation is protected from the very next tool call: `skill_update`, `skill_edit`, `skill_delete`, `skill_write_file` and `skill_delete_file` refuse by slug, `skill_create` and `skill_import` refuse on `slugify(name)` because `writeSkill` overwrites whatever sits at that slug. `skill_list` and `skill_read` say so up front, so the model does not try. The HTTP routes stay open: they are how the connector installs its own skills.

Manage them over the API (`GET/POST /agents/:id/skills`, `GET/PATCH /agents/:id/skills/:slug`, `/agents/:id/skills/:slug/files`, `GET /agents/:id/skills/:slug/archive`) or with `rerun skill list <agentId>`.

---

## 10. Scheduled tasks (cron)

Agents can run **on a schedule**, with no user message — the engine's equivalent of cron jobs / background tasks. A scheduled task is a file (file-first, just like skills):

```
data/agents/<id>/schedules/daily-digest.md
```

```markdown
---
name: Daily digest
description: Morning summary
enabled: true
cron: '0 8 * * *'          # recurring  (OR runAt for a one-shot)
runAt: null                # e.g. '2026-06-03T15:00:00Z'
timezone: Europe/Paris
lastRunAt: null            # written back by the scheduler after each fire
createdAt: '2026-06-02T...'
---
Summarize yesterday's notes and email me a digest.
```

The markdown **body is the prompt** the agent runs when the task fires. A task is either **recurring** (`cron`, standard 5-field expression) or **one-shot** (`runAt`, an ISO 8601 instant).

How it works (`src/runtime/scheduler.ts`):

- `startScheduler()` is launched from `rerun run` (right after migration) and ticks every ~30s.
- Each tick lists every agent on disk, loads its schedules, and asks `isDue(schedule, now)` (`src/schedules/cron.ts`, backed by [`croner`](https://www.npmjs.com/package/croner)).
- For each due task it starts a **fresh session** (`schedule: <slug>`) and calls the same `runAgent` used by the HTTP routes — so the run is fully audited in the `runs` table. Continuity across fires comes from the agent's memory/RAG, not the session.
- On success it writes `lastRunAt` back into the file (and disables one-shots). A **failed** run is **not** marked, so it is retried on the next tick. An in-memory guard prevents the same task from overlapping itself.

Manage tasks over the API (`GET/POST /agents/:id/schedules`, `GET/PATCH/DELETE /agents/:id/schedules/:slug`), with `rerun schedule list <agentId>`, or let the agent manage its own via the `schedule_*` tools (gated by `config.tools.schedule`) — a natural extension of the self-improvement model.

---

## 11. Memory and RAG

Memories are markdown files; the database indexes them for retrieval (`src/memory/`).

```
data/agents/<id>/memory/<memId>.md
```

```markdown
---
id: 4laqkyyphjq7bsnsci8hq
kind: preference
tags: [style]
createdAt: '2026-06-02T14:27:54.214Z'
---

The user prefers concise answers in English.
```

- **Write** (`memory_write` or `POST /agents/:id/memories`): write the `.md` file, embed the text, and upsert a row into the `memories` table (vector + FTS), keeping the file path.
- **Recall** (`memory_recall` or `POST /agents/:id/memories/recall`): embed the query, run libSQL `vector_top_k` KNN, merge with an FTS5 keyword search, dedupe, and re-read the canonical text from the `.md` files.
- Relevant memories are also injected into the system prompt automatically at the start of each run.

Embeddings use OpenAI `text-embedding-3-small` (1536 dims), computed by the UI's `/api/embed` endpoint — the engine POSTs the text there (reached via `RERUN_HUB_BASE_URL`, authenticated with `RERUN_API_KEY`) so the provider key lives only in the UI. **Without a reachable UI, recall still works using FTS keyword search only** (no vectors).

---

## 12. Self-improvement (the curator)

When `selfImprovement.enabled` is true, after each run a curator step (`src/runtime/curator.ts`) reviews the exchange and decides — via a structured `Output.object()` call — whether anything is worth keeping:

- `autoMemory`: distil a durable fact and store it as a memory.
- `autoSkillCreation`: distil a clearly reusable procedure and store it as a new skill.

Combined with the `self` tools (`tool_install`, `mcp_register`), an agent can extend its own capabilities and accumulate knowledge across conversations.

---

## 13. Security and sandboxing

- **Path jail:** `filesystem` tools resolve every path inside the agent's `workspace/` and `shared` tools inside the global `shared/` space; traversal (`../…`) and absolute paths outside the root are rejected (`resolveWithin` in `src/tools/sandbox.ts`). The same jail backs the HTTP file endpoints. The shared space is deliberately readable and writable by every agent — it is a collaboration surface, not an isolation boundary. The same holds for the shared database behind the `shared_db_*` tools.
- **No cross-database reach:** `ATTACH` is rejected on every SQL path, so an agent cannot open a database file it was not granted through its tools.
- **Command policy:** `shell_exec` blocks a denylist of destructive commands (e.g. `rm -rf /`, `mkfs`, fork bombs).
- **Keys never leave:** agent `.env` files are `chmod 600` and are never returned by the API.
- **Containment:** self-improvement is powerful by design (real shell, real `npm install`). The intended deployment is the engine **inside its own Docker container**, so the blast radius is that container. For stronger isolation, run one container per agent.
- **API auth:** set `RERUN_API_KEY` to require a bearer token on every route except `/health`.

---

## 14. Deployment

### Docker

```bash
docker build -t rerun-engine .
docker run -p 3000:3000 -v rerun-data:/app/data -e RERUN_API_KEY=secret rerun-engine
```

The image is a single Node process; `/app/data` is a volume so agents and the database persist across restarts.

---

## 15. End-to-end test

```bash
B=http://localhost:3000

# create an agent (with a real key)
AID=$(curl -s -X POST $B/agents -H 'content-type: application/json' -d '{
  "config": { "name": "Scout", "provider": "anthropic", "model": "claude-sonnet-4-6" },
  "soul": "You are Scout, concise. Use your tools when asked.",
  "keys": { "ANTHROPIC_API_KEY": "sk-ant-..." }
}' | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

# stream a chat that runs a tool
curl -N -X POST $B/agents/$AID/chat -H 'content-type: application/json' \
  -d '{"message":"Create hello.txt in your workspace with the text hi, then confirm."}'

# the file landed inside the sandbox
cat data/agents/$AID/workspace/hello.txt

# memory + skills
curl -s -X POST $B/agents/$AID/memories -H 'content-type: application/json' -d '{"content":"User likes short answers.","kind":"preference"}'
curl -s -X POST $B/agents/$AID/memories/recall -H 'content-type: application/json' -d '{"query":"answer length"}'
curl -s $B/agents/$AID/skills
```

---

## 16. Where things live in the code

| Area | Path |
| --- | --- |
| Entry / CLI | `src/cli/bin.ts`, `src/cli/commands/` |
| Config | `src/config/env.ts`, `src/config/paths.ts` |
| Database | `src/db/` (`schema.ts`, `migrate.ts`, `client.ts`, `repos/`) |
| Agents | `src/agents/` (`types.ts`, `factory.ts`, `loader.ts`, `registry.ts`, `providers.ts`, `systemPrompt.ts`) |
| Run loop | `src/runtime/` (`loop.ts`, `stream.ts`, `curator.ts`, `context.ts`, `scheduler.ts`) |
| Tools | `src/tools/` (`registry.ts`, `sandbox.ts`, `mcp.ts`, `builtin/` incl. `fsTools.ts`, `filesystem.ts`, `shared.ts`) |
| Files store | `src/files/store.ts` (root-scoped fs ops shared by tools and HTTP) |
| Skills | `src/skills/` (`loader.ts`, `index.ts`) |
| Schedules | `src/schedules/` (`loader.ts`, `cron.ts`, `index.ts`) |
| Memory | `src/memory/` (`files.ts`, `embed.ts`, `store.ts`) |
| HTTP | `src/http/` (`server.ts`, `auth.ts`, `routes/`) |
| Docs | `README.md`, `docs/API.md`, `docs/GUIDE.md` |
