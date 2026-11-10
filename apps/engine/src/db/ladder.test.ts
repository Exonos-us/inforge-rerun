import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-sqlite-ladder-'))

const { describe, expect, it } = await import('vitest')
const { createClient } = await import('@libsql/client')
const { mkdir, writeFile } = await import('node:fs/promises')
const { workspaceDir } = await import('../config/paths.js')
const { migrateSqlite, sqliteVersion } = await import('./ladder.js')
const { SYSTEM_DB_MIGRATIONS, SYSTEM_DB_VERSION, migrateSystemDb } = await import('./systemDb.js')
const { backfillPaidSources } = await import('../paid-data/backfill.js')
const { SHARED_DB_MIGRATIONS } = await import('./sharedDb.js')
const { BRAIN_DB_MIGRATIONS } = await import('./brainDb.js')

type Step = Parameters<typeof migrateSqlite>[1][number]

function freshFile(name: string) {
    return createClient({ url: `file:${resolve(process.env.RERUN_DATA_DIR!, `${name}.db`)}` })
}

function recorder(log: number[], fail?: number): Step[] {
    return [1, 2, 3].map(version => ({
        version,
        id: `step-${version}`,
        up: async () => {
            if (version === fail) throw new Error(`step ${version} failed`)
            log.push(version)
        },
    }))
}

async function columns(client: ReturnType<typeof createClient>, table: string): Promise<string[]> {
    return (await client.execute(`PRAGMA table_info('${table}')`)).rows.map(r => String(r.name))
}

describe('migrateSqlite', () => {
    it('applies every step in order and records the last one', async () => {
        const client = freshFile('order')
        const log: number[] = []
        await migrateSqlite(client, recorder(log), 'order.db')
        expect(log).toEqual([1, 2, 3])
        expect(await sqliteVersion(client)).toBe(3)
    })

    it('only applies the steps a file has not seen', async () => {
        const client = freshFile('partial')
        await client.execute('PRAGMA user_version = 2')
        const log: number[] = []
        await migrateSqlite(client, recorder(log), 'partial.db')
        expect(log).toEqual([3])
    })

    it('stops at the last step that succeeded, and finishes on the next open', async () => {
        const client = freshFile('crash')
        const log: number[] = []
        await expect(migrateSqlite(client, recorder(log, 2), 'crash.db')).rejects.toThrow('step 2 failed')
        expect(await sqliteVersion(client)).toBe(1)

        await migrateSqlite(client, recorder(log), 'crash.db')
        expect(log).toEqual([1, 2, 3])
        expect(await sqliteVersion(client)).toBe(3)
    })

    it('leaves a file migrated by a newer engine untouched', async () => {
        const client = freshFile('newer')
        await client.execute('PRAGMA user_version = 9')
        const log: number[] = []
        await migrateSqlite(client, recorder(log), 'newer.db')
        expect(log).toEqual([])
        expect(await sqliteVersion(client)).toBe(9)
    })
})

// The registries are append-only: a shipped step is never removed nor renamed, because a file
// archived before it still needs it. Updating one of these snapshots is the change to look at twice.
describe('sqlite ladders', () => {
    it.each([
        ['system.db', SYSTEM_DB_MIGRATIONS],
        ['shared.db', SHARED_DB_MIGRATIONS],
        ['brain.db', BRAIN_DB_MIGRATIONS],
    ])('%s numbers its steps from 1 without gaps', (_name, steps) => {
        expect(steps.map(s => s.version)).toEqual(steps.map((_, i) => i + 1))
        expect(new Set(steps.map(s => s.id)).size).toBe(steps.length)
    })

    it('keeps every shipped step', () => {
        expect(SYSTEM_DB_MIGRATIONS.map(s => [s.version, s.id])).toMatchInlineSnapshot(`
          [
            [
              1,
              "baseline",
            ],
            [
              2,
              "message-author",
            ],
            [
              3,
              "step-cache-cost",
            ],
            [
              4,
              "paid-sources",
            ],
            [
              5,
              "screen-secrets",
            ],
          ]
        `)
        expect(SHARED_DB_MIGRATIONS.map(s => [s.version, s.id])).toMatchInlineSnapshot(`
          [
            [
              1,
              "baseline",
            ],
          ]
        `)
        expect(BRAIN_DB_MIGRATIONS.map(s => [s.version, s.id])).toMatchInlineSnapshot(`
          [
            [
              1,
              "baseline",
            ],
            [
              2,
              "proposal-headline",
            ],
          ]
        `)
    })

    // Editing a shipped step changes what a fresh file gets and not what a file already past it has:
    // the two drift apart without an error. Pinning the schema each version produces catches it.
    it.each(SYSTEM_DB_MIGRATIONS.map(s => s.version))('system.db v%i produces the schema it shipped with', async version => {
        const client = freshFile(`schema-v${version}`)
        await migrateSqlite(
            client,
            SYSTEM_DB_MIGRATIONS.filter(s => s.version <= version),
            'schema.db'
        )
        const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%' AND name NOT LIKE '%_shadow' AND name NOT LIKE 'libsql_%' ORDER BY name")
        const schema: Record<string, string[]> = {}
        for (const row of tables.rows) schema[String(row.name)] = await columns(client, String(row.name))
        expect(schema).toMatchSnapshot()
    })
})

describe('system.db from before the ladder', () => {
    it('catches up a file missing every column added since it was created', async () => {
        const client = freshFile('v0-system')
        await SYSTEM_DB_MIGRATIONS[0].up(client)
        await client.executeMultiple(`
            ALTER TABLE sessions DROP COLUMN source;
            ALTER TABLE runs DROP COLUMN cost_micros;
            ALTER TABLE memories DROP COLUMN access_count;
            ALTER TABLE skill_proposals DROP COLUMN connection_id;
            PRAGMA user_version = 0;
        `)
        await client.execute("INSERT INTO sessions (id, agent_id, title, created_at, updated_at) VALUES ('s1', 'a1', 'schedule: daily digest', '2026-01-01', '2026-01-01')")

        await migrateSystemDb(client, 'v0-system.db')

        expect(await sqliteVersion(client)).toBe(SYSTEM_DB_VERSION)
        expect(await columns(client, 'runs')).toContain('cost_micros')
        expect(await columns(client, 'memories')).toContain('access_count')
        expect(await columns(client, 'skill_proposals')).toContain('connection_id')
        const session = await client.execute("SELECT source FROM sessions WHERE id = 's1'")
        expect(session.rows[0].source).toBe('schedule')
    })
})

describe('system.db v1 to v2', () => {
    it('adds the author of a message and leaves the messages already there unsigned', async () => {
        const client = freshFile('v1-system')
        await migrateSqlite(client, SYSTEM_DB_MIGRATIONS.slice(0, 1), 'v1-system.db')
        expect(await columns(client, 'messages')).not.toContain('author_id')
        await client.execute("INSERT INTO messages (id, session_id, role, content_json, created_at) VALUES ('m1', 's1', 'user', '\"hello\"', '2026-01-01')")

        await migrateSystemDb(client, 'v1-system.db')
        await SYSTEM_DB_MIGRATIONS[1].up(client)

        expect(await sqliteVersion(client)).toBe(SYSTEM_DB_VERSION)
        expect(await columns(client, 'messages')).toEqual(expect.arrayContaining(['author_id', 'author_name']))
        const message = await client.execute("SELECT content_json, author_id, author_name FROM messages WHERE id = 'm1'")
        expect(message.rows[0]).toMatchObject({ content_json: '"hello"', author_id: null, author_name: null })
    })
})

describe('system.db v2 to v3', () => {
    it('adds the cache writes and the cost of a step, and leaves the steps already recorded without them', async () => {
        const client = freshFile('v2-system')
        await migrateSqlite(client, SYSTEM_DB_MIGRATIONS.slice(0, 2), 'v2-system.db')
        expect(await columns(client, 'run_steps')).not.toContain('cache_write_tokens')
        await client.execute("INSERT INTO run_steps (id, run_id, agent_id, session_id, step_number, input_tokens, created_at) VALUES ('st1', 'r1', 'a1', 's1', 1, 38000, '2026-01-01')")

        await migrateSystemDb(client, 'v2-system.db')
        await SYSTEM_DB_MIGRATIONS[2].up(client)

        expect(await sqliteVersion(client)).toBe(SYSTEM_DB_VERSION)
        expect(await columns(client, 'run_steps')).toEqual(expect.arrayContaining(['cache_write_tokens', 'cost_micros']))
        const step = await client.execute("SELECT input_tokens, cache_write_tokens, cost_micros FROM run_steps WHERE id = 'st1'")
        expect(step.rows[0]).toMatchObject({ input_tokens: 38000, cache_write_tokens: null, cost_micros: null })
    })
})

describe('system.db v3 to v4', () => {
    const toolCall = (id: string, toolName: string, input: unknown, result: unknown, createdAt: string) => ({
        sql: "INSERT INTO tool_calls (id, run_id, agent_id, session_id, step_number, tool_call_id, tool_name, input_json, result_json, created_at) VALUES (?, 'r1', 'scout', 's1', 1, ?, ?, ?, ?, ?)",
        args: [id, `call-${id}`, toolName, JSON.stringify(input), JSON.stringify(result), createdAt],
    })

    it('creates the index, then a first backfill reads the paid calls already made from their result or from the answer saved in the workspace', async () => {
        const client = freshFile('v3-system')
        await migrateSqlite(client, SYSTEM_DB_MIGRATIONS.slice(0, 3), 'v3-system.db')
        const saved = '.rerun/paid-data/google.serp.maps-2026-10-20-treg-1.json'
        const workspace = workspaceDir('scout')
        await mkdir(resolve(workspace, '.rerun/paid-data'), { recursive: true })
        await writeFile(resolve(workspace, saved), JSON.stringify({ capability: 'google.serp.maps', output: { places: [{ title: 'Boulangerie Dupont', website: 'https://boulangerie-dupont.fr' }] } }))
        await client.batch([
            toolCall('1', 'mcp__rerun__paid_data', { capability: 'people.email.find', params: { full_name: 'Jane Doe' } }, { type: 'json', value: { status: 'found', servedBy: 'hunter', result: { output: { email: 'jane@acme.com' }, verification: { verdict: 'valid' } } } }, '2026-10-20T09:00:00.000Z'),
            toolCall('2', 'paid_data', { capability: 'google.serp.maps', params: { q: 'boulangerie' } }, { saved, status: 'found', outline: { output: {} } }, '2026-10-20T10:00:00.000Z'),
            toolCall('3', 'paid_data', { capability: 'people.email.find', params: { full_name: 'John Roe' } }, { status: 'nothing_found', result: { output: { email: null } } }, '2026-10-20T11:00:00.000Z'),
            toolCall('4', 'shell_exec', { command: 'echo hi@acme.com' }, { stdout: 'hi@acme.com' }, '2026-10-20T12:00:00.000Z'),
        ])

        await migrateSystemDb(client, 'v3-system.db')
        await SYSTEM_DB_MIGRATIONS[3].up(client)
        expect(await sqliteVersion(client)).toBe(SYSTEM_DB_VERSION)
        expect((await client.execute('SELECT count(*) AS n FROM paid_calls')).rows[0].n).toBe(0)

        await backfillPaidSources(client)
        const marker = await client.execute("SELECT value FROM system_meta WHERE key = 'paid_backfill'")
        expect(marker.rows).toHaveLength(1)

        // A second pass finds the marker and reads nothing: a call written since would stay out of it.
        await client.execute("DELETE FROM paid_keys WHERE key = 'n:boulangerie dupont'")
        await backfillPaidSources(client)
        expect((await client.execute("SELECT count(*) AS n FROM paid_keys WHERE key = 'n:boulangerie dupont'")).rows[0].n).toBe(0)
        await client.execute("INSERT INTO paid_keys (key, call_id, item, field) VALUES ('n:boulangerie dupont', 'call-2', 0, 'title')")
        const calls = await client.execute('SELECT call_id, capability, served_by FROM paid_calls ORDER BY call_id')
        expect(calls.rows.map(row => ({ ...row }))).toEqual([
            { call_id: 'call-1', capability: 'people.email.find', served_by: 'hunter' },
            { call_id: 'call-2', capability: 'google.serp.maps', served_by: null },
        ])
        const keys = await client.execute('SELECT key, call_id, verdict FROM paid_keys ORDER BY key')
        expect(keys.rows.map(row => ({ ...row }))).toEqual([
            { key: 'd:boulangerie-dupont.fr', call_id: 'call-2', verdict: null },
            { key: 'e:jane@acme.com', call_id: 'call-1', verdict: 'valid' },
            { key: 'n:boulangerie dupont', call_id: 'call-2', verdict: null },
        ])
    })
})

describe('brain.db v1 to v2', () => {
    it('adds the headline and the highlights of a proposal, and leaves the ones already waiting without them', async () => {
        const client = freshFile('v1-brain')
        await BRAIN_DB_MIGRATIONS[0].up(client)
        expect(await sqliteVersion(client)).toBe(0)
        expect(await columns(client, 'brain_proposals')).not.toContain('headline')
        await client.execute(
            "INSERT INTO brain_proposals (id, agent_id, agent_name, session_id, slug, mode, title, type, content, reason, sources_json, fingerprint, created_at) VALUES ('p1', 'a1', 'Sales', 's1', 'pricing', 'create', 'Pricing', 'offering', 'Starter is 49.', 'New', '[]', 'f1', '2026-01-01')"
        )

        await migrateSqlite(client, BRAIN_DB_MIGRATIONS, 'v1-brain.db')
        await BRAIN_DB_MIGRATIONS[1].up(client)

        expect(await sqliteVersion(client)).toBe(2)
        expect(await columns(client, 'brain_proposals')).toEqual(expect.arrayContaining(['headline', 'highlights_json']))
        const waiting = await client.execute("SELECT title, headline, highlights_json FROM brain_proposals WHERE id = 'p1'")
        expect(waiting.rows[0]).toMatchObject({ title: 'Pricing', headline: null, highlights_json: null })
    })
})
