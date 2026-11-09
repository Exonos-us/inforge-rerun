import { RERUN_CONNECTION_ID, appendAttachmentsRef, authorIdOf, queuedPreview, runUsesScreen, scrollCueOf, screenSite, shouldFlush, shouldKeepQueued, buildAttachmentsRef, findPendingAlert, findPendingHitl, findUnknownPendingCall, needsHuman, paidDataSourcesByTurn, pendingTakeover, quickRepliesOf, quickReplyDraft, type AgentModels, type AgentView, type SessionStatus } from '@rerun/contracts'
import * as Haptics from 'expo-haptics'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Keyboard, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native'
import Animated, { FadeInDown, FadeOutDown, LayoutAnimationConfig, SlideInDown, SlideOutDown, useAnimatedKeyboard, useAnimatedStyle } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { acknowledgeAlert, cancelSubRun } from '@/api/chat'
import { runningModel } from '@/api/models'
import { transcribeRecording, uploadVoiceRecording } from '@/api/uploads'
import { useAuth } from '@/auth/AuthProvider'
import { setPendingDesktopOpen } from '@/desktop/pending-open'
import { track } from '@/lib/analytics'
import { askForPushOnce, setConversationOnScreen } from '@/notifications/push'
import type { ChatEndpoints } from '@/chat/endpoints'
import { useCoworkerChat } from '@/chat/useCoworkerChat'
import { useMessageFeedback } from '@/chat/useMessageFeedback'
import { useQueuedMessage } from '@/chat/useQueuedMessage'
import { useSkillProposals } from '@/chat/useSkillProposals'
import { cachedBoard } from '@/data/local-cache'
import { useCoworkerSkills } from '@/data/useCoworkerSkills'
import { useMemberProfiles } from '@/data/useMemberProfiles'
import { useWorkspaceAgents } from '@/data/useWorkspaceAgents'
import { CHAT_COLUMN_MAX_WIDTH } from '@/components/layout/split'
import { connectHref } from '@/components/providers/routes'
import { AppText } from '@/components/ui/AppText'
import { moodOf } from '@/components/ui/CoworkerAvatar'
import { PillButton } from '@/components/ui/PillButton'
import { useTheme } from '@/theme/theme'
import { spacing } from '@/theme/tokens'

import { uploadAttachments, type ComposerAttachment } from './attachments'
import { PinnedSkillProposal } from './cards/SkillProposalRow'
import { CHAT_HEADER_HEIGHT } from './ChatHeader'
import { Composer, type ComposerHandle } from './Composer'
import { ErrorCard, type ErrorCardActions } from './ErrorCard'
import { ConversationSkeleton } from './ConversationSkeleton'
import { CoworkerEmptyState, ForemanEmptyState } from './EmptyStates'
import { StartedByBanner, type StartedBy } from './origins/StartedByBanner'
import type { VoiceSender } from './useVoiceMessage'
import { AlertWidget } from './hitl/AlertWidget'
import { HitlBlock, UnknownCallBlock } from './hitl/HitlBlock'
import { PendingHitlPill } from './hitl/PendingHitlPill'
import { QueuedMessagePill } from './QueuedMessagePill'
import { RISE_IN, ScrollToEndButton, SINK_OUT } from './ScrollToEndButton'
import { widgetFor } from './hitl/registry'
import { HITL_WIDGETS } from './hitl/widgets'
import { mentionAgentsOf } from './mentions'
import { MessageView } from './MessageView'
import { runPhase, stepGroupShowsActivity } from './run-phase'
import { RunStatus } from './RunStatus'
import { ChatScreen } from './screen/ChatScreen'
import { seenInThread } from './screen/seen-in-thread'
import { FloatingScreen, ScreenMirror } from './screen/FloatingScreen'
import { useAgentScreen } from './screen/useAgentScreen'
import { useTakeoverRequest } from './screen/useTakeoverRequest'
import { Suggestions } from './Suggestions'
import { TimedTurns } from './TimedTurns'

// The transcript scrolls under the suggestions and the composer, going out of focus this far above
// them; scrolled to the end, the last message rests just above that band, sharp.
export const BLUR_ABOVE_FOOTER = 32
// How far above the end the thread still counts as at the bottom, and keeps following what comes.
const AT_BOTTOM = 24
// Under the fade at the top of the thread a block is not really seen, even when it is on screen.
const SEEN_BAND = 24

export type ChatCoworker = { id: string; kind: 'coworker' | 'foreman'; name: string; role: string; status: AgentView['agent']['status'] }

type ConversationPaneProps = {
    coworker: ChatCoworker
    // Called once per page: a new conversation is named by its first send.
    makeEndpoints: () => ChatEndpoints
    initialSessionId: string | null
    onSessionCreated: (sessionId: string) => void
    models: AgentModels | null
    // What the hub says the conversation waits on. A call the app cannot name is one to answer only
    // when the session waits on a human; a notification is pinned until read.
    status: SessionStatus | null
    onStatusChange: () => void
    // Where the conversation opens on the web, which draws every block.
    webUrl: string
    // False on the pager's neighbouring pages, mounted but off screen.
    onScreen?: boolean
    // The coworker that opened this conversation on this one, when it was not a person.
    startedBy?: StartedBy | null
    // Sent as soon as a new conversation is ready, the text someone asked from the search.
    initialMessage?: string
    // False where the machine would refuse the upload: the Foreman of a box that predates its files.
    canAttach?: boolean
}

// One conversation on screen: the transcript, what waits on an answer, and the composer.
export function ConversationPane({ coworker, makeEndpoints, initialSessionId, onSessionCreated, models, status, onStatusChange, webUrl, onScreen = true, startedBy = null, initialMessage, canAttach = true }: ConversationPaneProps) {
    const { session, me } = useAuth()
    const caller = session && me ? { accessToken: session.access_token, workspaceId: me.workspace.id } : null
    const insets = useSafeAreaInsets()
    const scroll = useRef<ScrollViewInstance>(null)
    // The transcript a conversation opens on is shown already at its end; only what comes after scrolls.
    const shownTranscript = useRef(false)
    const [endpoints] = useState(makeEndpoints)
    // A message the engine refused while a run held the conversation waits behind it, as on the web.
    const enqueueRef = useRef<(text: string, behindRunId: string | null) => void>(() => {})
    const chat = useCoworkerChat({ endpoints, initialSessionId, onSessionCreated, onRefused: (text, behindRunId) => enqueueRef.current(text, behindRunId) })
    const queue = useQueuedMessage(`${coworker.id}-${chat.sessionId ?? 'new'}`)
    const proposals = useSkillProposals(coworker.kind === 'coworker' ? chat.sessionId : null, chat.busy)
    // A decision lifts the wait the proposal raised on the session, as on the web.
    const skillProposals = { ...proposals, decide: (proposalId: string, decision: 'accept' | 'dismiss') => proposals.decide(proposalId, decision).then(onStatusChange) }
    const feedback = useMessageFeedback(chat.sessionId, coworker.kind === 'foreman' ? 'foreman' : 'agent')
    enqueueRef.current = queue.enqueue
    const [stopping, setStopping] = useState(false)
    const [draft, setDraft] = useState('')
    const composer = useRef<ComposerHandle>(null)
    const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
    const [uploading, setUploading] = useState(false)
    const [belowFold, setBelowFold] = useState(0)
    // The web's stick-to-bottom: the thread follows what arrives only while the person sits at its
    // end. Scrolling up lets go; scrolling back down, sending or the arrow takes it again. Only the
    // person's own scrolling decides, never the scrolls the pane makes itself.
    const stuck = useRef(true)
    const [following, setFollowing] = useState(true)
    const stick = (value: boolean) => {
        if (stuck.current === value) return
        stuck.current = value
        setFollowing(value)
    }
    const touching = useRef(false)
    const metrics = useRef({ content: 0, viewport: 0 })
    const [blockHeight, setBlockHeight] = useState(0)
    const [scrollTop, setScrollTop] = useState(0)
    const [viewport, setViewport] = useState(0)
    const [threadTop, setThreadTop] = useState(0)
    const [screenBox, setScreenBox] = useState<{ y: number; height: number } | null>(null)
    // The full screen opened over the conversation drives the coworker's screen: the thread lets go
    // of its own connection meanwhile, as the web hides its thumbnail.
    const [focused, setFocused] = useState(true)
    useFocusEffect(
        useCallback(() => {
            setFocused(true)
            return () => setFocused(false)
        }, [])
    )
    const [footerHeight, setFooterHeight] = useState(0)

    const keyboard = useAnimatedKeyboard()
    const lift = useAnimatedStyle(() => ({ paddingBottom: Math.max(keyboard.height.value + spacing.sm, insets.bottom) }))

    const lastAssistant = chat.messages.findLastIndex(message => message.role === 'assistant')
    // The Foreman is the person's own assistant: nobody else writes there, so nothing is signed.
    const authorIds = coworker.kind === 'foreman' ? [] : [...new Set(chat.messages.flatMap(message => authorIdOf(message) ?? []))]
    const profileOf = useMemberProfiles(authorIds)
    const [dismissedCallId, setDismissedCallId] = useState<string | null>(null)
    // A live call never reads `idle` (it goes `working`, then `awaiting_*`): an idle session is one whose
    // block was closed, and it stays closed across a reload, as on the web.
    // A transcript kept from the last visit may hold a question answered since, on the web or by a
    // teammate: what acts on the run waits for the hub's own copy.
    const settled = chat.fresh && !chat.busy && !chat.error
    const pending = !settled || status === 'idle' ? null : findPendingHitl(chat.messages, dismissedCallId)
    // A block the app draws is answered inside it, so the composer steps aside as on the web. The
    // fallback card keeps it: typing is the only way to answer what the app cannot draw.
    const replacesComposer = pending !== null && widgetFor(pending, HITL_WIDGETS) !== null
    // Scrolled up past the whole block: the cue says what waits down the thread, as on the web.
    const blockOutOfSight = pending !== null && blockHeight > 0 && belowFold > blockHeight
    const [acknowledged, setAcknowledged] = useState<string | null>(null)
    const waitingOnHuman = status !== null && status !== 'error' && needsHuman(status)
    const pendingAlert = status === 'awaiting_ack' && settled ? findPendingAlert(chat.messages) : null
    const alert = pendingAlert && (pendingAlert.toolCallId ?? pendingAlert.message) !== acknowledged ? pendingAlert : null
    const unknownCall = pending || alert || !settled || !waitingOnHuman ? null : findUnknownPendingCall(chat.messages)
    const replies = !settled || pending || unknownCall || lastAssistant < 0 || lastAssistant !== chat.messages.length - 1 ? [] : quickRepliesOf(chat.messages[lastAssistant])
    const empty = chat.history === 'ready' && chat.messages.length === 0 && !chat.busy
    // A takeover the app can draw is asked on the screen it is about, not in a block of its own.
    const takeoverPending = pending?.kind === 'takeover' && replacesComposer ? pending : null
    const runOnScreen = useMemo(() => runUsesScreen(chat.messages), [chat.messages])
    const paidSourcesByTurn = useMemo(() => paidDataSourcesByTurn(chat.messages), [chat.messages])
    // The live screen stands in for the run's status while the run works on it.
    const screenShown = coworker.kind === 'coworker' && chat.history === 'ready' && ((chat.busy && runOnScreen) || !!takeoverPending)
    const screen = useAgentScreen(coworker.id, screenShown && onScreen && focused)
    const screenUnavailable = screen.status === 'error' || screen.status === 'disconnected'
    const screenInThread = screenShown && (!screenUnavailable || !!takeoverPending)
    const visibleTop = scrollTop + insets.top + CHAT_HEADER_HEIGHT + SEEN_BAND
    const visibleBottom = scrollTop + viewport - footerHeight
    const screenSeen = !screenBox || seenInThread({ top: threadTop + screenBox.y, bottom: threadTop + screenBox.y + screenBox.height }, { top: visibleTop, bottom: visibleBottom })
    const floatingShown = screenInThread && screen.status === 'live' && !screenSeen && focused
    const { mirror } = screen
    useEffect(() => mirror(floatingShown), [mirror, floatingShown])
    const phase = runPhase(chat.status, chat.messages.at(-1))

    // Photos go to the coworker's folder first; the message then names their paths, as on the web, and
    // shows them from the phone until the transcript comes back.
    const sessionId = chat.sessionId
    useEffect(() => {
        if (!onScreen) return
        setConversationOnScreen(sessionId)
        return () => setConversationOnScreen(null)
    }, [sessionId, onScreen])

    // A field in a waiting block sits above the composer: once the keyboard is up, the block's own
    // buttons are scrolled back into view.
    useEffect(() => {
        const subscription = Keyboard.addListener('keyboardDidShow', () => stuck.current && scroll.current?.scrollToEnd({ animated: true }))
        return () => subscription.remove()
    }, [])

    const followEnd = () => {
        stick(true)
        scroll.current?.scrollToEnd({ animated: true })
    }
    // While a run holds the conversation, what the person sends waits behind it and leaves on its
    // own once the run ends, the web's queue.
    const send = (text: string, files?: Parameters<typeof chat.send>[1]) => {
        stick(true)
        if (chat.busy) {
            queue.enqueue(text, chat.activeRunId())
            return
        }
        return chat.send(text, files)
    }

    const takeover = useTakeoverRequest(coworker.id, coworker.name, takeoverPending, text => send(text))
    const takeControl = () => {
        if (takeover) return takeover.onOpen()
        setPendingDesktopOpen({ agentId: coworker.id, name: coworker.name })
        router.push({ pathname: '/desktop', params: { agent: coworker.id } })
    }

    const canFlush = shouldFlush({ queued: queue.queued, busy: chat.busy || stopping, uploading, status: chat.status, hasError: !!chat.error })
    const flushing = useRef<string | null>(null)
    useEffect(() => {
        if (!canFlush || !queue.queued || flushing.current === queue.queued.id) return
        flushing.current = queue.queued.id
        stick(true)
        chat.send(queue.queued.text, undefined, { queued: true })
        queue.clear()
    }, [canFlush, queue, chat])

    // A message found waiting when the conversation opened only keeps waiting while a run still
    // holds it; otherwise it goes back to the composer rather than leaving days later on its own.
    const restored = queue.queued && queue.queued.id === queue.restoredId ? queue.queued : null
    useEffect(() => {
        if (!restored || !chat.fresh || chat.busy || status === 'working') return
        if (shouldKeepQueued(restored, chat.activeRunId())) return
        setDraft(current => current || queuedPreview(restored.text).text)
        queue.clear()
    }, [restored, chat, status, queue])

    const askedRef = useRef(false)
    useEffect(() => {
        if (!initialMessage || askedRef.current || initialSessionId || chat.history !== 'ready') return
        askedRef.current = true
        send(initialMessage)
    })

    const sendQueuedNow = async () => {
        setStopping(true)
        await chat.stop()
        setStopping(false)
    }

    // The web's `bringBlockIn`: a block taller than the room left between the header and the footer
    // comes in by its top, so its first line is read before its buttons.
    const jumpToPending = () => {
        const top = insets.top + CHAT_HEADER_HEIGHT + spacing.sm
        const room = metrics.current.viewport - top - footerHeight
        if (blockHeight <= room) return followEnd()
        stick(false)
        const blockBottom = metrics.current.content - footerHeight - BLUR_ABOVE_FOOTER
        scroll.current?.scrollTo({ y: Math.max(0, blockBottom - blockHeight - top), animated: true })
    }
    // Following the end counts as being there, as on the web: the stream outruns the scroll for a
    // moment on every chunk, and the arrow must not blink through it.
    const cue = scrollCueOf({ pending: pending !== null, pendingInView: !blockOutOfSight, atBottom: following || belowFold <= AT_BOTTOM })

    // A reply that announces a value the user still has to type is finished in the composer, as on the web.
    const pickReply = (reply: string) => {
        const draftReply = quickReplyDraft(reply)
        if (!draftReply) return void submit(reply)
        setDraft(draftReply)
        composer.current?.focus()
    }

    const submit = async (text: string) => {
        const message = text.trim()
        if (!message && attachments.length === 0) return
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        if (caller) askForPushOnce(caller).catch(() => {})
        if (attachments.length === 0 || !caller) {
            setDraft('')
            send(message)
            return
        }
        setUploading(true)
        try {
            const { paths, files } = await uploadAttachments(caller, coworker.id, attachments)
            setDraft('')
            setAttachments([])
            send(appendAttachmentsRef(message, buildAttachmentsRef(paths)), files)
        } catch {
            Alert.alert('Could not attach the files', 'Try again in a moment.')
        } finally {
            setUploading(false)
        }
    }

    // A voice message carries the attachments picked before it, their marker after its own, as on the web.
    // A throw keeps the recording for a retry.
    const voice: VoiceSender | undefined = caller
        ? {
              upload: uri => uploadVoiceRecording(caller, endpoints.fileOwner(chat.sessionId), uri),
              transcribe: uri => transcribeRecording(caller, uri),
              send: async text => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
                  askForPushOnce(caller).catch(() => {})
                  if (attachments.length === 0) {
                      send(text)
                      return
                  }
                  const { paths, files } = await uploadAttachments(caller, coworker.id, attachments)
                  setAttachments([])
                  send(appendAttachmentsRef(text, buildAttachmentsRef(paths)), files)
              },
          }
        : undefined

    const chip = runningModel(models)
    const model = chip && !models?.pinned ? { ...chip, label: `Default · ${chip.label}` } : chip

    const isForeman = coworker.kind === 'foreman'
    const skills = useCoworkerSkills(isForeman ? null : coworker.id)
    const workspaceAgents = useWorkspaceAgents()
    const boxes = me ? (cachedBoard(me.workspace.id).read()?.boxes ?? []) : []
    const mentionAgents = workspaceAgents ? mentionAgentsOf(workspaceAgents, boxes, isForeman ? null : coworker.id) : []
    // The web's chat notices: a dead sign-in opens the connection the coworker runs on, used-up
    // credits open the two plans. Rerun itself has no sign-in, so it opens the list.
    const runsOn = models?.resolved?.connectionId ?? models?.boxDefault?.connectionId
    const openModel = () => router.push({ pathname: '/model', params: { agent: coworker.id } })
    const errorActions: Omit<ErrorCardActions, 'onRetry'> = {
        onReconnect: () => {
            track('connection_cta_clicked', { source: 'ios_chat_error' })
            router.push(runsOn && runsOn !== RERUN_CONNECTION_ID ? { pathname: '/providers/[id]', params: { id: runsOn } } : '/providers')
        },
        onSwitchModel: openModel,
        onConnect: provider => {
            track('connection_cta_clicked', { source: `ios_budget_notice_${provider}` })
            router.push(connectHref(provider))
        },
    }
    const stopTask = (taskId: string) => {
        const runId = chat.activeRunId()
        if (caller && runId) cancelSubRun(caller, coworker.id, runId, taskId).catch(() => Alert.alert('Could not stop this task', 'Try again in a moment.'))
    }
    const placeholder = pending || unknownCall ? `Answer ${coworker.name}` : !chat.sessionId ? 'What should we work on?' : isForeman ? 'Ask Rerun anything' : `Message ${coworker.name}`

    return (
        <Animated.View style={[{ flex: 1 }, lift]}>
            <View style={{ flex: 1, justifyContent: 'flex-end' }}>
                <ScrollView
                    ref={scroll}
                    style={StyleSheet.absoluteFill}
                    scrollIndicatorInsets={{ bottom: footerHeight }}
                    keyboardDismissMode="interactive"
                    keyboardShouldPersistTaps="handled"
                    scrollEventThrottle={64}
                    onScroll={({ nativeEvent: { contentSize, contentOffset, layoutMeasurement } }) => {
                        const below = Math.max(0, contentSize.height - contentOffset.y - layoutMeasurement.height - BLUR_ABOVE_FOOTER)
                        metrics.current = { content: contentSize.height, viewport: layoutMeasurement.height }
                        setBelowFold(below)
                        if (screenInThread) {
                            setScrollTop(contentOffset.y)
                            setViewport(layoutMeasurement.height)
                        }
                        if (touching.current) stick(below <= AT_BOTTOM)
                    }}
                    onScrollBeginDrag={() => {
                        touching.current = true
                    }}
                    onScrollEndDrag={({ nativeEvent: { velocity } }) => {
                        if (!velocity?.y) touching.current = false
                    }}
                    onMomentumScrollEnd={() => {
                        touching.current = false
                    }}
                    onLayout={event => {
                        metrics.current = { ...metrics.current, viewport: event.nativeEvent.layout.height }
                        setViewport(event.nativeEvent.layout.height)
                    }}
                    onContentSizeChange={(_, height) => {
                        metrics.current = { ...metrics.current, content: height }
                        if (stuck.current) scroll.current?.scrollToEnd({ animated: shownTranscript.current })
                        if (chat.history === 'ready') shownTranscript.current = true
                    }}
                    contentContainerStyle={{ flexGrow: 1, justifyContent: empty ? 'center' : 'flex-end', width: '100%', maxWidth: CHAT_COLUMN_MAX_WIDTH, alignSelf: 'center', paddingTop: insets.top + CHAT_HEADER_HEIGHT + spacing.lg, paddingBottom: footerHeight + BLUR_ABOVE_FOOTER, paddingHorizontal: spacing.xl - 4 }}
                >
                    {chat.history === 'loading' && <ConversationSkeleton />}
                    {chat.history === 'error' && (
                        <View style={{ alignItems: 'center', gap: spacing.md }}>
                            <AppText variant="callout" tone="muted">
                                We could not load this conversation.
                            </AppText>
                            <PillButton label="Retry" variant="secondary" onPress={chat.retry} />
                        </View>
                    )}
                    {empty && (isForeman ? <ForemanEmptyState onSend={submit} onPrefill={setDraft} /> : <CoworkerEmptyState agentId={coworker.id} mood={moodOf(coworker.status)} asleep={coworker.status === 'offline'} onSend={submit} />)}
                    {chat.history === 'ready' && !empty && (
                        // The transcript a conversation opens on is already there; the first bubble of a
                        // new conversation, sent as the list appears, still rises.
                        <LayoutAnimationConfig skipEntering={!chat.busy}>
                            <View style={{ gap: spacing.xl }} onLayout={event => setThreadTop(event.nativeEvent.layout.y)}>
                                {startedBy && <StartedByBanner startedBy={startedBy} />}
                                <TimedTurns
                                    messages={chat.messages}
                                    authorOf={authorId => (isForeman ? undefined : profileOf(authorId))}
                                    renderMessage={(message, index, stamp) => <MessageView key={message.id} message={message} isLastAssistant={index === lastAssistant} running={chat.busy} agentId={isForeman ? null : coworker.id} fileOwner={endpoints.fileOwner(chat.sessionId)} coworkerName={coworker.name} hiddenCallId={alert?.toolCallId ?? null} skillProposals={skillProposals} onStopTask={stopTask} onRegenerate={pending ? undefined : () => void chat.regenerate()} feedback={feedback} stamp={stamp} paidSources={paidSourcesByTurn.get(message.id)} />}
                                />
                                {pending && !takeoverPending && (
                                    <Animated.View key={pending.toolCallId} entering={FadeInDown.duration(280)} onLayout={event => setBlockHeight(event.nativeEvent.layout.height)}>
                                        <HitlBlock
                                            pending={pending}
                                            agentId={coworker.id}
                                            coworkerName={coworker.name}
                                            webUrl={webUrl}
                                            onAnswer={text => send(text)}
                                            onDismiss={() => {
                                                setDismissedCallId(pending.toolCallId)
                                                chat.stop()
                                            }}
                                        />
                                    </Animated.View>
                                )}
                                {screenInThread && (
                                    <Animated.View
                                        entering={FadeInDown.duration(280)}
                                        onLayout={event => {
                                            const { y, height } = event.nativeEvent.layout
                                            setScreenBox({ y, height })
                                            if (takeoverPending) setBlockHeight(height)
                                        }}
                                    >
                                        <ChatScreen status={screen.status} uri={screen.uri} onMessage={screen.onMessage} attachWebView={screen.attachWebView} site={screenSite(chat.messages, takeoverPending ? (pendingTakeover(takeoverPending.input).url ?? null) : null)} takeover={takeover} onTakeControl={takeControl} />
                                    </Animated.View>
                                )}
                                {unknownCall && <UnknownCallBlock call={unknownCall} coworkerName={coworker.name} webUrl={webUrl} />}
                                {chat.error && <ErrorCard message={chat.error.message} onRetry={chat.regenerate} {...errorActions} />}
                                {chat.busy && !screenInThread && !stepGroupShowsActivity(chat.messages.at(-1)) && <RunStatus coworker={coworker} phase={phase} />}
                            </View>
                        </LayoutAnimationConfig>
                    )}
                </ScrollView>
                {floatingShown && (
                    <FloatingScreen top={insets.top + CHAT_HEADER_HEIGHT + spacing.xs} label={takeover ? 'Open browser' : 'Take control'} onTakeControl={takeControl}>
                        <ScreenMirror frames={screen.frames} />
                    </FloatingScreen>
                )}
                {cue === 'pill' && pending && (
                    <Animated.View key="pill" entering={RISE_IN} exiting={SINK_OUT} style={{ position: 'absolute', bottom: footerHeight + spacing.md, left: spacing.lg, right: spacing.lg, alignItems: 'center' }} pointerEvents="box-none">
                        <PendingHitlPill kind={pending.kind} input={pending.input} onJump={jumpToPending} />
                    </Animated.View>
                )}
                {cue === 'arrow' && !chat.error && chat.history === 'ready' && (
                    <Animated.View key="arrow" entering={RISE_IN} exiting={SINK_OUT} style={{ position: 'absolute', bottom: footerHeight + spacing.md, left: 0, right: 0, alignItems: 'center' }} pointerEvents="box-none">
                        <ScrollToEndButton onPress={followEnd} />
                    </Animated.View>
                )}

                <View onLayout={event => setFooterHeight(event.nativeEvent.layout.height)} style={{ gap: spacing.md, width: '100%', maxWidth: CHAT_COLUMN_MAX_WIDTH, alignSelf: 'center', paddingTop: replacesComposer && !alert ? 0 : spacing.sm }}>
                    {alert && (
                        <Animated.View entering={FadeInDown.duration(280)} exiting={FadeOutDown.duration(280)} style={{ paddingHorizontal: spacing.md }}>
                            <AlertWidget
                                message={alert.message}
                                onAcknowledge={async () => {
                                    if (!caller || !chat.sessionId) return
                                    await acknowledgeAlert(caller, chat.sessionId)
                                    setAcknowledged(alert.toolCallId ?? alert.message)
                                    onStatusChange()
                                }}
                            />
                        </Animated.View>
                    )}
                    {skillProposals.pinned.map(proposal => (
                        <Animated.View key={proposal.id} entering={FadeInDown.duration(280)} exiting={FadeOutDown.duration(280)} style={{ paddingHorizontal: spacing.md }}>
                            <PinnedSkillProposal proposal={proposal} pending={skillProposals.pendingId === proposal.id} onDecide={skillProposals.decide} />
                        </Animated.View>
                    ))}
                    {replies.length > 0 && !draft && !queue.queued && <Suggestions items={replies} onPick={pickReply} />}
                    {queue.queued && (
                        <Animated.View entering={FadeInDown.duration(200)} exiting={FadeOutDown.duration(200)} style={{ paddingHorizontal: spacing.md }}>
                            <QueuedMessagePill text={queue.queued.text} busy={chat.busy} pending={stopping} onSendNow={sendQueuedNow} onDiscard={queue.clear} />
                        </Animated.View>
                    )}
                    {!replacesComposer && (
                        // Slides rather than fades: the composer's glass goes blank under a parent below full opacity.
                        <Animated.View entering={SlideInDown.duration(280)} exiting={SlideOutDown.duration(280)} style={{ paddingHorizontal: spacing.md }}>
                            <Composer ref={composer} value={draft} onChangeText={setDraft} attachments={attachments} onAttachmentsChange={setAttachments} skills={skills} mentionAgents={mentionAgents} onSend={() => submit(draft)} onStop={chat.stop} running={chat.busy || uploading} placeholder={placeholder} model={model} onOpenModel={openModel} canAttach={canAttach && !pending} voice={voice} autoFocus={!initialSessionId && onScreen} />
                        </Animated.View>
                    )}
                </View>
            </View>
        </Animated.View>
    )
}
