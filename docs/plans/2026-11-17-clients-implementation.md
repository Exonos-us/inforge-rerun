# Clients Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A client is a workspace entity carrying skills and knowledge docs; a Box points at one, and every coworker hired into that Box inherits it.

**Architecture:** A `clients` table holding the same `AuthoredSkill[]` / `KnowledgeDoc[]` payloads a preset holds. `spaces.client_id` is the attach point. Skills reach a coworker through the engine's existing `importSkill` with an explicit `slug` and `overwrite: true`, which swaps a skill folder atomically and makes re-pushing safe. A `revision` integer on the client, compared against `agents.client_revision`, is the whole sync model.

**Tech Stack:** Next.js 16 (App Router, server actions), Supabase (Postgres + RLS), Vitest, Tailwind v4, `@rerun/ui/primitives`.

**Design doc:** `docs/plans/2026-11-17-clients-design.md` — read it first. It records what was rejected and why.

---

## Before you start

Read these, in this order. They are the patterns you will copy; do not invent new ones.

| File | Why |
|---|---|
| `apps/ui/lib/presets/types.ts` | The Zod schemas you reuse verbatim (`authoredSkillSchema`, `knowledgeDocSchema`) |
| `apps/ui/app/api/_services/preset.service.ts:335-385` | `applyAuthoredExtras` — the function `applyClientExtras` mirrors |
| `apps/ui/app/api/_actions/preset.actions.ts:1-55` | The server-action shape (`ActionResult`, try/catch, no throwing to the client) |
| `apps/ui/components/project-knowledge/ProjectKnowledgeDialog.tsx` | The Box-attached dialog this feature copies |
| `supabase/migrations/20261112150000_space_knowledge.sql` | Migration house style: RLS, revoke, grant |
| `CLAUDE.md` (repo root) | **Supabase rules are strict.** Reads go through typed helpers; writes carry an explicit payload generic. Grep your own diff for `.from('` before finishing. |

**Local stack:** `pnpm db:start`, then `pnpm dev:engine` and `pnpm dev:ui` in separate terminals. Never run any of this against production.

**Commands you will use repeatedly:**

```bash
pnpm --filter rerun test <path>      # one vitest file
pnpm --filter rerun ts-check         # typecheck apps/ui
pnpm db:reset                        # reapply every migration + seed (wipes local data)
```

---

## Task 1: The migration

**Files:**
- Create: `supabase/migrations/<timestamp>_clients.sql` (generate with `pnpm db:new clients`)
- Modify: `packages/db/src/database.types.ts` (regenerated, not hand-edited)

**Step 1: Create the migration file**

```bash
pnpm db:new clients
```

**Step 2: Write the migration**

Paste into the generated file:

```sql
-- A client is who the workspace works for, and how they like things done: the skills and
-- knowledge every coworker on that engagement should start with. A Box points at one
-- (spaces.client_id), the way it already points at a Confluence engagement (space_knowledge).
-- The payload columns hold the same shapes a preset holds, so the same parsers read both.

create table public.clients (
    id uuid primary key default gen_random_uuid(),
    workspace_id bigint not null references public.workspaces(id) on delete cascade,
    name text not null,
    short_code text not null default '',
    skills jsonb not null default '[]'::jsonb,
    knowledge jsonb not null default '[]'::jsonb,
    site_url text,
    cloud_id text,
    space_key text,
    space_name text,
    -- Bumped on every save. An agent records the revision that actually landed on its engine,
    -- so "3 to sync" is a count of agents trailing this number, not a job queue.
    revision integer not null default 1,
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index clients_workspace_idx on public.clients (workspace_id);
create index clients_workspace_name_idx on public.clients (workspace_id, name);

alter table public.spaces add column client_id uuid references public.clients(id) on delete set null;
create index spaces_client_idx on public.spaces (client_id);

alter table public.agents add column client_revision integer;

alter table public.clients enable row level security;

revoke all on table public.clients from anon, authenticated;
-- Readable by every member of the workspace, exactly as coworker_presets is. Writes go through
-- server actions on the service role.
grant select on table public.clients to authenticated;
grant all on table public.clients to service_role;

create policy "clients_select_workspace_members" on public.clients
    for select to authenticated
    using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
```

**Step 3: Apply it**

```bash
pnpm db:reset
```

Expected: every migration replays with no error, ending in the seed.

**Step 4: Regenerate the database types**

```bash
./node_modules/.bin/supabase gen types typescript --local > packages/db/src/database.types.ts
```

**Step 5: Verify the types landed**

```bash
grep -c 'clients:' packages/db/src/database.types.ts   # expect >= 1
grep -n 'client_revision' packages/db/src/database.types.ts | head -3
```

Expected: `clients` appears under `Tables`, and `client_revision` appears on `agents`.

**Step 6: Typecheck**

```bash
pnpm --filter rerun ts-check
```

Expected: no errors. (Regenerated types sometimes reorder unrelated tables — that's fine, commit it.)

**Step 7: Commit**

```bash
git add supabase/migrations packages/db/src/database.types.ts
git commit -m "feat(clients): the clients table, its Box pointer and the agent revision mark"
```

---

## Task 2: Slug derivation (pure, TDD)

Client skills need a namespaced slug so that changing a Box's client can remove exactly that client's files, and a coworker's own skill can never collide with the client's.

**Files:**
- Create: `apps/ui/lib/clients/naming.ts`
- Test: `apps/ui/lib/clients/naming.test.ts`

**Step 1: Write the failing test**

Create `apps/ui/lib/clients/naming.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { clientKnowledgeDir, clientSkillSlug, isClientSkillSlug } from './naming'

describe('clientSkillSlug', () => {
    it('namespaces a skill under its client code', () => {
        expect(clientSkillSlug('mdc', 'Document format')).toBe('client-mdc-document-format')
    })

    it('survives a client with no short code', () => {
        expect(clientSkillSlug('', 'Document format')).toBe('client-document-format')
    })

    it('collapses punctuation and case the way slugOf does', () => {
        expect(clientSkillSlug('MDC', 'Comms / tone!')).toBe('client-mdc-comms-tone')
    })

    it('keeps a name that slugs to nothing addressable', () => {
        expect(clientSkillSlug('mdc', '日本語')).toBe('client-mdc-skill')
    })
})

describe('isClientSkillSlug', () => {
    it('recognises its own slugs', () => {
        expect(isClientSkillSlug('client-mdc-doc-format', 'mdc')).toBe(true)
    })

    it('does not claim another client’s slug', () => {
        expect(isClientSkillSlug('client-bc-doc-format', 'mdc')).toBe(false)
    })

    it('does not claim a coworker’s own skill', () => {
        expect(isClientSkillSlug('permit-intake-triage', 'mdc')).toBe(false)
    })
})

describe('clientKnowledgeDir', () => {
    it('gives each client its own folder under knowledge/', () => {
        expect(clientKnowledgeDir('mdc')).toBe('knowledge/client-mdc')
    })
})
```

**Step 2: Run it and watch it fail**

```bash
pnpm --filter rerun test lib/clients/naming.test.ts
```

Expected: FAIL — `Cannot find module './naming'`.

**Step 3: Write the implementation**

Create `apps/ui/lib/clients/naming.ts`:

```ts
import { slugOf } from '@/lib/presets/naming'

// A client's skills live under a slug of their own so that changing a Box's client removes
// exactly that client's files, and a coworker's own skill can never collide with one of them.
const PREFIX = 'client'

export function clientSkillSlug(shortCode: string, skillName: string): string {
    const name = slugOf(skillName) || 'skill'
    return [PREFIX, slugOf(shortCode), name].filter(Boolean).join('-')
}

export function isClientSkillSlug(slug: string, shortCode: string): boolean {
    return slug.startsWith(`${[PREFIX, slugOf(shortCode)].filter(Boolean).join('-')}-`)
}

export function clientKnowledgeDir(shortCode: string): string {
    return `knowledge/${[PREFIX, slugOf(shortCode)].filter(Boolean).join('-')}`
}
```

**Step 4: Run the test**

```bash
pnpm --filter rerun test lib/clients/naming.test.ts
```

Expected: PASS, 8 tests.

**Step 5: Commit**

```bash
git add apps/ui/lib/clients/naming.ts apps/ui/lib/clients/naming.test.ts
git commit -m "feat(clients): namespaced slugs for a client's skills and knowledge"
```

---

## Task 3: Extract `authoredSkillMarkdown` so both services share it

`authoredSkillMarkdown` is private in `preset.service.ts:388`. The client service needs the same function. Move it rather than copy it.

**Files:**
- Create: `apps/ui/lib/presets/skill-markdown.ts`
- Modify: `apps/ui/app/api/_services/preset.service.ts`

**Step 1: Read the current function**

```bash
sed -n '386,400p' apps/ui/app/api/_services/preset.service.ts
```

**Step 2: Move it verbatim**

Create `apps/ui/lib/presets/skill-markdown.ts` containing that function, exported, with its comment, importing `AuthoredSkill` from `@/lib/presets/types`.

**Step 3: Delete it from `preset.service.ts` and import instead**

Add to the imports of `preset.service.ts`:

```ts
import { authoredSkillMarkdown } from '@/lib/presets/skill-markdown'
```

**Step 4: Verify nothing else referenced it**

```bash
grep -rn 'authoredSkillMarkdown' apps/ui | grep -v node_modules
```

Expected: the new file, its import in `preset.service.ts`, and the call site. Nothing orphaned.

**Step 5: Typecheck and run the preset tests**

```bash
pnpm --filter rerun ts-check
pnpm --filter rerun test app/api/_services/preset
```

Expected: no type errors, preset tests still green. **This is a pure move — if any test changes behaviour, you moved more than the function.**

**Step 6: Commit**

```bash
git add apps/ui/lib/presets/skill-markdown.ts apps/ui/app/api/_services/preset.service.ts
git commit -m "refactor(presets): share authoredSkillMarkdown with the client service"
```

---

## Task 4: Reading and writing clients

**Files:**
- Create: `apps/ui/app/api/_services/client.service.ts`
- Test: `apps/ui/app/api/_services/client.service.test.ts`

**CLAUDE.md rule, non-negotiable here:** every read goes through a typed helper (`selectMany`, `selectMaybeSingle`), every write carries its payload generic. No raw `.from(table).select(...)` for a read, not even an existence check.

**Step 1: Write the view type and the column list**

Create `apps/ui/app/api/_services/client.service.ts`:

```ts
import 'server-only'

import type { Database } from '@/app/api/database.types'
import { authoredSkillsFromRow, knowledgeDocsFromRow, type AuthoredSkill, type KnowledgeDoc } from '@/lib/presets/types'
import { shortCodeOf } from '@/lib/presets/naming'
import { selectMany, selectMaybeSingle } from '@/supabase/supabase-helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

const CLIENT_COLUMNS = ['id', 'name', 'short_code', 'skills', 'knowledge', 'site_url', 'cloud_id', 'space_key', 'space_name', 'revision', 'updated_at'] as const

export type ClientView = {
    id: string
    name: string
    shortCode: string
    skills: AuthoredSkill[]
    knowledgeDocs: KnowledgeDoc[]
    confluence: { siteUrl: string; cloudId: string; spaceKey: string; spaceName: string } | null
    revision: number
}

export type ClientPatch = {
    name?: string
    shortCode?: string
    skills?: AuthoredSkill[]
    knowledge?: KnowledgeDoc[]
    confluence?: { siteUrl: string; cloudId: string; spaceKey: string; spaceName: string } | null
}
```

**Step 2: Write the failing test for `listClients`**

Create `apps/ui/app/api/_services/client.service.test.ts`. Mock the Supabase helpers the way the suite already does — follow `apps/ui/app/api/_services/agent-rename.test.ts` for the shape. The first test:

```ts
it('parses a row written by an older build rather than throwing', async () => {
    const row = { id: 'c1', name: 'Miami Dade County', short_code: 'mdc', skills: 'not-an-array', knowledge: null, site_url: null, cloud_id: null, space_key: null, space_name: null, revision: 3, updated_at: '2026-11-17T00:00:00Z' }
    const [client] = toClientViews([row])
    expect(client.skills).toEqual([])
    expect(client.knowledgeDocs).toEqual([])
    expect(client.revision).toBe(3)
})
```

This is the `.catch([])` tolerance `CLAUDE.md` requires: a client written by an older build must render, not crash the panel.

**Step 3: Run it and watch it fail**

```bash
pnpm --filter rerun test app/api/_services/client.service.test.ts
```

Expected: FAIL — `toClientViews` is not exported.

**Step 4: Implement `toClientViews`, `listClients`, `getClient`**

```ts
export function toClientViews(rows: readonly Record<string, unknown>[]): ClientView[] {
    return rows.map(row => ({
        id: row.id as string,
        name: row.name as string,
        shortCode: (row.short_code as string) || '',
        skills: authoredSkillsFromRow.parse(row.skills),
        knowledgeDocs: knowledgeDocsFromRow.parse(row.knowledge),
        confluence: row.cloud_id ? { siteUrl: row.site_url as string, cloudId: row.cloud_id as string, spaceKey: row.space_key as string, spaceName: row.space_name as string } : null,
        revision: (row.revision as number) ?? 1,
    }))
}

export async function listClients(supabase: SupabaseClient<Database>, workspaceId: number): Promise<ClientView[]> {
    const { data } = await selectMany(supabase, 'clients', CLIENT_COLUMNS, { workspace_id: workspaceId })
    return toClientViews(data ?? [])
}
```

**Step 5: Run the test**

Expected: PASS.

**Step 6: Add create / update / delete**

Writes carry the generic explicitly — the verbose form, never `TablesInsert<'x'>`:

```ts
export async function createClient(supabase: SupabaseClient<Database>, workspaceId: number, userId: string, name: string): Promise<string> {
    const { data, error } = await supabase
        .from('clients')
        .insert<Database['public']['Tables']['clients']['Insert']>({ workspace_id: workspaceId, name: name.trim(), short_code: shortCodeOf(name), created_by: userId })
        .select('id')
        .single()
    if (error || !data) throw new Error(error?.message ?? 'Could not create the client')
    return data.id
}
```

`updateClient` applies the patch **and bumps `revision`** in the same statement — the revision is what the sync reads, so it must never be updated separately from the payload:

```ts
export async function updateClient(supabase: SupabaseClient<Database>, workspaceId: number, clientId: string, patch: ClientPatch, currentRevision: number): Promise<void> {
    const { error } = await supabase
        .from('clients')
        .update<Database['public']['Tables']['clients']['Update']>({
            ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
            ...(patch.shortCode !== undefined ? { short_code: patch.shortCode.trim() } : {}),
            ...(patch.skills !== undefined ? { skills: patch.skills } : {}),
            ...(patch.knowledge !== undefined ? { knowledge: patch.knowledge } : {}),
            revision: currentRevision + 1,
            updated_at: new Date().toISOString(),
        })
        .eq('id', clientId)
        .eq('workspace_id', workspaceId)
    if (error) throw new Error(error.message)
}
```

**Step 7: Add a test that the revision always moves**

```ts
it('bumps the revision on every save, so a stale coworker is always countable', async () => {
    await updateClient(supabase, 7, 'c1', { skills: [] }, 4)
    expect(captured.revision).toBe(5)
})
```

**Step 8: Run, typecheck, grep your own diff**

```bash
pnpm --filter rerun test app/api/_services/client.service.test.ts
pnpm --filter rerun ts-check
git diff --cached -U0 | grep "\.from('" || true
```

Expected: tests pass, no type errors, and **every `.from('` in your diff is a write** (insert/update/delete). Any read must use a helper.

**Step 9: Commit**

```bash
git add apps/ui/app/api/_services/client.service.ts apps/ui/app/api/_services/client.service.test.ts
git commit -m "feat(clients): read and write a client, revision bumped on every save"
```

---

## Task 5: Installing a client on a coworker

The heart of the feature. Mirrors `applyAuthoredExtras` (`preset.service.ts:335`) — **and like it, never throws.** It accumulates warnings.

**Files:**
- Modify: `apps/ui/app/api/_services/client.service.ts`
- Test: `apps/ui/app/api/_services/client-install.service.test.ts`

**Step 1: Write the failing tests**

Create `apps/ui/app/api/_services/client-install.service.test.ts`, mocking `@/lib/engine/client` as `apps/ui/app/api/v1/ai-connections/route.test.ts:1-40` does:

```ts
const importSkill = vi.fn()
const deleteSkill = vi.fn()
const writeFileText = vi.fn()
const makeDir = vi.fn()
vi.mock('@/lib/engine/client', () => ({ importSkill, deleteSkill, writeFileText, makeDir, createSkill: vi.fn() }))

describe('applyClientExtras', () => {
    it('re-pushes a skill onto its own slug so a second call replaces rather than duplicates', async () => {
        await applyClientExtras(client, 'space-1', agent, [])
        expect(importSkill).toHaveBeenCalledWith(
            expect.anything(), 'engine-agent-1', expect.any(String), [],
            { slug: 'client-mdc-doc-format', overwrite: true },
        )
    })

    it('collects a warning instead of throwing when the engine refuses', async () => {
        importSkill.mockRejectedValueOnce(new Error('engine offline'))
        const warnings: string[] = []
        await expect(applyClientExtras(client, 'space-1', agent, warnings)).resolves.toBeUndefined()
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain('doc-format')
    })

    it('writes knowledge under the client’s own folder', async () => {
        await applyClientExtras(client, 'space-1', agent, [])
        expect(writeFileText).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'knowledge/client-mdc/acronyms.md', expect.any(String))
    })
})

describe('removeClientExtras', () => {
    it('removes the client’s skills and only those', async () => {
        await removeClientExtras(client, 'space-1', agent, ['client-mdc-doc-format', 'permit-intake-triage'], [])
        expect(deleteSkill).toHaveBeenCalledTimes(1)
        expect(deleteSkill).toHaveBeenCalledWith(expect.anything(), 'engine-agent-1', 'client-mdc-doc-format')
    })
})
```

That third `removeClientExtras` test is the one that matters most. **If it ever goes green while deleting two skills, a coworker's own work is being destroyed.**

**Step 2: Run and watch them fail**

```bash
pnpm --filter rerun test app/api/_services/client-install.service.test.ts
```

Expected: FAIL — `applyClientExtras` is not exported.

**Step 3: Implement**

```ts
// Mirrors applyAuthoredExtras in preset.service.ts: it never throws, it collects warnings. A
// coworker whose engine is down keeps the skills it has and shows up as trailing the revision.
export async function applyClientExtras(client: ClientView, spaceId: string, agent: { name: string; engine_agent_id: string | null }, warnings: string[]): Promise<void> {
    if (!agent.engine_agent_id) return
    if (client.skills.length === 0 && client.knowledgeDocs.length === 0) return

    const conn = await getSpaceConnection(spaceId)
    for (const skill of client.skills.filter(s => s.name.trim())) {
        const slug = clientSkillSlug(client.shortCode, skill.name)
        const content = skill.raw || authoredSkillMarkdown(skill)
        await importSkill(conn, agent.engine_agent_id, content, skill.files, { slug, overwrite: true }).catch(() => {
            warnings.push(`"${agent.name}" did not get "${skill.name.trim()}" from ${client.name}.`)
        })
    }
    if (client.knowledgeDocs.length > 0) {
        const base = `/agents/${agent.engine_agent_id}/files`
        const dir = clientKnowledgeDir(client.shortCode)
        await makeDir(conn, base, dir).catch(() => {})
        for (const doc of client.knowledgeDocs.filter(d => d.path.trim())) {
            await writeFileText(conn, base, `${dir}/${doc.path.trim()}`, doc.content).catch(() => {
                warnings.push(`"${agent.name}" did not get the document "${doc.path.trim()}".`)
            })
        }
    }
}
```

`removeClientExtras` takes the coworker's existing slugs and deletes only those matching `isClientSkillSlug(slug, client.shortCode)`.

**Step 4: Run the tests**

Expected: PASS, 4 tests.

**Step 5: Commit**

```bash
git add apps/ui/app/api/_services/client.service.ts apps/ui/app/api/_services/client-install.service.test.ts
git commit -m "feat(clients): install and remove a client's skills on a coworker"
```

---

## Task 6: Syncing every coworker of a client

**Files:**
- Modify: `apps/ui/app/api/_services/client.service.ts`
- Test: extend `client-install.service.test.ts`

`syncClient(clientId)` finds every Box with that `client_id`, every agent in those Boxes, calls `applyClientExtras` on each, and writes `agents.client_revision = client.revision` **only for the ones that succeeded**.

**Step 1: Write the failing test**

```ts
it('marks only the coworkers whose install actually landed', async () => {
    importSkill.mockRejectedValueOnce(new Error('offline'))   // the first agent fails
    const result = await syncClient(supabase, 7, 'c1')
    expect(result.synced).toBe(1)
    expect(result.pending).toBe(1)
    expect(markedRevisions).toEqual([{ agentId: 'a2', revision: 5 }])
})
```

**Step 2: Run, watch it fail, implement, run again.**

The count the UI shows comes from the same source of truth:

```ts
export async function pendingSyncCount(supabase: SupabaseClient<Database>, workspaceId: number, clientId: string, revision: number): Promise<number>
```

— a count of agents in Boxes with this `client_id` whose `client_revision` is null or `< revision`. Use `selectCount`, not a raw query.

**Step 3: Commit**

```bash
git commit -am "feat(clients): sync every coworker of a client, counting what did not land"
```

---

## Task 7: Hiring into a Box that has a client

**Files:**
- Modify: `apps/ui/app/api/_services/preset.service.ts` (the hire path that calls `applyAuthoredExtras`)

**Step 1: Write the failing test** — hiring into a Box with `client_id` installs the client's skills *after* the preset's.

**Step 2: Implement** — after `applyAuthoredExtras(...)`, look up the Box's client and call `applyClientExtras`, then set the new agent's `client_revision`.

**Step 3: Confirm the preset tests still pass**

```bash
pnpm --filter rerun test app/api/_services/preset
```

**Step 4: Commit.**

---

## Task 8: Server actions

**Files:**
- Create: `apps/ui/app/api/_actions/client.actions.ts`

Copy the shape from `preset.actions.ts` exactly: `'use server'`, `requireWorkspaceContext()`, every function returns `ActionResult<T>`, every error is caught and returned as `{ ok: false, error }` — never thrown at the client.

Actions: `listClientsAction`, `createClientAction`, `updateClientAction` (then `syncClient`, returning the counts), `deleteClientAction`, `setBoxClientAction`, `retryClientSyncAction`.

`setBoxClientAction` is the one with teeth: it removes the previous client's extras from every coworker in the Box before applying the new client's. Guard it with `assertSpaceAccess` — only a manager of the Box may change its client.

**Commit:** `feat(clients): server actions for the clients panel and the Box pointer`

---

## Task 9: The Clients panel

**Files:**
- Modify: `apps/ui/lib/settings/panels.ts` (add `'clients'` to `SETTINGS_PANELS` and a label)
- Create: `apps/ui/components/clients/ClientsDialog.tsx`, `ClientsTable.tsx`, `ClientDetail.tsx`

Mockup: `docs/plans/2026-11-17-clients-mockup.html`, section 1 and 2. Open it next to your editor.

Non-negotiables, each from a repo skill:

- A dialog holding a list is a `PanelDialogContent`, never a bare `DialogContent` (`create-dialog`).
- Every field label goes through `Field` (`form-field-labels`).
- Every status pill is the shared `Badge` with a tone — `green` Synced, `orange` N to sync, `neutral` Not in use (`shared-badge`).
- Loading shows `SkeletonPanelRows` shaped like the table, never a centred spinner (`loading-skeletons`).
- Deleting a client and changing a Box's client both go through `ConfirmDialog` naming the count (`confirm-destructive-actions`).
- Keep each file under ~250 lines; the table, the detail and the skill editor are separate components (`split-components`).

Search is client-side over the loaded list for now; the table is sortable by Client, Skills, Docs, Coworkers.

**Responsive, checked before you call it done:** at 375px the table drops to stacked rows with the search pinned — it does not scroll sideways. At 768px and up it is a table. Check a 700px-tall viewport too: the header and footer must stay reachable with the list scrolling between them.

**Commit:** `feat(clients): the Clients panel, searchable and sortable`

---

## Task 10: The Box pointer

**Files:**
- Modify: `apps/ui/components/builder/BoardContextMenu.tsx` (add the item next to Project knowledge, around line 152)
- Create: `apps/ui/components/clients/BoxClientDialog.tsx`

The menu item carries the current client's name on its right, so the dialog is not needed just to check. It gets an icon, because every neighbour has one (`menu-item-icons`).

Setting a client on a Box that already has coworkers installs its skills on all of them — behind a `ConfirmDialog` naming the count.

**Commit:** `feat(clients): point a Box at its client from the board`

---

## Task 11: The Start project step

**Files:**
- Modify: `apps/ui/components/presets/StartProjectPage.tsx` (the Client field, line ~293)

The free-text input becomes a combobox over `clients`, **still typeable**. Picking a known client prefills the short code and the Confluence space. Typing an unknown name offers to create it.

**Do not break what is there.** `autoFilled` (line 78) exists so the wiki pick never clobbers a value someone typed. Your combobox must respect the same rule: a typed Client is never overwritten by a pick.

**Commit:** `feat(clients): pick a known client when starting a project`

---

## Task 12: Verify in the running app

Required by `CLAUDE.md` — this feature shows on screen, so tests and typecheck are not enough.

**Step 1: Full suite and typecheck**

```bash
pnpm --filter rerun test
pnpm --filter rerun ts-check
```

**Step 2: Write the scenario**

Create a scenario under `.context/verify/` clicking the whole path: create a client → add a skill → attach it to a Box → hire a coworker → edit the skill → see the sync count land.

**Step 3: Run the verifier on the local stack only**

```bash
pnpm db:start
pnpm cloud env:local
pnpm verify:ui
```

**Step 4: Look at every capture.** Both themes, every width. Fix what the change broke, run it again.

**Step 5: Confirm the engine side by hand**

```bash
curl -s -H "Authorization: Bearer $RERUN_ENGINE_API_KEY" http://localhost:3000/agents/<id>/skills
```

Expected: the client's skill present under its namespaced slug. Edit the skill in the app, re-run: **the same slug, updated content — not a second skill.** This is the one thing a mocked test cannot prove.

**Step 6: Commit**

```bash
git add .context/verify
git commit -m "test(clients): verify scenario for the client install path"
```

---

## Definition of done

- `pnpm --filter rerun test` and `pnpm --filter rerun ts-check` both green.
- `git diff` grepped for `.from('`: every hit is a write carrying its payload generic.
- `pnpm verify:ui` captures reviewed at every width, both themes, no console errors.
- Editing a client twice leaves **one** skill on the engine, not two.
- Changing a Box's client removes the old client's skills and leaves the coworker's own untouched.
- No new step in `DATA_DIR_MIGRATIONS` — if you found yourself needing one, stop: something is writing engine state outside the HTTP API, and the design says nothing should.
