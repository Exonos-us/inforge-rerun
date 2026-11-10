'use client'

import { AgentPanelChannels } from '@/components/agent/AgentPanelChannels'
import { AgentPanelData } from '@/components/agent/AgentPanelData'
import { AgentPanelFiles } from '@/components/agent/AgentPanelFiles'
import { AgentPanelLogs } from '@/components/agent/AgentPanelLogs'
import { AgentPanelMcp } from '@/components/agent/AgentPanelMcp'
import { AgentPanelMemories } from '@/components/agent/AgentPanelMemories'
import { AgentPanelMonitoring } from '@/components/agent/AgentPanelMonitoring'
import { AgentPanelScheduled } from '@/components/agent/AgentPanelScheduled'
import { AgentPanelServices } from '@/components/agent/AgentPanelServices'
import { AgentPanelSettings } from '@/components/agent/AgentPanelSettings'
import { AgentPanelSetup } from '@/components/agent/AgentPanelSetup'
import { AgentPanelTools } from '@/components/agent/AgentPanelTools'
import { AgentPanelTriggers } from '@/components/agent/AgentPanelTriggers'
import { AgentPanelSkills } from '@/components/agent/skills/AgentPanelSkills'
import { AgentPublishedPanel } from '@/components/published/AgentPublishedPanel'
import type { AgentViewTab } from '@/lib/board/agent-sheet-views'
import type { IsoAgent } from '@/lib/board/types'
import { useBoardStore } from '@/stores/board.store'

type AgentViewBodyProps = {
    agent: IsoAgent
    tab: AgentViewTab
    onOpenSession: (sessionId: string, title: string, runId: string | null) => void
}

// A deep link into a file, a table, a skill or a routine is read here, where the list that drills into it lives.
export function AgentViewBody({ agent, tab, onOpenSession }: AgentViewBodyProps) {
    const agentFileFocus = useBoardStore(s => s.agentFileFocus)
    const clearAgentFileFocus = useBoardStore(s => s.clearAgentFileFocus)
    const agentDataFocus = useBoardStore(s => s.agentDataFocus)
    const clearAgentDataFocus = useBoardStore(s => s.clearAgentDataFocus)
    const agentSkillFocus = useBoardStore(s => s.agentSkillFocus)
    const clearAgentSkillFocus = useBoardStore(s => s.clearAgentSkillFocus)
    const agentScheduleFocus = useBoardStore(s => s.agentScheduleFocus)
    const clearAgentScheduleFocus = useBoardStore(s => s.clearAgentScheduleFocus)

    switch (tab) {
        case 'services':
            return <AgentPanelServices agentId={agent.id} />
        case 'mcp':
            return <AgentPanelMcp agentId={agent.id} />
        case 'skills':
            return <AgentPanelSkills key={agent.id} agentId={agent.id} focusSlug={agentSkillFocus?.agentId === agent.id ? agentSkillFocus.slug : null} onFocusConsumed={clearAgentSkillFocus} />
        case 'memories':
            return <AgentPanelMemories agentId={agent.id} />
        case 'files':
            return <AgentPanelFiles key={agent.id} agentId={agent.id} focusPath={agentFileFocus?.agentId === agent.id ? agentFileFocus.path : null} onFocusConsumed={clearAgentFileFocus} />
        case 'published':
            return <AgentPublishedPanel key={agent.id} agentId={agent.id} agentName={agent.name} />
        case 'data':
            return (
                <AgentPanelData
                    key={agent.id}
                    agentId={agent.id}
                    initial={agentDataFocus?.agentId === agent.id ? { table: agentDataFocus.table, view: agentDataFocus.view } : null}
                    onInitialConsumed={clearAgentDataFocus}
                />
            )
        case 'scheduled':
            return (
                <AgentPanelScheduled
                    agentId={agent.id}
                    agentName={agent.name}
                    onOpenSession={onOpenSession}
                    focusSlug={agentScheduleFocus?.agentId === agent.id ? agentScheduleFocus.slug : null}
                    onFocusConsumed={clearAgentScheduleFocus}
                />
            )
        case 'triggers':
            return <AgentPanelTriggers agentId={agent.id} onOpenSession={onOpenSession} />
        case 'channels':
            return <AgentPanelChannels agent={agent} />
        case 'monitoring':
            return <AgentPanelMonitoring agentId={agent.id} />
        case 'logs':
            return <AgentPanelLogs agentId={agent.id} />
        case 'settings':
            return <AgentPanelSettings agent={agent} />
        case 'tools':
            return <AgentPanelTools agentId={agent.id} />
        case 'setup':
            return <AgentPanelSetup agentId={agent.id} />
    }
}
