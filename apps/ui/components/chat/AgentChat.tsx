'use client'

import { ModelSelector } from '@/components/agent/ModelSelector'
import { ThreadBranch } from '@/components/agent/sheet/ThreadBranch'
import { Context } from '@/components/ai-elements/context'
import { Conversation, ConversationContent, ConversationEmptyState, type ConversationHandle, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent } from '@/components/ai-elements/message'
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion'
import { ActionApprovalBlock } from '@/components/chat/ActionApprovalBlock'
import { AlertBlock } from '@/components/chat/AlertBlock'
import { McpSignInBlock } from '@/components/chat/McpSignInBlock'
import { SecretRequestBlock } from '@/components/chat/SecretRequestBlock'
import { ChatScreen } from '@/components/chat/ChatScreen'
import { BudgetExhaustedNotice } from '@rerun/cloud/billing.client'
import { ProviderErrorNotice } from '@/components/chat/ProviderErrorNotice'
import { ComposerSubscriptionCta } from '@/components/chat/ComposerSubscriptionCta'
import { InstallGate } from '@/components/chat/InstallGate'
import { QuestionForm } from '@/components/chat/QuestionForm'
import type { QuestionFormHandle } from '@rerun/ui/chat'
import { SkillProposalDock } from '@/components/chat/SkillProposalDock'
import { ChatActivityLoader } from '@/components/chat/ChatActivityLoader'
import { useAgentBuddyMood } from '@/hooks/useAgentBuddyMood'
import { useConnectorServices } from '@/hooks/useConnectorServices'
import { AgentBuddy } from '@rerun/ui/iso-grid'
import type { CatalogEntry } from '@rerun/ui/new-agent'
import { ChatComposer, type ChatComposerHandle } from '@/components/chat/ChatComposer'
import { useMentionAutocomplete } from '@/components/chat/MentionAutocomplete'
import { MessageFeedbackDialog } from '@/components/chat/MessageFeedbackDialog'
import { AuthoredGroup } from '@/components/chat/AuthoredGroup'
import { ChatTimeSeparator } from '@/components/chat/ChatTimeSeparator'
import { MessageView } from '@/components/chat/MessageView'
import { ServiceSuggestionBlock } from '@/components/services/ServiceSuggestionBlock'
import { SkeletonChat } from '@/components/ui/skeleton'

import { cancelRunAction, getRunAction } from '@/app/api/_actions/agent.actions'
import { acknowledgeSessionAlertAction, cancelSessionRunsAction, fetchSessionActiveRun, fetchSessionMessages, finalizeSessionAction, openSessionAction } from '@/app/api/_actions/session.actions'
import type { SessionUsageSeed } from '@/app/api/_services/chat.service'
import type { ThreadRow } from '@/app/api/_services/conversation.service'
import { useAgentModel } from '@/hooks/useAgentModel'
import { useWorkspaceConnections } from '@/hooks/useWorkspaceConnections'
import { useArriveByTop } from '@/hooks/useArriveByTop'
import { useMemberProfiles } from '@/hooks/useMemberProfiles'
import { useMessageFeedback } from '@/hooks/useMessageFeedback'
import { useMessageTimes } from '@/hooks/useMessageTimes'
import { useQueuedMessage } from '@/hooks/useQueuedMessage'
import { useRunReconnect } from '@/hooks/useRunReconnect'
import { invalidateAgentSkillSummaries } from '@/hooks/useAgentSkillSummaries'
import { useSkillProposals } from '@/hooks/useSkillProposals'
import { useModelPickerStore } from '@/stores/model-picker.store'
import { useWorkspaceSettingsStore } from '@/stores/workspace-settings.store'
import { useSession } from '@/supabase/session/SessionProvider'
import { useNotificationsStore } from '@/stores/notifications.store'
import { useUnseenRunsStore } from '@/stores/unseen-runs.store'
import { stepGroupShowsActivity } from '@/lib/agent-chat-loader'
import { buildInstallMessage } from '@/lib/chat/install-marker'
import { contextStatsOf } from '@/lib/chat/context-stats'
import { summarizePendingHitl } from '@/lib/chat/hitl-cue'
import { hitlCallBefore } from '@/lib/chat/hitl-receipts'
import { turnRanOutOfPaidCredit } from '@/lib/chat/paid-data-credit'
import { authorTurnsOf } from '@/lib/chat/message-author'
import { splitTurnsAtBreaks, timeBreaksOf } from '@/lib/chat/message-times'
import { threadsByMessage } from '@/lib/chat/thread-rows'
import { shouldFlush, shouldKeepQueued } from '@/lib/chat/queued-message'
import { classifyChatError, installInFlightOf, teammateRunOf, unwrapChatError } from '@/lib/chat-error'
import { findPendingAlert, findPendingHitl, HITL_CANCELLED, pendingApprovals, pendingMcpSignIn, pendingQuestions, pendingSecrets, pendingTakeover, serializeApprovalDecisions } from '@/lib/chat-hitl'
import { lastUserText } from '@/lib/chat-payload'
import { historyCovers, needsReconcile } from '@/lib/chat/transcript-reconcile'
import { browserPermission } from '@/lib/notifications/browser'
import { modelContextWindow } from '@/lib/engine/models'
import { rerunCreditOf } from '@/lib/engine/ai-sources'
import { toGroup } from '@/lib/engine/model-groups'
import { isPremiumModelEntitled } from '@rerun/cloud/billing'
import { createClient } from '@/supabase/client'
import { selectMaybeSingle } from '@/supabase/supabase-helpers'
import { useChat } from '@ai-sdk/react'
import { COWORKER_STARTER_SUGGESTIONS, paidDataSourcesByTurn, RERUN_CONNECTION_ID, runUsesScreen, screenSite } from '@rerun/contracts'
import { track } from '@rerun/analytics/client'
import { AnimatePresence, motion } from 'motion/react'
import { DefaultChatTransport } from 'ai'
import type { ReactNode } from 'react'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { scrollFadeMask, useScrollEdges } from '@rerun/ui/primitives'
import { toast } from 'sonner'

const SCROLL_FADE = 32

export type AgentChatSessionInsert = {
    id: string
    agentId: string
    originAgentId: string | null
    status: 'working' | 'idle' | 'error'
}

type AgentChatProps = {
    uid: string
    active: boolean
    agentId: string
    agentName: string
    sessionId: string | null
    onSessionCreated: (id: string) => void
    initialRunId?: string | null
    // Bumped each time the conversation is opened from somewhere else (a notification, the inbox):
    // it then lands on its latest message, or on the top of the question it is waiting on.
    arrival?: number
    mentionAgents?: { id: string; name: string; handle: string | null }[]
    mentionSkills?: { slug: string; name: string; description?: string }[]
    sessionWorking?: boolean
    sessionIdle?: boolean
    alertPending?: boolean
    body?: Record<string, unknown>
    header?: ReactNode
    suppressEmptyState?: boolean
    setup?: { pending: boolean; prompt: string; skipped: boolean; sessionId: string | null }
    onSetupSkipped?: () => void
    // Opens the conversation the agent's install already runs in.
    onOpenInstall?: (sessionId: string) => void
    onRunFinished?: () => void
    onSessionInserted?: (session: AgentChatSessionInsert) => void
    onSessionStatusChange?: (sessionId: string, status: 'working' | 'idle' | 'error') => void
    onMessageSent?: () => void
    // Opens a blank conversation with this coworker, the way out of one it cannot reach.
    onNewConversation?: () => void
    // General only: the coworker's threads, each hung under the message it was opened after.
    threads?: ThreadRow[]
    onOpenThread?: (sessionId: string, title: string) => void
    composerPlaceholder?: string
}

export function AgentChat({ uid, active, agentId, agentName, sessionId, onSessionCreated, initialRunId, arrival = 0, mentionAgents = [], mentionSkills = [], sessionWorking = false, sessionIdle = false, alertPending = false, body, header, suppressEmptyState = false, setup, onSetupSkipped, onOpenInstall, onRunFinished, onSessionInserted, onSessionStatusChange, onMessageSent, onNewConversation, threads, onOpenThread, composerPlaceholder }: AgentChatProps) {
    const { workspace, user } = useSession()
    const userId = user?.id
    const onSessionCreatedRef = useRef(onSessionCreated)
    onSessionCreatedRef.current = onSessionCreated

    const sessionIdRef = useRef(sessionId)
    sessionIdRef.current = sessionId

    const onSessionInsertedRef = useRef(onSessionInserted)
    onSessionInsertedRef.current = onSessionInserted

    const onMessageSentRef = useRef(onMessageSent)
    onMessageSentRef.current = onMessageSent

    const onRunFinishedRef = useRef(onRunFinished)
    onRunFinishedRef.current = onRunFinished

    const { queued, restoredId: restoredQueuedId, enqueue: enqueueMessage, clear: clearQueued } = useQueuedMessage(uid)

    // The composer owns its own text, draft and attachments (see ChatComposer). What is left here
    // is the handle, for the two paths that hand a message back to it.
    const composerRef = useRef<ChatComposerHandle | null>(null)

    // A pending ask_user replaces the composer, and its free answer takes the mentions over.
    const questionFormRef = useRef<QuestionFormHandle | null>(null)

    // Picking a mention writes `el.value` directly, which fires no React change event, so the
    // hook hands the new text back to whichever of the two is mounted to keep its value in sync.
    const syncMentionTarget = useCallback((text: string) => {
        composerRef.current?.sync(text)
        questionFormRef.current?.sync(text)
    }, [])
    const { inputRef, menu: mentionMenu, tokens: mentionTokens, textareaProps: mentionTextareaProps } = useMentionAutocomplete(mentionAgents, mentionSkills, syncMentionTarget)

    // The field is the composer in the footer or a pending question's answer in the thread, so the
    // menu is placed against the whole chat and sits on the field wherever it is.
    const chatRootRef = useRef<HTMLDivElement>(null)
    const [mentionMenuTop, setMentionMenuTop] = useState(0)
    const mentionMenuOpen = mentionMenu !== null
    useLayoutEffect(() => {
        const root = chatRootRef.current
        const input = inputRef.current
        if (!mentionMenuOpen || !root || !input) return
        setMentionMenuTop(input.getBoundingClientRect().top - root.getBoundingClientRect().top)
    }, [mentionMenuOpen, inputRef])

    // An attachment in flight holds the queued message back until its last byte.
    const [uploading, setUploading] = useState(false)

    const buddyMood = useAgentBuddyMood(agentId)
    const uploadTarget = useMemo(() => ({ kind: 'agent', agentId }) as const, [agentId])

    // Per-conversation model override (see useAgentModel). Read via a ref so the
    // transport body picks up the latest pick without recreating the transport.
    const { selection: modelSelection, select: selectModel } = useAgentModel(agentId)
    const modelSelectionRef = useRef(modelSelection)
    modelSelectionRef.current = modelSelection

    // Extra transport body fields injected by the host (e.g. source).
    // Read via a ref so updates flow without recreating the transport.
    const bodyRef = useRef(body)
    bodyRef.current = body

    const activeRunIdRef = useRef<string | null>(null)

    const interceptFetch = useCallback(
        async (url: string | URL | Request, init?: RequestInit) => {
            const res = await fetch(url, init)
            const newSessionId = res.headers.get('X-Session-Id')
            if (newSessionId && !sessionIdRef.current) {
                sessionIdRef.current = newSessionId
                onSessionCreatedRef.current(newSessionId)
                onSessionInsertedRef.current?.({ id: newSessionId, agentId, originAgentId: null, status: 'working' })
            }
            const runId = res.headers.get('X-Run-Id')
            if (runId) activeRunIdRef.current = runId
            return res
        },
        [agentId]
    )

    const transport = useMemo(
        () =>
            new DefaultChatTransport({
                api: '/api/chat',
                body: () => ({ agentId, sessionId: sessionIdRef.current, connectionId: modelSelectionRef.current.connectionId, model: modelSelectionRef.current.model, ...bodyRef.current }),
                // Send the message being posted, never the transcript: the engine holds the
                // conversation, and a research session's tool outputs alone blow past the 10MB
                // body cap the Next proxy enforces on /api/chat.
                prepareSendMessagesRequest: ({ body, messages }) => ({ body: { ...body, text: lastUserText(messages) } }),
                fetch: interceptFetch as typeof globalThis.fetch,
                prepareReconnectToStreamRequest: () => ({
                    api: `/api/chat/resume?agentId=${encodeURIComponent(agentId)}&runId=${encodeURIComponent(activeRunIdRef.current ?? '')}`,
                }),
            }),
        [agentId, interceptFetch]
    )

    const chatId = `chat-${uid}`

    const completedRef = useRef(false)
    const mountedRef = useRef(true)

    const {
        messages,
        setMessages,
        sendMessage: sendChatMessage,
        regenerate,
        status,
        error,
        clearError,
        resumeStream,
        stop: stopStream,
    } = useChat({
        id: chatId,
        transport,
        // A chunk lands far more often than a frame: without this the whole transcript is
        // reconciled at the rate the tokens arrive, which a long conversation cannot keep up with.
        experimental_throttle: 80,
        onFinish: ({ isAbort, isDisconnect, isError }) => {
            if (!isAbort && !isDisconnect && !isError) {
                completedRef.current = true
            }
            // An installation ends with the agent calling install_complete, which only the engine
            // knows about: re-read it rather than infer the end of the setup from the transcript.
            onRunFinishedRef.current?.()
        },
    })

    // The very first message anyone sends is where the browser notification permission is asked
    // for, through the store's one-shot dialog. A run kicked off elsewhere is not a message the
    // user typed, so it stays out of this.
    const askNotificationPermission = useNotificationsStore(state => state.askPermission)

    // Every answer to an interactive block funnels through here, so this is where a duplicate send
    // is stopped: a second one would start a second run on the same conversation, both replying to
    // the same history and stepping on each other. Latched on a ref because `status` only flips on
    // the next render, well after two callbacks fired from the same one have both read it.
    const sendingRef = useRef(false)
    useEffect(() => {
        if (status === 'ready' || status === 'error') sendingRef.current = false
    }, [status])

    // What the last send carried. A conversation that refuses the message has to give it back
    // rather than swallow it, which is what used to happen behind the "already in flight" wall.
    const lastSentTextRef = useRef<string | null>(null)

    // Whether that last send came from the queue. A refused queued message goes back to waiting,
    // where a refused typed one goes back to the composer the user is still looking at.
    const lastSendQueuedRef = useRef(false)

    // Scrolling up unsticks the conversation for good, so speaking up has to re-arm the follow:
    // otherwise the message just sent, and the answer streaming under it, land off-screen.
    const conversationRef = useRef<ConversationHandle | null>(null)
    const [scroller, setScroller] = useState<HTMLElement | null>(null)
    const [chatRoot, setChatRoot] = useState<HTMLElement | null>(null)
    useEffect(() => {
        setScroller(conversationRef.current?.scrollRef.current ?? null)
        setChatRoot(chatRootRef.current)
    }, [])
    const scrollEdges = useScrollEdges(scroller, { fadeSize: SCROLL_FADE })
    const scrollMask = scrollFadeMask(scrollEdges)

    // Returns whether the message was handed to the SDK: a refused send is not a lost one, and the
    // queue has to know so it can keep holding what it was about to let go of.
    const sendMessage = useCallback(
        (opts: { text: string }, options?: { body?: Record<string, unknown> }): boolean => {
            if (sendingRef.current || status === 'submitted' || status === 'streaming') return false
            sendingRef.current = true
            lastSentTextRef.current = opts.text
            lastSendQueuedRef.current = options?.body?.queued === true
            if (browserPermission() === 'default') askNotificationPermission()
            // Signed here so the bubble carries its author before the transcript is read back.
            sendChatMessage(userId ? { ...opts, metadata: { authorId: userId } } : opts, options)
            conversationRef.current?.scrollToBottom()
            return true
        },
        [sendChatMessage, status, askNotificationPermission, userId]
    )

    // What the user already typed stays, after the reply: they may have pasted the value first.
    const draftReply = useCallback(
        (text: string) => {
            const el = inputRef.current
            if (!composerRef.current?.restore(text) && el && !el.value.startsWith(text)) {
                el.value = `${text}${el.value.trimStart()}`
                el.setSelectionRange(el.value.length, el.value.length)
                composerRef.current?.sync(el.value)
            }
            composerRef.current?.focus()
        },
        [inputRef]
    )

    // ask_user / request_approval now execute a passthrough result and end the
    // turn; the answer comes back as a normal chat message. A call is "awaiting" an
    // answer when the last message is the assistant's and it holds a HITL tool call
    // (no user message has followed yet). It renders as an interactive block at the end
    // of the thread while the composer steps aside; answering sends a plain user message
    // that resumes the run.
    // Only on a conversation nobody has spoken in yet: once the install is under way, the user
    // answers the agent's questions like in any other chat, and a fresh tab offers the button again.
    const showInstallGate = !!setup?.pending && !setup.skipped && messages.length === 0
    const connectors = useConnectorServices(agentId)
    const installApps = useMemo(() => {
        const bySlug = new Map<string, CatalogEntry>()
        for (const service of connectors.map.values()) {
            if (!service.custom && !bySlug.has(service.slug)) bySlug.set(service.slug, { slug: service.slug, name: service.name, icon: service.icon, category: service.category })
        }
        return [...bySlug.values()]
    }, [connectors.map])

    // Closing a block ends the conversation without answering it. A live call never reads `idle` (it
    // goes `working` then `awaiting_*`), so an idle session is one whose block was closed, and it
    // stays closed across a reload.
    const [dismissedHitlCallId, setDismissedHitlCallId] = useState<string | null>(null)

    const pendingHitl = useMemo(() => {
        if (status === 'streaming' || status === 'submitted') return null
        if (sessionIdle) return null
        return findPendingHitl(messages, dismissedHitlCallId)
    }, [messages, status, sessionIdle, dismissedHitlCallId])

    // A tab kept mounted keeps the place it was read at, which may be far up the thread: being
    // sent here re-arms the follow. Once per arrival, so coming back to it by its tab later does not.
    const arrivedRef = useRef(0)
    useEffect(() => {
        if (!active || arrival === arrivedRef.current) return
        arrivedRef.current = arrival
        conversationRef.current?.scrollToBottom('instant')
    }, [active, arrival])
    const pendingHitlRef = useArriveByTop(conversationRef, pendingHitl ? `${pendingHitl.toolCallId}:${arrival}` : null)
    const pendingCue = useMemo(() => (pendingHitl ? { key: pendingHitl.toolCallId, summary: summarizePendingHitl(pendingHitl.kind, pendingHitl.input), blockRef: pendingHitlRef } : null), [pendingHitl, pendingHitlRef])

    // An alert never stopped the run, so it is the session status, not the shape of the transcript,
    // that says whether one is still unread. It stays pinned while the agent keeps working.
    const pendingAlert = useMemo(() => (alertPending ? findPendingAlert(messages) : null), [alertPending, messages])
    const [acknowledging, setAcknowledging] = useState(false)

    // Same value the "To handle" tab shows next to the session, so both surfaces agree on when the
    // agent asked for attention. Tagged with its session so switching conversations never shows the
    // previous one's time while the new fetch is in flight.
    const [alertAt, setAlertAt] = useState<{ sessionId: string; at: string | null } | null>(null)
    const pendingAlertToolCallId = pendingAlert?.toolCallId ?? null
    useEffect(() => {
        if (!alertPending || !sessionId) return
        let cancelled = false
        void selectMaybeSingle(createClient(), 'sessions', ['updated_at'] as const, { id: sessionId }).then(({ data }) => {
            if (!cancelled) setAlertAt({ sessionId, at: data?.updated_at ?? null })
        })
        return () => {
            cancelled = true
        }
    }, [alertPending, sessionId, pendingAlertToolCallId])

    // Raised by the agent mid-turn, decided here without a message and without a run: accepting
    // starts the writing on the engine and this row reports it when it lands.
    const skillProposals = useSkillProposals(sessionId ?? null, status)

    // An accepted proposal is written in the background and lands after the turn that raised it,
    // so the `/` menu learns about the new skill here rather than from the end of a run.
    const undecidedProposalIdsRef = useRef<ReadonlySet<string>>(new Set())
    useEffect(() => {
        const undecided = new Set<string>()
        let landed = false
        for (const proposal of skillProposals.proposals.values()) {
            if (proposal.status === 'proposed' || proposal.status === 'accepted') undecided.add(proposal.id)
            else if (proposal.status === 'applied' && undecidedProposalIdsRef.current.has(proposal.id)) landed = true
        }
        undecidedProposalIdsRef.current = undecided
        if (landed) invalidateAgentSkillSummaries(agentId)
    }, [skillProposals.proposals, agentId])

    const acknowledgeAlert = useCallback(async () => {
        if (!sessionId) return
        setAcknowledging(true)
        try {
            await acknowledgeSessionAlertAction(sessionId)
            onSessionStatusChange?.(sessionId, 'idle')
        } finally {
            setAcknowledging(false)
        }
    }, [sessionId, onSessionStatusChange])

    // Usage of the session's last finished run, fetched on history load so the
    // context gauge shows immediately when reopening a conversation (the loaded
    // history messages themselves carry no usage metadata).
    const [seededUsage, setSeededUsage] = useState<SessionUsageSeed | null>(null)

    const contextStats = useMemo(() => contextStatsOf(messages, seededUsage, modelSelection.model), [messages, modelSelection.model, seededUsage])

    // Terminal run error (e.g. missing API key) surfaced to the user. Kept in its
    // own state because the reconnect flow clears useChat's internal `error`, and
    // because a genuine run failure must stay visible (not be swallowed as a drop).
    const [runError, setRunError] = useState<string | null>(null)

    // A failure read back from the engine on reopening, rather than one this tab just streamed. It
    // was reported when it happened, and a budget refusal is over once the credit has room again:
    // a payment made since must not meet the same notice on the way back.
    const rerunCredit = useMemo(() => rerunCreditOf(workspace), [workspace])
    const creditHasRoom = !rerunCredit.paused && rerunCredit.budgetMicros > rerunCredit.usedMicros
    const creditHasRoomRef = useRef(creditHasRoom)
    useEffect(() => {
        creditHasRoomRef.current = creditHasRoom
    }, [creditHasRoom])
    const replayedRunErrorRef = useRef<string | null>(null)
    const showReplayedRunError = useCallback((error: string) => {
        if (creditHasRoomRef.current && classifyChatError(unwrapChatError(error)) === 'budget') return
        replayedRunErrorRef.current = error
        setRunError(error)
    }, [])

    // Clear a previously surfaced run error whenever a fresh turn starts or the
    // conversation switches, so a stale failure banner never lingers.
    useEffect(() => {
        if (status !== 'submitted' && status !== 'streaming') return
        setRunError(null)
        replayedRunErrorRef.current = null
    }, [status])

    useEffect(() => {
        setRunError(null)
    }, [sessionId])

    const [historyLoading, setHistoryLoading] = useState(false)
    const historyLoadedRef = useRef<string | null>(null)
    // The session whose snapshot is on its way: it answers the active-run question too, so the
    // separate lookup below waits for it instead of racing it.
    const [snapshotPendingFor, setSnapshotPendingFor] = useState<string | null>(null)
    const sessionWorkingRef = useRef(sessionWorking)
    const seedProposalsRef = useRef(skillProposals.seed)
    const refreshProposalsRef = useRef(skillProposals.refresh)
    useEffect(() => {
        sessionWorkingRef.current = sessionWorking
        seedProposalsRef.current = skillProposals.seed
        refreshProposalsRef.current = skillProposals.refresh
    })
    const proposalsLoadedRef = useRef<string | null>(null)
    const [attachRunId, setAttachRunId] = useState<string | null>(initialRunId ?? null)
    const attachedRunRef = useRef<string | null>(null)

    useEffect(() => {
        setSeededUsage(null)
    }, [sessionId])

    // Opening a conversation reads its results, and a run finishing while it is on screen is read too.
    useEffect(() => {
        if (!active || !sessionId) return
        return useUnseenRunsStore.getState().view(sessionId)
    }, [active, sessionId])

    useEffect(() => {
        if (!active || !sessionId || historyLoadedRef.current === sessionId || messages.length > 0) return
        // Session de kickoff : l'effet de rattachement plus bas possède le chargement initial
        // (retry tant que l'engine n'a pas persisté le message, puis replay du stream).
        if (initialRunId) return
        historyLoadedRef.current = sessionId
        setHistoryLoading(true)
        setSnapshotPendingFor(sessionId)
        openSessionAction(sessionId)
            .then(snapshot => {
                // A run attached while this fetch was in flight: the transcript is the stream's
                // now, and writing the persisted history back would wipe what it has emitted.
                if (snapshot.messages.length > 0 && !attachedRunRef.current) {
                    setMessages(snapshot.messages as Parameters<typeof setMessages>[0])
                }
                if (snapshot.usage) setSeededUsage(snapshot.usage)
                seedProposalsRef.current(sessionId, snapshot.proposals)
                proposalsLoadedRef.current = sessionId
                if (sessionIdRef.current !== sessionId) return
                // The engine never writes a failure into the transcript, so without this a run that
                // died before answering leaves the conversation looking like nothing ever happened.
                if (snapshot.lastError) showReplayedRunError(snapshot.lastError)
                if (snapshot.activeRunId && sessionWorkingRef.current && !activeRunIdRef.current) setAttachRunId(snapshot.activeRunId)
            })
            .catch(() => {})
            .finally(() => {
                setHistoryLoading(false)
                setSnapshotPendingFor(null)
            })
    }, [active, sessionId, messages.length, setMessages, initialRunId, showReplayedRunError])

    const reconnecting = useRunReconnect({
        error,
        completedRef,
        start: () => {
            const runId = activeRunIdRef.current
            const sid = sessionIdRef.current
            if (!runId || !sid) return null
            return {
                runId,
                getRun: () => getRunAction(agentId, runId),
                fetchMessages: () => fetchSessionMessages(sid),
                onSettled: async ({ errored, errorText }) => {
                    await finalizeSessionAction(sid, errored ? 'error' : 'idle').catch(() => {})
                    activeRunIdRef.current = null
                    if (errorText) setRunError(errorText)
                },
            }
        },
        resumeStream,
        setMessages: setMessages as (messages: never[]) => void,
        clearError,
    })

    // Whether the conversation is busy at all, this tab's own stream included. It decides the
    // loader, whether a message goes out or waits in the queue, and what the send button offers.
    const showLoader = status === 'submitted' || status === 'streaming' || sessionWorking || reconnecting

    // The queued message this render already handed over. `status` only flips to `submitted` on the
    // next render, so without this ref the flush effect fires again and sends the message twice.
    const flushingRef = useRef<string | null>(null)
    useEffect(() => {
        if (status !== 'ready') flushingRef.current = null
    }, [status])

    const prevStatusRef = useRef(status)
    useEffect(() => {
        if (status === 'submitted' && prevStatusRef.current !== 'submitted') {
            track('agent_run_started', { agent_id: agentId })
        }
        prevStatusRef.current = status
    }, [status, agentId])

    const prevRunErrorRef = useRef<string | null>(null)
    useEffect(() => {
        // A run that reached the engine is reported by the hub when it ends. A budget refusal can stop
        // the request before any run exists, so that one is only visible from here.
        if (runError && !prevRunErrorRef.current && runError !== replayedRunErrorRef.current && classifyChatError(unwrapChatError(runError)) === 'budget') {
            track('agent_run_failed', { agent_id: agentId, error_type: 'budget_exhausted' })
        }
        prevRunErrorRef.current = runError
    }, [runError, agentId])

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
        }
    }, [])

    // Reachable whenever the conversation reads as busy, including after a reload where this tab
    // never streamed anything: without that, a run the provider wedged had no way out at all.
    // Awaited rather than fired and forgotten because `abortRun` frees the engine's session claim
    // before it answers, so this return is what says the next message may go out.
    const stopRun = useCallback(async (): Promise<boolean> => {
        stopStream()
        const runId = activeRunIdRef.current
        const sid = sessionIdRef.current
        activeRunIdRef.current = null
        clearError()
        if (sid) {
            onSessionStatusChange?.(sid, 'idle')
            finalizeSessionAction(sid, 'idle').catch(() => {})
        }
        if (runId) {
            // Covers a run this tab never held the id of: only the engine knows the full list. Awaited
            // with the stop itself: left running, it lands after a queued message has started its own
            // run and cancels that one too, so the message never gets an answer.
            const [, stopped] = await Promise.all([sid ? cancelSessionRunsAction(sid).catch(() => false) : false, cancelRunAction(agentId, runId)])
            return stopped
        }
        return sid ? cancelSessionRunsAction(sid) : false
    }, [stopStream, agentId, onSessionStatusChange, clearError])

    const handleStop = useCallback(() => {
        void stopRun()
    }, [stopRun])

    const dismissHitl = useCallback(
        (toolCallId: string) => {
            setDismissedHitlCallId(toolCallId)
            void stopRun()
        },
        [stopRun]
    )

    const [stopping, setStopping] = useState(false)

    // Sending a queued message right away means ending the run holding the conversation. The send
    // itself is left to the flush effect: starting a request in the same tick as `stopStream()`
    // would leave two streams writing into the same transcript.
    const sendQueuedNow = useCallback(async () => {
        if (!queued) return
        setStopping(true)
        // The banner of a run that already failed would otherwise keep the flush from firing, and
        // this click is the user saying they want the message out regardless.
        setRunError(null)
        const stopped = await stopRun()
        setStopping(false)
        if (!stopped) toast.error('Could not stop the current run. Your message will be sent when it ends.')
    }, [queued, stopRun, setRunError, setStopping])

    // The install this tab just asked for already runs in another conversation, started from a tab
    // or a device this one had not heard of yet. Nothing was sent: the tab goes back to blank and
    // the user lands in the install under way.
    useEffect(() => {
        if (!error) return
        const inFlight = installInFlightOf(error.message)
        if (!inFlight) return
        lastSentTextRef.current = null
        setMessages([])
        clearError()
        onOpenInstall?.(inFlight.sessionId)
    }, [error, setMessages, clearError, onOpenInstall])

    // The engine refused the send because the conversation still holds a run. The text would
    // otherwise be dropped server-side and never seen again.
    useEffect(() => {
        if (!error) return
        if (classifyChatError(unwrapChatError(error.message)) !== 'run_in_flight') return
        const text = lastSentTextRef.current
        lastSentTextRef.current = null
        if (!text) return
        // A queued message goes back to waiting rather than into the composer: it left on its own
        // and it will leave on its own again, without asking the user to press send a second time.
        // So does a message that ran into a teammate's run: it is new to the agent, and the run
        // holding the conversation is not this person's to stop.
        const teammateRun = teammateRunOf(error.message)
        if (lastSendQueuedRef.current || teammateRun) {
            lastSendQueuedRef.current = false
            enqueueMessage(text, teammateRun?.runId ?? activeRunIdRef.current)
            return
        }
        composerRef.current?.restore(text)
    }, [error, enqueueMessage])

    // Whether the agent has a usable model (an active provider + a picked model). Reported
    // by the ModelSelector; gates sending so we never silently fall back to an unconfigured
    // default model. Starts true so we don't block before the selector has reported.
    const [modelReady, setModelReady] = useState(true)
    // Whether the Box holds a connection of its own, reported by the ModelSelector: the subscription
    // pitch is for the users who brought none. Starts true so it never flashes before that answer.
    const [hasOwnConnection, setHasOwnConnection] = useState(true)
    const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null)
    const [refusedModel, setRefusedModel] = useState<string | null>(null)
    // Credentials belong to the workspace, so both the subscription strip and the error notices'
    // action cells leave the chat for the AI providers dialog.
    const openAiProviders = useWorkspaceSettingsStore(state => state.openAiProviders)
    const manageModels = useCallback(() => {
        openAiProviders()
    }, [openAiProviders])
    // A plan that is out, or that does not include the model, is fixed by picking another model for
    // this conversation, which is the composer's picker rather than the credentials dialog.
    const requestModelPicker = useModelPickerStore(state => state.request)
    const switchModel = useCallback(() => requestModelPicker(uid), [requestModelPicker, uid])
    // The keyless Rerun connection has no sign-in of its own, so it keeps the plain list.
    const reconnectAiProvider = useWorkspaceSettingsStore(state => state.reconnectAiProvider)
    const reconnectProvider = useCallback(() => {
        if (activeConnectionId && activeConnectionId !== RERUN_CONNECTION_ID) reconnectAiProvider(activeConnectionId)
        else openAiProviders()
    }, [activeConnectionId, openAiProviders, reconnectAiProvider])
    // Same destination as manageModels, tracked apart: this one is a discovery pitch, not a repair.
    const connectSubscription = useCallback(() => {
        track('connection_cta_clicked', { source: 'chat_composer' })
        manageModels()
    }, [manageModels])
    const addAiProvider = useWorkspaceSettingsStore(state => state.addAiProvider)
    // A Claude or ChatGPT plan already plugged into the Box, the Box default first. A conversation
    // that ran into the Rerun credit while one is there was pinned to Rerun: the way out is to run it
    // on that plan, not to sign in to it again.
    const { connections, boxDefault } = useWorkspaceConnections()
    const ownConnection = useMemo(() => {
        const own = connections.filter(connection => connection.connected && connection.id !== RERUN_CONNECTION_ID)
        return own.find(connection => connection.id === boxDefault?.connectionId) ?? own[0] ?? null
    }, [connections, boxDefault])
    const premiumAllowed = !workspace || isPremiumModelEntitled(workspace)
    const runOnOwnConnection = useMemo(() => {
        if (!ownConnection) return undefined
        const onUse = () => {
            track('connection_cta_clicked', { source: 'budget_notice_use_connection' })
            // The Box default is resolved by the engine on every run, so following it beats freezing it.
            if (boxDefault?.connectionId === ownConnection.id) selectModel({})
            else selectModel({ connectionId: ownConnection.id, model: toGroup(ownConnection, premiumAllowed).defaultModel })
            setRunError(null)
            clearError()
        }
        return { label: ownConnection.name, provider: ownConnection.provider, onUse }
    }, [ownConnection, boxDefault, premiumAllowed, selectModel, clearError])
    const connectProvider = useCallback(
        (provider: 'claude' | 'codex') => {
            track('connection_cta_clicked', { source: `budget_notice_${provider}` })
            addAiProvider(provider)
        },
        [addAiProvider]
    )
    const [hintArmed, setHintArmed] = useState(false)
    // Only surface the hint while it's both armed (a blocked send) and still no model.
    const showModelHint = hintArmed && !modelReady
    // Shared by the composer and the install gate, which both refuse to run without a model.
    const modelHint = showModelHint ? <p className="text-xs text-destructive">{refusedModel ?? 'Select a model to start — open the model menu below.'}</p> : null
    // A model the plan refuses has served models next to it: the picker opens on them right away.
    const blockSend = useCallback(() => {
        setHintArmed(true)
        if (refusedModel) switchModel()
    }, [refusedModel, switchModel])

    // Run already in flight when the conversation opens: the kickoff started server-side right
    // after agent creation (see startKickoffAction), or a run a schedule / a trigger / another
    // agent started on its own. Both attach the same way, only the run id is found differently:
    // the kickoff hands it over, the others are resolved from the engine below.
    useEffect(() => {
        if (initialRunId) setAttachRunId(initialRunId)
    }, [initialRunId])

    useEffect(() => {
        if (!active || !sessionId || !sessionWorking || attachRunId || status !== 'ready') return
        if (snapshotPendingFor === sessionId) return
        // This chat is streaming its own run: attaching would be reattaching to itself.
        if (activeRunIdRef.current) return
        let cancelled = false
        fetchSessionActiveRun(sessionId)
            .then(runId => {
                if (!cancelled && runId) setAttachRunId(runId)
            })
            .catch(() => {})
        return () => {
            cancelled = true
        }
    }, [active, sessionId, sessionWorking, attachRunId, status, snapshotPendingFor])

    const messagesRef = useRef(messages)
    useEffect(() => {
        messagesRef.current = messages
    }, [messages])

    // Load the persisted messages (retrying while the engine hasn't written the first one yet),
    // then replay the run stream from its start via /api/chat/resume, and read the transcript back
    // once the run is over so nothing the replay got wrong survives it.
    useEffect(() => {
        if (!attachRunId || !active || !sessionId || attachedRunRef.current === attachRunId) return
        attachedRunRef.current = attachRunId
        historyLoadedRef.current = sessionId
        activeRunIdRef.current = attachRunId
        if (proposalsLoadedRef.current !== sessionId) {
            proposalsLoadedRef.current = sessionId
            refreshProposalsRef.current().catch(() => {})
        }
        const wait = () => new Promise(r => setTimeout(r, 600))
        ;(async () => {
            setHistoryLoading(true)
            try {
                for (let i = 0; i < 5; i++) {
                    const data = await fetchSessionMessages(sessionId).catch(() => [])
                    if (data.length > 0) {
                        if (mountedRef.current) setMessages(data as Parameters<typeof setMessages>[0])
                        break
                    }
                    await wait()
                }
            } finally {
                if (mountedRef.current) setHistoryLoading(false)
            }
            if (!mountedRef.current) return
            // The run id came from a list that may be seconds old, and the history above may already
            // hold the answer. Replaying a finished run onto its own persisted answer lands every tool
            // call twice: the SDK matches streamed `dynamic-tool` parts by type, never the static
            // `tool-<name>` parts the history gave it, so the streamed copies stay "running" for good.
            // Its buffer outlives the run by minutes, so the engine's status is what decides.
            const run = await getRunAction(agentId, attachRunId).catch(() => null)
            if (!mountedRef.current) return
            // The run this conversation was opened on already carries its own failure: a schedule
            // opened from the inbox has no stream left to replay the error through.
            if (run?.status === 'error' && run.error && sessionIdRef.current === sessionId) showReplayedRunError(run.error)
            if (!run || run.status === 'running') await resumeStream().catch(() => {})
            // The engine writes the assistant row after its stream closed, so the transcript can lag
            // the replay by a moment. The live transcript is read after the fetch, once React has
            // rendered the replay's last write. A send that left from this tab meanwhile owns it.
            for (let i = 0; i < 5 && mountedRef.current; i++) {
                const data = await fetchSessionMessages(sessionId).catch(() => [])
                if (!mountedRef.current || sendingRef.current) return
                const live = messagesRef.current
                if (!needsReconcile(live)) return
                if (historyCovers(live, data)) {
                    setMessages(data as Parameters<typeof setMessages>[0])
                    return
                }
                await wait()
            }
        })()
    }, [attachRunId, initialRunId, active, sessionId, agentId, resumeStream, setMessages, showReplayedRunError])

    // Inline, this arrow would be a new prop on every render and would defeat MessageView's memo
    // for every message of the conversation.
    const handleRegenerate = useCallback((messageId: string) => regenerate({ messageId }), [regenerate])
    const messageFeedback = useMessageFeedback(sessionId)
    const continueInterruptedRun = useCallback(() => sendMessage({ text: 'Continue where you left off.' }), [sendMessage])
    // The failed turn's message is already in the conversation, on screen and on the engine:
    // regenerating sends it again without a second bubble, dropping whatever partial answer followed.
    const retryLastTurn = useCallback(() => {
        if (sendingRef.current || status === 'submitted' || status === 'streaming') return
        sendingRef.current = true
        lastSentTextRef.current = null
        lastSendQueuedRef.current = false
        void regenerate()
    }, [regenerate, status])
    const canRetry = messages.some(message => message.role === 'user')

    const enqueueFromComposer = useCallback(
        (text: string) => {
            // Asked here, while the click is still a user activation: a queued message never goes
            // through sendMessage, which is where the prompt is raised for a message that leaves.
            if (browserPermission() === 'default') askNotificationPermission()
            enqueueMessage(text, activeRunIdRef.current)
            conversationRef.current?.scrollToBottom()
        },
        [askNotificationPermission, enqueueMessage]
    )

    const messageTimes = useMessageTimes(messages)
    const lastAssistant = messages.findLastIndex(message => message.role === 'assistant')
    const timeBreaks = useMemo(() => timeBreaksOf(messageTimes), [messageTimes])
    const threadRows = useMemo(() => threadsByMessage(messageTimes, threads ?? []), [messageTimes, threads])
    const threadBranches = (rows: ThreadRow[] | undefined) => rows?.map(thread => <ThreadBranch key={thread.id} thread={thread} onOpen={() => onOpenThread?.(thread.id, thread.title)} />)
    const authorTurns = useMemo(() => splitTurnsAtBreaks(authorTurnsOf(messages), timeBreaks), [messages, timeBreaks])
    const authorIds = useMemo(() => [...new Set(authorTurns.flatMap(turn => (turn.authorId ? [turn.authorId] : [])))], [authorTurns])
    const profileOf = useMemberProfiles(workspace?.id, authorIds)

    const displayedError = runError || (error && !reconnecting) ? unwrapChatError(runError ?? error?.message) : null
    const errorKind = displayedError === null ? null : classifyChatError(displayedError)
    const outOfPaidCredit = useMemo(() => turnRanOutOfPaidCredit(messages), [messages])
    const paidSourcesByTurn = useMemo(() => paidDataSourcesByTurn(messages), [messages])

    // The queued message leaves as soon as the conversation is free again. The engine only drops
    // its session claim once the run has torn its provider down, well after this stream closed, so
    // the send often lands on a 409 first: the route retries, and the effect above puts the message
    // back in the queue if it never got through.
    const canFlush = shouldFlush({ queued, busy: showLoader, uploading, status, hasError: displayedError !== null })
    useEffect(() => {
        if (!canFlush || !queued || flushingRef.current) return
        flushingRef.current = queued.id
        // Only let go of the message once the send has actually been taken.
        if (!sendMessage({ text: queued.text }, { body: { queued: true } })) {
            flushingRef.current = null
            return
        }
        clearQueued()
        onMessageSentRef.current?.()
    }, [canFlush, queued, clearQueued, sendMessage])

    // A message found waiting when the chat opened only stays waiting while the run it was queued
    // behind is still the one running. Otherwise a tab reopened days later would fire off, on its
    // own, a message nobody is expecting anymore: it goes back to the composer instead.
    useEffect(() => {
        if (!active || !queued || queued.id !== restoredQueuedId || flushingRef.current || stopping) return
        const activeRunId = attachRunId ?? activeRunIdRef.current
        // A reload reads the conversation as busy before it knows which run is holding it.
        if (activeRunId === null && showLoader) return
        if (shouldKeepQueued(queued, activeRunId)) return
        if (!composerRef.current?.restore(queued.text)) return
        clearQueued()
    }, [queued, restoredQueuedId, active, attachRunId, showLoader, stopping, clearQueued])

    const footerVisible = !pendingHitl || !!pendingAlert || skillProposals.pinned.length > 0

    const takeoverAsk = pendingHitl?.kind === 'takeover' ? { callId: pendingHitl.toolCallId, request: pendingTakeover(pendingHitl.input) } : null
    const runOnScreen = useMemo(() => runUsesScreen(messages), [messages])
    // The live screen stands in for the activity loader while the run works on it.
    const screenShown = (showLoader && runOnScreen) || !!takeoverAsk
    const activityLoader = showLoader && !stepGroupShowsActivity(messages.at(-1)) ? <ChatActivityLoader agentId={agentId} message={messages.at(-1)} indicator={<AgentBuddy agentId={agentId} mood="working" size={24} facing="right" />} /> : null

    return (
        <div ref={chatRootRef} data-chat-scrolled={active && scrollEdges.top > 0 ? '' : undefined} className="relative flex flex-1 flex-col overflow-hidden">
            {header}
            {/* History lands after mount, as a resize: animating it would scroll the whole
                conversation in front of the user. Only a reply being written is followed smoothly. */}
            <Conversation className="flex-1" contextRef={conversationRef} initial="instant" resize={status === 'streaming' || status === 'submitted' ? 'smooth' : 'instant'}>
                <div className="h-full" style={{ maskImage: scrollMask, WebkitMaskImage: scrollMask }}>
                    <ConversationContent>
                        {historyLoading && <SkeletonChat className="py-2" />}
                        {threadRows.leading.length > 0 && !historyLoading && <div className="flex flex-col gap-3">{threadBranches(threadRows.leading)}</div>}
                        {messages.length === 0 && threadRows.leading.length === 0 && !suppressEmptyState && !historyLoading && !showInstallGate && (
                            <ConversationEmptyState>
                                <AgentBuddy agentId={agentId} mood={buddyMood} size={96} />
                                <div className="space-y-1">
                                    <h3 className="font-medium text-sm">Start a conversation</h3>
                                    <p className="text-muted-foreground text-sm">Send a message to this coworker</p>
                                </div>
                                <Suggestions className="mt-2 justify-center">
                                    {COWORKER_STARTER_SUGGESTIONS.map(s => (
                                        <Suggestion key={s} suggestion={s} onClick={text => sendMessage({ text })} />
                                    ))}
                                </Suggestions>
                            </ConversationEmptyState>
                        )}
                        {authorTurns.map(turn => {
                            const views = turn.items.map(({ message, index: mi }) => {
                                const isLast = mi === messages.length - 1
                                const isActive = isLast && (status === 'streaming' || status === 'submitted')
                                const hitlCall = hitlCallBefore(messages, mi)
                                const branches = threadBranches(threadRows.after.get(mi))
                                const view = (
                                    <MessageView
                                        key={message.id}
                                        message={message}
                                        isActive={isActive}
                                        isLastAssistant={mi === lastAssistant}
                                        agentId={agentId}
                                        pendingHitlToolCallId={pendingHitl?.toolCallId}
                                        pendingMcpSignIn={pendingHitl?.kind === 'mcp' ? pendingMcpSignIn(pendingHitl.input).name : undefined}
                                        hitlCall={hitlCall}
                                        pendingAlertToolCallId={pendingAlert?.toolCallId ?? undefined}
                                        activeRunId={activeRunIdRef.current}
                                        onSendMessage={sendMessage}
                                        onDraftReply={draftReply}
                                        showQuickReplies={isLast && !showLoader && !pendingHitl && !pendingAlert && displayedError === null}
                                        onRegenerate={isLast && pendingHitl ? undefined : handleRegenerate}
                                        onRateMessage={sessionId ? messageFeedback.rate : undefined}
                                        feedbackRating={messageFeedback.votes.get(message.id)?.rating ?? null}
                                        skillProposals={skillProposals.proposals}
                                        decidingProposalId={skillProposals.pendingId}
                                        onDecideProposal={skillProposals.decide}
                                        pinnedProposalIds={skillProposals.pinnedIds}
                                        installing={setup?.pending === true}
                                        mentions={mentionTokens}
                                        createdAt={messageTimes[mi]}
                                        paidSources={paidSourcesByTurn.get(message.id)}
                                    />
                                )
                                if (!branches?.length) return view
                                return (
                                    <Fragment key={message.id}>
                                        {view}
                                        {branches}
                                    </Fragment>
                                )
                            })
                            const opening = turn.items[0].index
                            return (
                                <Fragment key={turn.key}>
                                    {timeBreaks.has(opening) && <ChatTimeSeparator createdAt={messageTimes[opening]} />}
                                    {turn.authorId ? <AuthoredGroup author={profileOf(turn.authorId)}>{views}</AuthoredGroup> : views}
                                </Fragment>
                            )
                        })}
                        {pendingHitl && pendingHitl.kind !== 'takeover' && (
                            <motion.div key={pendingHitl.toolCallId} ref={pendingHitlRef} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}>
                                {pendingHitl.kind === 'question' && <QuestionForm inline ref={questionFormRef} agentId={agentId} questions={pendingQuestions(pendingHitl.input)} onSend={text => sendMessage({ text })} onCancel={() => dismissHitl(pendingHitl.toolCallId)} textareaRef={inputRef} textareaProps={mentionTextareaProps} />}
                                {pendingHitl.kind === 'approval' && <ActionApprovalBlock inline approvals={pendingApprovals(pendingHitl.input)} onSubmit={decisions => sendMessage({ text: serializeApprovalDecisions(decisions) })} />}
                                {pendingHitl.kind === 'secret' && agentId && <SecretRequestBlock inline agentId={agentId} sessionId={sessionId ?? null} secrets={pendingSecrets(pendingHitl.input)} reason={typeof pendingHitl.input.reason === 'string' ? pendingHitl.input.reason : undefined} onDone={summary => sendMessage({ text: summary })} onSkip={() => sendMessage({ text: HITL_CANCELLED.secret })} onDismiss={() => dismissHitl(pendingHitl.toolCallId)} />}
                                {pendingHitl.kind === 'mcp' && agentId && <McpSignInBlock inline agentId={agentId} {...pendingMcpSignIn(pendingHitl.input)} onDone={summary => sendMessage({ text: summary })} onSkip={() => sendMessage({ text: HITL_CANCELLED.mcp })} />}
                                {pendingHitl.kind === 'service' && agentId && <ServiceSuggestionBlock inline agentId={agentId} services={(Array.isArray(pendingHitl.input.services) ? pendingHitl.input.services : []) as { slug: string; reason?: string }[]} onDone={summary => sendMessage({ text: summary })} />}
                            </motion.div>
                        )}
                        {screenShown && (
                            <ChatScreen
                                agentId={agentId}
                                active={active}
                                site={screenSite(messages, takeoverAsk?.request.url ?? null)}
                                takeoverAsk={takeoverAsk}
                                onTakeoverDone={summary => sendMessage({ text: summary })}
                                onTakeoverSkip={() => sendMessage({ text: HITL_CANCELLED.takeover })}
                                scroller={scroller}
                                floatingHost={chatRoot}
                                arriveRef={takeoverAsk ? pendingHitlRef : undefined}
                                fallback={activityLoader}
                            />
                        )}
                        {!screenShown && activityLoader}
                        {outOfPaidCredit && !showLoader && displayedError === null && (
                            <Message from="assistant">
                                {/* Paid data only runs on Rerun credit: connecting a Claude or ChatGPT plan would not buy it. */}
                                <MessageContent>
                                    <BudgetExhaustedNotice trialing={workspace?.subscription_status === 'trialing'} paused={!!workspace?.rerun_credit_paused_at} noCredit={rerunCredit.budgetMicros === 0} />
                                </MessageContent>
                            </Message>
                        )}
                        {displayedError !== null && errorKind !== null && (
                            <Message from="assistant">
                                <MessageContent>{errorKind === 'budget' ? <BudgetExhaustedNotice onConnectProvider={connectProvider} ownConnection={runOnOwnConnection} trialing={workspace?.subscription_status === 'trialing'} paused={!!workspace?.rerun_credit_paused_at} noCredit={rerunCredit.budgetMicros === 0} /> : <ProviderErrorNotice kind={errorKind} message={displayedError} onSwitchModel={switchModel} onReconnect={reconnectProvider} onStopRun={handleStop} onContinue={continueInterruptedRun} onRetry={canRetry ? retryLastTurn : undefined} onNewConversation={onNewConversation} />}</MessageContent>
                            </Message>
                        )}
                    </ConversationContent>
                </div>
                <ConversationScrollButton pending={pendingCue} />
            </Conversation>
            <MessageFeedbackDialog open={messageFeedback.dialogOpen} rating={messageFeedback.dialogRating} onOpenChange={messageFeedback.onDialogOpenChange} onSubmit={messageFeedback.submitDetails} />

            {mentionMenu && <div className="absolute inset-x-3" style={{ top: mentionMenuTop }}>{mentionMenu}</div>}
            {footerVisible && (
                <div className="border-t border-border p-3">
                    <AnimatePresence initial={false}>
                        {pendingAlert && (
                            <motion.div key="alert" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }} className="overflow-hidden">
                                <AlertBlock message={pendingAlert.message} at={alertAt?.sessionId === sessionId ? alertAt.at : null} pending={acknowledging} onAcknowledge={() => void acknowledgeAlert()} />
                            </motion.div>
                        )}
                    </AnimatePresence>
                    <SkillProposalDock agentId={agentId} proposals={skillProposals.pinned} pendingId={skillProposals.pendingId} onDecide={skillProposals.decide} />
                    <AnimatePresence initial={false} mode="popLayout">
                        {pendingHitl ? null : showInstallGate ? (
                            <motion.div key="install-gate" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }} className="overflow-hidden">
                                <InstallGate
                                    agentId={agentId}
                                    agentName={agentName}
                                    apps={installApps}
                                    inProgress={!!setup?.sessionId && setup.sessionId !== sessionId}
                                    onContinue={() => setup?.sessionId && onOpenInstall?.(setup.sessionId)}
                                    disabled={status === 'streaming' || status === 'submitted'}
                                    hint={modelHint}
                                    modelSlot={<ModelSelector agentId={agentId} pickerKey={uid} onReadyChange={setModelReady} onOwnConnectionChange={setHasOwnConnection} onConnectionChange={setActiveConnectionId} onRefusedModelChange={setRefusedModel} />}
                                    onStart={() => {
                                        if (!modelReady) {
                                            blockSend()
                                            return false
                                        }
                                        track('agent_install_started', { agent_id: agentId })
                                        return sendMessage({ text: buildInstallMessage(setup!.prompt, agentName) })
                                    }}
                                    onSkip={() => {
                                        track('agent_install_skipped', { agent_id: agentId })
                                        onSetupSkipped?.()
                                    }}
                                />
                            </motion.div>
                        ) : (
                            <motion.div key="composer" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }} className="overflow-hidden pb-px">
                                <ChatComposer ref={composerRef} uid={uid} active={active} placeholder={composerPlaceholder} uploadTarget={uploadTarget} status={status} busy={showLoader} onSend={text => sendMessage({ text })} onSent={() => onMessageSentRef.current?.()} onStop={handleStop} onUploadingChange={setUploading} queue={{ text: queued?.text ?? null, pending: stopping, enqueue: enqueueFromComposer, onSendNow: () => void sendQueuedNow(), onDiscard: clearQueued }} gate={{ ready: modelReady, onBlocked: blockSend, hint: modelHint }} modelSlot={<ModelSelector agentId={agentId} pickerKey={uid} onReadyChange={setModelReady} onOwnConnectionChange={setHasOwnConnection} onConnectionChange={setActiveConnectionId} onRefusedModelChange={setRefusedModel} />} contextSlot={contextStats && <Context usedTokens={contextStats.used} maxTokens={contextStats.max ?? modelContextWindow(contextStats.model, contextStats.provider)} usage={contextStats.usage} modelId={contextStats.model} />} textareaRef={inputRef} textareaProps={mentionTextareaProps} mentionTokens={mentionTokens} />
                                <ComposerSubscriptionCta open={!hasOwnConnection} onClick={connectSubscription} />
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            )}
        </div>
    )
}
