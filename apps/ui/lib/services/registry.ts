import { parseServiceRegistryKey } from '@rerun/contracts'

import { makeDir, readFileText, writeFileText } from '@/lib/engine/client'
import type { EngineConnection } from '@/lib/engine/types'

// The per-agent "installed services" registry lives WITH the agent, on the engine, not
// in the UI database — an agent must be autonomous and carry its own capabilities. It is
// a small JSON file in the agent's own workspace, alongside the actual compiled
// primitives (mcpServers/skills/keys). The agent itself can read it via its fs tools.
//
// It holds only slugs + non-secret config + status — no secrets (those are in the
// engine .env / mcp headers) and nothing proprietary from the catalog.

const REGISTRY_PATH = '.rerun/services.json'
const REGISTRY_DIR = '.rerun'

function filesBase(engineAgentId: string): string {
    return `/agents/${engineAgentId}/files`
}

export type RegistryEntry = {
    status: 'active' | 'needs_config' | 'needs_auth'
    config: Record<string, string>
    // Which auth method (manifest.authMethods[].id) this install used, so the UI can
    // re-open the right method and a reconfigure targets it. Absent on legacy entries.
    authMethodId?: string
    // Footprint of what the install added, so uninstall can reverse it exactly without
    // depending on the catalog (which may have changed or been removed since).
    mcpServers: string[]
    envKeys: string[]
    skills: string[]
    // The OAuth mcp server to connect (needs_auth) — lets the UI render Connect without
    // re-reading the catalog. Non-secret: just the server name and its url.
    oauth?: { serverName: string; url: string }
    // A managed connection to complete (needs_auth): Rerun-brokered OAuth + proxy. Carries the
    // provider, the engine token-store key (serverName) and, once connected, the account label.
    managed?: { provider: string; serverName: string; accountEmail?: string }
    // A Composio connection to complete (needs_auth): Composio holds the third-party token, so
    // there is no engine token-store entry. `connectedAccountId` (set once connected) is what
    // uninstall/reconnect delete at Composio to actually revoke access.
    composio?: { toolkit: string; serverName: string; connectedAccountId?: string; accountLabel?: string }
    // A paid app to plug in (needs_auth until the coworker picks an account). Which account it
    // picked lives in Supabase (app_connection_agents), the label here is only for display.
    app?: { appSlug: string; serverName: string; accountLabel?: string }
    // A workspace-level (Global apps) connection this entry runs on. Reconnect/disconnect live on
    // the workspace page, not here; uninstalling only detaches this coworker. For a composio entry
    // the connected account belongs to the connection row, never to `composio.connectedAccountId`,
    // so a per-coworker teardown can never revoke the shared account.
    global?: { connectionId: string; label?: string }
    // Set on an extra account only, the base one is the bare slug key.
    instanceId?: string
    // Which account this entry is, for the user and the agent alike: the email, else "Gmail 2".
    label?: string
    installedAt: string
}

export type ServiceRegistry = { services: Record<string, RegistryEntry> }

// Older entries predate the footprint fields, and mcpServers used to be stored as `toolNames`.
// readRegistry casts without parsing, so every reader has to go through this.
export function registryFootprint(entry: RegistryEntry): { mcpServers: string[]; envKeys: string[]; skills: string[] } {
    return {
        mcpServers: entry.mcpServers ?? (entry as { toolNames?: string[] }).toolNames ?? [],
        envKeys: entry.envKeys ?? [],
        skills: entry.skills ?? [],
    }
}

// A skill an install wrote into the agent folder is not something the agent's author chose:
// it belongs to the connector, and anywhere the connector is already shown it says nothing more.
export function connectorSkillSlugs(reg: ServiceRegistry): Set<string> {
    return new Set(connectorSkillOwners(reg).keys())
}

// Skill slug → slug of the connector that installed it, so a refusal can name what owns the skill.
// Every account of an app shares its skills, so the owner is the app, never one of its accounts.
export function connectorSkillOwners(reg: ServiceRegistry): Map<string, string> {
    const owners = new Map<string, string>()
    for (const [key, entry] of Object.entries(reg.services)) {
        const { slug: service } = parseServiceRegistryKey(key)
        for (const slug of registryFootprint(entry).skills) owners.set(slug, service)
    }
    return owners
}

// Every account of one app, the base one first, then in the order they were added.
export function entriesOfSlug(reg: ServiceRegistry, slug: string): Array<{ key: string; entry: RegistryEntry }> {
    return Object.entries(reg.services)
        .filter(([key]) => parseServiceRegistryKey(key).slug === slug)
        .map(([key, entry]) => ({ key, entry }))
        .sort((a, b) => Number(a.key !== slug) - Number(b.key !== slug) || (a.entry.installedAt ?? '').localeCompare(b.entry.installedAt ?? ''))
}

// A bare slug addresses the base account, never "whichever account is left".
export function resolveRegistryEntry(reg: ServiceRegistry, slugOrKey: string): { key: string; entry: RegistryEntry } | null {
    const entry = reg.services[slugOrKey]
    return entry ? { key: slugOrKey, entry } : null
}

// The skills of one entry that another account of the same app still relies on, so its uninstall
// leaves them in place.
export function sharedSkillSlugs(reg: ServiceRegistry, key: string): Set<string> {
    const { slug } = parseServiceRegistryKey(key)
    const shared = new Set<string>()
    for (const other of entriesOfSlug(reg, slug)) {
        if (other.key === key) continue
        for (const skill of registryFootprint(other.entry).skills) shared.add(skill)
    }
    return shared
}

const STATUS_RANK: Record<RegistryEntry['status'], number> = { active: 0, needs_auth: 1, needs_config: 2 }

// One status per app for the library tiles: the base account's, or the best one left once the
// base account is gone.
export function primaryStatusOfSlug(reg: ServiceRegistry, slug: string): RegistryEntry['status'] | null {
    const entries = entriesOfSlug(reg, slug)
    if (entries.length === 0) return null
    const base = entries.find(e => e.key === slug)
    if (base) return base.entry.status
    return entries.map(e => e.entry.status).sort((a, b) => (STATUS_RANK[a] ?? 9) - (STATUS_RANK[b] ?? 9))[0]
}

// Same reasoning for MCP servers, plus a harder consequence: editing or deleting one by hand
// desynchronises the registry, which still lists it as part of the connector's footprint. The auth
// targets are folded in because a legacy needs_auth entry can name its server there and nowhere else.
export function connectorMcpServerNames(reg: ServiceRegistry): Set<string> {
    return new Set(
        Object.values(reg.services).flatMap(entry =>
            [...registryFootprint(entry).mcpServers, entry.oauth?.serverName, entry.managed?.serverName, entry.composio?.serverName, entry.app?.serverName].filter(
                (name): name is string => !!name,
            ),
        ),
    )
}

export async function readRegistry(conn: EngineConnection, engineAgentId: string): Promise<ServiceRegistry> {
    try {
        const { content } = await readFileText(conn, filesBase(engineAgentId), REGISTRY_PATH)
        const parsed = JSON.parse(content) as unknown
        if (parsed && typeof parsed === 'object' && 'services' in parsed && (parsed as ServiceRegistry).services) {
            return parsed as ServiceRegistry
        }
        return { services: {} }
    } catch {
        // Missing file / unreachable / invalid JSON → treat as empty.
        return { services: {} }
    }
}

async function writeRegistry(conn: EngineConnection, engineAgentId: string, reg: ServiceRegistry): Promise<void> {
    await makeDir(conn, filesBase(engineAgentId), REGISTRY_DIR).catch(() => {})
    await writeFileText(conn, filesBase(engineAgentId), REGISTRY_PATH, `${JSON.stringify(reg, null, 2)}\n`)
}

export async function upsertRegistryEntry(conn: EngineConnection, engineAgentId: string, key: string, entry: RegistryEntry): Promise<void> {
    const reg = await readRegistry(conn, engineAgentId)
    reg.services[key] = entry
    await writeRegistry(conn, engineAgentId, reg)
}

export async function removeRegistryEntry(conn: EngineConnection, engineAgentId: string, key: string): Promise<void> {
    const reg = await readRegistry(conn, engineAgentId)
    if (reg.services[key]) {
        delete reg.services[key]
        await writeRegistry(conn, engineAgentId, reg)
    }
}
