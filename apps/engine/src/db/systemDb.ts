import { mkdirSync, existsSync } from 'node:fs'
import { createClient, type Client } from '@libsql/client'
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql'
import { agentDataDir, systemDbPath } from '../config/paths.js'
import { sessions, messages, runs, runSteps, toolCalls, compactionCheckpoints, skillProposals, screenSecrets } from './schema.js'
import { latestVersion, migrateSqlite, type SqliteMigration } from './ladder.js'
import { scheduleBackfillPaidSources } from '../paid-data/backfill.js'

const schema = { sessions, messages, runs, runSteps, toolCalls, compactionCheckpoints, skillProposals, screenSecrets }

export type SystemDb = { client: Client; db: LibSQLDatabase<typeof schema> }

const SYSTEM_DDL = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'Untitled',
    status TEXT NOT NULL DEFAULT 'open',
    source TEXT NOT NULL DEFAULT 'dashboard',
    origin_agent_id TEXT,
    origin_session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_agent_idx ON sessions(agent_id);
CREATE INDEX IF NOT EXISTS sessions_origin_agent_idx ON sessions(origin_agent_id);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    tool_calls_json TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, message_id UNINDEXED);

CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding F32_BLOB(1536),
    kind TEXT NOT NULL DEFAULT 'note',
    created_at TEXT NOT NULL,
    last_accessed_at TEXT,
    access_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS memories_agent_idx ON memories(agent_id);
CREATE INDEX IF NOT EXISTS memories_vec_idx ON memories(libsql_vector_idx(embedding));

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, memory_id UNINDEXED);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    step_count INTEGER NOT NULL DEFAULT 0,
    usage_json TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error TEXT
);
CREATE INDEX IF NOT EXISTS runs_agent_idx ON runs(agent_id);
CREATE INDEX IF NOT EXISTS runs_agent_started_idx ON runs(agent_id, started_at);
CREATE INDEX IF NOT EXISTS runs_session_started_idx ON runs(session_id, started_at);

CREATE TABLE IF NOT EXISTS run_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    step_number INTEGER NOT NULL,
    provider TEXT,
    model TEXT,
    finish_reason TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_input_tokens INTEGER,
    reasoning_tokens INTEGER,
    total_tokens INTEGER,
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    text_length INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_steps_run_idx ON run_steps(run_id);

CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    step_number INTEGER NOT NULL,
    tool_call_id TEXT,
    tool_name TEXT NOT NULL,
    input_json TEXT,
    result_json TEXT,
    is_error INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_run_idx ON tool_calls(run_id);
CREATE INDEX IF NOT EXISTS tool_calls_name_idx ON tool_calls(tool_name);

CREATE TABLE IF NOT EXISTS compaction_checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    through_message_id TEXT NOT NULL,
    through_created_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS compaction_checkpoints_session_idx ON compaction_checkpoints(session_id);

CREATE TABLE IF NOT EXISTS skill_proposals (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    run_id TEXT,
    tool_call_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    slug TEXT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    instructions_json TEXT NOT NULL,
    fingerprints_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed',
    applied_slug TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT,
    connection_id TEXT,
    provider TEXT,
    model TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS skill_proposals_tool_call_idx ON skill_proposals(tool_call_id);
CREATE INDEX IF NOT EXISTS skill_proposals_session_idx ON skill_proposals(session_id);
CREATE INDEX IF NOT EXISTS skill_proposals_agent_idx ON skill_proposals(agent_id);
`

const pool = new Map<string, SystemDb>()
const opening = new Map<string, Promise<SystemDb>>()

async function ensureSessionSourceColumn(client: Client): Promise<void> {
    const info = await client.execute("PRAGMA table_info('sessions')")
    const hasSource = info.rows.some(row => row.name === 'source')
    if (hasSource) return
    await client.execute("ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'dashboard'")
    await client.executeMultiple(`
        UPDATE sessions SET source = 'schedule' WHERE source = 'dashboard' AND title LIKE 'schedule: %';
        UPDATE sessions SET source = 'delegate' WHERE source = 'dashboard' AND title LIKE 'delegated: %';
        UPDATE sessions SET source = 'agent' WHERE source = 'dashboard' AND title LIKE 'from %';
    `)
}

async function ensureColumns(client: Client, table: string, columns: string[]): Promise<void> {
    const info = await client.execute(`PRAGMA table_info('${table}')`)
    const existing = new Set(info.rows.map(row => row.name))
    for (const column of columns) {
        const name = column.split(' ')[0]
        if (existing.has(name)) continue
        await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column}`)
    }
}

const RUN_TELEMETRY_COLUMNS = [
    'provider TEXT',
    'model TEXT',
    'trigger_source TEXT',
    'trigger_slug TEXT',
    'cost_micros INTEGER',
    'input_tokens INTEGER',
    'output_tokens INTEGER',
    'cached_input_tokens INTEGER',
    'reasoning_tokens INTEGER',
    'total_tokens INTEGER',
]

const MEMORY_DECAY_COLUMNS = ['last_accessed_at TEXT', 'access_count INTEGER NOT NULL DEFAULT 0']

// The pair the proposing conversation ran on, so the writing job bills the same subscription.
const SKILL_PROPOSAL_MODEL_COLUMNS = ['connection_id TEXT', 'provider TEXT', 'model TEXT']

const MESSAGE_AUTHOR_COLUMNS = ['author_id TEXT', 'author_name TEXT']

// What a step wrote into the prompt cache and what it cost: the two numbers that tell whether a
// turn reused the one before it, which the run row cannot say.
const RUN_STEP_CACHE_COST_COLUMNS = ['cache_write_tokens INTEGER', 'cost_micros INTEGER']

// Every paid data call indexed by the values it returned, so a table cell can be traced back to the
// call it came from. `fields_json` keeps the item's fields and the link to show for it. `system_meta`
// holds the one-off markers of the file, such as the end of the paid calls backfill.
const PAID_SOURCES_DDL = `
CREATE TABLE IF NOT EXISTS system_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS paid_calls (
    call_id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    capability TEXT NOT NULL,
    served_by TEXT
);
CREATE TABLE IF NOT EXISTS paid_items (
    call_id TEXT NOT NULL,
    item INTEGER NOT NULL,
    fields_json TEXT NOT NULL,
    PRIMARY KEY (call_id, item)
);
CREATE TABLE IF NOT EXISTS paid_keys (
    key TEXT NOT NULL,
    call_id TEXT NOT NULL,
    item INTEGER NOT NULL,
    field TEXT NOT NULL,
    verdict TEXT,
    PRIMARY KEY (key, call_id, item, field)
);
`

const SCREEN_SECRETS_DDL = `
CREATE TABLE IF NOT EXISTS screen_secrets (
    key TEXT PRIMARY KEY,
    site TEXT NOT NULL,
    approved_always INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
`

// A schema change is a new step at the end, never an edit to a shipped one: see `db/ladder.ts`.
export const SYSTEM_DB_MIGRATIONS: SqliteMigration[] = [
    {
        version: 1,
        id: 'baseline',
        up: async client => {
            await client.executeMultiple(SYSTEM_DDL)
            await ensureSessionSourceColumn(client)
            await ensureColumns(client, 'runs', RUN_TELEMETRY_COLUMNS)
            await ensureColumns(client, 'memories', MEMORY_DECAY_COLUMNS)
            await ensureColumns(client, 'skill_proposals', SKILL_PROPOSAL_MODEL_COLUMNS)
        },
    },
    {
        version: 2,
        id: 'message-author',
        up: async client => {
            await ensureColumns(client, 'messages', MESSAGE_AUTHOR_COLUMNS)
        },
    },
    {
        version: 3,
        id: 'step-cache-cost',
        up: async client => {
            await ensureColumns(client, 'run_steps', RUN_STEP_CACHE_COST_COLUMNS)
        },
    },
    {
        version: 4,
        id: 'paid-sources',
        up: async client => {
            await client.executeMultiple(PAID_SOURCES_DDL)
        },
    },
    {
        // The site each screen secret signs in to and whether the user pre-authorized typing it
        // there. The values themselves stay in the agent's .env; a data-dir restored from before
        // this step simply has no screen secrets yet.
        version: 5,
        id: 'screen-secrets',
        up: async client => {
            await client.executeMultiple(SCREEN_SECRETS_DDL)
        },
    },
]

export const SYSTEM_DB_VERSION = latestVersion(SYSTEM_DB_MIGRATIONS)

export async function migrateSystemDb(client: Client, file: string): Promise<void> {
    await migrateSqlite(client, SYSTEM_DB_MIGRATIONS, file)
}

async function open(id: string): Promise<SystemDb> {
    mkdirSync(agentDataDir(id), { recursive: true })
    const client = createClient({ url: `file:${systemDbPath(id)}` })
    await migrateSystemDb(client, systemDbPath(id))
    const entry: SystemDb = { client, db: drizzle(client, { schema }) }
    pool.set(id, entry)
    scheduleBackfillPaidSources(client, id)
    return entry
}

export async function getSystemDb(id: string): Promise<SystemDb> {
    const cached = pool.get(id)
    if (cached) return cached
    const inflight = opening.get(id)
    if (inflight) return inflight
    const promise = open(id).finally(() => opening.delete(id))
    opening.set(id, promise)
    return promise
}

export function systemDbExists(id: string): boolean {
    return existsSync(systemDbPath(id))
}

export function closeSystemDb(id: string): void {
    const entry = pool.get(id)
    if (!entry) return
    pool.delete(id)
    try {
        entry.client.close()
    } catch {}
}
