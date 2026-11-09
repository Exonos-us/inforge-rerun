import * as Haptics from 'expo-haptics'
import { SymbolView } from 'expo-symbols'
import { useRef, type ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'

import { AppText } from '@/components/ui/AppText'
import { CoworkerAvatar } from '@/components/ui/CoworkerAvatar'
import { UnreadDot } from '@/components/ui/UnreadDot'
import { timeAgo, type StatusLine } from '@/components/ui/status'
import type { Coworker } from '@/mocks/data'
import { useTheme } from '@/theme/theme'
import { brand, spacing } from '@/theme/tokens'

export const AVATAR = 36
// At the default text size: the padding around a name line (22) and a status line (20) under it.
export const COWORKER_ROW_HEIGHT = 68
const PIN_ACTION_WIDTH = 96

export type PinControl = { pinned: boolean; onToggle: () => void }

type CoworkerRowProps = {
    coworker: Pick<Coworker, 'id' | 'kind' | 'name' | 'status'>
    line: StatusLine
    minutesAgo: number | null
    unread: boolean
    // The conversation open beside the list, on a wide window.
    selected?: boolean
    onPress: () => void
    // The finger lands before the tap ends: enough of a head start to read the conversation. Held
    // back a few frames so a scroll or a pin swipe starting on the row does not read anything.
    onPressIn?: () => void
    // A swipe to the left pins the row to the top of the list, or unpins it.
    pin?: PinControl
}

function PinSwipe({ pin, children }: { pin: PinControl; children: ReactNode }) {
    const swipeable = useRef<SwipeableMethods>(null)
    const label = pin.pinned ? 'Unpin' : 'Pin'

    const toggle = () => {
        Haptics.selectionAsync()
        swipeable.current?.close()
        pin.onToggle()
    }

    return (
        <ReanimatedSwipeable
            ref={swipeable}
            friction={2}
            rightThreshold={PIN_ACTION_WIDTH / 2}
            overshootRight={false}
            onSwipeableOpen={toggle}
            renderRightActions={() => (
                <Pressable onPress={() => swipeable.current?.close()} accessibilityElementsHidden style={{ width: PIN_ACTION_WIDTH, alignItems: 'center', justifyContent: 'center', gap: 2, backgroundColor: brand.base }}>
                    <SymbolView name={pin.pinned ? 'pin.slash.fill' : 'pin.fill'} size={18} weight="semibold" tintColor="#ffffff" />
                    <AppText variant="caption" medium maxFontSizeMultiplier={1.2} style={{ color: '#ffffff' }}>
                        {label}
                    </AppText>
                </Pressable>
            )}
        >
            {children}
        </ReanimatedSwipeable>
    )
}

export function CoworkerRow({ coworker, line, minutesAgo, unread, selected = false, onPress, onPressIn, pin }: CoworkerRowProps) {
    const theme = useTheme()
    const row = (
        <Pressable
            onPress={onPress}
            onPressIn={onPressIn}
            unstable_pressDelay={80}
            accessibilityRole="button"
            accessibilityLabel={[coworker.name, line.text].filter(Boolean).join(', ')}
            accessibilityHint="Opens the conversation"
            accessibilityActions={pin ? [{ name: 'togglePin', label: pin.pinned ? 'Unpin' : 'Pin to top' }] : undefined}
            onAccessibilityAction={event => event.nativeEvent.actionName === 'togglePin' && pin?.onToggle()}
            // Opaque under the content: the pin action waits behind the row.
            style={selected ? { backgroundColor: theme.muted } : pin ? { backgroundColor: theme.background } : undefined}
            accessibilityState={{ selected }}
        >
            {({ pressed }) => (
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.lg, paddingVertical: spacing.md, paddingHorizontal: spacing.xl, opacity: pressed ? 0.6 : 1 }}>
                    <View style={{ paddingTop: 2 }}>
                        <CoworkerAvatar coworker={coworker} size={AVATAR} facing="right" />
                    </View>
                    <View style={{ flex: 1, gap: 2 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm }}>
                            <AppText variant="headline" numberOfLines={1} maxFontSizeMultiplier={1.4} style={{ flex: 1 }}>
                                {coworker.name}
                            </AppText>
                            {minutesAgo !== null && (
                                <AppText variant="footnote" tone="muted" maxFontSizeMultiplier={1.4}>
                                    {timeAgo(minutesAgo)}
                                </AppText>
                            )}
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                            <AppText variant="callout" tone={line.tone} numberOfLines={1} maxFontSizeMultiplier={1.4} style={{ flex: 1 }}>
                                {line.text}
                            </AppText>
                            {unread && <UnreadDot />}
                        </View>
                    </View>
                </View>
            )}
        </Pressable>
    )
    return pin ? <PinSwipe pin={pin}>{row}</PinSwipe> : row
}
