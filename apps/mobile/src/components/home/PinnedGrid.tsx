import { Button, ContextMenu, Host, RNHostView } from '@expo/ui/swift-ui'
import { accessibilityLabel, buttonStyle } from '@expo/ui/swift-ui/modifiers'
import { View } from 'react-native'

import { AgentBuddy } from '@/components/buddy/AgentBuddy'
import { moodStatus, type HomeCoworker } from '@/components/home/board'
import { usePaneSize } from '@/components/layout/PaneSize'
import { columnsFor } from '@/components/layout/split'
import { AppText } from '@/components/ui/AppText'
import { moodOf } from '@/components/ui/CoworkerAvatar'
import { UnreadDot } from '@/components/ui/UnreadDot'
import { useTheme } from '@/theme/theme'
import { spacing } from '@/theme/tokens'

const FEWEST_COLUMNS = 3
const MIN_CELL = 108
const DISC_MAX = 84
const UNREAD_DOT = 14

export type PinnedCell = { width: number; disc: number; columns: number }

// The size of a cell of the grid in this pane: three across on an iPhone, more on a wider pane, the disc
// capped on a wide one.
export function usePinnedCell(): PinnedCell {
    const { width } = usePaneSize()
    const inner = width - 2 * spacing.xl
    const columns = columnsFor(inner, MIN_CELL, FEWEST_COLUMNS)
    const cellWidth = Math.floor(inner / columns)
    return { width: cellWidth, disc: Math.min(DISC_MAX, cellWidth - 2 * spacing.md), columns }
}

// A pinned coworker as iMessage draws a pinned contact: a round disc, the name under it.
export function PinnedAvatar({ coworker, cell, animated = true }: { coworker: HomeCoworker; cell: PinnedCell; animated?: boolean }) {
    const theme = useTheme()
    const unread = coworker.pending > 0
    const dotInset = Math.round((cell.disc / 2) * (1 - Math.SQRT1_2) - UNREAD_DOT / 2)
    return (
        <View style={{ width: cell.width, alignItems: 'center', gap: spacing.xs + 2, paddingVertical: spacing.sm }}>
            <View style={{ width: cell.disc, height: cell.disc, borderRadius: cell.disc / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.muted }}>
                <AgentBuddy agentId={coworker.id} size={Math.round(cell.disc * 0.7)} mood={moodOf(moodStatus(coworker))} animated={animated} />
                {unread && <UnreadDot style={{ position: 'absolute', top: dotInset, left: dotInset, width: UNREAD_DOT, height: UNREAD_DOT, borderRadius: UNREAD_DOT / 2, borderWidth: 2, borderColor: theme.background }} />}
            </View>
            <AppText variant="footnote" tone={unread ? 'default' : 'muted'} medium={unread} numberOfLines={1} maxFontSizeMultiplier={1.3} style={{ maxWidth: cell.width - spacing.sm, textAlign: 'center' }}>
                {coworker.name}
            </AppText>
        </View>
    )
}

type PinnedGridProps = {
    coworkers: HomeCoworker[]
    onOpen: (coworker: HomeCoworker) => void
    onUnpin: (coworker: HomeCoworker) => void
    onDetails: (coworker: HomeCoworker) => void
    // Absent with a single pin: there is nothing to reorder.
    onEdit?: () => void
}

// The pinned coworkers in a grid at the top of the Home. A tap opens the chat, a long press the
// system's context menu. The cell is a SwiftUI button around an inert RN view, so both gestures stay native.
export function PinnedGrid({ coworkers, onOpen, onUnpin, onDetails, onEdit }: PinnedGridProps) {
    const theme = useTheme()
    const cell = usePinnedCell()
    return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: spacing.xl }}>
            {coworkers.map(coworker => (
                <Host key={coworker.id} matchContents colorScheme={theme.scheme}>
                    <ContextMenu>
                        <ContextMenu.Items>
                            <Button label="Unpin" systemImage="pin.slash" onPress={() => onUnpin(coworker)} />
                            <Button label="Coworker details" systemImage="info.circle" onPress={() => onDetails(coworker)} />
                            {onEdit ? <Button label="Edit pins" systemImage="arrow.up.arrow.down" onPress={onEdit} /> : null}
                        </ContextMenu.Items>
                        <ContextMenu.Trigger>
                            <Button onPress={() => onOpen(coworker)} modifiers={[buttonStyle('plain'), accessibilityLabel(coworker.pending > 0 ? `${coworker.name}, unread` : coworker.name)]}>
                                <RNHostView matchContents>
                                    <PinnedAvatar coworker={coworker} cell={cell} />
                                </RNHostView>
                            </Button>
                        </ContextMenu.Trigger>
                    </ContextMenu>
                </Host>
            ))}
        </View>
    )
}
