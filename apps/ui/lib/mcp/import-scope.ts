import type { AuthenticatedApiKey } from './api-keys'

// What an import key reaches: enough for an outside agent to rebuild itself as one coworker, and
// nothing that reads or changes the rest of the account. No deletion, no messages, no database,
// no listing of the other coworkers.
export const IMPORT_TOOL_NAMES: ReadonlySet<string> = new Set([
    'create_agent',
    'get_agent',
    'update_agent',
    'list_skills',
    'get_skill',
    'upsert_skill',
    'list_schedules',
    'upsert_schedule',
    'list_triggers',
    'upsert_trigger',
    'search_connectors',
    'list_agent_connectors',
    'attach_connector',
    'write_memory',
    'upload_workspace_file',
])

export const IMPORT_KEY_TTL_MS = 24 * 60 * 60_000

export function isImportKey(key: Pick<AuthenticatedApiKey, 'scope'>): boolean {
    return key.scope === 'agent_import'
}

export function importToolDefs<T extends { name: string }>(defs: readonly T[]): T[] {
    return defs.filter(def => IMPORT_TOOL_NAMES.has(def.name))
}

// Throws the reason an import key may not make this call, in words the calling model can act on.
export function assertImportCall(key: Pick<AuthenticatedApiKey, 'boundAgentId'>, name: string, args: Record<string, unknown>): void {
    if (!IMPORT_TOOL_NAMES.has(name)) throw new Error(`"${name}" is not available to an import key.`)
    if (name === 'create_agent') {
        if (key.boundAgentId) throw new Error(`This import key already created its coworker (agentId ${key.boundAgentId}). Keep writing to that one.`)
        return
    }
    if (args.agentId === undefined) return
    if (!key.boundAgentId) throw new Error('Call create_agent first: an import key only writes to the coworker it creates.')
    if (args.agentId !== key.boundAgentId) throw new Error(`An import key only writes to its own coworker (agentId ${key.boundAgentId}).`)
}
