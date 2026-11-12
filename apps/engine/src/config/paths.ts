import { resolve } from 'node:path'
import { env } from './env.js'
import { badRequest } from '../lib/errors.js'

export const dataDir = () => env().RERUN_DATA_DIR

// Ids, slugs and server names reach these helpers from tool calls and URLs, and `resolve` would
// happily walk `../other-agent/SOUL` out of the folder they are meant to name.
export const isPathSegment = (value: string): boolean => !!value && value !== '.' && value !== '..' && !/[/\\\0]/.test(value)

export function pathSegment(value: string, what: string): string {
    if (!isPathSegment(value)) throw badRequest(`Invalid ${what}: ${JSON.stringify(value)}`)
    return value
}

export const dbPath = () => resolve(dataDir(), 'rerun.db')

// The last step of the data-dir migration ladder this folder has been through. Absent means v0.
export const dataVersionPath = () => resolve(dataDir(), 'data-version.json')

// What the last `rerun update` did, read back by `/health`.
export const lastUpdatePath = () => resolve(dataDir(), 'last-update.json')

export const agentsDir = () => resolve(dataDir(), 'agents')

export const sharedDir = () => resolve(dataDir(), 'shared')

// Deliberately a sibling of `shared/` rather than a file inside it: shared_write and the
// /shared/files router would otherwise be able to truncate the database, and the Files tab
// would show the user a binary blob next to its -wal and -shm siblings.
export const sharedDbDir = () => resolve(dataDir(), 'shared-db')

export const sharedDbPath = () => resolve(sharedDbDir(), 'shared.db')

// A sibling of `shared/` too, for a different reason: agents write `shared/` freely, while a brain
// page only changes once a human accepts it, so no shared_ tool may reach these files.
export const brainDir = () => resolve(dataDir(), 'brain')

export const brainPagePath = (slug: string) => resolve(brainDir(), `${pathSegment(slug, 'brain page slug')}.md`)

export const brainDbDir = () => resolve(dataDir(), 'brain-db')

export const brainDbPath = () => resolve(brainDbDir(), 'brain.db')

export const agentDir = (id: string) => resolve(agentsDir(), pathSegment(id, 'agent id'))

export const connectionsDir = () => resolve(dataDir(), 'connections')

export const connectionDir = (id: string) => resolve(connectionsDir(), pathSegment(id, 'connection id'))

export const connectionConfigPath = (id: string) => resolve(connectionDir(id), 'connection.json')

export const connectionEnvPath = (id: string) => resolve(connectionDir(id), '.env')

// Written once the boot migration has folded every agent's provider keys into box connections.
export const connectionsMigratedPath = () => resolve(connectionsDir(), '.migrated')

// The connection and model an agent runs on when it has picked none. A sibling of the connection
// folders rather than a flag inside each of them: `listConnectionIds` only walks directories, so
// this file stays invisible to the listing.
export const boxDefaultPath = () => resolve(connectionsDir(), 'default.json')

// What the hub last said about the workspace's plan, which decides whether premium models run.
export const boxPlanPath = () => resolve(dataDir(), 'plan.json')

// The MCP servers an agent declares as `npx <package>`, installed once so a run does not fetch them again.
export const mcpPackagesDir = () => resolve(dataDir(), 'mcp-packages')

export const soulPath = (id: string) => resolve(agentDir(id), 'SOUL.md')

export const configPath = (id: string) => resolve(agentDir(id), 'config.json')

export const installPath = (id: string) => resolve(agentDir(id), 'INSTALL.md')

export const agentEnvPath = (id: string) => resolve(agentDir(id), '.env')

// Written by the hub when the agent's Box is linked to a Confluence engagement (Project
// knowledge); absent otherwise. Read into the system prompt, never written engine-side.
export const projectNotePath = (id: string) => resolve(agentDir(id), '.rerun', 'project.md')

export const workspaceDir = (id: string) => resolve(agentDir(id), 'workspace')

export const agentDataDir = (id: string) => resolve(agentDir(id), 'data')

// Cookies, consents and cleared challenges outlive a single call. Not an ARCHIVE_ROOTS entry, so an
// agent's sessions never leave the box in an export, a duplicate or a template.
export const browserProfileDir = (id: string) => resolve(agentDir(id), 'browser-profile')

export const agentDataDbPath = (id: string) => resolve(agentDataDir(id), 'agent.db')

export const systemDbPath = (id: string) => resolve(agentDataDir(id), 'system.db')

export const skillsDir = (id: string) => resolve(agentDir(id), 'skills')

export const skillDir = (id: string, slug: string) => resolve(skillsDir(id), pathSegment(slug, 'skill slug'))

export const schedulesDir = (id: string) => resolve(agentDir(id), 'schedules')

export const scheduleFile = (id: string, slug: string) => resolve(schedulesDir(id), `${pathSegment(slug, 'schedule slug')}.md`)

export const triggersDir = (id: string) => resolve(agentDir(id), 'triggers')

export const triggerFile = (id: string, slug: string) => resolve(triggersDir(id), `${pathSegment(slug, 'trigger slug')}.md`)

// Codex keeps all of its state (auth.json, sessions, logs) under CODEX_HOME. One per connection:
// the credential is the connection's, so every agent drawing on it shares one refresh lineage
// instead of racing to rotate its own copy.
export const codexHomeDir = (connectionId: string) => resolve(connectionDir(connectionId), '.codex')

export const codexAuthPath = (connectionId: string) => resolve(codexHomeDir(connectionId), 'auth.json')

export const mcpDir = (id: string) => resolve(agentDir(id), 'mcp')

export const mcpTokenPath = (id: string, name: string) => resolve(mcpDir(id), `${pathSegment(name, 'MCP server name')}.json`)

export const mcpPendingPath = (id: string, name: string) => resolve(mcpDir(id), `${pathSegment(name, 'MCP server name')}.pending.json`)
