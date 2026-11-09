import type { UIMessage } from 'ai'
import { useRef, useState } from 'react'
import { ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native'
import Animated, { FadeInDown, FadeOutDown, useAnimatedKeyboard, useAnimatedStyle } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { QuestionReceipt } from '@/components/chat/hitl/Receipts'
import { Composer } from '@/components/chat/Composer'
import { MessageView } from '@/components/chat/MessageView'
import { UserBubble } from '@/components/chat/Messages'
import { RunStatus } from '@/components/chat/RunStatus'
import { AppText } from '@/components/ui/AppText'
import { EdgeFade } from '@/components/ui/EdgeFade'
import { PillButton } from '@/components/ui/PillButton'
import { ProgressiveBlur } from '@/components/ui/ProgressiveBlur'
import { spacing } from '@/theme/tokens'

import { buildTasks, isKickoff, pendingWidget, readBuildResult, readPlanOutput, readQuestionOutput, readStarterPack, readStarterPackOutput, readTrialOutput, textOf, widgetOf, type WidgetPart } from './parts'
import { PlanCard } from './widgets/PlanCard'
import { EitherCard, QuestionCard } from './widgets/QuestionCards'
import { StarterPackCard } from './widgets/StarterPackCard'
import { BuildCard, TeamStartCard, type TeamStartState } from './widgets/TeamCards'

const BLUR_ABOVE_FOOTER = 32
const FOREMAN = { id: 'foreman', kind: 'foreman' as const, name: 'Rerun', role: 'Your workspace assistant', status: 'working' as const }

export type OnboardingConversationProps = {
    messages: UIMessage[]
    busy: boolean
    // A turn that did not go through, with the way to send it again.
    failed: boolean
    onRetry: () => void
    teamStart: TeamStartState
    leadStarting: boolean
    onAnswer: (toolCallId: string, output: unknown) => void
    onSend: (text: string) => void
    onStop: () => void
    onRetryStart: () => void
    onRetryBuild: () => void
    onStartLead: () => void
}

type Segment = { parts: UIMessage['parts'] } | { widget: WidgetPart }

// What the hub said and the cards it put up, in the order it put them up: each run of text between two
// cards is its own bubble, so two steps never read as one sentence.
function segmentsOf(message: UIMessage): Segment[] {
    const segments: Segment[] = []
    for (const part of message.parts) {
        if (part.type === 'data-delegate') continue
        const widget = widgetOf(part)
        if (widget) {
            segments.push({ widget })
            continue
        }
        const last = segments.at(-1)
        if (part.type === 'step-start') segments.push({ parts: [] })
        else if (last && 'parts' in last) last.parts.push(part)
        else segments.push({ parts: [part] })
    }
    return segments.filter(segment => 'widget' in segment || segment.parts.length > 0)
}

function Answered({ widget }: { widget: WidgetPart }) {
    if (widget.widget === 'ask_choice' || widget.widget === 'ask_input' || widget.widget === 'ask_either') {
        const answer = readQuestionOutput(widget.output)
        if (!answer?.answered) return null
        return <QuestionReceipt answers={[{ question: answer.question, answers: answer.answers }]} />
    }
    if (widget.widget === 'show_starter_pack') {
        const answer = readStarterPackOutput(widget.output)
        if (!answer?.answered) return null
        const cards = readStarterPack(widget.input)
        const hired = 'custom' in answer ? [answer.custom] : cards.filter(card => answer.chosen.includes(card.slug)).map(card => card.promise)
        return <QuestionReceipt answers={[{ question: 'Your starter team', answers: hired }]} />
    }
    return null
}

// The hub's onboarding conversation: what it says in bubbles, each card where it was asked, and the
// composer only while no card waits on an answer.
export function OnboardingConversation({ messages, busy, failed, onRetry, teamStart, leadStarting, onAnswer, onSend, onStop, onRetryStart, onRetryBuild, onStartLead }: OnboardingConversationProps) {
    const insets = useSafeAreaInsets()
    const scroll = useRef<ScrollViewInstance>(null)
    const [draft, setDraft] = useState('')
    const [footerHeight, setFooterHeight] = useState(0)
    const keyboard = useAnimatedKeyboard()
    const lift = useAnimatedStyle(() => ({ paddingBottom: Math.max(keyboard.height.value + spacing.sm, insets.bottom) }))

    const pending = busy ? null : pendingWidget(messages)
    const building = messages.some(message => message.parts.some(part => widgetOf(part)?.widget === 'build_team'))
    const trialUp = messages.some(message => message.parts.some(part => widgetOf(part)?.widget === 'open_checkout'))
    // Past the plan nothing can be typed, as on the web: the trial and the build run on their own.
    const composer = !pending && !trialUp && !building
    const shown = messages.filter(message => !isKickoff(message))
    // Only the last build can be run again: an earlier one that failed is history.
    const lastBuild = messages.flatMap(message => message.parts.flatMap(part => (widgetOf(part)?.widget === 'build_team' ? [widgetOf(part)?.toolCallId] : []))).at(-1)

    const render = (widget: WidgetPart, message: UIMessage) => {
        if (widget.widget === 'open_checkout') return <TeamStartCard state={widget.answered ? (readTrialOutput(widget.output)?.ok ? 'started' : 'blocked') : teamStart} onRetry={onRetryStart} />
        if (widget.widget === 'build_team') return <BuildCard tasks={buildTasks(message, widget.toolCallId)} result={readBuildResult(widget.output)} starting={leadStarting} onStartLead={onStartLead} onRetry={widget.toolCallId === lastBuild ? onRetryBuild : null} />
        if (widget.widget === 'show_plan') return <PlanCard input={widget.input} answered={widget.answered ? readPlanOutput(widget.output) : null} onAnswer={output => onAnswer(widget.toolCallId, output)} />
        if (widget.answered) return <Answered widget={widget} />
        if (pending?.toolCallId !== widget.toolCallId) return null
        if (widget.widget === 'ask_either') return <EitherCard input={widget.input} onAnswer={output => onAnswer(widget.toolCallId, output)} />
        if (widget.widget === 'show_starter_pack') return <StarterPackCard input={widget.input} onAnswer={output => onAnswer(widget.toolCallId, output)} />
        return <QuestionCard widget={widget.widget as 'ask_choice' | 'ask_input'} input={widget.input} onAnswer={output => onAnswer(widget.toolCallId, output)} />
    }

    const send = () => {
        const text = draft.trim()
        if (!text) return
        setDraft('')
        onSend(text)
    }

    return (
        <Animated.View style={[{ flex: 1 }, lift]}>
            <View style={{ flex: 1, justifyContent: 'flex-end' }}>
                <ScrollView ref={scroll} style={StyleSheet.absoluteFill} keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled" onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })} contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end', paddingTop: spacing.lg, paddingBottom: footerHeight + BLUR_ABOVE_FOOTER, paddingHorizontal: spacing.xl - 4, gap: spacing.xl }}>
                    {shown.map((message, index) => {
                        if (message.role === 'user') return <UserBubble key={message.id} text={textOf(message)} />
                        return (
                            <View key={message.id} style={{ gap: spacing.lg }}>
                                {segmentsOf(message).map((segment, at) =>
                                    'widget' in segment ? (
                                        <Animated.View key={segment.widget.toolCallId} entering={FadeInDown.duration(280)}>
                                            {render(segment.widget, message)}
                                        </Animated.View>
                                    ) : (
                                        <MessageView key={`${message.id}-${at}`} message={{ ...message, id: `${message.id}-${at}`, parts: segment.parts }} isLastAssistant={index === shown.length - 1} running={busy} agentId={null} fileOwner={null} coworkerName="Rerun" hiddenCallId={null} />
                                    )
                                )}
                            </View>
                        )
                    })}
                    {failed && !busy && (
                        <View style={{ alignItems: 'flex-start', gap: spacing.sm }}>
                            <AppText variant="callout" tone="muted">
                                That did not go through.
                            </AppText>
                            <PillButton label="Try again" variant="secondary" onPress={onRetry} />
                        </View>
                    )}
                    {busy && !building && <RunStatus coworker={FOREMAN} phase="working" />}
                </ScrollView>
                <EdgeFade edge="top" height={spacing.xl} />
                <ProgressiveBlur height={footerHeight + BLUR_ABOVE_FOOTER} veiled={false} />
                <View onLayout={event => setFooterHeight(event.nativeEvent.layout.height)} style={{ paddingTop: composer ? spacing.sm : 0 }}>
                    {composer && (
                        <Animated.View entering={FadeInDown.duration(280)} exiting={FadeOutDown.duration(280)} style={{ paddingHorizontal: spacing.md }}>
                            <Composer value={draft} onChangeText={setDraft} onSend={send} onStop={onStop} running={busy} placeholder="Answer Rerun" canAttach={false} />
                        </Animated.View>
                    )}
                </View>
            </View>
        </Animated.View>
    )
}
