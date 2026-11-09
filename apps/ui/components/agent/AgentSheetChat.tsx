'use client'

import type { ThreadRow } from '@/app/api/_services/conversation.service'
import { AgentChat } from '@/components/chat/AgentChat'
import type { MentionAgent } from '@/components/chat/MentionAutocomplete'
import { useAgentSkillSummaries } from '@/hooks/useAgentSkillSummaries'
import { NEW_THREAD_TITLE } from '@/hooks/useSessionTabs'
import { useBoardStore } from '@/stores/board.store'
import { createClient } from '@/supabase/client'
import { selectMaybeSingle } from '@/supabase/supabase-helpers'
import { AgentBuddy } from '@rerun/ui/iso-grid'
import { Stripes } from '@rerun/ui/primitives'
import { useEffect, useMemo, useState } from 'react'

type AgentSheetChatProps = {
    uid: string
    active: boolean
    agentId: string
    sessionId: string | null
    onSessionCreated: (id: string) => void
    initialRunId?: string | null
    arrival?: number
    setup?: { pending: boolean; prompt: string; skipped: boolean; sessionId: string | null }
    onSetupSkipped?: () => void
    onOpenInstall?: (sessionId: string) => void
    onRunFinished?: () => void
    onNewConversation?: () => void
    // The coworker's General: its first message opens it on the hub, its feed hangs the threads.
    kind?: 'general'
    title?: string
    threads?: ThreadRow[]
    onOpenThread?: (sessionId: string, title: string) => void
}

export function AgentSheetChat({ uid, active, agentId, sessionId, onSessionCreated, initialRunId, arrival, setup, onSetupSkipped, onOpenInstall, onRunFinished, onNewConversation, kind, title, threads, onOpenThread }: AgentSheetChatProps) {
    const boardAgents = useBoardStore(s => s.agents)
    const spaces = useBoardStore(s => s.spaces)
    // Every agent of the workspace answers to `call_agent`, whichever Box it sits in. Its own Box
    // opens the list, and only the others carry a Box name, so a single-Box workspace sees none.
    const mentionAgents = useMemo<MentionAgent[]>(() => {
        const self = boardAgents.find(a => a.id === agentId)
        if (!self) return []
        const boxNames = new Map(spaces.map(space => [space.id, space.name]))
        return boardAgents
            .filter(a => a.id !== agentId && !a.disabledAt)
            .map(a => ({ id: a.id, name: a.name, handle: a.handle, hint: a.spaceId === self.spaceId ? undefined : (boxNames.get(a.spaceId) ?? undefined), preferred: a.spaceId === self.spaceId }))
    }, [boardAgents, spaces, agentId])

    const mentionSkills = useAgentSkillSummaries(agentId)

    const [originAgentId, setOriginAgentId] = useState<string | null>(null)
    useEffect(() => {
        setOriginAgentId(null)
        if (!sessionId) return
        selectMaybeSingle(createClient(), 'sessions', ['origin_agent_id'] as const, { id: sessionId })
            .then(({ data }) => setOriginAgentId(data?.origin_agent_id ?? null))
    }, [sessionId])
    const originAgentName = originAgentId ? (boardAgents.find(a => a.id === originAgentId)?.name ?? 'another coworker') : null

    const onSessionInsert = useBoardStore(s => s._onSessionInsert)
    const setSessionStatus = useBoardStore(s => s.setSessionStatus)

    // Deux booléens plutôt que le tableau : un onglet monté en arrière-plan ne se re-rend pas parce
    // qu'une session d'un autre agent a bougé.
    const sessionWorking = useBoardStore(s => s.sessions.some(entry => entry.id === sessionId && entry.status === 'working'))
    const alertPending = useBoardStore(s => s.sessions.some(entry => entry.id === sessionId && entry.status === 'awaiting_ack'))
    const sessionIdle = useBoardStore(s => s.sessions.some(entry => entry.id === sessionId && entry.status === 'idle'))

    const body = useMemo(() => ({ source: 'builder' as const, ...(kind === 'general' && { kind }) }), [kind])
    const agentName = boardAgents.find(a => a.id === agentId)?.name ?? 'your coworker'
    // A thread keeps the default name until the hub has named it after its first message.
    const composerPlaceholder = kind === 'general' || !sessionId || !title || title === NEW_THREAD_TITLE ? `Message ${agentName}...` : `Reply in ${title}...`

    const header = originAgentName ? (
        <div className="relative flex items-center gap-2 mx-3 mt-2 p-3 rounded-md border border-border bg-muted/50">
            <Stripes className="rounded-md" fade="right" />
            {originAgentId && <AgentBuddy agentId={originAgentId} size={20} animated={false} facing="right" className="relative" />}
            <p className="relative flex-1 min-w-0 text-xs text-muted-foreground">
                This session was started by <span className="font-medium text-foreground">{originAgentName}</span>
            </p>
        </div>
    ) : null

    return (
        <AgentChat
            uid={uid}
            active={active}
            agentId={agentId}
            agentName={agentName}
            sessionId={sessionId}
            onSessionCreated={onSessionCreated}
            initialRunId={initialRunId}
            arrival={arrival}
            mentionAgents={mentionAgents}
            mentionSkills={mentionSkills}
            sessionWorking={sessionWorking}
            sessionIdle={sessionIdle}
            alertPending={alertPending}
            body={body}
            header={header}
            setup={setup}
            onSetupSkipped={onSetupSkipped}
            onOpenInstall={onOpenInstall}
            onRunFinished={onRunFinished}
            onNewConversation={onNewConversation}
            onSessionInserted={onSessionInsert}
            onSessionStatusChange={setSessionStatus}
            threads={threads}
            onOpenThread={onOpenThread}
            composerPlaceholder={composerPlaceholder}
        />
    )
}
