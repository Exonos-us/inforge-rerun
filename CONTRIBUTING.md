# Contributing to Rerun

Thank you for helping. This page covers running Rerun from source, the shape of the code, and how a
pull request gets in.

## Run it from source

You need Node 22, pnpm 8 (`corepack enable`), Docker (for the local Supabase) and an OpenRouter key.

```bash
pnpm install
pnpm db:start                      # Postgres, auth, storage and Mailpit on ports 54420 to 54429
pnpm --filter @rerun/contracts build
cp .env.example apps/ui/.env
cp apps/engine/.env.example apps/engine/.env
```

`pnpm db:start` runs the Supabase CLI version this repository pins. `npx supabase start` grabs the
latest one, which can refuse our `supabase/config.toml`.

Then fill the two files. Pick any long random string as the engine key and use it in both, and a
long random string for each secret:

| `apps/ui/.env` | Value |
|---|---|
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3050` |
| `NEXT_PUBLIC_SUPABASE_URL` | `http://localhost:54421` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` | the keys `pnpm exec supabase status` prints |
| `OPENROUTER_API_KEY` | your OpenRouter key |
| `RERUN_ENGINE_URL` | `http://localhost:3000` |
| `RERUN_ENGINE_API_KEY` | the engine key |
| `FOREMAN_HUB_TOKEN_SECRET`, `BOARD_IMAGE_SECRET`, `MOBILE_OAUTH_TICKET_SECRET`, `PUBLISHED_ACCESS_SECRET` | a random string each |
| `PUBLISH_HOST` | `localhost:3050`, so the pages coworkers publish open at `<slug>.localhost:3050` |

| `apps/engine/.env` | Value |
|---|---|
| `RERUN_API_KEY` | the engine key |
| `RERUN_HUB_BASE_URL` | `http://localhost:3050` |

Start both, each in its own terminal:

```bash
pnpm dev:engine    # http://localhost:3000
pnpm dev:ui        # http://localhost:3050
```

The first workspace that needs an engine gets this one. Sign-in codes land in Mailpit, at
http://localhost:54424.

## Checks

```bash
pnpm -r --if-present ts-check
pnpm --filter rerun lint
pnpm --filter rerun test
pnpm --filter rerun-engine test
```

CI runs the same, plus the migrations on an empty database and both Docker images.

## The code

| Path | What it is |
|---|---|
| `apps/ui` | The web app and its API (Next.js). Talks to Supabase and to the engine of each workspace |
| `apps/engine` | The engine: runs the coworkers, their tools, their memory, their browser and screen |
| `apps/docs` | The documentation (Mintlify) |
| `packages/contracts` | Types and schemas shared by the app and the engine |
| `packages/ui` | The design system and the board |
| `supabase/migrations` | The database schema, one migration per change |

`CLAUDE.md` holds the conventions of the codebase (and is what coding agents read): Supabase access
through the typed helpers, responsive from the first version, migrations of the engine data-dir.

`@rerun/cloud/*` is the seam where Rerun Cloud plugs in billing, paid apps, emails and its machine
pool. In this repository it resolves to `apps/ui/cloud-oss/`, the self-hosted behaviour. Pull requests that change what it
exports are unlikely to be merged.

## Pull requests

1. Open an issue first for anything bigger than a fix, so we agree on the direction.
2. Keep a pull request to one change, with tests where the code has them.

Rerun is developed in a private repository that Rerun Cloud deploys from, and this repository is
published from it at each release. A merged pull request is applied there with its author kept,
and comes back here with the next release, with credit in the release notes.

We will not take: anything that changes what `apps/ui/cloud-oss/` exports, a dependency with a license incompatible
with the AGPL, or a feature that only makes sense for one deployment.
