import type { AgentModels, AgentView, Conversation } from '@rerun/contracts'
import * as Haptics from 'expo-haptics'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useId, useState } from 'react'
import { View } from 'react-native'
import { useSharedValue } from 'react-native-reanimated'

import { fetchAgentConversations, fetchAgentView } from '@/api/chat'
import { markInboxRead } from '@/api/inbox'
import { fetchAgentModels } from '@/api/models'
import { useAuth } from '@/auth/AuthProvider'
import { supabase } from '@/auth/supabase'
import { coworkerEndpoints } from '@/chat/endpoints'
import { useChatBack } from '@/components/layout/useChatBack'
import { environment } from '@/config/environment'
import { readCoworkerScreen, saveCoworkerScreen } from '@/data/local-cache'
import { useTheme } from '@/theme/theme'

import { ChatHeader, type ChatTab } from './ChatHeader'
import { stateOf } from './conversation-sections'
import { activePageIndex, conversationPages, type ConversationPage } from './conversation-pages'
import { ConversationPager } from './ConversationPager'
import { ConversationPane, type ChatCoworker } from './ConversationPane'
import type { StartedBy } from './origins/StartedByBanner'
import { useOpenChats } from './useOpenChats'

function coworkerOf(agentId: string, view: AgentView | null): ChatCoworker {
    const agent = view?.agent
    return { id: agentId, kind: 'coworker', name: agent?.name ?? '', role: agent?.description ?? '', status: agent?.disabledAt ? 'offline' : (agent?.status ?? 'idle') }
}

const tabOf = (conversation: Conversation): ChatTab | null => (conversation.id ? { id: conversation.id, title: conversation.title, running: conversation.status === 'working', empty: false, status: conversation.status, unseen: conversation.unseen, ask: conversation.ask, automationName: conversation.automationName, updatedAt: conversation.updatedAt } : null)

// A coworker's conversations, on the hub. `sessionId` is null for a new one: the first send creates it,
// and the page keeps its chat while the route learns the new id.
function startedByOf(conversation: Conversation | undefined): StartedBy | null {
    return conversation?.originAgentName ? { agentId: conversation.originAgentId ?? null, name: conversation.originAgentName } : null
}

export function CoworkerChat({ agentId, sessionId }: { agentId: string; sessionId: string | null }) {
    const theme = useTheme()
    const back = useChatBack()
    const { session, me } = useAuth()
    // The header opens on what the last visit read: name, tabs and model are there before the hub answers.
    const [kept] = useState(() => (me ? readCoworkerScreen(me.workspace.id, agentId) : null))
    const [view, setView] = useState<AgentView | null>(kept?.view ?? null)
    const [models, setModels] = useState<AgentModels | null>(kept?.models ?? null)
    const [conversations, setConversations] = useState<Conversation[]>(kept?.conversations ?? [])
    const [conversationsLoaded, setConversationsLoaded] = useState(!!kept?.conversations)
    const [draftKey, setDraftKey] = useState(() => `new-${Date.now()}`)
    const [bornKeys, setBornKeys] = useState<Record<string, string>>({})
    const [activeId, setActiveId] = useState(sessionId)
    // Two chats of the same coworker can be stacked (a push opens a second one): each needs its own
    // channel, supabase.channel() hands back the existing instance for a topic already taken.
    const channelId = useId()
    const [openIds, openChat] = useOpenChats(agentId, sessionId)
    const coworker = coworkerOf(agentId, view)
    const accessToken = session?.access_token
    const workspaceId = me?.workspace.id

    const loadConversations = useCallback(() => {
        if (!accessToken || !workspaceId) return
        fetchAgentConversations({ accessToken, workspaceId }, agentId)
            .then(list => {
                const sorted = [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                setConversations(sorted)
                saveCoworkerScreen(workspaceId, agentId, { conversations: sorted })
            })
            .catch(() => {})
            .finally(() => setConversationsLoaded(true))
    }, [accessToken, workspaceId, agentId])

    useEffect(loadConversations, [loadConversations])

    // Read again when the model sheet closes on a new pick, or the details come back on a new name.
    useFocusEffect(
        useCallback(() => {
            if (!accessToken || !workspaceId) return
            fetchAgentView({ accessToken, workspaceId }, agentId)
                .then(fetched => {
                    setView(fetched)
                    saveCoworkerScreen(workspaceId, agentId, { view: fetched })
                })
                .catch(() => {})
            fetchAgentModels({ accessToken, workspaceId }, agentId)
                .then(fetched => {
                    setModels(fetched)
                    saveCoworkerScreen(workspaceId, agentId, { models: fetched })
                })
                .catch(() => {})
        }, [accessToken, workspaceId, agentId])
    )

    // The status moves on the hub while the page is open (a run ends on a question, another one starts
    // on a schedule): the header's menu sorts them by state, so every row of the coworker is followed live.
    useEffect(() => {
        const channel = supabase
            .channel(`conversations:${agentId}:${channelId}`)
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `agent_id=eq.${agentId}` }, loadConversations)
            .subscribe()
        return () => {
            supabase.removeChannel(channel)
        }
    }, [agentId, channelId, loadConversations])

    // On screen is read: a finished run leaves Unread once its conversation is the open one. Only an
    // Unread one: the inbox's read also sends a waiting conversation back to idle.
    const activeUnseen = !!activeId && conversations.some(conversation => conversation.id === activeId && stateOf(conversation) === 'new')
    useEffect(() => {
        if (!activeUnseen || !activeId || !accessToken || !workspaceId) return
        markInboxRead({ accessToken, workspaceId }, [activeId])
            .then(loadConversations)
            .catch(() => {})
    }, [activeUnseen, activeId, accessToken, workspaceId, loadConversations])

    const open = (id: string) => {
        openChat(id)
        setActiveId(id)
        router.setParams({ id })
    }

    const showDraft = () => {
        setActiveId(null)
        router.setParams({ id: 'new' })
    }

    // A pick in the header ticks on the tap; a swipe has already ticked as it crossed into the page.
    const select = (id: string) => {
        Haptics.selectionAsync()
        open(id)
    }

    const startNew = () => {
        Haptics.selectionAsync()
        showDraft()
    }

    // Born from its first send: the page stays and becomes a tab, and a fresh draft ends the row.
    const onSessionCreated = useCallback(
        (id: string) => {
            setBornKeys(known => ({ ...known, [id]: draftKey }))
            setDraftKey(`new-${Date.now()}`)
            openChat(id)
            setActiveId(id)
            router.setParams({ id })
            loadConversations()
        },
        [draftKey, openChat, loadConversations]
    )

    const pages = conversationPages(openIds, bornKeys, draftKey)
    const activeIndex = activePageIndex(pages, activeId)

    const progress = useSharedValue(activeIndex)

    const settleOn = (index: number) => {
        const sessionAt = pages[index]?.sessionId
        if (sessionAt === undefined) return
        if (sessionAt) open(sessionAt)
        else showDraft()
    }

    const byId = new Map(conversations.map(conversation => [conversation.id, conversation]))
    // One chip per page, even before the hub names the conversation, so the strip lines up with the pager.
    const tabs = openIds.map(id => byId.get(id)).map((conversation, index) => (conversation && tabOf(conversation)) || { id: openIds[index], title: null, running: false, empty: false, loading: !conversationsLoaded })
    const allTabs = conversations.map(tabOf).filter((tab): tab is ChatTab => tab !== null)

    return (
        <View style={{ flex: 1, backgroundColor: theme.background }}>
            <ConversationPager pages={pages} activeIndex={activeIndex} progress={progress} onSettle={settleOn} renderPage={(page: ConversationPage, onScreen) => <ConversationPane coworker={coworker} makeEndpoints={() => coworkerEndpoints(agentId)} initialSessionId={page.sessionId} onSessionCreated={onSessionCreated} models={models} status={(page.sessionId && byId.get(page.sessionId)?.status) || null} onStatusChange={loadConversations} webUrl={`${environment.apiUrl}/?agent=${encodeURIComponent(agentId)}`} onScreen={onScreen} startedBy={startedByOf(page.sessionId ? byId.get(page.sessionId) : undefined)} />} />
            <ChatHeader coworker={coworker} tabs={tabs} activeId={activeId ?? undefined} progress={progress} allSessions={allTabs} onBack={back} onSelect={select} onNewSession={startNew} onOpenDetails={() => router.push({ pathname: '/coworker/[id]', params: { id: agentId, name: coworker.name } })} />
        </View>
    )
}
