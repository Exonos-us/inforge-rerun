import { Button, Host, HStack, Image, Spacer, Text } from '@expo/ui/swift-ui'
import { accessibilityLabel, buttonBorderShape, buttonStyle, font, foregroundStyle, frame, padding } from '@expo/ui/swift-ui/modifiers'

import { GLASS_BUTTON_SIZE, GLASS_INSET } from '@/components/ui/GlassButton'
import { useTheme } from '@/theme/theme'
import { spacing } from '@/theme/tokens'

// The Home's search, a glass capsule pinned to the bottom like iMessage's: a tap opens the search screen.
export function SearchBar({ height = GLASS_BUTTON_SIZE, onPress }: { height?: number; onPress: () => void }) {
    const theme = useTheme()
    const tint = theme.mutedForeground
    return (
        <Host colorScheme={theme.scheme} style={{ flex: 1, height }}>
            <Button onPress={onPress} modifiers={[buttonStyle('glass'), buttonBorderShape('capsule'), accessibilityLabel('Search')]}>
                <HStack spacing={spacing.sm} modifiers={[frame({ height: height - 2 * GLASS_INSET }), frame({ maxWidth: 10_000 }), padding({ leading: spacing.xs })]}>
                    <Image systemName="magnifyingglass" color={tint} modifiers={[font({ size: 17, weight: 'medium' })]} />
                    <Text modifiers={[font({ size: 17 }), foregroundStyle(tint)]}>Search</Text>
                    <Spacer />
                </HStack>
            </Button>
        </Host>
    )
}
