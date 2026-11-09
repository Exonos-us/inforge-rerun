import { GlassView } from 'expo-glass-effect'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated'

import { usePaneSize } from '@/components/layout/PaneSize'
import { useGlassStyle } from '@/components/ui/GlassButton'
import { AppText } from '@/components/ui/AppText'
import { useTheme } from '@/theme/theme'
import { radius, spacing, withAlpha } from '@/theme/tokens'

import { GLASS_SHADOW, GLASS_TINT_ALPHA } from './glass'
import { mentionText, type MentionItem } from './mentions'

const ROW = 48
const MAX_ROWS = 5

// The web composer's `@` and `/` menu, above the composer: a tap puts the token in the text.
export function MentionSuggestions({ trigger, items, onPick }: { trigger: '@' | '/'; items: MentionItem[]; onPick: (item: MentionItem) => void }) {
    const theme = useTheme()
    const glass = useGlassStyle()
    const { height } = usePaneSize()
    // A short screen with the keyboard up keeps the conversation's header in sight.
    const maxHeight = Math.min(ROW * MAX_ROWS, height * 0.3)
    return (
        <Animated.View entering={FadeInDown.duration(200)} exiting={FadeOutDown.duration(200)}>
            <GlassView key={theme.scheme} colorScheme={theme.scheme} glassEffectStyle={glass} tintColor={withAlpha(theme.card, GLASS_TINT_ALPHA)} style={{ borderRadius: radius.lg, borderCurve: 'continuous', borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border, boxShadow: GLASS_SHADOW[theme.scheme], overflow: 'hidden' }}>
                <AppText variant="caption" tone="muted" medium style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm }}>
                    {trigger === '/' ? 'Skills' : 'Coworkers'}
                </AppText>
                <ScrollView style={{ maxHeight }} keyboardShouldPersistTaps="always" contentContainerStyle={{ paddingVertical: spacing.xs }}>
                    {items.map(item => (
                        <Pressable key={item.kind === 'skill' ? item.slug : item.id} onPress={() => onPick(item)} accessibilityRole="button" style={({ pressed }) => ({ minHeight: ROW, justifyContent: 'center', paddingHorizontal: spacing.lg, backgroundColor: pressed ? theme.muted : 'transparent' })}>
                            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm }}>
                                <AppText variant="callout" medium numberOfLines={1} style={{ flexShrink: 1 }}>
                                    {item.name}
                                </AppText>
                                <AppText variant="footnote" tone="muted" numberOfLines={1} style={{ flexShrink: 2 }}>
                                    {item.kind === 'agent' && item.hint ? `${mentionText(item)} · ${item.hint}` : mentionText(item)}
                                </AppText>
                            </View>
                        </Pressable>
                    ))}
                </ScrollView>
            </GlassView>
        </Animated.View>
    )
}
