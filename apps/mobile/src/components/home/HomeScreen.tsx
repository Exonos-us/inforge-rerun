import { FOREMAN_AGENT_ID } from '@rerun/contracts'
import { router, useGlobalSearchParams, usePathname, type Href } from 'expo-router'
import { useEffect, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useAuth } from '@/auth/AuthProvider'
import { coworkerEndpoints } from '@/chat/endpoints'
import { lineOf, minutesSince, moodStatus, recentCoworkers, sectionsByBox, withPinned, type HomeCoworker } from '@/components/home/board'
import { SkeletonFade, useBootFill } from '@/components/home/BootFill'
import { LAST_CONVERSATION } from '@/components/chat/ForemanChat'
import { CoworkerRow } from '@/components/home/CoworkerRow'
import { ForemanRow } from '@/components/home/ForemanRow'
import { HomeBottomBar } from '@/components/home/HomeBottomBar'
import { HomeHeader } from '@/components/home/HomeHeader'
import { HomeSkeleton } from '@/components/home/HomeSkeleton'
import { NewCoworkerRow } from '@/components/home/NewCoworkerRow'
import { PinnedAvatar, PinnedGrid, usePinnedCell } from '@/components/home/PinnedGrid'
import { SectionHeader } from '@/components/home/SectionHeader'
import { SortableGrid } from '@/components/home/SortableGrid'
import { useForemanLast } from '@/components/home/useForemanLast'
import { useGroupMode } from '@/components/home/useGroupMode'
import { usePinnedAgents } from '@/components/home/usePinnedAgents'
import { inboxCount } from '@/components/inbox/inbox'
import { AppText } from '@/components/ui/AppText'
import { EdgeFade } from '@/components/ui/EdgeFade'
import { GLASS_BUTTON_SIZE } from '@/components/ui/GlassButton'
import { PillButton } from '@/components/ui/PillButton'
import { loadTranscript } from '@/data/local-cache'
import { useInbox } from '@/data/InboxProvider'
import { useBoard } from '@/data/useBoard'
import { setBadge } from '@/notifications/push'
import { layoutTransition as layout } from '@/theme/motion'
import { useTheme } from '@/theme/theme'
import { spacing } from '@/theme/tokens'

// A wide window draws the Home as a sidebar beside the conversation: a tap swaps the conversation
// instead of stacking one more screen, and the row of the open one stays lit.
export function HomeScreen({ sidebar = false }: { sidebar?: boolean }) {
    const theme = useTheme()
    const insets = useSafeAreaInsets()
    const { session, me } = useAuth()
    const board = useBoard()
    const inbox = useInbox()
    const [group, setGroup] = useGroupMode()
    const [collapsed, setCollapsed] = useState<string[]>([])
    const fill = useBootFill(board.state === 'ready')

    const pathname = usePathname()
    const { to } = useGlobalSearchParams<{ to?: string }>()
    const openAgentId = sidebar && pathname.startsWith('/chat/') ? (to ?? FOREMAN_AGENT_ID) : null
    const go = (href: Href) => {
        if (!sidebar) return router.push(href)
        if (router.canDismiss()) router.dismissAll()
        router.replace(href)
    }

    const openForeman = () => go({ pathname: '/chat/[id]', params: { id: LAST_CONVERSATION } })

    const foreman = useForemanLast()
    const pins = usePinnedAgents()
    const cell = usePinnedCell()
    const [reordering, setReordering] = useState(false)
    const { pinned, others } = withPinned(board.state === 'ready' ? board.coworkers : [], pins.pinned)
    const sections = board.state === 'ready' && group === 'box' ? sectionsByBox(others, board.boxes) : []
    const recent = board.state === 'ready' && group === 'recent' ? recentCoworkers(others) : []

    // The app icon shows the bell's count, never off the copy kept from the last visit.
    const unread = inbox.state === 'ready' && inbox.fresh ? inboxCount(inbox.items) : null
    useEffect(() => {
        if (unread !== null) setBadge(unread).catch(() => {})
    }, [unread])

    const open = (coworker: HomeCoworker) => go({ pathname: '/chat/[id]', params: { id: coworker.latest?.id ?? 'new', to: coworker.id } })

    const warmUp = (coworker: HomeCoworker) => {
        const sessionId = coworker.latest?.id
        if (!sessionId || !session || !me) return
        const caller = { accessToken: session.access_token, workspaceId: me.workspace.id }
        loadTranscript(caller.workspaceId, sessionId, () => coworkerEndpoints(coworker.id).messages(caller, sessionId)).catch(() => {})
    }

    const togglePin = (coworker: HomeCoworker) => (pins.pinned.includes(coworker.id) ? pins.unpin(coworker.id) : pins.pin(coworker.id))

    const coworkerRow = (coworker: HomeCoworker) => <CoworkerRow coworker={{ id: coworker.id, kind: 'coworker', name: coworker.name, status: moodStatus(coworker) }} line={lineOf(coworker)} minutesAgo={minutesSince(coworker.latest?.updatedAt)} unread={coworker.pending > 0} selected={openAgentId === coworker.id} onPress={() => open(coworker)} onPressIn={() => warmUp(coworker)} pin={{ pinned: pins.pinned.includes(coworker.id), onToggle: () => togglePin(coworker) }} />

    const toggle = (key: string) => setCollapsed(current => (current.includes(key) ? current.filter(entry => entry !== key) : [...current, key]))
    const headerHeight = insets.top + spacing.sm + GLASS_BUTTON_SIZE

    return (
        <View style={{ flex: 1, backgroundColor: theme.background }}>
            <ScrollView scrollEnabled={!reordering} contentContainerStyle={{ paddingTop: headerHeight + spacing.lg, paddingBottom: insets.bottom + 120 }} contentInsetAdjustmentBehavior="never">
                <AppText variant="largeTitle" maxFontSizeMultiplier={1} style={{ paddingHorizontal: spacing.xl, marginBottom: spacing.md }}>
                    Coworkers
                </AppText>

                {board.state === 'loading' && <HomeSkeleton />}

                {board.state === 'error' && (
                    <View style={{ alignItems: 'flex-start', gap: spacing.md, paddingHorizontal: spacing.xl, paddingTop: spacing.lg }}>
                        <AppText variant="callout" tone="muted">
                            We could not load your coworkers.
                        </AppText>
                        <PillButton label="Retry" variant="secondary" onPress={board.reload} />
                    </View>
                )}

                {board.state === 'ready' && board.coworkers.length === 0 && (
                    <AppText variant="callout" tone="muted" style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.lg }}>
                        No coworkers yet.
                    </AppText>
                )}

                <View>
                    {pinned.length > 0 && (
                        <Animated.View layout={layout} entering={fill.playing ? fill.rowEntering(0) : undefined} style={{ marginBottom: spacing.sm }}>
                            {reordering && (
                                <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.sm }}>
                                    <AppText variant="footnote" tone="muted" medium style={{ flex: 1 }}>
                                        Drag to reorder
                                    </AppText>
                                    <Pressable onPress={() => setReordering(false)} accessibilityRole="button" hitSlop={10}>
                                        <AppText variant="footnote" medium style={{ color: theme.foreground }}>
                                            Done
                                        </AppText>
                                    </Pressable>
                                </View>
                            )}
                            {reordering ? (
                                <View style={{ paddingHorizontal: spacing.xl }}>
                                    <SortableGrid items={pinned} columns={cell.columns} cellWidth={cell.width} renderCell={coworker => <PinnedAvatar coworker={coworker} cell={cell} animated={false} />} onReorder={pins.reorder} />
                                </View>
                            ) : (
                                <PinnedGrid coworkers={pinned} onOpen={open} onUnpin={coworker => pins.unpin(coworker.id)} onDetails={coworker => router.push({ pathname: '/coworker/[id]', params: { id: coworker.id, name: coworker.name } })} onEdit={pinned.length > 1 ? () => setReordering(true) : undefined} />
                            )}
                        </Animated.View>
                    )}

                    {board.state === 'ready' && <ForemanRow last={foreman} selected={openAgentId === FOREMAN_AGENT_ID} onPress={openForeman} />}

                    {recent.map((coworker, index) => (
                        <Animated.View key={`recent:${coworker.id}`} layout={layout} entering={fill.rowEntering(index)} exiting={FadeOut.duration(120)}>
                            {coworkerRow(coworker)}
                        </Animated.View>
                    ))}

                    {sections.map((section, index) => (
                        <Animated.View key={`box:${section.key}`} layout={layout} entering={fill.playing ? fill.rowEntering(index) : undefined} style={{ marginTop: spacing.sm }}>
                            <SectionHeader label={section.label} count={section.members.length} collapsed={collapsed.includes(section.key)} onToggle={() => toggle(section.key)} divided={index > 0} />
                            {!collapsed.includes(section.key) &&
                                section.members.map(coworker => (
                                    <Animated.View key={coworker.id} layout={layout} entering={fill.playing ? undefined : FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
                                        {coworkerRow(coworker)}
                                    </Animated.View>
                                ))}
                        </Animated.View>
                    ))}

                    {board.state === 'ready' && (
                        <Animated.View entering={fill.playing ? fill.rowEntering(recent.length + sections.length) : undefined}>
                            <NewCoworkerRow onPress={() => router.push('/new-coworker')} />
                        </Animated.View>
                    )}

                    {fill.playing && <SkeletonFade reveal={fill.reveal} staggered={fill.staggered} />}
                </View>
            </ScrollView>

            <EdgeFade edge="top" height={headerHeight + spacing.lg} />
            <EdgeFade edge="bottom" height={insets.bottom + 90} />
            <Animated.View entering={fill.chromeEntering} pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + spacing.sm, left: 0, right: 0 }}>
                <HomeHeader group={group} onGroup={setGroup} />
            </Animated.View>
            <Animated.View entering={fill.chromeEntering} pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + spacing.sm }}>
                <HomeBottomBar count={inbox.state === 'ready' ? inboxCount(inbox.items) : 0} onSearch={() => router.push('/search')} onInbox={() => router.push('/inbox')} />
            </Animated.View>
        </View>
    )
}
