import type { ReactNode } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'

import { HomeScreen } from '@/components/home/HomeScreen'
import { PaneSizeProvider } from '@/components/layout/PaneSize'
import { isSplit, sidebarWidth } from '@/components/layout/split'
import { useTheme } from '@/theme/theme'

// The coworker list beside the stack when the window is wide enough (an iPad, an unfolded iPhone Duo),
// the stack alone otherwise. The stack keeps its place in the tree either way, so folding the phone or
// resizing the window never resets the conversation on screen.
export function SplitShell({ enabled, children }: { enabled: boolean; children: ReactNode }) {
    const theme = useTheme()
    const { width } = useWindowDimensions()
    const split = enabled && isSplit(width)
    return (
        <View style={{ flex: 1, flexDirection: 'row', backgroundColor: theme.background }}>
            {split && (
                <PaneSizeProvider style={{ flex: 0, width: sidebarWidth(width), borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: theme.border }}>
                    <HomeScreen sidebar />
                </PaneSizeProvider>
            )}
            <PaneSizeProvider>{children}</PaneSizeProvider>
        </View>
    )
}
