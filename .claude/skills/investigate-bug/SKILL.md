---
name: investigate-bug
description: Start of every bug, before any fix. Read the report (often a Notion card), gather the evidence, reproduce the bug when possible, find the root cause and report it with the smallest fix proposed. Use whenever a bug, an incident or a customer complaint comes in, or when someone says "investigate this bug", "why does X happen", "reproduce the bug", « analyse ce bug », « regarde cette carte », « reproduis le bug », « trouve la cause ».
---

# investigate-bug: understand before fixing

Reply in the user's language. Notes and captures go in `.context/bugs/<slug>/`.

## 1. Read the report

- A Notion card: fetch the page, its comments and its attachments (screenshots, videos).
- Write down in one line each: what was expected, what happened, who (workspace id, user), where
  (web, mobile, engine, email…), when (date and time), how often (once, always, since a release).
- What is missing from the report, ask for it now rather than guessing.

## 2. Gather the evidence

Production and staging are **read-only** here: read, never write, restart or redeploy.

- Errors and logs around the reported time: PostHog (error tracking, session replay), Dokploy app
  logs, Trigger.dev runs, Supabase logs.
- The rows involved in the database (through a read query, never an update).
- What shipped in that area around that date: `git log --since=... -- <path>`, merged PRs.

### A bug in production: go and look at the customer's account

Investigating on the real account is allowed, still read-only:

- The workspace, its plan, its coworkers, its sessions and runs in Supabase.
- The engine box: find it through `engine_pool.claimed_by_workspace_id` (`engine_host`), then read
  through the engine API (`/agents/:id`, `/sessions/:sid/messages`, `/runs`, `/runs/:rid/tools`).
  Transcripts live on the box, not in Supabase.
- When the API is not enough, SSH into the box: engine logs, `journalctl`, the data-dir, disk and
  memory. Look only: no restart, no `rerun update`, no file edited, no data deleted.
- Read the model and provider the customer actually used before any reproduction, it changes the
  behaviour.
- Never paste the engine API key, tokens or the customer's private content in a message, a commit
  or a Notion card. Quote only what proves the cause.

## 3. Reproduce

- On the local stack only (`pnpm db:start`, `pnpm cloud env:local`): a `pnpm verify:ui` scenario in
  `.context/verify/` that clicks the reported path, or a failing test.
- Keep the exact steps that trigger it. A bug reproduced is a bug whose fix can be proved.
- Not reproducible: say so, list what was tried, and keep going from the evidence. Never present a
  guessed cause as a found one.

## 4. Find the root cause

- Trace the code path from the symptom back to the line that is wrong (`file:line`).
- The cause must explain **every** symptom of the report. If one is left over, keep digging.
- Tell the trigger (what the user did) apart from the cause (what the code does wrong).
- Other places with the same flaw: list them, do not fix them.
- The cause is a vulnerability: stop and switch to the `security-fix` skill.

## 5. Report, then wait

Unless the user already asked for the fix, stop here and give:

- **Symptom**: one sentence.
- **Reproduction**: the steps, or "not reproduced" with what was tried.
- **Root cause**: `file:line` and why, with the evidence (log line, row, capture).
- **Proposed fix**: the smallest diff that removes the cause. A wider refactor is mentioned in one
  line, never folded into the fix.
- **Open questions**, if any.

Save the same report in `.context/bugs/<slug>/report.md` for the agent that will fix it.
