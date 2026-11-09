import { agentIdOf, argsOf, readableToolError, toolHeadline, toolLabelOf } from '@rerun/contracts'
import { SymbolView, type SFSymbol } from 'expo-symbols'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewInstance } from 'react-native'
import Animated, { Easing, FadeIn, FadeInUp, FadeOut, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'

import { AgentBuddy } from '@/components/buddy/AgentBuddy'
import { AppText } from '@/components/ui/AppText'
import { EdgeFade } from '@/components/ui/EdgeFade'
import { useTheme } from '@/theme/theme'
import { fonts, radius, spacing, withAlpha } from '@/theme/tokens'

import { toolSymbolOf } from './toolSymbols'
import { formatElapsed, useElapsed } from './useElapsed'

export type StepStatus = 'done' | 'error' | 'running'

export type StepItem = { key: string; symbol: SFSymbol; node: ReactNode; status: StepStatus; runningLabel?: string }

export type ToolState = 'input-streaming' | 'input-available' | 'output-available' | 'output-error' | 'output-denied' | 'approval-requested' | 'approval-responded'

const MAX_STACKED = 4
const STACKED_SIZE = 20
const ROW_HEIGHT = 32
const PILL_HEIGHT = 28
const LIST_HEIGHT = 240
const OUTPUT_MAX = 2000

const takeTouch = () => true

export function toolStatusOf(state: string | undefined): StepStatus {
    if (state === 'output-available') return 'done'
    if (state === 'output-error' || state === 'output-denied') return 'error'
    return 'running'
}

// The web shimmers what is running; a phone breathes it, like the run status under the thread.
function Breathing({ children }: { children: ReactNode }) {
    const pulse = useSharedValue(1)
    useEffect(() => {
        pulse.value = withRepeat(withTiming(0.45, { duration: 900, easing: Easing.inOut(Easing.quad) }), -1, true)
    }, [pulse])
    const fade = useAnimatedStyle(() => ({ opacity: pulse.value }))
    return <Animated.View style={[{ flexShrink: 1 }, fade]}>{children}</Animated.View>
}

// Distinct tools in order of first use, so a new one lands at the end of the stack instead of reshuffling it.
const usedSymbols = (items: StepItem[]): SFSymbol[] => [...new Set(items.map(item => item.symbol))]

function ToolStack({ items }: { items: StepItem[] }) {
    const theme = useTheme()
    const symbols = usedSymbols(items)
    const shown = symbols.slice(-MAX_STACKED)
    const hidden = symbols.length - shown.length
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {shown.map((symbol, i) => (
                <Animated.View key={symbol} entering={FadeIn.duration(250)} style={{ width: STACKED_SIZE, height: STACKED_SIZE, marginLeft: i > 0 ? -4 : 0, alignItems: 'center', justifyContent: 'center', borderRadius: STACKED_SIZE / 2, borderWidth: 2, borderColor: theme.background, backgroundColor: theme.muted }}>
                    <SymbolView name={symbol} size={10} tintColor={theme.mutedForeground} />
                </Animated.View>
            ))}
            {hidden > 0 && (
                <AppText variant="caption" tone="muted" style={{ marginLeft: 4, fontVariant: ['tabular-nums'] }}>
                    {`+${hidden}`}
                </AppText>
            )}
        </View>
    )
}

function Activity({ label }: { label: string }) {
    return (
        <Animated.View key={label} entering={FadeInUp.duration(250)} style={{ flexShrink: 1 }}>
            <Breathing>
                <AppText variant="body" tone="muted" numberOfLines={1}>
                    {label}
                </AppText>
            </Breathing>
        </Animated.View>
    )
}

// Glides to each new step while the reader sits at the bottom; once they scroll up to read, it leaves them there.
function StepList({ items }: { items: StepItem[] }) {
    const scroll = useRef<ScrollViewInstance>(null)
    const placedCount = useRef(0)
    const pinned = useRef(true)
    // Only a finger moves the pin: the glide's own scroll events would unpin it halfway down.
    const touched = useRef(false)
    const [scrolledDown, setScrolledDown] = useState(false)

    const onScroll = ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
        const { contentOffset, contentSize, layoutMeasurement } = nativeEvent
        setScrolledDown(contentOffset.y > 1)
        if (touched.current) pinned.current = contentSize.height - layoutMeasurement.height - contentOffset.y <= 4
    }

    return (
        <View style={{ marginTop: spacing.xs }}>
            <ScrollView
                ref={scroll}
                style={{ maxHeight: LIST_HEIGHT }}
                scrollEventThrottle={16}
                onScroll={onScroll}
                onScrollBeginDrag={() => {
                    touched.current = true
                }}
                // A new step moves the list, a step opened to read it does not.
                onContentSizeChange={() => {
                    if (!pinned.current || placedCount.current === items.length) return
                    touched.current = false
                    scroll.current?.scrollToEnd({ animated: placedCount.current > 0 })
                    placedCount.current = items.length
                }}
            >
                {/* The bubble's tap that brings the time up would freeze the scroll, see HorizontalScroll. */}
                <View onStartShouldSetResponder={takeTouch}>
                    {items.map(item => (
                        <Animated.View key={item.key} entering={FadeIn.duration(300)}>
                            {item.node}
                        </Animated.View>
                    ))}
                </View>
            </ScrollView>
            {scrolledDown && <EdgeFade edge="top" height={32} />}
        </View>
    )
}

/**
 * The web's `StepGroup`: the run of steps between two pieces of text, the coworker and what it is
 * doing while it works, beside a pill with every tool used so far. The pill opens on the full list.
 */
export function StepGroup({ items, agentId }: { items: StepItem[]; agentId: string | null }) {
    const theme = useTheme()
    const [open, setOpen] = useState(false)
    const running = items.find(item => item.status === 'running')
    const live = !!running
    const failed = items.filter(item => item.status === 'error').length
    const count = `${items.length} ${items.length > 1 ? 'steps' : 'step'}`
    return (
        <View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: ROW_HEIGHT }}>
                {agentId && <AgentBuddy agentId={agentId} mood={live ? 'working' : 'idle'} size={24} facing="right" animated={live} />}
                {running?.runningLabel && <Activity label={running.runningLabel} />}
                <Pressable
                    onPress={() => setOpen(current => !current)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: open }}
                    accessibilityLabel={failed > 0 ? `${count}, ${failed} failed` : count}
                    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, height: PILL_HEIGHT, paddingLeft: 4, paddingRight: spacing.sm, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border, backgroundColor: pressed ? theme.muted : withAlpha(theme.muted, 0.4) })}
                >
                    <ToolStack items={items} />
                    <AppText variant="caption" tone="muted" style={{ fontVariant: ['tabular-nums'] }}>
                        {live ? String(items.length) : count}
                    </AppText>
                    {failed > 0 && (
                        <AppText variant="caption" tone="destructive">
                            {`${failed} failed`}
                        </AppText>
                    )}
                    <SymbolView name="chevron.right" size={10} weight="semibold" tintColor={theme.mutedForeground} style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }} />
                </Pressable>
            </View>
            {open && (
                <Animated.View entering={FadeIn.duration(250)} exiting={FadeOut.duration(200)}>
                    <StepList items={items} />
                </Animated.View>
            )}
        </View>
    )
}

/** One step of an agent's work on a single line, which opens on what went in and what came out. */
// `defaultOpen`: a step that opens on its own while it runs (a delegation and its tasks), and folds
// back once it settles.
export function StepRow({ symbol, label, detail, status, elapsed, defaultOpen = false, children }: { symbol: SFSymbol; label: string; detail?: string; status: StepStatus; elapsed?: ReactNode; defaultOpen?: boolean; children?: ReactNode }) {
    const theme = useTheme()
    const [open, setOpen] = useState(defaultOpen)
    const wasOpenByDefault = useRef(defaultOpen)
    useEffect(() => {
        if (wasOpenByDefault.current && !defaultOpen) setOpen(false)
        wasOpenByDefault.current = defaultOpen
    }, [defaultOpen])
    const expandable = !!children
    const title = (
        <AppText variant="footnote" medium numberOfLines={1} style={{ color: status === 'error' ? theme.destructive : theme.foreground }}>
            {label}
        </AppText>
    )
    return (
        <View>
            <Pressable disabled={!expandable} onPress={() => setOpen(current => !current)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: ROW_HEIGHT, paddingHorizontal: 6, borderRadius: radius.sm, backgroundColor: pressed ? theme.muted : 'transparent' })}>
                <SymbolView name={symbol} size={13} tintColor={theme.mutedForeground} />
                <View style={{ flexShrink: 0, maxWidth: '60%' }}>{status === 'running' ? <Breathing>{title}</Breathing> : title}</View>
                <AppText variant="footnote" tone="muted" numberOfLines={1} style={{ flex: 1 }}>
                    {detail}
                </AppText>
                {elapsed}
                {expandable && <SymbolView name="chevron.right" size={10} weight="semibold" tintColor={theme.mutedForeground} style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }} />}
            </Pressable>
            {open && expandable && <View style={{ gap: 6, marginHorizontal: 6, marginBottom: spacing.xs }}>{children}</View>}
        </View>
    )
}

function Elapsed({ active }: { active: boolean }) {
    const seconds = useElapsed(active)
    if (seconds === undefined) return null
    return (
        <AppText variant="caption" tone="muted" style={{ fontFamily: fonts.mono, fontSize: 11, fontVariant: ['tabular-nums'], opacity: 0.7 }}>
            {formatElapsed(seconds)}
        </AppText>
    )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
    return (
        <View style={{ gap: 2 }}>
            <AppText variant="caption" tone="muted" medium style={{ fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase' }}>
                {label}
            </AppText>
            {children}
        </View>
    )
}

function Mono({ text, tone = 'default', maxHeight = 160 }: { text: string; tone?: 'default' | 'destructive'; maxHeight?: number }) {
    const theme = useTheme()
    return (
        <ScrollView nestedScrollEnabled style={{ maxHeight, borderRadius: 6, backgroundColor: tone === 'destructive' ? 'rgba(239,68,68,0.12)' : theme.background }} contentContainerStyle={{ paddingHorizontal: spacing.sm, paddingVertical: 6 }}>
            <Text selectable style={{ fontFamily: tone === 'destructive' ? fonts.regular : fonts.mono, fontSize: 12, lineHeight: 17, color: tone === 'destructive' ? theme.destructive : theme.foreground }}>
                {text}
            </Text>
        </ScrollView>
    )
}

// The arguments the way the web reads them: a lone preview, a shell command or a file path stands
// alone, anything else as JSON.
function argsText(toolName: string, args: Record<string, unknown>): string {
    if (typeof args.preview === 'string' && Object.keys(args).length <= 1) return args.preview
    if (toolName === 'shell_exec' && typeof args.command === 'string') return args.command
    if (/^(fs|shared)_(read|write|edit|list|search)$/.test(toolName) && typeof args.path === 'string') return args.path
    return JSON.stringify(args, null, 2)
}

function outputText(output: unknown): string {
    if (output && typeof output === 'object' && 'duration' in output && Object.keys(output).length === 1) {
        const duration = (output as { duration?: number }).duration
        if (typeof duration === 'number') return `Completed in ${duration < 1 ? `${Math.round(duration * 1000)}ms` : `${duration.toFixed(1)}s`}`
    }
    const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2)
    return text.length > OUTPUT_MAX ? `${text.slice(0, OUTPUT_MAX)}…` : text
}

type ToolCallStepProps = { toolName: string; state: string | undefined; input?: unknown; inputText?: string; output?: unknown; errorText?: string; agentName?: (agentId: string) => string | undefined }

/** A tool call on one line of the folded steps: what it was called with, and the full exchange on a tap. */
export function ToolCallStep({ toolName, state, input, inputText, output, errorText, agentName }: ToolCallStepProps) {
    const status = toolStatusOf(state)
    const args = argsOf(input)
    const targetAgentId = agentIdOf(input)
    const detail = status === 'error' && errorText ? readableToolError(errorText) : toolHeadline(input, targetAgentId ? agentName?.(targetAgentId) : undefined)
    const hasDetails = Object.keys(args ?? {}).length > 0 || output !== undefined || !!inputText || !!errorText
    return (
        <StepRow symbol={toolSymbolOf(toolName)} label={toolLabelOf(toolName, input)} detail={detail} status={status} elapsed={<Elapsed active={status === 'running'} />}>
            {hasDetails ? (
                <>
                    {state === 'input-streaming' && inputText ? <Section label="Input">{<Mono text={inputText} />}</Section> : null}
                    {args && Object.keys(args).length > 0 ? <Section label="Input">{<Mono text={argsText(toolName, args)} />}</Section> : null}
                    {errorText ? <Section label="Error">{<Mono text={readableToolError(errorText)} tone="destructive" />}</Section> : null}
                    {output !== undefined ? <Section label="Output">{<Mono text={outputText(output)} maxHeight={240} />}</Section> : null}
                </>
            ) : null}
        </StepRow>
    )
}

/** A settled or running thought on one line of the folded steps. */
export function ReasoningStep({ text, streaming }: { text: string; streaming: boolean }) {
    const theme = useTheme()
    return (
        <StepRow symbol="brain" label={streaming ? 'Thinking...' : 'Thought'} detail={text.replace(/\s+/g, ' ')} status={streaming ? 'running' : 'done'}>
            {text ? (
                <View style={{ borderLeftWidth: StyleSheet.hairlineWidth * 2, borderLeftColor: theme.border, paddingLeft: spacing.md }}>
                    <AppText variant="footnote" tone="muted" selectable>
                        {text}
                    </AppText>
                </View>
            ) : null}
        </StepRow>
    )
}

export type CompactionData = { status: 'running' | 'done' | 'error'; messagesCompacted?: number; tokensRecovered?: number }

/** The compaction of the conversation's context on one line of the folded steps. */
export function CompactionStep({ data }: { data: CompactionData }) {
    const settled = data.status === 'done'
    const summarized = settled && typeof data.messagesCompacted === 'number' ? `${data.messagesCompacted} earlier messages summarized` : undefined
    const recovered = settled && typeof data.tokensRecovered === 'number' ? `~${data.tokensRecovered.toLocaleString('en-US')} tokens recovered` : undefined
    const label = data.status === 'running' ? 'Compacting context…' : data.status === 'error' ? 'Context compaction failed' : 'Context compacted'
    return <StepRow symbol="arrow.down.right.and.arrow.up.left" label={label} detail={[summarized, recovered].filter(Boolean).join(' · ')} status={data.status} />
}
