// The settings surfaces of the app, the ones that live in a dialog over the board rather than on a
// tab of a panel. Declared here rather than beside their dialogs so the stores and the foreman's
// tool belt can name one without importing the component it opens, exactly as lib/board/types.ts
// does for the tabs of the agent panel.
export const SETTINGS_PANELS = ['workspace', 'members', 'api_keys', 'ai_providers', 'chat_apps', 'coworker_presets', 'knowledge_base', 'billing', 'notifications', 'shortcuts', 'delete_account'] as const

export type SettingsPanel = (typeof SETTINGS_PANELS)[number]

export const SETTINGS_PANEL_LABELS: Record<SettingsPanel, string> = {
    workspace: 'Workspace settings',
    members: 'Members',
    api_keys: 'API keys & MCP',
    ai_providers: 'AI providers',
    chat_apps: 'Chat apps',
    coworker_presets: 'Coworkers Store',
    knowledge_base: 'Brain',
    billing: 'Billing',
    notifications: 'Notifications',
    shortcuts: 'Shortcuts',
    delete_account: 'Delete account',
}

// The ones the workspace settings store owns. The others already have a store of their own.
export type WorkspaceDialogPanel = Extract<SettingsPanel, 'workspace' | 'members' | 'api_keys' | 'ai_providers' | 'chat_apps' | 'coworker_presets' | 'knowledge_base'>

// The tabs of the Brain dialog: the company pages every agent reads, the changes agents propose to
// them, the links they published, the shared folder and the shared database. The panel id keeps its
// older name.
export const KNOWLEDGE_BASE_TABS = ['company', 'proposals', 'published', 'files', 'database'] as const

export type KnowledgeBaseTab = (typeof KNOWLEDGE_BASE_TABS)[number]
