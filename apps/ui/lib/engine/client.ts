import {
    ENGINE_CAPABILITY_DESKTOP,
    ENGINE_CAPABILITY_OPENCODE,
    ENGINE_CAPABILITY_CUSTOM,
    customProbeResultSchema,
    desktopStatusSchema,
    type CustomProbeInput,
    type CustomProbeResult,
    takeoverResultSchema,
    type DesktopApp,
    type DesktopStatus,
    type TakeoverResult,
    ENGINE_CAPABILITY_FILES_STREAM,
    ENGINE_CAPABILITY_FOREMAN_FILES,
    ENGINE_CAPABILITY_SCHEDULE_RENAME,
    engineDbGroupsSchema,
    engineRowUpdateResultSchema,
    engineTableViewSchema,
    engineTableViewsSchema,
    tableSourcesResultSchema,
    type EngineDbGroup,
    type TableSourcesRequest,
    type TableSourcesResult,
    type RowFilter,
    type TableView,
    type TableViewInput,
    agentArchivePlanSchema,
    agentDuplicateResultSchema,
    agentImportResultSchema,
    type AgentArchivePlan,
    type BoxPlan,
    type AgentDuplicateResult,
    type AgentImportResult,
    type ForemanBrief,
    type MessageAuthor,
    brainPageResponseSchema,
    brainPagesListSchema,
    brainProposalCountSchema,
    brainProposalResponseSchema,
    brainProposalsListSchema,
    brainRevisionContentSchema,
    brainSeedResultSchema,
    type BrainPage,
    type BrainPageSummary,
    type BrainPageWrite,
    type BrainProposal,
    type BrainProposalAccept,
    type BrainProposalStatus,
    type BrainRevision,
    type BrainSeedPage,
    type BrainSeedResult,
} from '@rerun/contracts'
import { isNetworkFailure } from '@/lib/net/network-error'
import {
    type EngineAgentConfigPatch,
    type EngineMcpServer,
    type EngineAgentDetail,
    type EngineConnection,
    type BoxConnection,
    type BoxConnectionsList,
    type BoxConnectionUsage,
    type BoxDefault,
    type CreateBoxConnectionInput,
    type UpdateBoxConnectionInput,
    type EngineFileContent,
    type EngineFileEntry,
    type EngineMemory,
    type EngineMessage,
    type EngineProvider,
    type EngineRun,
    type EngineRunDetail,
    type EngineRunStep,
    type EngineToolCall,
    type EngineSchedule,
    type EngineTrigger,
    type EngineTriggerMethod,
    type EngineSession,
    type SessionSource,
    type EngineSkill,
    type EngineSkillSummary,
    type EngineSkillFilePayload,
    type EngineSkillProposal,
    type EngineToolFamily,
    type EngineHealth,
    type EngineUpdateResult,
    type EngineDbTable,
    type EngineDbRows,
    type EngineUsageBucket,
    type EngineStatsPoint,
    type EngineStatsQuery,
    engineStatsResponseSchema,
    engineUsageSchema,
    engineHealthSchema,
    engineDoctorSchema,
    type EngineDoctor,
    engineUploadResultSchema,
    engineUpdateResultSchema,
    engineDbTablesListSchema,
    engineDbRowsSchema,
    engineDeleteRowsResultSchema,
    dbQueryResultSchema,
    dbExecuteResultSchema,
    type DbQueryInput,
    type DbQueryResult,
    type DbExecuteInput,
    type DbExecuteResult,
    engineAgentDetailSchema,
    engineActivatedAutomationsSchema,
    engineAgentKeysListSchema,
    boxConnectionSchema,
    boxConnectionsListSchema,
    connectionUsageSchema,
    deleteConnectionResultSchema,
    engineToolsListSchema,
    engineMcpServerStatusListSchema,
    type EngineMcpServerStatus,
    engineFileContentSchema,
    engineFileEntriesListSchema,
    engineMemoriesListSchema,
    engineMessagesListSchema,
    engineRunDetailSchema,
    engineRunsListSchema,
    engineRunStepsListSchema,
    engineToolCallsListSchema,
    engineScheduleSchema,
    engineSchedulesListSchema,
    engineTriggerSchema,
    engineTriggersListSchema,
    engineSessionSchema,
    engineSessionsListSchema,
    engineSkillSchema,
    engineSkillsListSchema,
    engineSkillSummariesListSchema,
    engineSkillProposalSchema,
    engineSkillProposalsListSchema,
} from './types'

const CHAT_TIMEOUT_MS = Number(process.env.ENGINE_CHAT_TIMEOUT_MS) || 60 * 60 * 1000

// A stopped/unreachable engine makes fetch hang on TCP connect for minutes. Next.js runs Server
// Actions sequentially, so one hanging engine call blocks every later action (Restart included).
// Fail fast unless the caller opts into a longer timeout via its own signal (chat, update).
const DEFAULT_TIMEOUT_MS = 10_000

// Staging and gzipping a whole agent folder is well past the fail-fast budget.
const ARCHIVE_TIMEOUT_MS = 5 * 60 * 1000

function buildHeaders(conn: EngineConnection): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (conn.apiKey) h['Authorization'] = `Bearer ${conn.apiKey}`
    return h
}

// Carries the status so a caller can tell "this box predates the route" (404) or "someone saved
// first" (409) from a real failure, without parsing the message.
export class EngineRequestError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message)
        this.name = 'EngineRequestError'
    }
}

// The box did not answer at all (restarting, off the network, too slow). Its message is shown as is
// by every action that surfaces an engine error, so it is written for the person, not for the logs.
export class EngineUnreachableError extends Error {
    constructor(cause: unknown) {
        super("Couldn't reach your workspace's machine. It may be restarting, try again in a moment.", { cause })
        this.name = 'EngineUnreachableError'
    }
}

async function fetchEngine(url: string, init: RequestInit): Promise<Response> {
    try {
        return await fetch(url, init)
    } catch (err) {
        if (isNetworkFailure(err)) throw new EngineUnreachableError(err)
        throw err
    }
}

export async function request<T>(conn: EngineConnection, path: string, init: RequestInit, parse: (data: unknown) => T): Promise<T> {
    const signal = init.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    const res = await fetchEngine(`${conn.baseUrl}${path}`, { ...init, signal, headers: { ...buildHeaders(conn), ...(init.headers ?? {}) } })
    if (!res.ok) {
        const body = await res.text().catch(() => 'Unknown error')
        throw new EngineRequestError(`rerun-engine ${init.method ?? 'GET'} ${path} failed: ${res.status} ${body}`, res.status)
    }
    if (res.status === 204) return parse(null)
    const text = await res.text()
    return parse(text ? JSON.parse(text) : null)
}

// --- Box connections ---
// The AI provider credentials a box holds. Values are never returned by any of these: the engine
// answers with key names and a `connected` flag, so a credential only ever travels inbound.

export async function listConnections(conn: EngineConnection, init: RequestInit = {}): Promise<BoxConnectionsList> {
    return request(conn, '/connections', { ...init, method: 'GET' }, d => boxConnectionsListSchema.parse(d))
}

// The pair every agent that picked no model of its own runs on. `null` clears it.
export async function setBoxDefault(conn: EngineConnection, pick: BoxDefault | null): Promise<void> {
    if (!pick) {
        await request(conn, '/connections/default', { method: 'DELETE' }, () => undefined)
        return
    }
    await request(conn, '/connections/default', { method: 'PUT', body: JSON.stringify(pick) }, () => undefined)
}

// Whether the box runs premium models as asked or steps them down. An engine older than plans
// answers 404, which leaves it running everything as it always has.
export async function setBoxPlan(conn: EngineConnection, plan: BoxPlan): Promise<void> {
    await request(conn, '/plan', { method: 'PUT', body: JSON.stringify(plan) }, () => undefined)
}

export async function createConnection(conn: EngineConnection, params: CreateBoxConnectionInput): Promise<BoxConnection> {
    return request(conn, '/connections', { method: 'POST', body: JSON.stringify(params) }, d => boxConnectionSchema.parse(d))
}

// A custom endpoint's new address is read for its models before the engine answers, 10 s at worst.
const PATCH_CONNECTION_TIMEOUT_MS = 20_000

export async function patchConnection(conn: EngineConnection, id: string, patch: UpdateBoxConnectionInput): Promise<BoxConnection> {
    return request(conn, `/connections/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch), signal: AbortSignal.timeout(PATCH_CONNECTION_TIMEOUT_MS) }, d => boxConnectionSchema.parse(d))
}

// The probe tries the address as typed and, for a loopback one, the Docker host after it; asking a
// model for one token on a slow local server can take a while on top.
const PROBE_TIMEOUT_MS = 75_000

export async function probeCustomEndpoint(conn: EngineConnection, input: CustomProbeInput): Promise<CustomProbeResult> {
    return request(conn, '/connections/probe', { method: 'POST', body: JSON.stringify(input), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }, d => customProbeResultSchema.parse(d))
}

export async function updateConnectionKeys(conn: EngineConnection, id: string, body: { set?: Record<string, string>; remove?: string[] }): Promise<string[]> {
    return request(conn, `/connections/${encodeURIComponent(id)}/keys`, { method: 'PATCH', body: JSON.stringify(body) }, d => engineAgentKeysListSchema.parse(d).keys)
}

export async function getConnectionUsage(conn: EngineConnection, id: string): Promise<BoxConnectionUsage> {
    return request(conn, `/connections/${encodeURIComponent(id)}/usage`, { method: 'GET' }, d => connectionUsageSchema.parse(d))
}

// Answers with what the delete released rather than a bare 204: agents and automations that named
// this connection are back on the Box default, and the UI is the only place that can say so.
export async function deleteConnection(conn: EngineConnection, id: string): Promise<BoxConnectionUsage> {
    return request(conn, `/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }, d => deleteConnectionResultSchema.parse(d).released)
}

// --- Agents ---

// The config is a patch, not a full set: the engine parses it with agentConfigSchema.partial(),
// so a partial tools / selfImprovement is completed from the engine's own defaults. That is what
// lets a template say "shell off" without freezing today's value of every other flag.
export async function createAgent(conn: EngineConnection, params: { config: EngineAgentConfigPatch & { name: string }; soul?: string; install?: string; keys?: Record<string, string> }): Promise<EngineAgentDetail> {
    return request(conn, '/agents', { method: 'POST', body: JSON.stringify(params) }, d => engineAgentDetailSchema.parse(d))
}

export async function getAgent(conn: EngineConnection, id: string): Promise<EngineAgentDetail> {
    return request(conn, `/agents/${encodeURIComponent(id)}`, { method: 'GET' }, d => engineAgentDetailSchema.parse(d))
}

// API variables / secrets are stored in the agent's .env on the engine. Only key
// names are ever returned (values stay server-side); updates merge set/remove.
// `engineKeys` are the RERUN_* names the engine resolves from its own process env;
// engines predating the field simply omit it.
export async function getAgentKeys(conn: EngineConnection, id: string): Promise<{ keys: string[]; engineKeys: string[] }> {
    return request(conn, `/agents/${encodeURIComponent(id)}/keys`, { method: 'GET' }, d => {
        const parsed = engineAgentKeysListSchema.parse(d)
        return { keys: parsed.keys, engineKeys: parsed.engineKeys ?? [] }
    })
}

export async function updateAgentKeys(conn: EngineConnection, id: string, body: { set?: Record<string, string>; remove?: string[] }): Promise<string[]> {
    return request(conn, `/agents/${encodeURIComponent(id)}/keys`, { method: 'PATCH', body: JSON.stringify(body) }, d => engineAgentKeysListSchema.parse(d).keys)
}

export async function patchAgent(conn: EngineConnection, id: string, patch: EngineAgentConfigPatch & { soul?: string; install?: string }): Promise<EngineAgentDetail> {
    return request(conn, `/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }, d => engineAgentDetailSchema.parse(d))
}

// Switches on the schedules and webhooks a captured agent arrived with. The engine does it by
// itself when an agent needs no setup, and when the agent closes its own install: this is the host
// side of the same thing, for an install the user skipped.
export async function activateAgentAutomations(conn: EngineConnection, id: string): Promise<{ schedules: string[]; triggers: string[] }> {
    return request(conn, `/agents/${encodeURIComponent(id)}/automations/activate`, { method: 'POST' }, d => engineActivatedAutomationsSchema.parse(d))
}

// mcpServers are edited via deltas so concurrent installs/edits never clobber each other:
// the engine does the read-merge-write atomically under a per-agent lock.
export async function patchMcpServers(conn: EngineConnection, id: string, body: { upsert?: EngineMcpServer[]; remove?: string[] }): Promise<EngineAgentDetail> {
    return request(conn, `/agents/${encodeURIComponent(id)}/mcp-servers`, { method: 'PATCH', body: JSON.stringify(body) }, d => engineAgentDetailSchema.parse(d))
}

// OAuth token bundle for an mcp server, stored in the engine token store (never in
// Supabase). The engine injects it as a bearer at connect time and refreshes it via the
// stored tokenEndpoint/clientId.
export type McpTokenBundle = {
    accessToken: string
    refreshToken?: string
    expiresAt?: number
    scope?: string
    tokenEndpoint?: string
    clientId?: string
    clientSecret?: string
    obtainedAt?: number
}

export async function putMcpToken(conn: EngineConnection, agentId: string, serverName: string, token: McpTokenBundle): Promise<void> {
    await request(conn, `/agents/${encodeURIComponent(agentId)}/mcp/${encodeURIComponent(serverName)}/token`, { method: 'PUT', body: JSON.stringify(token) }, () => null)
}

export async function deleteMcpToken(conn: EngineConnection, agentId: string, serverName: string): Promise<void> {
    await request(conn, `/agents/${encodeURIComponent(agentId)}/mcp/${encodeURIComponent(serverName)}/token`, { method: 'DELETE' }, () => null)
}

// Each server is dialed for real, so this runs to the engine's own probe deadline plus margin. Null
// from an engine that predates the route: the caller has no status to show, not an error.
export async function getMcpServerStatuses(conn: EngineConnection, agentId: string, names: string[]): Promise<EngineMcpServerStatus[] | null> {
    const query = new URLSearchParams(names.map(name => ['name', name])).toString()
    try {
        return await request(conn, `/agents/${encodeURIComponent(agentId)}/mcp-servers/status?${query}`, { method: 'GET', signal: AbortSignal.timeout(20_000) }, d => engineMcpServerStatusListSchema.parse(d).servers)
    } catch (e) {
        if (e instanceof EngineRequestError && e.status === 404) return null
        throw e
    }
}

// Per-agent tool catalog: families with descriptions, enabled state, and the
// individual tools each family exposes. Drives the tools panel.
export async function listAgentTools(conn: EngineConnection, agentId: string): Promise<EngineToolFamily[]> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/tools`, { method: 'GET' }, d => engineToolsListSchema.parse(d).families)
}

// A SQLite database the engine exposes: table list with columns, a paginated window of one
// table's rows, and raw SQL. The engine refuses a write on /query, so the read path can't
// be turned into a write by a crafted statement. `base` picks which database is addressed,
// exactly like the files router: an agent's private one, or the one shared by the whole Box.
export const agentDataBase = (agentId: string) => `/agents/${encodeURIComponent(agentId)}/data`

export const agentFilesBase = (agentId: string) => `/agents/${encodeURIComponent(agentId)}/files`
export const SPACE_DATA_BASE = '/shared/data'

export async function listDbTables(conn: EngineConnection, base: string): Promise<EngineDbTable[]> {
    return request(conn, `${base}/tables`, { method: 'GET' }, d => engineDbTablesListSchema.parse(d).tables)
}

export async function queryDb(conn: EngineConnection, base: string, params: DbQueryInput): Promise<DbQueryResult> {
    return request(conn, `${base}/query`, { method: 'POST', body: JSON.stringify(params) }, d => dbQueryResultSchema.parse(d))
}

export async function executeDb(conn: EngineConnection, base: string, params: DbExecuteInput): Promise<DbExecuteResult> {
    return request(conn, `${base}/execute`, { method: 'POST', body: JSON.stringify(params) }, d => dbExecuteResultSchema.parse(d))
}

export type ReadDbTableRowsParams = { limit: number; offset: number; sort?: string; dir?: 'asc' | 'desc'; q?: string; columns?: string[]; where?: RowFilter[] }

export async function readDbTableRows(conn: EngineConnection, base: string, table: string, params: ReadDbTableRowsParams): Promise<EngineDbRows> {
    const qs = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) })
    if (params.sort) qs.set('sort', params.sort)
    if (params.dir) qs.set('dir', params.dir)
    if (params.q) qs.set('q', params.q)
    if (params.columns && params.columns.length > 0) qs.set('columns', params.columns.join(','))
    if (params.where && params.where.length > 0) qs.set('where', JSON.stringify(params.where))
    return request(conn, `${base}/tables/${encodeURIComponent(table)}/rows?${qs.toString()}`, { method: 'GET' }, d => engineDbRowsSchema.parse(d))
}

export type ReadDbTableGroupsParams = { groupBy: string; sum?: string; q?: string; where?: RowFilter[] }

export async function readDbTableGroups(conn: EngineConnection, base: string, table: string, params: ReadDbTableGroupsParams): Promise<EngineDbGroup[]> {
    const qs = new URLSearchParams({ groupBy: params.groupBy })
    if (params.sum) qs.set('sum', params.sum)
    if (params.q) qs.set('q', params.q)
    if (params.where && params.where.length > 0) qs.set('where', JSON.stringify(params.where))
    return request(conn, `${base}/tables/${encodeURIComponent(table)}/groups?${qs.toString()}`, { method: 'GET' }, d => engineDbGroupsSchema.parse(d).groups)
}

export async function updateDbTableRow(conn: EngineConnection, base: string, table: string, rowid: number | string, values: Record<string, string | number | boolean | null>): Promise<Record<string, unknown>> {
    const path = `${base}/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(String(rowid))}`
    return request(conn, path, { method: 'PATCH', body: JSON.stringify({ values }) }, d => engineRowUpdateResultSchema.parse(d).row)
}

// Where each row's paid data came from. The engine matches the values themselves, so the table the
// rows were read from does not travel.
export async function readTableSources(conn: EngineConnection, base: string, rows: TableSourcesRequest['rows']): Promise<TableSourcesResult> {
    return request(conn, `${base}/sources`, { method: 'POST', body: JSON.stringify({ rows }) }, d => tableSourcesResultSchema.parse(d))
}

// A view is how the app draws a table: a layout over chosen columns, shared by everyone who opens
// it and by the agent, which saves its own through a tool.
export async function listTableViews(conn: EngineConnection, base: string, table: string): Promise<TableView[]> {
    return request(conn, `${base}/tables/${encodeURIComponent(table)}/views`, { method: 'GET' }, d => engineTableViewsSchema.parse(d).views)
}

export async function saveTableView(conn: EngineConnection, base: string, table: string, input: TableViewInput, id?: string): Promise<TableView> {
    const path = `${base}/tables/${encodeURIComponent(table)}/views${id ? `/${encodeURIComponent(id)}` : ''}`
    return request(conn, path, { method: id ? 'PUT' : 'POST', body: JSON.stringify(input) }, d => engineTableViewSchema.parse(d).view)
}

export async function deleteTableView(conn: EngineConnection, base: string, table: string, id: string): Promise<void> {
    await request(conn, `${base}/tables/${encodeURIComponent(table)}/views/${encodeURIComponent(id)}`, { method: 'DELETE' }, () => null)
}

export type ExportDbTableParams = { format: 'csv' | 'json'; sort?: string; dir?: 'asc' | 'desc'; q?: string; where?: RowFilter[] }

export async function exportDbTable(conn: EngineConnection, base: string, table: string, params: ExportDbTableParams): Promise<Response> {
    const qs = new URLSearchParams({ format: params.format })
    if (params.sort) qs.set('sort', params.sort)
    if (params.dir) qs.set('dir', params.dir)
    if (params.q) qs.set('q', params.q)
    if (params.where && params.where.length > 0) qs.set('where', JSON.stringify(params.where))
    const headers: Record<string, string> = {}
    if (conn.apiKey) headers['Authorization'] = `Bearer ${conn.apiKey}`
    return fetchEngine(`${conn.baseUrl}${base}/tables/${encodeURIComponent(table)}/export?${qs.toString()}`, { method: 'GET', headers })
}

export async function deleteDbTableRows(conn: EngineConnection, base: string, table: string, rowids: (number | string)[]): Promise<{ deleted: number }> {
    return request(conn, `${base}/tables/${encodeURIComponent(table)}/rows`, { method: 'DELETE', body: JSON.stringify({ rowids }) }, d => engineDeleteRowsResultSchema.parse(d))
}

export async function dropDbTable(conn: EngineConnection, base: string, table: string): Promise<void> {
    await request(conn, `${base}/tables/${encodeURIComponent(table)}`, { method: 'DELETE' }, () => null)
}

export async function purgeDbTable(conn: EngineConnection, base: string, table: string): Promise<{ deleted: number }> {
    return request(conn, `${base}/tables/${encodeURIComponent(table)}/purge`, { method: 'POST' }, d => engineDeleteRowsResultSchema.parse(d))
}

// --- Archive ---

// A template captures the agent's folder rather than re-describing it. The plan is what the
// folder looks like before it is tarred: it drives the admin's security review and the
// editorial projection, so nothing here ever has to open the archive.
function excludeQuery(exclude: string[]): string {
    const qs = new URLSearchParams()
    for (const path of exclude) qs.append('exclude', path)
    const query = qs.toString()
    return query ? `?${query}` : ''
}

export async function planAgentArchive(conn: EngineConnection, agentId: string, exclude: string[] = []): Promise<AgentArchivePlan> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/archive/plan${excludeQuery(exclude)}`, { method: 'GET', signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS) }, d => agentArchivePlanSchema.parse(d))
}

// Streamed rather than parsed: the caller pipes it straight into private storage.
export async function fetchAgentArchive(conn: EngineConnection, agentId: string, exclude: string[] = []): Promise<Response> {
    const headers: Record<string, string> = {}
    if (conn.apiKey) headers['Authorization'] = `Bearer ${conn.apiKey}`
    return fetchEngine(`${conn.baseUrl}/agents/${encodeURIComponent(agentId)}/archive${excludeQuery(exclude)}`, { method: 'GET', headers, signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS) })
}

// The tarball is the body rather than a multipart field, so it travels from private storage to
// the engine without being copied into a form. The engine allocates the id and answers with what
// the copy is missing: `.env` keys to fill in and MCP servers to re-authorize.
export async function importAgentArchive(conn: EngineConnection, archive: Blob, name: string, displayName: string): Promise<AgentImportResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/gzip' }
    if (conn.apiKey) headers['Authorization'] = `Bearer ${conn.apiKey}`
    const query = new URLSearchParams({ name, displayName })
    const res = await fetchEngine(`${conn.baseUrl}/agents/import?${query}`, { method: 'POST', headers, body: archive, signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`rerun-engine POST /agents/import failed: ${res.status} ${await res.text().catch(() => 'Unknown error')}`)
    return agentImportResultSchema.parse(await res.json())
}

// A copy of an agent onto the box it already lives on. Nothing is packed or uploaded: the source
// folder never leaves the engine, so the copy keeps its keys, its connectors and the model it was
// pinned to, none of which survive the archive round trip an import goes through.
export async function duplicateAgent(conn: EngineConnection, id: string, params: { name: string; displayName?: string }): Promise<AgentDuplicateResult> {
    return request(conn, `/agents/${encodeURIComponent(id)}/duplicate`, { method: 'POST', body: JSON.stringify(params), signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS) }, d => agentDuplicateResultSchema.parse(d))
}

export async function deleteAgent(conn: EngineConnection, id: string): Promise<void> {
    const res = await fetchEngine(`${conn.baseUrl}/agents/${encodeURIComponent(id)}`, { method: 'DELETE', headers: buildHeaders(conn) })
    if (!res.ok && res.status !== 404) {
        const body = await res.text().catch(() => 'Unknown error')
        throw new Error(`rerun-engine DELETE /agents/${id} failed: ${res.status} ${body}`)
    }
}

// --- Sessions ---

export async function listSessions(conn: EngineConnection, agentId: string): Promise<EngineSession[]> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/sessions`, { method: 'GET' }, d => engineSessionsListSchema.parse(d).sessions)
}

// Null when the session does not exist, and when the engine predates this route: the caller falls
// back to the full listing then.
export async function getSession(conn: EngineConnection, agentId: string, sessionId: string): Promise<EngineSession | null> {
    const res = await fetchEngine(`${conn.baseUrl}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`, { headers: buildHeaders(conn), signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`rerun-engine GET /agents/${agentId}/sessions/${sessionId} failed: ${res.status}`)
    return engineSessionSchema.parse(await res.json())
}

export async function getSessionMessages(conn: EngineConnection, agentId: string, sessionId: string): Promise<EngineMessage[]> {
    const res = await fetchEngine(`${conn.baseUrl}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/messages`, { headers: buildHeaders(conn) })
    if (!res.ok) return []
    return engineMessagesListSchema.parse(await res.json()).messages
}

// --- Chat (SSE, AI-SDK UI message stream protocol) ---

// Returns the raw fetch Response so the caller can read the `x-session-id`
// header and pipe the SSE body straight through to the browser.
export async function chat(conn: EngineConnection, agentId: string, params: { sessionId?: string; message: string; connectionId?: string; model?: string; source?: SessionSource; foreman?: ForemanBrief; author?: MessageAuthor; install?: boolean; userLanguage?: string; callableAgentIds?: string[] }): Promise<Response> {
    return fetchEngine(`${conn.baseUrl}/agents/${encodeURIComponent(agentId)}/chat`, {
        method: 'POST',
        headers: buildHeaders(conn),
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    })
}

// Re-attaches to an in-progress run's stream by run id. The engine replays what
// it has buffered so far and tails the live remainder; returns 204 when the run
// is finished or its buffer has been evicted.
export async function reconnectRun(conn: EngineConnection, agentId: string, runId: string): Promise<Response> {
    return fetchEngine(`${conn.baseUrl}/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`, {
        method: 'GET',
        headers: buildHeaders(conn),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    })
}

// --- Memories ---

export async function listMemories(conn: EngineConnection, agentId: string): Promise<EngineMemory[]> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/memories`, { method: 'GET' }, d => engineMemoriesListSchema.parse(d).memories)
}

export async function createMemory(conn: EngineConnection, agentId: string, params: { content: string; kind?: string; tags?: string[] }): Promise<{ id?: string }> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/memories`, { method: 'POST', body: JSON.stringify(params) }, d => d as { id?: string })
}

export async function recallMemories(conn: EngineConnection, agentId: string, params: { query: string; limit?: number }): Promise<EngineMemory[]> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/memories/recall`, { method: 'POST', body: JSON.stringify(params) }, d => engineMemoriesListSchema.parse(d).memories)
}

export async function clearMemories(conn: EngineConnection, agentId: string): Promise<void> {
    await request(conn, `/agents/${encodeURIComponent(agentId)}/memories`, { method: 'DELETE' }, () => null)
}

export async function deleteMemory(conn: EngineConnection, agentId: string, memoryId: string): Promise<void> {
    await request(conn, `/agents/${encodeURIComponent(agentId)}/memories/${encodeURIComponent(memoryId)}`, { method: 'DELETE' }, () => null)
}

// --- Files (agent workspace at /agents/:id/files, shared space at /shared/files) ---

export async function listFiles(conn: EngineConnection, base: string, path: string): Promise<EngineFileEntry[]> {
    return request(conn, `${base}?path=${encodeURIComponent(path)}`, { method: 'GET' }, d => engineFileEntriesListSchema.parse(d).entries)
}

export async function readFileText(conn: EngineConnection, base: string, path: string, offset = 0): Promise<EngineFileContent> {
    const page = offset > 0 ? `&offset=${offset}` : ''
    return request(conn, `${base}/read?path=${encodeURIComponent(path)}${page}`, { method: 'GET' }, d => engineFileContentSchema.parse(d))
}

export async function writeFileText(conn: EngineConnection, base: string, path: string, content: string): Promise<void> {
    await request(conn, base, { method: 'PUT', body: JSON.stringify({ path, content }) }, () => null)
}

export async function moveFile(conn: EngineConnection, base: string, from: string, to: string): Promise<void> {
    await request(conn, `${base}/move`, { method: 'POST', body: JSON.stringify({ from, to }) }, () => null)
}

export async function makeDir(conn: EngineConnection, base: string, path: string): Promise<void> {
    await request(conn, `${base}/dir`, { method: 'POST', body: JSON.stringify({ path }) }, () => null)
}

export async function deleteFile(conn: EngineConnection, base: string, path: string): Promise<void> {
    const res = await fetchEngine(`${conn.baseUrl}${base}?path=${encodeURIComponent(path)}`, { method: 'DELETE', headers: buildHeaders(conn) })
    if (!res.ok && res.status !== 404) {
        const body = await res.text().catch(() => 'Unknown error')
        throw new Error(`rerun-engine DELETE ${base} failed: ${res.status} ${body}`)
    }
}

export async function uploadFile(conn: EngineConnection, base: string, file: File, dir: string): Promise<void> {
    const form = new FormData()
    // `dir` already fully specifies the target directory, so send the file under
    // its basename only. Browsers put the full relative path into the multipart
    // filename for folder uploads, which would otherwise be duplicated onto dir.
    const name = file.name.split(/[\\/]/).pop() || file.name
    form.set('file', file, name)
    const headers: Record<string, string> = {}
    if (conn.apiKey) headers['Authorization'] = `Bearer ${conn.apiKey}`
    const qs = dir ? `?dir=${encodeURIComponent(dir)}` : ''
    const res = await fetchEngine(`${conn.baseUrl}${base}/raw${qs}`, { method: 'POST', headers, body: form })
    if (!res.ok) {
        const body = await res.text().catch(() => 'Unknown error')
        throw new Error(`rerun-engine POST ${base}/raw failed: ${res.status} ${body}`)
    }
}

export type StreamUploadInput = {
    dir: string
    name: string
    body: ReadableStream<Uint8Array>
    size: number | null
    signal?: AbortSignal
}

// The bytes are relayed as the request body, never buffered here: `duplex: 'half'` is what lets
// undici pull from the browser's stream at the engine's pace instead of reading it all first.
// The size travels as a query parameter because `Content-Length` is a forbidden header for fetch.
export async function uploadFileStream(conn: EngineConnection, base: string, input: StreamUploadInput): Promise<{ path: string; bytes: number }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' }
    if (conn.apiKey) headers['Authorization'] = `Bearer ${conn.apiKey}`

    const query = new URLSearchParams({ name: input.name })
    if (input.dir) query.set('dir', input.dir)
    if (input.size != null) query.set('size', String(input.size))

    const res = await fetchEngine(`${conn.baseUrl}${base}/raw?${query}`, {
        method: 'PUT',
        headers,
        body: input.body,
        signal: input.signal,
        duplex: 'half',
    } as RequestInit & { duplex: 'half' })

    if (!res.ok) {
        const body = await res.text().catch(() => 'Unknown error')
        throw new EngineUploadError(res.status, body)
    }
    return engineUploadResultSchema.parse(await res.json())
}

export class EngineUploadError extends Error {
    status: number
    constructor(status: number, body: string) {
        super(parseEngineError(body) ?? `rerun-engine upload failed: ${status}`)
        this.status = status
        this.name = 'EngineUploadError'
    }
}

function parseEngineError(body: string): string | null {
    try {
        const parsed: unknown = JSON.parse(body)
        const message = (parsed as { error?: unknown }).error
        return typeof message === 'string' ? message : null
    } catch {
        return null
    }
}

// Boxes self-update on their own schedule, so an engine that predates the streamed upload route is a
// normal state, not an error. Cached per Box: a folder upload would otherwise probe once per file.
const CAPABILITIES_TTL_MS = 5 * 60 * 1000
const capabilityCache = new Map<string, { caps: Set<string>; at: number }>()

async function engineCapabilities(conn: EngineConnection): Promise<Set<string>> {
    const cached = capabilityCache.get(conn.baseUrl)
    if (cached && Date.now() - cached.at < CAPABILITIES_TTL_MS) return cached.caps

    const caps = new Set(await getEngineHealth(conn).then(h => h.capabilities).catch(() => []))
    capabilityCache.set(conn.baseUrl, { caps, at: Date.now() })
    return caps
}

export async function supportsStreamedUploads(conn: EngineConnection): Promise<boolean> {
    return (await engineCapabilities(conn)).has(ENGINE_CAPABILITY_FILES_STREAM)
}

export async function supportsForemanFiles(conn: EngineConnection): Promise<boolean> {
    return (await engineCapabilities(conn)).has(ENGINE_CAPABILITY_FOREMAN_FILES)
}

export async function supportsDesktop(conn: EngineConnection): Promise<boolean> {
    return (await engineCapabilities(conn)).has(ENGINE_CAPABILITY_DESKTOP)
}

export async function supportsOpencode(conn: EngineConnection): Promise<boolean> {
    return (await engineCapabilities(conn)).has(ENGINE_CAPABILITY_OPENCODE)
}

export async function supportsCustomProvider(conn: EngineConnection): Promise<boolean> {
    return (await engineCapabilities(conn)).has(ENGINE_CAPABILITY_CUSTOM)
}

export async function supportsScheduleRename(conn: EngineConnection): Promise<boolean> {
    return (await engineCapabilities(conn)).has(ENGINE_CAPABILITY_SCHEDULE_RENAME)
}

// --- Desktop ---
// The screen of one agent on the Box. Starting it and opening a browser on a slow page both
// outlast the fail-fast budget.
const DESKTOP_TIMEOUT_MS = 45_000

export async function startDesktop(conn: EngineConnection, agentId: string, timeZone?: string): Promise<DesktopStatus> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/desktop/session`, { method: 'POST', body: JSON.stringify(timeZone ? { timeZone } : {}), signal: AbortSignal.timeout(DESKTOP_TIMEOUT_MS) }, d => desktopStatusSchema.parse(d))
}

export async function openDesktopApp(conn: EngineConnection, agentId: string, app: DesktopApp): Promise<void> {
    await request(conn, `/agents/${encodeURIComponent(agentId)}/desktop/apps`, { method: 'POST', body: JSON.stringify({ app }), signal: AbortSignal.timeout(DESKTOP_TIMEOUT_MS) }, () => undefined)
}

export async function startTakeover(conn: EngineConnection, agentId: string, url?: string): Promise<void> {
    await request(conn, `/agents/${encodeURIComponent(agentId)}/desktop/takeover`, { method: 'POST', body: JSON.stringify(url ? { url } : {}), signal: AbortSignal.timeout(DESKTOP_TIMEOUT_MS) }, () => undefined)
}

// keepOpen leaves the window on the coworker's screen for the run it resumes. An engine that predates
// it ignores the flag, closes the window and says nothing of `open`.
export async function finishTakeover(conn: EngineConnection, agentId: string, { keepOpen = false } = {}): Promise<TakeoverResult> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/desktop/takeover${keepOpen ? '?keepOpen=1' : ''}`, { method: 'DELETE', signal: AbortSignal.timeout(DESKTOP_TIMEOUT_MS) }, d => takeoverResultSchema.parse(d))
}

export function forgetEngineCapabilities(conn: EngineConnection): void {
    capabilityCache.delete(conn.baseUrl)
}

// Returns the raw fetch Response so a proxy route can stream the bytes straight
// through to the browser with the engine's Content-Type intact.
export async function fetchRawFile(conn: EngineConnection, base: string, path: string, range?: string | null): Promise<Response> {
    const headers: Record<string, string> = {}
    if (conn.apiKey) headers['Authorization'] = `Bearer ${conn.apiKey}`
    if (range) headers['Range'] = range
    return fetchEngine(`${conn.baseUrl}${base}/raw?path=${encodeURIComponent(path)}`, { method: 'GET', headers })
}

// --- Skills ---

export async function listSkills(conn: EngineConnection, agentId: string): Promise<EngineSkill[]> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/skills`, { method: 'GET' }, d => engineSkillsListSchema.parse(d).skills)
}

// Names and descriptions only. An engine that predates the summary answers with full skills, which
// the schema trims down to the same shape.
export async function listSkillSummaries(conn: EngineConnection, agentId: string): Promise<EngineSkillSummary[]> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/skills?summary=1`, { method: 'GET' }, d => engineSkillSummariesListSchema.parse(d).skills)
}

export async function getSkill(conn: EngineConnection, agentId: string, slug: string): Promise<EngineSkill> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(slug)}`, { method: 'GET' }, d => engineSkillSchema.parse(d))
}

export async function createSkill(conn: EngineConnection, agentId: string, params: { name: string; description: string; body: string }): Promise<EngineSkill> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/skills`, { method: 'POST', body: JSON.stringify(params) }, d => engineSkillSchema.parse(d))
}

export type ImportSkillOptions = { name?: string; description?: string; slug?: string; overwrite?: boolean }

// The engine writes the whole skill folder in one atomic swap: either SKILL.md and every
// bundled file land, or nothing does and the existing skill is untouched. Pass `slug` to
// target an existing skill, which is how a skill gets renamed instead of duplicated.
export async function importSkill(conn: EngineConnection, agentId: string, content: string, files: EngineSkillFilePayload[] = [], options: ImportSkillOptions = {}): Promise<EngineSkill> {
    const res = await fetchEngine(`${conn.baseUrl}/agents/${encodeURIComponent(agentId)}/skills/import`, { method: 'POST', headers: buildHeaders(conn), body: JSON.stringify({ content, files, ...options }) })
    const data = res.status === 204 ? null : await res.json().catch(() => null)
    if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? 'Failed to import skill')
    return engineSkillSchema.parse(data)
}

export function skillFilesBase(agentId: string, slug: string): string {
    return `/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(slug)}/files`
}

export async function fetchSkillArchive(conn: EngineConnection, agentId: string, slug: string): Promise<ArrayBuffer> {
    const res = await fetchEngine(`${conn.baseUrl}/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(slug)}/archive`, { method: 'GET', headers: buildHeaders(conn) })
    if (!res.ok) throw new Error(`Failed to download skill ${slug}: ${res.status}`)
    return res.arrayBuffer()
}

export async function updateSkill(conn: EngineConnection, agentId: string, slug: string, patch: { description?: string; body?: string }): Promise<EngineSkill> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(slug)}`, { method: 'PATCH', body: JSON.stringify(patch) }, d => engineSkillSchema.parse(d))
}

export async function deleteSkill(conn: EngineConnection, agentId: string, slug: string): Promise<void> {
    await request(conn, `/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(slug)}`, { method: 'DELETE' }, () => null)
}

export async function listSkillProposals(conn: EngineConnection, agentId: string, sessionId: string): Promise<EngineSkillProposal[]> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/skill-proposals?session=${encodeURIComponent(sessionId)}`, { method: 'GET' }, d => engineSkillProposalsListSchema.parse(d).proposals)
}

// The engine answers before the writing job is done, so the caller reads the outcome by listing
// again rather than from this response.
export async function decideSkillProposal(conn: EngineConnection, agentId: string, proposalId: string, decision: 'accept' | 'dismiss'): Promise<EngineSkillProposal> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/skill-proposals/${encodeURIComponent(proposalId)}/${decision}`, { method: 'POST' }, d => engineSkillProposalSchema.parse((d as { proposal: unknown }).proposal))
}

// --- Schedules (cron / one-shot) ---

// A null model means "whatever the agent runs", which is itself the Box default when the agent
// picked nothing. A routine only freezes a pair when someone chose one.
export type ScheduleCreateParams = { name: string; description?: string; body: string; cron?: string; runAt?: string; timezone?: string; enabled?: boolean; connectionId?: string | null; provider?: EngineProvider | null; model?: string | null }
export type ScheduleUpdateParams = { name?: string; description?: string; body?: string; cron?: string; runAt?: string; timezone?: string; enabled?: boolean; connectionId?: string | null; provider?: EngineProvider | null; model?: string | null }

export async function listSchedules(conn: EngineConnection, agentId: string, init: RequestInit = {}): Promise<EngineSchedule[]> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/schedules`, { ...init, method: 'GET' }, d => engineSchedulesListSchema.parse(d).schedules)
}

export async function createSchedule(conn: EngineConnection, agentId: string, params: ScheduleCreateParams): Promise<EngineSchedule> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/schedules`, { method: 'POST', body: JSON.stringify(params) }, d => engineScheduleSchema.parse(d))
}

export async function getSchedule(conn: EngineConnection, agentId: string, slug: string): Promise<EngineSchedule> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(slug)}`, { method: 'GET' }, d => engineScheduleSchema.parse(d))
}

export async function updateSchedule(conn: EngineConnection, agentId: string, slug: string, patch: ScheduleUpdateParams): Promise<EngineSchedule> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(slug)}`, { method: 'PATCH', body: JSON.stringify(patch) }, d => engineScheduleSchema.parse(d))
}

export async function runScheduleNow(conn: EngineConnection, agentId: string, slug: string): Promise<{ runId: string; sessionId: string }> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(slug)}/run`, { method: 'POST' }, d => d as { runId: string; sessionId: string })
}

export async function deleteSchedule(conn: EngineConnection, agentId: string, slug: string): Promise<void> {
    const res = await fetchEngine(`${conn.baseUrl}/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(slug)}`, { method: 'DELETE', headers: buildHeaders(conn) })
    if (!res.ok && res.status !== 404) {
        const body = await res.text().catch(() => 'Unknown error')
        throw new Error(`rerun-engine DELETE /agents/${agentId}/schedules/${slug} failed: ${res.status} ${body}`)
    }
}

// --- Triggers (public webhook URLs) ---

export type TriggerCreateParams = { name: string; description?: string; body: string; methods?: EngineTriggerMethod[]; enabled?: boolean; connectionId?: string | null; provider?: EngineProvider | null; model?: string | null }
export type TriggerUpdateParams = { description?: string; body?: string; methods?: EngineTriggerMethod[]; enabled?: boolean; connectionId?: string | null; provider?: EngineProvider | null; model?: string | null }
export type TriggerFirePayload = { token: string; method: EngineTriggerMethod; query: string; contentType: string; body: string; bodyBytes: number }
export type TriggerFireOutcome = { status: number; runId?: string; sessionId?: string; allow?: EngineTriggerMethod[] }

export async function listTriggers(conn: EngineConnection, agentId: string): Promise<EngineTrigger[]> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/triggers`, { method: 'GET' }, d => engineTriggersListSchema.parse(d).triggers)
}

export async function createTrigger(conn: EngineConnection, agentId: string, params: TriggerCreateParams): Promise<EngineTrigger> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/triggers`, { method: 'POST', body: JSON.stringify(params) }, d => engineTriggerSchema.parse(d))
}

export async function getTrigger(conn: EngineConnection, agentId: string, slug: string): Promise<EngineTrigger> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/triggers/${encodeURIComponent(slug)}`, { method: 'GET' }, d => engineTriggerSchema.parse(d))
}

export async function updateTrigger(conn: EngineConnection, agentId: string, slug: string, patch: TriggerUpdateParams): Promise<EngineTrigger> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/triggers/${encodeURIComponent(slug)}`, { method: 'PATCH', body: JSON.stringify(patch) }, d => engineTriggerSchema.parse(d))
}

export async function rotateTriggerToken(conn: EngineConnection, agentId: string, slug: string): Promise<EngineTrigger> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/triggers/${encodeURIComponent(slug)}/rotate`, { method: 'POST' }, d => engineTriggerSchema.parse(d))
}

export async function deleteTrigger(conn: EngineConnection, agentId: string, slug: string): Promise<void> {
    const res = await fetchEngine(`${conn.baseUrl}/agents/${encodeURIComponent(agentId)}/triggers/${encodeURIComponent(slug)}`, { method: 'DELETE', headers: buildHeaders(conn) })
    if (!res.ok && res.status !== 404) {
        const body = await res.text().catch(() => 'Unknown error')
        throw new Error(`rerun-engine DELETE /agents/${agentId}/triggers/${slug} failed: ${res.status} ${body}`)
    }
}

// Not routed through `request`, which turns every non-2xx into a message-only Error: the public
// webhook route has to tell a wrong token (404) from a wrong method (405) to answer correctly.
export async function fireTrigger(conn: EngineConnection, agentId: string, slug: string, payload: TriggerFirePayload, signal?: AbortSignal): Promise<TriggerFireOutcome> {
    const res = await fetchEngine(`${conn.baseUrl}/agents/${encodeURIComponent(agentId)}/triggers/${encodeURIComponent(slug)}/fire`, {
        method: 'POST',
        headers: buildHeaders(conn),
        body: JSON.stringify(payload),
        signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    })
    const data = (await res.json().catch(() => ({}))) as { runId?: string; sessionId?: string; allow?: EngineTriggerMethod[] }
    return { status: res.status, runId: data.runId, sessionId: data.sessionId, allow: data.allow }
}

// --- Health & self-update ---

export async function getEngineHealth(conn: EngineConnection): Promise<EngineHealth> {
    return request(conn, '/health', { method: 'GET', signal: AbortSignal.timeout(5000) }, d => engineHealthSchema.parse(d))
}

// Null on an engine that predates the route: the caller judges it on /health alone then.
export async function getEngineDoctor(conn: EngineConnection): Promise<EngineDoctor | null> {
    const res = await fetchEngine(`${conn.baseUrl}/doctor`, { headers: buildHeaders(conn), signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`rerun-engine GET /doctor failed: ${res.status}`)
    return engineDoctorSchema.parse(await res.json())
}

// What a box needs to install a prebuilt release: the URL is signed for a short while.
export type EngineUpdateArtifact = { url: string; sha256: string; commit: string; bytes?: number }

// Without an artifact the engine pulls and rebuilds its checkout; with one it downloads the release.
export async function requestEngineUpdate(conn: EngineConnection, force = false, artifact?: EngineUpdateArtifact): Promise<EngineUpdateResult> {
    return request(conn, '/update', { method: 'POST', body: JSON.stringify({ force, ...(artifact ? { artifact } : {}) }), signal: AbortSignal.timeout(15000) }, d => engineUpdateResultSchema.parse(d))
}

// --- Runs (execution history) ---

export type RunFilter = { limit?: number; sessionId?: string; status?: EngineRun['status'] }

// An engine that predates `session` / `status` ignores them and returns its most recent runs, so
// callers keep filtering what comes back.
export async function listRuns(conn: EngineConnection, agentId: string, { limit, sessionId, status }: RunFilter = {}): Promise<EngineRun[]> {
    const params = new URLSearchParams()
    if (limit) params.set('limit', String(limit))
    if (sessionId) params.set('session', sessionId)
    if (status) params.set('status', status)
    const qs = params.size > 0 ? `?${params}` : ''
    return request(conn, `/agents/${encodeURIComponent(agentId)}/runs${qs}`, { method: 'GET' }, d => engineRunsListSchema.parse(d).runs)
}

export async function getRun(conn: EngineConnection, agentId: string, runId: string): Promise<EngineRunDetail> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`, { method: 'GET' }, d => engineRunDetailSchema.parse(d))
}

export async function getRunSteps(conn: EngineConnection, agentId: string, runId: string): Promise<EngineRunStep[]> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/steps`, { method: 'GET' }, d => engineRunStepsListSchema.parse(d).steps)
}

export async function getRunTools(conn: EngineConnection, agentId: string, runId: string): Promise<EngineToolCall[]> {
    return request(conn, `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/tools`, { method: 'GET' }, d => engineToolCallsListSchema.parse(d).tools)
}

export async function getAgentUsage(conn: EngineConnection, agentId: string, range?: string): Promise<EngineUsageBucket[]> {
    const qs = range ? `?range=${encodeURIComponent(range)}` : ''
    return request(conn, `/agents/${encodeURIComponent(agentId)}/usage${qs}`, { method: 'GET' }, d => engineUsageSchema.parse(d).buckets)
}

export async function getAgentStats(conn: EngineConnection, agentId: string, query: EngineStatsQuery): Promise<EngineStatsPoint[]> {
    const qs = new URLSearchParams({
        dataset: query.dataset,
        metric: query.metric,
        groupBy: query.groupBy,
        range: query.range,
        ...(query.status ? { status: query.status } : {}),
    })
    return request(conn, `/agents/${encodeURIComponent(agentId)}/stats?${qs}`, { method: 'GET' }, d => engineStatsResponseSchema.parse(d).points)
}

export async function cancelRun(conn: EngineConnection, agentId: string, runId: string): Promise<void> {
    await request(conn, `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }, () => null)
}

export async function cancelSubRun(conn: EngineConnection, agentId: string, runId: string, taskId: string): Promise<void> {
    await request(conn, `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' }, () => null)
}

// --- Company brain ---
// Workspace-wide pages on the box. The engine has no notion of users, so every write names its
// author (`user:<id>`) for the history.

export type BrainPageDetail = { page: BrainPage; revisions: BrainRevision[] }

export async function listBrainPages(conn: EngineConnection): Promise<BrainPageSummary[]> {
    return request(conn, '/brain/pages', { method: 'GET' }, d => brainPagesListSchema.parse(d).pages)
}

export async function readBrainPage(conn: EngineConnection, slug: string): Promise<BrainPageDetail> {
    return request(conn, `/brain/pages/${encodeURIComponent(slug)}`, { method: 'GET' }, d => brainPageResponseSchema.parse(d))
}

export async function writeBrainPage(conn: EngineConnection, slug: string, body: BrainPageWrite): Promise<BrainPageDetail> {
    return request(conn, `/brain/pages/${encodeURIComponent(slug)}`, { method: 'PUT', body: JSON.stringify(body) }, d => brainPageResponseSchema.parse(d))
}

export async function deleteBrainPage(conn: EngineConnection, slug: string): Promise<void> {
    await request(conn, `/brain/pages/${encodeURIComponent(slug)}`, { method: 'DELETE' }, () => undefined)
}

export async function readBrainRevision(conn: EngineConnection, slug: string, revisionId: string): Promise<{ revision: BrainRevision; content: string }> {
    return request(conn, `/brain/pages/${encodeURIComponent(slug)}/revisions/${encodeURIComponent(revisionId)}`, { method: 'GET' }, d => brainRevisionContentSchema.parse(d))
}

export async function revertBrainPage(conn: EngineConnection, slug: string, revisionId: string, author: string, expectedHash?: string): Promise<BrainPageDetail> {
    return request(conn, `/brain/pages/${encodeURIComponent(slug)}/revert/${encodeURIComponent(revisionId)}`, { method: 'POST', body: JSON.stringify({ author, expectedHash }) }, d => brainPageResponseSchema.parse(d))
}

export async function confirmBrainSections(conn: EngineConnection, slug: string, headings: string[] | null): Promise<BrainPageDetail> {
    return request(conn, `/brain/pages/${encodeURIComponent(slug)}/confirm`, { method: 'POST', body: JSON.stringify({ headings }) }, d => brainPageResponseSchema.parse(d))
}

export async function listBrainProposals(conn: EngineConnection, status?: BrainProposalStatus): Promise<BrainProposal[]> {
    const qs = status ? `?status=${status}` : ''
    return request(conn, `/brain/proposals${qs}`, { method: 'GET' }, d => brainProposalsListSchema.parse(d).proposals)
}

export async function countBrainProposals(conn: EngineConnection): Promise<number> {
    return request(conn, '/brain/proposals/count', { method: 'GET' }, d => brainProposalCountSchema.parse(d).count)
}

export async function decideBrainProposal(conn: EngineConnection, proposalId: string, decision: 'accept' | 'dismiss', body: BrainProposalAccept): Promise<BrainProposal> {
    return request(conn, `/brain/proposals/${encodeURIComponent(proposalId)}/${decision}`, { method: 'POST', body: JSON.stringify(body) }, d => brainProposalResponseSchema.parse(d).proposal)
}

// Seeding runs the whole Company Lab output through one call, which embeds nothing inline but
// still writes a dozen files: a longer timeout than the default.
export async function seedBrain(conn: EngineConnection, pages: BrainSeedPage[]): Promise<BrainSeedResult> {
    return request(conn, '/brain/seed', { method: 'POST', body: JSON.stringify({ pages }), signal: AbortSignal.timeout(60_000) }, d => brainSeedResultSchema.parse(d))
}
