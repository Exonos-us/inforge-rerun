# Clients: a coworker born knowing how its client works

Design, 2026-11-17. Branch base `dev`.

## The problem

A coworker hired for an engagement does not know how that client likes documents written or
communications phrased. Today the only way to give it that is to bake the conventions into a
template, which makes the template client-specific: one "SOW Writer" per client per role, and a
change to the client's house style means editing every one of them.

The idea started as "client tags on coworker templates". Tags already exist
(`20261111170000_preset_tags.sql`), so the tag itself is not the missing piece. What is missing is
a place for the client's conventions to live *once*.

## Shape

A **client** is a workspace entity carrying the reusable parts of a preset: skills, knowledge docs,
a default Confluence space, and the short code that already names Boxes, channels and coworkers.
A **Box points at a client**, the way it already points at a Confluence engagement. Every coworker
hired into that Box inherits the client's skills, whatever template it came from.

Templates stay client-neutral and reusable. Updating a client updates every coworker using it.

Decisions taken, and what was rejected:

| Decision | Rejected alternative |
|---|---|
| Client is an entity attached to the Box | A tag on the template, with conventions copied per template |
| Conventions ship as **skills**, loaded when relevant | Always-on context in the system prompt, like `project.md` |
| Editing a client **re-pushes** to live coworkers | New hires only, which lets the fleet drift |
| Client carries skills, knowledge, Confluence default, naming | Skills only |

Why skills rather than always-on context: a house style guide is long and only matters when the
coworker is actually writing something. `<project_knowledge>` pays its tokens on every run; a skill
pays them when it is used. This also matches how these conventions are already written elsewhere
as `SKILL.md` files.

## Data model

```sql
create table public.clients (
    id uuid primary key default gen_random_uuid(),
    workspace_id bigint not null references workspaces(id) on delete cascade,
    name text not null,
    short_code text not null default '',
    skills jsonb not null default '[]'::jsonb,     -- AuthoredSkill[]
    knowledge jsonb not null default '[]'::jsonb,  -- KnowledgeDoc[]
    site_url text, cloud_id text, space_key text, space_name text,
    revision integer not null default 1,
    created_by uuid references users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index clients_workspace_idx on public.clients (workspace_id);
create index clients_workspace_name_idx on public.clients (workspace_id, name);

alter table public.spaces add column client_id uuid references clients(id) on delete set null;
alter table public.agents add column client_revision integer;
```

The payload columns reuse `authoredSkillSchema` and `knowledgeDocSchema` from
`apps/ui/lib/presets/types.ts` — same Zod parsers, same `.catch()` tolerance for rows written by an
older build, same `MAX_PRESET_SKILLS_BYTES` caps. A client is a preset stripped to its reusable
parts: no soul, no archive, no questions, no role.

`spaces.client_id` sits beside `space_knowledge.space_id` rather than inside it. The two answer
different questions: `space_knowledge` is *this engagement's live wiki pages*, `client_id` is *who
the client is and how they like things done*. One Box, one client, many engagements over time.

The Confluence columns are the client's **default** space, used to prefill the Start project
wizard. `space_knowledge` still records what was actually linked, so changing a client's default
never rewrites history on existing Boxes.

RLS follows `coworker_presets`: SELECT for workspace members, writes service-role through server
actions.

### Counts

"7 coworkers across 2 Boxes" is an aggregate over `spaces` and `agents`. At 24+ clients that is a
join per render, so it goes in a view rather than a per-row query. Only cache it on the row if the
view measures slow.

## The write path

`client.service.ts`, mirroring `preset.service.ts`. One function shaped like
`applyAuthoredExtras` (`preset.service.ts:335`):

```ts
async function applyClientExtras(client, spaceId, agent, warnings: string[]): Promise<void>
```

Skills go through `importSkill(conn, engineAgentId, content, files, { slug, overwrite: true })`.
Passing an explicit `slug` is what makes this re-runnable — the hire path omits it and *creates*,
so a second call would duplicate. With it the engine swaps the whole folder atomically: the edit
lands whole or not at all.

**Namespacing makes removal possible.** Client skills get a stable derived slug
(`client-<short_code>-<skill>`) and knowledge lands under `knowledge/<short_code>/`. Without it,
"this Box is Broward now, not Miami-Dade" could not tell which files to pull, and a coworker's own
skill could collide with the client's.

Three callers, one function:

1. **Hire** into a Box with a client — after `applyAuthoredExtras`, so ordering is deterministic.
2. **Set or change a Box's client** — remove the previous client's namespaced skills and docs,
   then apply the new one. Confirmed first when the Box already has coworkers.
3. **Edit a client** — apply to every coworker in every Box pointing at it.

## Failure and sync state

`applyAuthoredExtras` never throws; it accumulates `warnings[]`. The client path keeps that, but
warnings alone are a toast you can miss.

`clients.revision` bumps on every save. Each agent records the `client_revision` that actually
landed. **"3 to sync" is the count of agents whose recorded revision trails the client's.** No
separate job table, self-healing, and an engine that was offline simply shows a gap until something
closes it:

- `Retry` on the client row closes it manually.
- Opening the Box closes it opportunistically.

A coworker that never reached its engine keeps the older skill and keeps working. It is stale, not
broken, and the staleness is visible on the row rather than lost in a dismissed toast.

## UI

Mockup: `docs/plans/2026-11-17-clients-mockup.html` (dark and light, desktop and 375px).

- **Settings → Clients**: a new `SETTINGS_PANELS` entry beside Coworkers Store, in a
  `PanelDialogContent`. A searchable, sortable table on the `Table` primitive — sticky header,
  columns Client / Code / Skills / Docs / Coworkers / Status. Search is the house pattern, a
  `SearchIcon` inset in an `Input` (`OpencodeModels.tsx:84`). Empty search results offer to create
  what was typed. Under `sm` the table drops to stacked rows; search stays pinned.
- **Status** is the shared `Badge`: `Synced`, `N to sync`, `Not in use`. The third matters at
  scale — clients attached to no Box are stale accounts or work that never started.
- **Box context menu**: one new item beside Project knowledge, carrying the current client name on
  the item so the dialog is not needed just to check.
- **Start project → Project step**: the free-text Client input (`StartProjectPage.tsx:294`) becomes
  a combobox over `clients`, still typeable, querying server-side. Picking a known client prefills
  the short code and Confluence space. Typed values are never clobbered.
- **Agent panel → Skills**: client skills read as inherited and are not editable there. Editing one
  locally would silently fork it from the client, which is the drift this design exists to prevent.
  The affordance is "Open client ›".
- Destructive steps (changing a Box's client, deleting a client in use) go through `ConfirmDialog`
  naming the affected count.

## Tests

- Pure unit tests for slug derivation: collisions, renames, a client named in non-Latin script.
- `client.service` with the engine client mocked: re-push passes `slug` and `overwrite`; a
  rejecting engine produces a warning and does not throw; changing a Box's client removes the old
  namespaced skills and only those.
- Revision-gap count against local Supabase.
- `pnpm verify:ui` over the Clients panel at every width in both themes, plus a `.context/verify/`
  scenario clicking: create a client, add a skill, attach it to a Box, edit the skill, see the
  count land.

## Explicitly not needed

**No engine data-dir migration.** Client skills are ordinary agent skills written through the
existing HTTP API, and knowledge docs are ordinary files. Nothing new lands on disk and no SQLite
schema changes, so no new step in `DATA_DIR_MIGRATIONS`, `SYSTEM_DB_MIGRATIONS` or
`SHARED_DB_MIGRATIONS`.

**Nothing in `@rerun/cloud/*`.** Clients are not a Rerun Cloud feature; a self-hosted install gets
the same behaviour, so no `cloud-oss` twin is required.

## Deleting a client in use

A client can be deleted while Boxes still point at it. The confirm names the Boxes and the number
of coworkers affected. `spaces.client_id` is `on delete set null`, so those Boxes simply lose their
client.

**The already-installed skills and knowledge stay on the coworkers.** Deleting a client is an
admin tidying a list; stripping a live engagement's coworkers of the conventions they are working
to is not what that gesture means. They keep what they have, now unmanaged, and the Box shows no
client until one is set.

This is the one place where namespaced slugs are deliberately *not* used to clean up. Removal
happens when a Box's client is **changed** — a different client is taking over — not when a client
row is deleted.

## Visibility

Clients are visible to every member of the workspace, the same rule `coworker_presets` already
uses: `SELECT` where `workspace_id` is one of mine. No per-client member list, no inheritance from
Box grants.

This was decided knowing the trade: Boxes *can* be restricted (`spaces.visibility`,
`space_members`, `boxAccessFor` in `lib/board/box-access.ts`), so a restricted Box whose client is
world-readable leaks the engagement's existence and its conventions through the Clients table.
Today no Box in the workspace is restricted, so the leak is theoretical.

**Tripwire:** the first time a Box is set to `restricted`, revisit this. The cheapest fix at that
point is deriving client visibility from the Boxes that use it, rather than giving clients their
own member list.
