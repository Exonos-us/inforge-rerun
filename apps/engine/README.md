# rerun-engine

A light, self-hostable engine for autonomous AI agents. One process manages many fully independent agents — each with its own personality, memory, skills, tools and API keys — exposed entirely over HTTP. Built on the Vercel AI SDK.

It is a lighter, TypeScript replacement for a Hermes-style agent host: file-first (you can open and read everything an agent knows), with a single libSQL database used only for transcripts and retrieval.

## Quick start

```bash
pnpm install
pnpm build
node dist/cli/bin.js run
# or, in dev:
pnpm dev
```

The server listens on `RERUN_PORT` (default 3000). Health check:

```bash
curl localhost:3000/health
```

## How an agent is stored

Everything an agent owns lives in files under `RERUN_DATA_DIR/agents/<id>/`:

```
SOUL.md                 personality / system prompt
INSTALL.md              guided setup the agent runs once on a new owner's account (optional)
config.json             model, provider, enabled tools, MCP servers, self-improvement flags, setup state
.env                    per-agent API keys (chmod 600, never returned by the API)
workspace/              private root for the file tools, working directory of the shell tool (which is not confined to it)
skills/<slug>/SKILL.md  reusable procedures (markdown + frontmatter), read on demand
memory/<id>.md          durable memories (markdown + frontmatter)
```

Alongside the per-agent dirs, `RERUN_DATA_DIR/shared/` is a global space every agent can read and write through the `shared_*` tools — use it to pass files between agents.

The libSQL database (`RERUN_DATA_DIR/rerun.db`) holds only what needs query or RAG: conversation `sessions` + `messages`, the `memories` vector + FTS index (each row points back to its `.md` file), a light `agents` index, and `runs` audit logs.

## Data-dir migrations

A data-dir can come back from an archive taken weeks earlier and boot on today's engine, so it carries
its own version and every change to its layout is a numbered step in a ladder:

- `src/datadir/migrations.ts`: the data-dir ladder (files, folders, `rerun.db`). The version reached
  is written to `RERUN_DATA_DIR/data-version.json` after each step; a folder without it is v0.
- `SYSTEM_DB_MIGRATIONS` (`src/db/systemDb.ts`) and `SHARED_DB_MIGRATIONS` (`src/db/sharedDb.ts`): one
  ladder per SQLite file, versioned with `PRAGMA user_version`, applied when the file is opened.
- Every-boot reconcilers (`ensureAgentsIndex`, `reconcileConnections`, `ensureForeman`) are not
  steps: they bring the folder in line with today's code, whatever its history.

Rules:

1. Any change to what lives on disk is a new step at the end of its ladder.
2. A shipped step is never edited nor removed. The registry snapshots in `src/datadir/ladder.test.ts`
   and `src/db/ladder.test.ts`, and the per-version `system.db` schema snapshot, fail when one is.
3. A step must be re-runnable (a crash between the step and the version write replays it) and must
   not break the engine still running beside it: `rerun update` migrates before the restart. Add
   first, remove in a later step.
4. A step ships with a test that starts from the previous version.

An engine older than the data-dir it finds leaves it untouched and boots; `/health` reports
`dataVersion` against `dataVersionTarget` and `GET /doctor` says what is wrong, read-only.

## CLI

```
rerun run                       Start the API server (runs migrations first)
rerun migrate                   Run the data-dir migration ladder
rerun agent create --name X     Create an agent (--provider, --model, --key KEY=VALUE)
rerun agent list                List agents
rerun agent delete <id>         Delete an agent
rerun skill list <agentId>      List an agent's skills
rerun doctor                    Check the data-dir without changing it (exits 1 on a failure)
rerun update                    Pull, rebuild, migrate and restart the service (git checkout)
rerun update --artifact <url> --sha256 <hex> --commit <sha>
                                Install a prebuilt release, migrate and restart the service
rerun rollback                  Go back to the previous release and restart the service
rerun install-layout            Write the launcher and the systemd units for the release layout
rerun start | stop | restart    Control the systemd service
rerun status                    Show the service status
rerun logs [--no-follow]        Tail the service logs
```

## HTTP API

All routes except `/health` require `Authorization: Bearer $RERUN_API_KEY` when `RERUN_API_KEY` is set.

```
GET    /health
GET    /doctor                              read-only data-dir checks
GET    /agents                              POST /agents
GET    /agents/:id   PATCH /agents/:id   DELETE /agents/:id
POST   /agents/:id/chat                      stream the run (AI SDK UI message stream); x-session-id header
GET    /agents/:id/sessions
GET    /agents/:id/sessions/:sid/messages
GET    /agents/:id/memories                  POST /agents/:id/memories
POST   /agents/:id/memories/recall
GET    /agents/:id/skills                    POST /agents/:id/skills
GET    /agents/:id/skills/:slug              PATCH /agents/:id/skills/:slug
GET    /agents/:id/files   /read   /raw       PUT /agents/:id/files   POST /raw /move /dir   DELETE   (private workspace)
GET    /shared/files       /read   /raw       PUT /shared/files       POST /raw /move /dir   DELETE   (shared space)
```

Create an agent:

```bash
curl -X POST localhost:3000/agents -H 'content-type: application/json' -d '{
  "config": { "name": "Scout", "provider": "anthropic", "model": "claude-sonnet-4-6" },
  "soul": "You are Scout, a curious researcher.",
  "keys": { "ANTHROPIC_API_KEY": "sk-ant-..." }
}'
```

## Tools and self-improvement

Each agent gets a tool set gated by `config.json`: `filesystem` (jailed to its private `workspace/`, with `fs_edit` surgical edits and `fs_search` regex grep), `shared` (`shared_read/write/list/edit/search` on the global `shared/` space all agents share), `shell`, `web` (`web_fetch`, `web_search`, `download`), `memory` (`memory_write` / `memory_recall`), `skills` (`skill_read/create/update/delete/list`), `self` (`tool_install` to npm-install into its workspace, `mcp_register` to add an MCP server), `delegate` (`delegate_task` spawns an ephemeral sub-agent), `browser` (`browser_navigate` via a windowed Chromium on a virtual display, patched by patchright, with a persistent profile per agent — needs `rerun install-browser`), and `vision` (`vision_analyze` on workspace images). After each run a curator can distil a memory or a new skill automatically (`selfImprovement` flags).

Shell and install run inside the agent workspace with a command-policy denylist. Run the engine in its own container (see Dockerfile) so arbitrary shell stays contained.

## Memory recall

`memory_recall` embeds the query (OpenAI `text-embedding-3-small`, 1536 dims) and runs libSQL `vector_top_k` KNN merged with FTS5 keyword search. The engine no longer holds an embedding key: it POSTs the text to the UI's `/api/embed` endpoint (reached at `RERUN_HUB_BASE_URL`, authenticated with `RERUN_API_KEY`), which owns the provider key. Without a reachable UI, recall falls back to FTS only.

## Deployment

The engine runs in Docker, one container per workspace, next to the app or on a machine of its own:

```bash
docker build -f apps/engine/Dockerfile -t rerun-engine .   # from the repository root
docker run -d -p 3000:3000 -v rerun-engine:/data --shm-size 2g -e RERUN_API_KEY=<key> -e RERUN_HUB_BASE_URL=<app url> rerun-engine
```

The app attaches it to a workspace: the first one gets the engine of `docker-compose.yml`, any
other is paired from Servers, in the workspace menu (see https://docs.rerun.build/self-host/servers).
Its data-dir is `/data`: the database and every file of every coworker. Updates are a new image;
the data-dir migrates itself on start.

### Securing a public deployment

- **API key.** Always set `RERUN_API_KEY` (a paired server generates its own): without it the API is open.
- **TLS.** Don't expose port 3000 in clear. Keep the engine bound locally (`RERUN_HOST=127.0.0.1`)
  and put a reverse proxy in front for HTTPS — with Caddy that's a single `reverse_proxy
  localhost:3000` block (automatic certificates).

Docker: `docker build -f apps/engine/Dockerfile .` from the repository root builds an image with
Chromium, the desktop packages and the Codex CLI. Its data-dir is `/data`.

## The agent's computer

Every agent can get a Linux screen of its own on the box: a person watches and drives it from the
app, and the agent drives it through the `computer` tools. The Docker image ships everything; an
engine installed by hand on a Debian/Ubuntu server gets the packages from `rerun update` (or
`rerun install-desktop`) when it has passwordless sudo. Otherwise install them yourself:

```bash
sudo apt-get install -y --no-install-recommends xvfb openbox x11vnc xdotool maim tint2 hsetroot curl thunar xfce4-terminal adwaita-icon-theme ffmpeg
```

| Package | What it enables | Without it |
| --- | --- | --- |
| `xvfb` | One virtual display per agent (1920x1080); also installed with the browser's system dependencies | No screen; the browser runs headless |
| `openbox` | The window manager of each screen | No desktop at all (required) |
| `x11vnc` | The live view and drive mode in the app | No desktop at all (required) |
| `xdotool` | Clicks, keys and typing, the agent's and the dock's | No desktop at all (required) |
| `maim` | Screenshots, so the agent's `computer` tools exist | People can watch and drive, agents cannot use the screen |
| `tint2`, `curl` | The dock and the top bar | A bare screen; the app draws its own launcher |
| `hsetroot` | The wallpaper | A black background |
| `thunar`, `xfce4-terminal`, `adwaita-icon-theme` | The file manager and terminal of the dock and `computer_open_app` | Those apps fail to open; the browser still works |
| `ffmpeg` | The MP4 recording of each screen session | Sessions keep their screenshots only |

Check what a box can do with its health route:

```bash
curl -s localhost:3000/health | jq .capabilities
```

`desktop` (and `desktop.hold`) means people can watch and drive the screens, `computer` that agents
can use them, `computer.recording` that screen sessions are recorded. `RERUN_DESKTOP=off` turns all
of it off.

**Security model.** Screens are per agent: each agent has its own display, VNC port, window manager
and browser profile, and what one has open never shows on another's screen. Files and the system user
are per box: every app on every screen runs as the engine's user, the file manager and the terminal
can reach the other agents' folders, the same way a VM per account is shared by everything on that
account. The VNC servers listen on localhost only; the app reaches them through the engine's
ticket-authenticated WebSocket. Put agents that must not see each other's files on different boxes.
The design notes and the options for stronger isolation are in [`docs/COMPUTER.md`](docs/COMPUTER.md).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `RERUN_DATA_DIR` | `~/.rerun` | Root for the database and agent files |
| `RERUN_PORT` | `3000` | HTTP port |
| `RERUN_HOST` | `0.0.0.0` | Bind address |
| `RERUN_API_KEY` | _unset_ | Bearer token for the API (open if unset); also used to authenticate to the UI's `/api/embed` |
| `RERUN_HUB_BASE_URL` | _unset_ | Public UI base URL for embeddings and agent notifications |
| `RERUN_LOG_LEVEL` | `info` | pino log level |
| `RERUN_DESKTOP` | on | `off` turns off the screens and the computer tools of the box |
| `RERUN_DESKTOP_MAX_SCREENS` | `20` | Agent screens running at once; one more is refused with a 503 naming this variable |
| `RERUN_DESKTOP_IDLE_STOP_MINUTES` | `5` | Minutes a screen nobody watches, holds or drives stays up |
| `RERUN_COMPUTER_RECORDING` | `on` | `off` records no screen session on the box, whatever each agent's `computerRecording` switch says |
| `RERUN_COMPUTER_RECORDING_MAX_MINUTES` | `15` | Length cap of one screen session's recording |
| `RERUN_COMPUTER_SESSIONS_KEPT` | `20` | Screen session folders (`screen/<id>/`) kept per agent workspace |
| `RERUN_COMPUTER_MAX_ACTIONS` | `200` | Screen actions one run may take |
| `RERUN_COMPUTER_MAX_ACTIONS_CLI` | `60` | The same on the `claude` and `codex` providers, which keep every picture in context |
| `RERUN_COMPUTER_SCREENSHOTS_IN_CONTEXT` | `6` | Screenshots a run keeps attached to its model calls before dropping to half of them |
