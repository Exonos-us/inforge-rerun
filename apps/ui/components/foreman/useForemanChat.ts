'use client'

import { useChat } from '@ai-sdk/react'
import { FOREMAN_AGENT_ID, FOREMAN_INTENT_PART, type ForemanIntent } from '@rerun/contracts'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { OrbActivity } from '@/components/foreman/Orb'
import { isForemanClientTool, runForemanClientTool, type ForemanClientGates, type ForemanClientToolName } from '@/components/foreman/foremanClientTools'
import { refreshForemanSurface } from '@/components/foreman/useForemanKickoff'
import { getRunAction } from '@/app/api/_actions/agent.actions'
import type { SessionUsageSeed } from '@/app/api/_services/chat.service'
import { readAgentModel, useAgentModel } from '@/hooks/useAgentModel'
import { useRunReconnect } from '@/hooks/useRunReconnect'
import { contextStatsOf } from '@/lib/chat/context-stats'
import { historyCovers, needsReconcile } from '@/lib/chat/transcript-reconcile'
import { isWorkspaceApiEntitled } from '@rerun/cloud/billing'
import { lastUserText } from '@/lib/chat-payload'
import { PHONE_REQUIRED_MESSAGE } from '@rerun/cloud/phone'
import { findPendingEngineHitl, findPendingWidget, resumesAfterAnswer } from '@/lib/foreman/pending-widget'
import type { ForemanBackend } from '@/lib/foreman/phase'
import { sealPendingWidgets, withTypedAnswer } from '@/lib/foreman/seal-pending'
import { selectForemanBackend, selectForemanOpen, useForemanStore } from '@/stores/foreman.store'
import { useIsWorkspaceAdmin, useSession } from '@/supabase/session/SessionProvider'

// The foreman's chat, on whichever loop serves the conversation.
//
// On the hub (app/api/chat/foreman), the onboarding, the transport carries the whole transcript: the
// widget answers written in the browser have to travel back with it. On the engine
// (app/api/chat/foreman/engine), everything after, the engine holds the conversation, so only the
// message being sent travels, a question is answered by the next message, and a board gesture
// arrives as a data part.
//
// Both chats are always mounted and the store says which one the column reads: a conversation never
// moves from one to the other. Once the build hands the workspace to the engine, the onboarding's
// stays on screen, and the next message opens a new conversation there.

type RestoredConversation = { sessionId: string; backend: ForemanBackend; messages: UIMessage[]; usage?: SessionUsageSeed | null; lastError?: string | null; activeRunId?: string | null }

async function fetchEngineTranscript(sessionId: string): Promise<UIMessage[]> {
    const res = await fetch(`/api/chat/foreman/engine?sessionId=${encodeURIComponent(sessionId)}`)
    if (!res.ok) return []
    return ((await res.json()) as { messages?: UIMessage[] }).messages ?? []
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export function useForemanChat() {
    const sessionId = useForemanStore(state => state.sessionId)
    const backend = useForemanStore(selectForemanBackend)
    const surface = useForemanStore(state => state.surface)
    const setActivity = useForemanStore(state => state.setActivity)
    const open = useForemanStore(selectForemanOpen)
    const engaged = useForemanStore(state => state.engaged)
    const { workspace, refreshPhoneStep } = useSession()
    const isAdmin = useIsWorkspaceAdmin()

    // A client tool that opens a locked panel has to know it is locked, and the session is a React
    // context. Kept in a ref rather than read in the closure below: useChat holds on to the options
    // it was given, and a workspace read there would be the one of the first render forever.
    const gates = useRef<ForemanClientGates>({ apiEntitled: false, isSandbox: false, isAdmin: false })
    useEffect(() => {
        gates.current = { apiEntitled: !!workspace && isWorkspaceApiEntitled(workspace), isSandbox: !!workspace?.is_sandbox, isAdmin }
    }, [workspace, isAdmin])

    const transport = useMemo(
        () =>
            new DefaultChatTransport<UIMessage>({
                api: '/api/chat/foreman',
                body: () => ({ sessionId }),
            }),
        [sessionId]
    )

    // The SDK decides on the automatic resume right after it flips the status to ready, then starts it
    // after an await: a send made in that gap by an effect that saw `ready` runs a second turn beside
    // the resume, and the SDK crashes on the overlap. Raised from inside that decision, so it is
    // already up when the render that shows `ready` runs.
    const autoResumePending = useRef(false)

    const hubChat = useChat<UIMessage>({
        id: sessionId,
        transport,
        // A client tool answering leaves the assistant waiting on an answer it cannot produce alone:
        // the turn resumes on its own.
        sendAutomaticallyWhen: chat => (autoResumePending.current = resumesAfterAnswer(chat)),
        onToolCall: ({ toolCall }) => {
            // Widgets are deliberately not here: they are drawn in the message stream and answered
            // by the user, not resolved on arrival.
            if (!isForemanClientTool(toolCall.toolName)) return
            const output = runForemanClientTool(toolCall.toolName as ForemanClientToolName, toolCall.input, gates.current)
            void hubChat.addToolResult({ tool: toolCall.toolName, toolCallId: toolCall.toolCallId, output })
        },
        // No toast: a spent budget or a provider that refused is shown in the stack, as a notice
        // with somewhere to go, exactly as the agent chat shows it.
    })

    // The run the engine is streaming, so Stop can end it there and not only close the stream, and a
    // stream that drops can be picked up again. Kept in the store: the transport reads it when it
    // reconnects, long after the render that built it.
    const activeRunId = useForemanStore(state => state.engineRunId)
    const holdRun = useForemanStore(state => state.setEngineRunId)
    const completedRef = useRef(false)
    const engineTransport = useMemo(
        () =>
            new DefaultChatTransport<UIMessage>({
                api: '/api/chat/foreman/engine',
                // Read at send time: the transport lives as long as the conversation, and a model picked in
                // the composer has to reach the very next message.
                body: () => ({ sessionId, ...readAgentModel(FOREMAN_AGENT_ID) }),
                prepareSendMessagesRequest: ({ body, messages }) => ({ body: { ...body, text: lastUserText(messages) } }),
                prepareReconnectToStreamRequest: () => ({ api: `/api/chat/resume?agentId=${FOREMAN_AGENT_ID}&runId=${encodeURIComponent(useForemanStore.getState().engineRunId ?? '')}` }),
                fetch: (async (url: string | URL | Request, init?: RequestInit) => {
                    const res = await fetch(url, init)
                    // Only a send names a run. A send the route refused names none, and letting go
                    // of the previous one keeps its failure from being chased as a dropped stream.
                    if (init?.method === 'POST') holdRun(res.headers.get('X-Run-Id'))
                    return res
                }) as typeof globalThis.fetch,
            }),
        [sessionId, holdRun]
    )

    const engineChat = useChat<UIMessage>({
        id: `engine-${sessionId}`,
        transport: engineTransport,
        experimental_throttle: 80,
        // A gesture the engine foreman makes on the board. Its tool already answered on the engine,
        // so what the browser makes of it goes nowhere.
        onData: part => {
            if (part.type !== FOREMAN_INTENT_PART) return
            const { tool, input } = part.data as ForemanIntent
            if (isForemanClientTool(tool)) runForemanClientTool(tool, input, gates.current)
        },
        onFinish: ({ isAbort, isDisconnect, isError }) => {
            if (isAbort || isDisconnect || isError) return
            completedRef.current = true
            holdRun(null)
        },
    })

    const onEngine = backend === 'engine'
    const chat = onEngine ? engineChat : hubChat
    const { status, messages } = chat
    const { setMessages: setHubMessages, sendMessage: sendHubMessage, addToolResult, status: hubStatus } = hubChat

    useEffect(() => {
        if (hubStatus !== 'ready') autoResumePending.current = false
    }, [hubStatus])
    const { sendMessage: sendEngineMessage, stop: stopEngineStream, setMessages: setEngineMessages, resumeStream: resumeEngineStream, clearError: clearEngineError, regenerate: regenerateEngine } = engineChat

    // The failure of a run that ended without this tab watching it: the engine never writes one into
    // the transcript, so it is read off the run when the conversation reopens or a chase gives up.
    // Both are tagged with the conversation they belong to, so a new chat shows none of the last one's.
    const [runErrorOf, setRunErrorOf] = useState<{ sessionId: string; text: string } | null>(null)
    const runError = runErrorOf?.sessionId === sessionId ? runErrorOf.text : null
    const setRunError = useCallback((text: string | null) => setRunErrorOf(text ? { sessionId, text } : null), [sessionId])
    // Usage of the conversation's last finished run, so the gauge shows as soon as it reopens.
    const [usageOf, setUsageOf] = useState<{ sessionId: string; usage: SessionUsageSeed } | null>(null)
    const seededUsage = usageOf?.sessionId === sessionId ? usageOf.usage : null

    const { selection: modelSelection } = useAgentModel(FOREMAN_AGENT_ID)
    const contextStats = useMemo(() => (onEngine ? contextStatsOf(messages, seededUsage, modelSelection.model) : null), [onEngine, messages, seededUsage, modelSelection.model])

    const reconnecting = useRunReconnect({
        error: engineChat.error,
        completedRef,
        start: () => {
            const runId = useForemanStore.getState().engineRunId
            if (!runId) return null
            return {
                runId,
                getRun: () => getRunAction(FOREMAN_AGENT_ID, runId),
                fetchMessages: () => fetchEngineTranscript(sessionId),
                onSettled: ({ errorText }) => {
                    holdRun(null)
                    if (errorText) setRunError(errorText)
                },
            }
        },
        resumeStream: resumeEngineStream,
        setMessages: setEngineMessages as (messages: never[]) => void,
        clearError: clearEngineError,
    })

    // `streaming` couvre aussi bien un outil qui tourne qu'une réponse qui s'écrit : c'est le dernier
    // bloc du transcript qui départage. La bête parle quand du texte sort, elle réfléchit le reste du
    // temps. Dériver l'état dans le rendu plutôt que dans l'effet évite d'écrire dans le store à
    // chaque token, puisque seul son changement réveille l'effet.
    const tail = messages.at(-1)?.parts.at(-1)
    const activity: OrbActivity = status === 'submitted' ? 'thinking' : status !== 'streaming' ? 'idle' : tail?.type === 'text' && tail.state === 'streaming' ? 'speaking' : 'thinking'

    useEffect(() => {
        setActivity(activity)
    }, [activity, setActivity])

    // Typing instead of answering is an answer too. On the hub the question is closed through
    // setMessages rather than addToolResult, because resolving the call would fire the automatic
    // resume and race the message being sent. The message lands in that same write and the request
    // leaves with no await in between: sendMessage(text) awaits before pushing it, and a render in
    // that gap reads a sealed question as answered and resumes the turn a second time. On the engine
    // the next message is the answer.
    //
    // False when the hub is about to resume the turn on its own: the caller keeps the message.
    const send = useCallback(
        (message: { text: string }, options?: { queued?: boolean }): boolean => {
            const store = useForemanStore.getState()
            // The onboarding is over under this conversation: it stays where it is, and what they
            // say next starts with the foreman on the engine, sent once the new chat is in place.
            if (store.backend === 'hub' && store.surface === 'engine') {
                store.newChat()
                store.askForeman(message.text)
                return true
            }
            if (!onEngine && autoResumePending.current) return false
            store.pinBackend()
            setRunErrorOf(null)
            if (onEngine) {
                void sendEngineMessage(message, options?.queued ? { body: { queued: true } } : undefined)
                return true
            }
            setHubMessages(current => withTypedAnswer(current, message.text))
            void sendHubMessage()
            return true
        },
        [onEngine, sendEngineMessage, sendHubMessage, setHubMessages]
    )

    // A second answer to the same call would fire a second automatic resume next to the first: a
    // double click on a widget button runs the turn twice on the hub.
    const answeredCalls = useRef(new Set<string>())
    useEffect(() => {
        answeredCalls.current = new Set()
    }, [sessionId])

    const answerWidget = useCallback(
        (tool: string, toolCallId: string, output: unknown) => {
            if (onEngine) return void send({ text: String(output) })
            if (answeredCalls.current.has(toolCallId)) return
            answeredCalls.current.add(toolCallId)
            void addToolResult({ tool, toolCallId, output })
        },
        [onEngine, send, addToolResult]
    )

    const [dismissedCallId, setDismissedCallId] = useState<string | null>(null)

    // The question the conversation is stopped on. It waits in the stack and the composer steps
    // aside for it, the way an agent's chat does for its pending ask_user.
    const pendingWidget = useMemo(() => {
        const pending = onEngine ? findPendingEngineHitl(messages, status) : findPendingWidget(messages, status)
        return pending?.toolCallId === dismissedCallId ? null : pending
    }, [onEngine, messages, status, dismissedCallId])

    // Closing the stream alone would leave the engine run going, still answering nobody. The session
    // rides along because a tab reloaded mid-run may not hold the id of the run it is looking at.
    // `stopping` stays true until the engine has answered, whichever button asked: the stream flips
    // to ready as soon as it is aborted, and a queued message sent then would start the run the
    // engine is about to sweep.
    const [stopping, setStopping] = useState(false)
    const stop = useCallback(async () => {
        setStopping(true)
        try {
            if (!onEngine) {
                autoResumePending.current = false
                return await hubChat.stop()
            }
            await stopEngineStream()
            const params = new URLSearchParams({ sessionId })
            const runId = useForemanStore.getState().engineRunId
            if (runId) params.set('runId', runId)
            holdRun(null)
            clearEngineError()
            await fetch(`/api/chat/foreman/engine?${params}`, { method: 'DELETE' }).catch(() => {})
        } finally {
            setStopping(false)
        }
    }, [onEngine, hubChat, stopEngineStream, clearEngineError, holdRun, sessionId])

    // Closing a question ends the turn without answering it, the way an agent's chat does. On the
    // hub it is sealed through setMessages for the same reason as in `send`: addToolResult would
    // fire the automatic resume.
    const dismissWidget = useCallback(
        (toolCallId: string) => {
            if (!onEngine) return setHubMessages(current => sealPendingWidgets(current, 'dismissed'))
            setDismissedCallId(toolCallId)
            void stop()
        },
        [onEngine, setHubMessages, stop]
    )

    // A foreman that turned the message away because the workspace moved on under this tab: the
    // onboarding ended in another tab, or the machine went away. Asked again, the column follows.
    const turnedAway = [hubChat.error, engineChat.error].some(err => !!err && /onboarding_over|foreman_unavailable/.test(err.message))
    useEffect(() => {
        if (turnedAway) void refreshForemanSurface()
    }, [turnedAway])

    // Same on a tab that missed the phone wall: asked again, the wall comes back up.
    const owesPhone = [hubChat.error, engineChat.error].some(err => !!err && err.message.includes(PHONE_REQUIRED_MESSAGE))
    useEffect(() => {
        if (owesPhone) void refreshPhoneStep()
    }, [owesPhone, refreshPhoneStep])

    // The server holds the conversation, so the column asks for the last one at mount, of the foreman
    // the workspace talks to now: the onboarding's never comes back once the engine took over.
    // Adopting its id comes first: useChat is keyed on it, and messages set before the swap would
    // belong to the chat instance the swap throws away. The second effect lands them once the ids
    // agree.
    const restored = useRef<RestoredConversation | null>(null)
    const asked = useRef(false)
    // Whether the transcript on the server has been asked for yet. Anything that wants to write the
    // first message has to wait for this, or it writes into a conversation it has not seen.
    const [restoreDone, setRestoreDone] = useState(false)
    useEffect(() => {
        // Not before the Foreman is opened or called on from its pill: the column is mounted on every
        // board load, and a transcript carries its tool outputs with it. The 300ms the panel takes to
        // slide in covers the fetch.
        if ((!open && !engaged) || asked.current || surface === 'unknown' || surface === 'none') return
        asked.current = true
        void fetch(surface === 'engine' ? '/api/chat/foreman/engine' : '/api/chat/foreman')
            .then(res => (res.ok ? (res.json() as Promise<RestoredConversation | null>) : null))
            .then(conversation => {
                if (!conversation?.messages.length) {
                    setRestoreDone(true)
                    return
                }
                restored.current = conversation
                useForemanStore.getState().setSessionId(conversation.sessionId, conversation.backend)
            })
            .catch(() => setRestoreDone(true))
    }, [open, engaged, surface])

    const engineLive = useRef({ messages: engineChat.messages, status: engineChat.status })
    useEffect(() => {
        engineLive.current = { messages: engineChat.messages, status: engineChat.status }
    }, [engineChat.messages, engineChat.status])
    const mounted = useRef(true)
    useEffect(() => {
        mounted.current = true
        return () => {
            mounted.current = false
        }
    }, [])

    // A run already in flight when the column reopens: its stream is replayed from the start onto the
    // transcript just restored, and the transcript is read back once it is over so nothing the replay
    // got wrong survives it. The run's status decides, not the id: the replay buffer outlives the run
    // by minutes, and replaying a finished run onto its own persisted answer lands every call twice.
    const attachToRun = useCallback(
        async (conversationId: string, runId: string) => {
            const run = await getRunAction(FOREMAN_AGENT_ID, runId).catch(() => null)
            if (!mounted.current) return
            if (run?.status === 'error' && run.error) setRunError(run.error)
            if (!run || run.status === 'running') await resumeEngineStream().catch(() => {})
            for (let i = 0; i < 5 && mounted.current; i++) {
                const data = await fetchEngineTranscript(conversationId).catch(() => [])
                const live = engineLive.current
                // A message sent from this tab meanwhile owns the transcript.
                if (!mounted.current || live.status === 'submitted' || live.status === 'streaming') return
                if (!needsReconcile(live.messages)) return
                if (historyCovers(live.messages, data)) {
                    setEngineMessages(data)
                    return
                }
                await wait(600)
            }
        },
        [resumeEngineStream, setEngineMessages, setRunError]
    )

    useEffect(() => {
        const conversation = restored.current
        if (!conversation || conversation.sessionId !== sessionId) return
        restored.current = null
        if (conversation.backend === 'engine') {
            setEngineMessages(conversation.messages)
            setUsageOf(conversation.usage ? { sessionId, usage: conversation.usage } : null)
            setRunError(conversation.lastError ?? null)
            if (conversation.activeRunId) {
                holdRun(conversation.activeRunId)
                void attachToRun(conversation.sessionId, conversation.activeRunId)
            }
        } else setHubMessages(conversation.messages)
        // Marked here rather than when the fetch resolves: between the two the transcript is in
        // hand but not in the chat, and anything watching for an empty conversation would fire.
        setRestoreDone(true)
    }, [sessionId, setHubMessages, setEngineMessages, holdRun, attachToRun, setRunError])

    // Where the next message goes, which is not always where the conversation on screen runs: the
    // onboarding's stays displayed once the engine took over, and the composer reads as the engine's.
    const composerBackend: ForemanBackend = surface === 'engine' ? 'engine' : backend

    const regenerate = useCallback(
        (messageId: string) => {
            setRunErrorOf(null)
            void regenerateEngine({ messageId })
        },
        [regenerateEngine]
    )

    // A stream being chased is not a failure yet: the error only shows once the chase gave up.
    const error = onEngine && reconnecting ? undefined : chat.error

    return { ...chat, error, stop, stopping, sendMessage: send, regenerate, answerWidget, dismissWidget, pendingWidget, restoreDone, composerBackend, backend, contextStats, runError, reconnecting: onEngine && reconnecting, activeRunId: onEngine ? activeRunId : null }
}
