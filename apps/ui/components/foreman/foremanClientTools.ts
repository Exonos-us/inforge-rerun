'use client'

import { readAgentPicks } from '@/components/foreman/widgets/agent-picks'
import { openAgentPick } from '@/components/foreman/widgets/AgentPickerCard'
import { AGENT_TAB_LABELS, resolveTab } from '@/lib/board/types'
import { isForemanClientTool, type ForemanClientToolName } from '@/lib/foreman/tool-defs'
import { SETTINGS_PANEL_LABELS } from '@/lib/settings/panels'
import { useAccountStore } from '@/stores/account.store'
import { useBillingStore } from '@/stores/billing.store'
import { useBoardStore } from '@/stores/board.store'
import { useNotificationsStore } from '@/stores/notifications.store'
import { useShortcutsStore } from '@/stores/shortcuts.store'
import { useTemplateFlowStore } from '@/stores/template-flow.store'
import { useWorkspaceSettingsStore } from '@/stores/workspace-settings.store'

// The other half of lib/foreman/tool-defs.ts: the tools the server declares but cannot run. Each
// one is an action the user already has under the mouse, so they go through the board store rather
// than a second write path.

type ToolOutput = { ok: true; note?: string } | { ok: false; error: string }

// What the workspace menu knows and a tool call does not: which of its sections exist here. The
// session lives in a React context, so the caller reads it and hands it over.
export type ForemanClientGates = { apiEntitled: boolean; isSandbox: boolean; isAdmin: boolean }

function unknownTab(requested: string, labels: Record<string, string>, noun = 'tab'): string {
    const choices = Object.entries(labels).map(([id, label]) => `${id} ("${label}")`)
    return `Unknown ${noun} "${requested}". Pick one of: ${choices.join(', ')}.`
}

function arg(input: unknown, key: string): unknown {
    return input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
}

function asString(input: unknown, key: string): string | null {
    const value = arg(input, key)
    return typeof value === 'string' && value ? value : null
}

export function runForemanClientTool(name: ForemanClientToolName, input: unknown, gates: ForemanClientGates): ToolOutput {
    const board = useBoardStore.getState()

    switch (name) {
        case 'focus_agent': {
            const agentId = asString(input, 'agentId')
            const requested = asString(input, 'tab') ?? 'chat'
            if (!agentId) return { ok: false, error: 'focus_agent needs agentId.' }
            const tab = resolveTab(requested, AGENT_TAB_LABELS)
            if (!tab) return { ok: false, error: unknownTab(requested, AGENT_TAB_LABELS) }
            openAgentPick({ agentId, tab, conversationId: asString(input, 'conversationId'), runId: asString(input, 'runId') })
            return { ok: true }
        }

        case 'show_agents': {
            const agentIds = readAgentPicks(input).map(pick => pick.agentId)
            if (agentIds.length === 0) return { ok: false, error: 'show_agents needs at least one agentId.' }
            const unknown = agentIds.filter(agentId => !board.agents.some(agent => agent.id === agentId))
            if (unknown.length === agentIds.length) return { ok: false, error: 'None of these ids is a coworker on the board. Take them from the board map.' }
            const shown = 'The list is under your message and nothing opened: they click a row to go there, so do not write the names out again.'
            return { ok: true, note: unknown.length ? `${shown} Left out, no such coworker on the board: ${unknown.join(', ')}.` : shown }
        }

        case 'open_settings': {
            const requested = asString(input, 'panel')
            if (!requested) return { ok: false, error: 'open_settings needs panel.' }
            const panel = resolveTab(requested, SETTINGS_PANEL_LABELS)
            if (!panel) return { ok: false, error: unknownTab(requested, SETTINGS_PANEL_LABELS, 'panel') }
            if ((panel === 'workspace' || panel === 'api_keys') && !gates.isAdmin) {
                return { ok: false, error: `Only an admin of the workspace can open the ${SETTINGS_PANEL_LABELS[panel]} panel, and this user is a member. Say so, and suggest they ask an admin.` }
            }
            if (panel === 'api_keys' && !gates.apiEntitled) {
                return { ok: false, error: 'API keys and the MCP client need an active subscription, and this workspace has none. Say so, and offer to open the billing panel instead.' }
            }
            if (gates.isSandbox && (panel === 'workspace' || panel === 'members' || panel === 'billing')) {
                return { ok: false, error: 'This is the expert sandbox: it has no settings, no members and no billing of its own. Those belong to the real workspace.' }
            }
            switch (panel) {
                case 'workspace':
                case 'members':
                case 'api_keys':
                case 'ai_providers':
                case 'chat_apps':
                case 'global_apps':
                case 'coworker_presets':
                case 'knowledge_base':
                    useWorkspaceSettingsStore.getState().openWorkspacePanel(panel)
                    break
                case 'billing':
                    useBillingStore.getState().openBilling(undefined, 'foreman')
                    break
                case 'notifications':
                    useNotificationsStore.getState().openNotifications()
                    break
                case 'shortcuts':
                    useShortcutsStore.getState().openShortcuts()
                    break
                case 'delete_account':
                    useAccountStore.getState().openAccount('delete')
                    break
            }
            return { ok: true, note: `The ${SETTINGS_PANEL_LABELS[panel]} panel is open in front of the user. They set it themselves from there, so wait for them rather than walking them through it.` }
        }

        case 'open_brain_page': {
            const settings = useWorkspaceSettingsStore.getState()
            const slug = asString(input, 'slug')
            if (arg(input, 'proposals') === true) settings.openKnowledgeBase('proposals')
            else if (slug) settings.openBrainPage(slug)
            else settings.openKnowledgeBase('company')
            return { ok: true, note: 'The Brain is open in front of the user.' }
        }

        case 'open_connector_setup': {
            const agentId = asString(input, 'agentId')
            const slug = asString(input, 'slug')
            if (!agentId || !slug) return { ok: false, error: 'open_connector_setup needs agentId and slug.' }
            return { ok: true, note: `A row leading to the Apps tab is under your message. Tell them to connect ${slug} from there, and do not ask for the credential yourself.` }
        }

        case 'open_template_card': {
            const slug = asString(input, 'slug')
            if (!slug) return { ok: false, error: 'open_template_card needs slug.' }
            useTemplateFlowStore.getState().openLink(slug)
            return { ok: true, note: 'The template card is open in front of the user. They install it from there; wait for them rather than narrating the steps.' }
        }

        case 'recenter_board': {
            board.recenterBoard()
            return { ok: true, note: 'The board is framed on everything it holds. Say what you built, not that you moved the camera.' }
        }
    }
}

export { isForemanClientTool }
export type { ForemanClientToolName }
