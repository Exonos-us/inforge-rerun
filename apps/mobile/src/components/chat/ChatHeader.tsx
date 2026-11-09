import { Button, Image, Menu, Section, Text, Toggle } from '@expo/ui/swift-ui'
import { disabled } from '@expo/ui/swift-ui/modifiers'
import type { SessionStatus } from '@rerun/contracts'
import { GlassView } from 'expo-glass-effect'
import { SymbolView } from 'expo-symbols'
import { View } from 'react-native'
import Animated, { Extrapolation, FadeIn, interpolate, useAnimatedStyle, type SharedValue } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { conversationSections, glyphOf, stateOf } from '@/components/chat/conversation-sections'
import { usePaneSize } from '@/components/layout/PaneSize'
import { AppText } from '@/components/ui/AppText'
import { CoworkerAvatar } from '@/components/ui/CoworkerAvatar'
import { EdgeFade } from '@/components/ui/EdgeFade'
import { GlassButton, GLASS_BUTTON_SIZE, useGlassStyle } from '@/components/ui/GlassButton'
import { NativeMenu } from '@/components/ui/NativeMenu'
import { Skeleton } from '@/components/ui/Skeleton'
import { messageStamp } from '@/lib/time'
import type { Coworker } from '@/mocks/data'
import { useTheme } from '@/theme/theme'
import { fonts, spacing } from '@/theme/tokens'

const AVATAR = GLASS_BUTTON_SIZE
const PILL_HEIGHT = 40
const PILL_OVERLAP = 8
const CHEVRON_SPACE = 18
export const CHAT_HEADER_HEIGHT = AVATAR - PILL_OVERLAP + PILL_HEIGHT + spacing.sm
const CHIP_MAX_WIDTH = 220

// A conversation as the header shows it. `title` is null until the first message names it, and
// `loading` while the hub has not said yet what the conversation is called. `status`, `unseen` and
// `ask` sort it into the menu's sections; without them it sits in a single list.
// `automationName` and `updatedAt` are set on a scheduled or triggered run, whose title says what it did.
export type ChatTab = { id: string; title: string | null; running: boolean; empty: boolean; loading?: boolean; status?: SessionStatus; unseen?: boolean; ask?: string | null; automationName?: string | null; updatedAt?: string }

// The draft the pager ends on, as the last page of the chip.
const DRAFT_TAB: ChatTab = { id: 'draft', title: null, running: false, empty: true }

type ChatCoworker = Pick<Coworker, 'id' | 'kind' | 'name' | 'status'>

type ChipPageProps = {
    coworker: ChatCoworker
    session: ChatTab
    active: boolean
    width: number
    // The pager's position and this page's index: the page fades as it slides out of the chip.
    progress?: SharedValue<number>
    index?: number
}

// One conversation inside the header's pill: the coworker's name over the conversation's title.
export function ChipPage({ coworker, session, active, width, progress, index = 0 }: ChipPageProps) {
    const theme = useTheme()
    const title = session.title ?? 'New conversation'
    const settledDistance = active ? 0 : 1
    const fade = useAnimatedStyle(() => {
        const distance = progress ? Math.abs(progress.value - index) : settledDistance
        return { opacity: interpolate(distance, [0, 0.6], [1, 0], Extrapolation.CLAMP) }
    })
    return (
        <Animated.View style={[{ width, height: PILL_HEIGHT, alignItems: 'center', justifyContent: 'center', paddingLeft: CHEVRON_SPACE, paddingRight: CHEVRON_SPACE }, fade]}>
            <View style={{ maxWidth: '100%', alignItems: 'center' }}>
                <AppText variant="caption" tone="muted" medium numberOfLines={1} maxFontSizeMultiplier={1.2} style={{ textAlign: 'center' }}>
                    {coworker.name}
                </AppText>
                {session.loading ? (
                    <Skeleton style={{ width: 96, height: 12, marginVertical: 3 }} />
                ) : (
                    <Animated.Text key={title} entering={FadeIn.duration(400)} numberOfLines={1} maxFontSizeMultiplier={1.2} style={{ fontFamily: fonts.medium, fontSize: 14, lineHeight: 18, letterSpacing: -0.2, textAlign: 'center', color: session.title ? theme.foreground : theme.mutedForeground }}>
                        {title}
                    </Animated.Text>
                )}
            </View>
        </Animated.View>
    )
}

function ConversationItem({ session, active, onSelect }: { session: ChatTab; active: boolean; onSelect: (sessionId: string) => void }) {
    const title = session.title ?? 'New conversation'
    if (active) return <Toggle label={title} isOn onIsOnChange={() => {}} />
    const glyph = glyphOf(session)
    const subtitle = (stateOf(session) === 'needs-you' ? session.ask : null) ?? automationLine(session)
    return (
        <Button onPress={() => onSelect(session.id)}>
            {glyph ? <Image systemName={glyph} /> : <Text>{''}</Text>}
            <Text>{title}</Text>
            {subtitle ? <Text>{subtitle}</Text> : <Text>{''}</Text>}
        </Button>
    )
}

// "Daily missions apply · Yesterday 4:30 PM". The routine is left out while the title still is its name.
function automationLine({ title, automationName, updatedAt }: ChatTab): string | null {
    if (!automationName || !updatedAt) return null
    return [automationName !== title && automationName, messageStamp(updatedAt)].filter(Boolean).join(' · ')
}

function ConversationsMenu({ sessions, activeId, onSelect }: { sessions: ChatTab[]; activeId: string | undefined; onSelect: (sessionId: string) => void }) {
    const { sections, earlier } = conversationSections(sessions)
    if (sections.length === 0) {
        return (
            <Menu label="Conversations">
                {sessions.map(session => (
                    <Toggle key={session.id} label={session.title ?? 'New conversation'} isOn={session.id === activeId} onIsOnChange={() => onSelect(session.id)} />
                ))}
            </Menu>
        )
    }
    return (
        <>
            {sections.map(section => (
                <Section key={section.state} title={section.label}>
                    {section.conversations.map(session => (
                        <ConversationItem key={session.id} session={session} active={session.id === activeId} onSelect={onSelect} />
                    ))}
                </Section>
            ))}
            {earlier.length > 0 && (
                <Section title="Earlier">
                    <Menu label={earlier.length === 1 ? '1 conversation' : `${earlier.length} conversations`}>
                        {earlier.map(session => (
                            <ConversationItem key={session.id} session={session} active={session.id === activeId} onSelect={onSelect} />
                        ))}
                    </Menu>
                </Section>
            )}
        </>
    )
}

type ChatHeaderProps = {
    coworker: ChatCoworker
    // The open conversations in the pager's order. The pager ends on a draft, the chip's last page.
    tabs: ChatTab[]
    // Undefined on the draft.
    activeId: string | undefined
    // The pager's position, in pages: the chip's content slides with the finger.
    progress: SharedValue<number>
    allSessions: ChatTab[]
    // Absent beside the sidebar of a wide window, where the conversation is the root of its pane.
    onBack?: () => void
    onSelect: (sessionId: string) => void
    onNewSession: () => void
    onOpenDetails?: () => void
}

export function ChatHeader({ coworker, tabs, activeId, progress, allSessions, onBack, onSelect, onNewSession, onOpenDetails }: ChatHeaderProps) {
    const theme = useTheme()
    const glass = useGlassStyle()
    const insets = useSafeAreaInsets()
    const { width: paneWidth } = usePaneSize()
    const chipWidth = Math.min(CHIP_MAX_WIDTH, paneWidth - 2 * (spacing.lg + GLASS_BUTTON_SIZE + spacing.sm))
    const hasConversations = tabs.length > 0
    const pages = [...tabs, DRAFT_TAB]
    const activeIndex = hasConversations && activeId ? tabs.findIndex(session => session.id === activeId) : tabs.length
    const activeTitle = tabs[activeIndex]?.title ?? 'New conversation'
    const running = tabs[activeIndex]?.running ?? false
    const track = useAnimatedStyle(() => ({ transform: [{ translateX: hasConversations ? -progress.value * chipWidth : 0 }] }))
    const menuOpens = hasConversations || Boolean(onOpenDetails)
    // The coworker's face over a glass pill with its name and the conversation, as iMessage heads a chat.
    const identity = (
        <View style={{ alignItems: 'center' }}>
            <CoworkerAvatar coworker={{ ...coworker, status: running ? 'working' : coworker.status === 'working' ? 'idle' : coworker.status }} size={AVATAR} />
            <GlassView colorScheme={theme.scheme} glassEffectStyle={glass} style={{ borderRadius: PILL_HEIGHT / 2, marginTop: -PILL_OVERLAP }}>
                <View style={{ width: chipWidth, height: PILL_HEIGHT, overflow: 'hidden' }}>
                    <Animated.View style={[{ flexDirection: 'row', width: pages.length * chipWidth }, track]}>
                        {pages.map((session, index) => (
                            <ChipPage key={session.id} coworker={coworker} session={hasConversations ? session : { ...session, title: 'New chat' }} active={index === activeIndex} width={chipWidth} progress={hasConversations ? progress : undefined} index={index} />
                        ))}
                    </Animated.View>
                    {menuOpens && (
                        <View pointerEvents="none" style={{ position: 'absolute', right: spacing.sm + 2, top: 0, bottom: 0, justifyContent: 'center' }}>
                            <SymbolView name="chevron.right" size={11} weight="semibold" tintColor={theme.mutedForeground} />
                        </View>
                    )}
                </View>
            </GlassView>
        </View>
    )

    return (
        <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0 }}>
            <EdgeFade edge="top" height={insets.top + CHAT_HEADER_HEIGHT + 16} />
            <View pointerEvents="box-none" style={{ paddingTop: insets.top + spacing.xs, paddingHorizontal: spacing.lg, flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
                {onBack ? <GlassButton symbol="chevron.left" label="Back" onPress={onBack} /> : <View style={{ width: GLASS_BUTTON_SIZE }} />}
                <View pointerEvents="box-none" style={{ flex: 1, alignItems: 'center' }}>
                    {menuOpens ? (
                        <NativeMenu label={`${coworker.name}, ${activeTitle}, conversations`} trigger={identity}>
                            {onOpenDetails && <Button label="Coworker details" systemImage="info.circle" onPress={onOpenDetails} />}
                            {hasConversations && <Button label="New conversation" systemImage="plus" onPress={onNewSession} modifiers={[disabled(!activeId)]} />}
                            {hasConversations && <ConversationsMenu sessions={allSessions} activeId={activeId} onSelect={onSelect} />}
                        </NativeMenu>
                    ) : (
                        identity
                    )}
                </View>
                <View style={{ width: GLASS_BUTTON_SIZE }} />
            </View>
        </View>
    )
}
