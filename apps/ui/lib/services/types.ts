import type { InputDef, InstallOutcome } from './manifest'

// Result shapes shared between the server service layer and the client renderers.
// Kept in their own module so client components can `import type` them without
// pulling the server-only service code into the browser bundle.

export type AgentServiceStatus = 'active' | 'needs_config' | 'needs_auth' | 'error'

// Where the OAuth sign-in popup connects, carried so the UI can render Connect.
export type OAuthTarget = { serverName: string; url: string }

// A managed connection to complete: Rerun-brokered OAuth (one app) + API proxy. The UI opens
// /api/oauth/managed/<provider>/start; `serverName` is only kept for parity/tracing.
export type ManagedTarget = { provider: string; serverName: string; accountEmail?: string }

// A Composio connection to complete: Composio brokers the OAuth and holds the token, Rerun
// proxies the tool calls. The UI opens /api/oauth/composio/start with just the agent + slug.
export type ComposioTarget = { toolkit: string; serverName: string; accountLabel?: string }

// A paid app to plug in: the workspace connects the account once (Settings → Apps), the coworker
// picks which one it acts with. `accountLabel` is the picked account's name once there is one.
export type AppTarget = { appSlug: string; serverName: string; accountLabel?: string }

// Client-safe view of one auth method: enough to render the method picker and its fields,
// but never the mcpServers/envKeys (those stay server-side). `kind` drives Connect vs Install.
export type AuthMethodSummary = {
    id: string
    label: string
    kind: 'oauth' | 'key' | 'stdio' | 'none' | 'managed' | 'composio' | 'app'
    recommended: boolean
    inputs: InputDef[]
    requiresSecrets: boolean
}

export type ServiceAlternative = { slug: string; name: string; category: string; icon: string | null }

export type ServiceSearchResult = {
    slug: string
    name: string
    category: string
    summary: string
    icon: string | null
    // Whether the recommended method asks for a secret. NOT a promise that the connector
    // works without one: see `setup` for what declaring it on an agent actually leaves behind.
    requiresSecrets: boolean
    setup: InstallOutcome
    setupReason: string
    // True only when the connector is usable right now. A connector that is declared on the
    // agent but still waiting for a sign-in or credentials is NOT installed — see installStatus.
    installed: boolean
    // The agent's registry status for this service, or null when it isn't declared at all.
    installStatus: AgentServiceStatus | null
    // Tested & approved by the Rerun team — drives the "Verified" badge in the library.
    verified: boolean
    // A paid Rerun app (LinkedIn Pro): sold by the slot, shown with a Pro badge.
    paidApp?: boolean
    // The coworker can add a second account of this app next to the first.
    multiInstance: boolean
    // Cosine similarity (0..1) when results come from semantic search; absent for the
    // keyword fallback.
    similarity?: number
}

// One account of an app on the coworker, `key` addresses it in every per-entry call.
export type ServiceInstanceSummary = { key: string; label?: string; status: AgentServiceStatus }

export type ServiceDetails = {
    // The registry entry these details describe: the bare slug for the base account.
    key: string
    slug: string
    label?: string
    name: string
    category: string
    summary: string
    description: string
    authMethods: AuthMethodSummary[]
    // Same contract as ServiceSearchResult.installed: usable now, not merely declared.
    installed: boolean
    installStatus: AgentServiceStatus | null
    // The method the current install used (if installed), so the UI re-opens the right one.
    installedMethodId?: string
    // Pending sign-in target of an existing needs_auth entry, so the UI can jump straight to
    // Connect instead of walking the user through the config form again.
    oauth?: OAuthTarget
    managed?: ManagedTarget
    composio?: ComposioTarget
    app?: AppTarget
    multiInstance: boolean
    instances: ServiceInstanceSummary[]
}

export type InstalledService = {
    key: string
    slug: string
    instanceId?: string
    // Which account this row is: the email when the sign-in gave one, else "Gmail 2".
    label?: string
    name: string
    icon: string | null
    category: string
    status: AgentServiceStatus
    toolNames: string[]
    oauth?: OAuthTarget
    managed?: ManagedTarget
    composio?: ComposioTarget
    app?: AppTarget
    authMethodId?: string
    // The workspace (Global apps) connection this row runs on: reconnect lives on the workspace
    // page, and removing the row only detaches this coworker.
    global?: { connectionId: string; label?: string }
    installedAt: string
}

// --- Global apps (workspace-level connections) ---

export type GlobalAppStatus = 'connecting' | 'connected' | 'needs_reconnect'
// 'key': a pasted credential compiled onto each enabled coworker (stdio servers included).
// 'composio': Composio holds the token under a per-connection user id.
// 'oauth': one browser sign-in for the workspace, the token stays on the server and coworker
// calls go through the /api/mcp/global proxy.
export type GlobalAppKind = 'key' | 'composio' | 'oauth'

// One workspace account on the Global apps page.
export type GlobalAppConnection = {
    id: string
    slug: string
    name: string
    icon: string | null
    category: string
    label: string
    kind: GlobalAppKind
    status: GlobalAppStatus
    authMethodId: string
    // The signed-in identity Composio reported, when there is one ("ops@inforge.us").
    accountLabel?: string
    createdAt: string
    // Coworkers enabled on this account (Supabase agent ids).
    agentIds: string[]
}

// A workspace account offered while installing an app on a coworker.
export type GlobalAppOption = {
    id: string
    label: string
    status: GlobalAppStatus
    usedBy: number
}

// A catalog row of the workspace-level connect picker: every service shows, the ones whose auth
// cannot be shared say so instead of hiding.
export type ShareableService = {
    slug: string
    name: string
    category: string
    summary: string
    icon: string | null
    shareable: boolean
    // Why not, when it isn't ("Signs in per coworker for now", "Runs locally on each coworker").
    shareableReason?: string
}

// Outcome of resetting a connected service: 'auth' when only the sign-in was cleared (the
// compiled footprint stays in place, the user just signs in again), 'config' when there is no
// sign-in to redo and the config form has to be walked again.
export type ResetConnectionResult = { mode: 'auth'; oauth?: OAuthTarget; managed?: ManagedTarget; composio?: ComposioTarget; app?: AppTarget } | { mode: 'config'; authMethodId?: string }

export type InstallResult =
    | { status: 'installed'; key: string; slug: string; name: string; toolNames: string[]; message: string }
    | { status: 'needs_config'; key: string; slug: string; name: string; authMethods: AuthMethodSummary[]; authMethodId?: string; message: string }
    | { status: 'needs_auth'; key: string; slug: string; name: string; oauth?: OAuthTarget; managed?: ManagedTarget; composio?: ComposioTarget; app?: AppTarget; message: string }

// --- Published files (publishing via the Hub) ---

export type PublishedAccessMode = 'public' | 'workspace' | 'password' | 'invited'

export type PublishResult = {
    status: 'published'
    url: string // <slug>.rerun.site, or /p/<slug> where no publish host is configured
    slug: string
    path: string
    kind: 'file' | 'site'
    contentType: string
    size: number
    title: string
    access: PublishedAccessMode
    // 'public' when the coworker asked for it and the workspace policy holds it for a person.
    requestedAccess: 'public' | null
    message: string
}

export type PublishedFile = {
    slug: string
    agentId: string
    path: string
    url: string
    kind: 'file' | 'site'
    contentType: string
    size: number
    title: string
    access: PublishedAccessMode
    requestedAccess: 'public' | null
    invited: string[]
    hasPassword: boolean
    thumbnailUrl: string | null
    publishedAt: string
    updatedAt: string
}

// --- Agent creation ---

// A service that couldn't be auto-installed at creation because it needs secrets or a
// method choice — marked `needs_config` and finished later from the agent's Services tab.
export type ServiceChecklistItem = { slug: string; name: string; authMethods: AuthMethodSummary[] }

// --- Custom MCP servers (registered by hand or by the agent, outside the catalog) ---

export type McpTransportKind = 'stdio' | 'sse' | 'http'

export type CustomMcpServer = {
    name: string
    displayName: string
    transport: McpTransportKind
    // Null for a stdio server, or a url hiding its host behind a ${VAR}.
    host: string | null
    // Either the matching catalog app's icon or a favicon already checked to exist; null draws the plug.
    icon: string | null
    // Only a literal http(s) url can go through the browser OAuth flow.
    signInUrl: string | null
}

export type CustomMcpLiveStatus = 'connected' | 'needs_auth' | 'error' | 'unknown'

export type CustomMcpStatus = { name: string; status: CustomMcpLiveStatus; toolCount: number; error?: string }
