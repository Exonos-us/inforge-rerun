import type { AgentFocusTab } from '@/lib/board/types'

// The screens the coworker card opens in place of the thread. Each one gathers the panel tabs a
// user goes to for the same question; the first tab is the one the screen opens on.
export const AGENT_SHEET_VIEWS = {
    apps: ['services', 'mcp'],
    skills: ['skills'],
    knowledge: ['memories'],
    files: ['files', 'published'],
    data: ['data'],
    routines: ['scheduled', 'triggers'],
    channels: ['channels'],
    activity: ['monitoring', 'logs'],
    settings: ['settings', 'tools', 'setup'],
} as const satisfies Record<string, readonly AgentFocusTab[]>

export type AgentSheetView = keyof typeof AGENT_SHEET_VIEWS

// A tab that lives on one of those screens. `chat` is the thread itself and `actions` its list of
// conversations filtered on what waits for the user, so neither is a screen.
export type AgentViewTab = (typeof AGENT_SHEET_VIEWS)[AgentSheetView][number]

export const AGENT_SHEET_VIEW_LABELS: Record<AgentSheetView, string> = {
    apps: 'Apps',
    skills: 'Skills',
    knowledge: 'Knowledge',
    files: 'Files',
    data: 'Database',
    routines: 'Routines',
    channels: 'Chats',
    activity: 'Activity',
    settings: 'Settings',
}

// Inside a screen a tab is read beside its siblings, where the screen's own name would repeat.
export const AGENT_VIEW_TAB_LABELS: Record<AgentViewTab, string> = {
    services: 'Apps',
    mcp: 'MCP',
    skills: 'Skills',
    memories: 'Knowledge',
    files: 'Files',
    published: 'Published',
    data: 'Database',
    scheduled: 'Scheduled',
    triggers: 'Triggers',
    channels: 'Chats',
    monitoring: 'Monitoring',
    logs: 'Logs',
    settings: 'General',
    tools: 'Capabilities',
    setup: 'Install',
}

const VIEW_OF_TAB = Object.fromEntries((Object.entries(AGENT_SHEET_VIEWS) as [AgentSheetView, readonly AgentViewTab[]][]).flatMap(([view, tabs]) => tabs.map(tab => [tab, view]))) as Record<AgentViewTab, AgentSheetView>

export function isAgentViewTab(tab: AgentFocusTab): tab is AgentViewTab {
    return tab in VIEW_OF_TAB
}

export function agentSheetViewOf(tab: AgentViewTab): AgentSheetView {
    return VIEW_OF_TAB[tab]
}
