import { router, useLocalSearchParams } from 'expo-router'
import { useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { lineOf, moodStatus, type HomeCoworker } from '@/components/home/board'
import { CoworkerRow } from '@/components/home/CoworkerRow'
import { ForemanRow } from '@/components/home/ForemanRow'
import { HomeBottomBar } from '@/components/home/HomeBottomBar'
import { HomeHeader } from '@/components/home/HomeHeader'
import { PinnedAvatar, PinnedGrid, usePinnedCell } from '@/components/home/PinnedGrid'
import { SortableGrid } from '@/components/home/SortableGrid'
import { AppText } from '@/components/ui/AppText'
import { EdgeFade } from '@/components/ui/EdgeFade'
import { GLASS_BUTTON_SIZE } from '@/components/ui/GlassButton'
import { ThemeScope, useColorSchemeName, useTheme } from '@/theme/theme'
import { spacing, type ColorScheme } from '@/theme/tokens'

// Dev only: the Home on mock coworkers, to judge the pinned grid, the Foreman's row and the bottom bar.
//   /lab-home?pins=3&scheme=dark   pins: 0 to 9

const noop = () => {}

const mock = (id: string, name: string, status: HomeCoworker['status'], description: string, pending = 0, paused = false): HomeCoworker => ({ id, name, handle: null, description, status, paused, spaceId: 'box-1', latest: null, pending })

const TEAM: HomeCoworker[] = [
    mock('agent-scout', 'Scout', 'waiting_human', 'Lead finder', 2),
    mock('agent-pulse', 'Pulse', 'working', 'Social media'),
    mock('agent-ledger', 'Ledger', 'error', 'Invoices and payments', 1),
    mock('agent-inbox', 'Inbox Zero', 'idle', 'Email triage'),
    mock('agent-recap', 'Recap', 'offline', 'Weekly report'),
    mock('cw-inbox', 'Echo', 'idle', 'Customer support'),
    mock('agent-hunter', 'Headhunter Pro', 'idle', 'Sources candidates on LinkedIn'),
    mock('agent-seo', 'Rankwell', 'working', 'Writes the blog'),
    mock('agent-books', 'Bookkeeper', 'idle', 'Closes the month', 0, true),
    mock('agent-calls', 'Callback', 'idle', 'Books the demos'),
    mock('agent-press', 'Press', 'idle', 'Watches the news'),
]

function MockHome({ pinCount }: { pinCount: number }) {
    const theme = useTheme()
    const insets = useSafeAreaInsets()
    const cell = usePinnedCell()
    const [pinnedIds, setPinnedIds] = useState(() => TEAM.slice(0, pinCount).map(coworker => coworker.id))
    const [reordering, setReordering] = useState(false)
    const [group, setGroup] = useState<'recent' | 'box'>('recent')
    const pinned = pinnedIds.map(id => TEAM.find(coworker => coworker.id === id)!)
    const others = TEAM.filter(coworker => !pinnedIds.includes(coworker.id))
    const togglePin = (id: string) => setPinnedIds(current => (current.includes(id) ? current.filter(entry => entry !== id) : [...current, id]))
    const headerHeight = insets.top + spacing.sm + GLASS_BUTTON_SIZE

    return (
        <View style={{ flex: 1, backgroundColor: theme.background }}>
            <ScrollView scrollEnabled={!reordering} contentContainerStyle={{ paddingTop: headerHeight + spacing.lg, paddingBottom: insets.bottom + 120 }} contentInsetAdjustmentBehavior="never">
                <AppText variant="largeTitle" maxFontSizeMultiplier={1} style={{ paddingHorizontal: spacing.xl, marginBottom: spacing.md }}>
                    Coworkers
                </AppText>
                {pinned.length > 0 && (
                    <View style={{ marginBottom: spacing.sm }}>
                        {reordering && (
                            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.sm }}>
                                <AppText variant="footnote" tone="muted" medium style={{ flex: 1 }}>
                                    Drag to reorder
                                </AppText>
                                <Pressable onPress={() => setReordering(false)} accessibilityRole="button" hitSlop={10}>
                                    <AppText variant="footnote" medium>
                                        Done
                                    </AppText>
                                </Pressable>
                            </View>
                        )}
                        {reordering ? (
                            <View style={{ paddingHorizontal: spacing.xl }}>
                                <SortableGrid items={pinned} columns={cell.columns} cellWidth={cell.width} renderCell={coworker => <PinnedAvatar coworker={coworker} cell={cell} animated={false} />} onReorder={setPinnedIds} />
                            </View>
                        ) : (
                            <PinnedGrid coworkers={pinned} onOpen={noop} onUnpin={coworker => togglePin(coworker.id)} onDetails={noop} onEdit={pinned.length > 1 ? () => setReordering(true) : undefined} />
                        )}
                    </View>
                )}
                <ForemanRow last={{ title: 'Overnight catch-up', running: false }} onPress={() => router.push({ pathname: '/lab-chat', params: { coworker: 'foreman', tabs: '1', state: 'conversation' } })} />
                {others.map(coworker => (
                    <CoworkerRow key={coworker.id} coworker={{ id: coworker.id, kind: 'coworker', name: coworker.name, status: moodStatus(coworker) }} line={lineOf(coworker)} minutesAgo={null} unread={coworker.pending > 0} onPress={noop} pin={{ pinned: false, onToggle: () => togglePin(coworker.id) }} />
                ))}
            </ScrollView>
            <EdgeFade edge="top" height={headerHeight + spacing.lg} />
            <EdgeFade edge="bottom" height={insets.bottom + 90} />
            <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + spacing.sm, left: 0, right: 0 }}>
                <HomeHeader group={group} onGroup={setGroup} />
            </View>
            <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + spacing.sm }}>
                <HomeBottomBar count={4} onSearch={() => router.push('/search')} onInbox={noop} />
            </View>
        </View>
    )
}

export default function HomeLab() {
    const params = useLocalSearchParams<{ pins?: string; scheme?: ColorScheme }>()
    const system = useColorSchemeName()
    const scheme = params.scheme === 'dark' || params.scheme === 'light' ? params.scheme : system
    const pinCount = Math.max(0, Math.min(9, Number(params.pins ?? 3)))
    return (
        <ThemeScope scheme={scheme}>
            <MockHome key={pinCount} pinCount={pinCount} />
        </ThemeScope>
    )
}
