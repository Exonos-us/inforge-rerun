import { createContext, useContext, useState, type ReactNode } from 'react'
import { useWindowDimensions, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native'

import { isSplit } from '@/components/layout/split'

export type PaneSize = { width: number; height: number }

const PaneSizeContext = createContext<PaneSize | null>(null)

// The size of the pane a screen is drawn in: the detail column beside the sidebar, a sheet on an iPad.
// Outside any pane it is the window, which on an iPhone is the same thing.
export function usePaneSize(): PaneSize {
    const window = useWindowDimensions()
    const pane = useContext(PaneSizeContext)
    return pane ?? { width: window.width, height: window.height }
}

export function useIsSplit(): boolean {
    const { width } = useWindowDimensions()
    return isSplit(width)
}

export function PaneSizeProvider({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
    const [size, setSize] = useState<PaneSize | null>(null)
    const onLayout = (event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout
        setSize(current => (current?.width === width && current.height === height ? current : { width, height }))
    }
    return (
        <View style={[{ flex: 1 }, style]} onLayout={onLayout}>
            <PaneSizeContext.Provider value={size}>{children}</PaneSizeContext.Provider>
        </View>
    )
}
