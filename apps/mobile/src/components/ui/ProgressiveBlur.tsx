import MaskedViewNative from '@react-native-masked-view/masked-view'
import { BlurView } from 'expo-blur'
import { useId, type ComponentType, type ReactElement } from 'react'
import { StyleSheet, View, type ViewProps } from 'react-native'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'

import { useTheme } from '@/theme/theme'

// The package types its class through React Native's NativeMethods mixin, which the strict types of
// React Native 0.88 no longer export: the component itself is unchanged.
const MaskedView = MaskedViewNative as unknown as ComponentType<ViewProps & { maskElement: ReactElement }>

const BLUR_INTENSITY = 24

function Ramp({ id, color, height, stops }: { id: string; color: string; height: number; stops: [offset: number, opacity: number][] }) {
    return (
        <Svg width="100%" height={height}>
            <Defs>
                <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                    {stops.map(([offset, opacity]) => (
                        <Stop key={offset} offset={offset} stopColor={color} stopOpacity={opacity} />
                    ))}
                </LinearGradient>
            </Defs>
            <Rect width="100%" height="100%" fill={`url(#${id})`} />
        </Svg>
    )
}

// Content scrolling under a bar at the bottom of the screen goes out of focus as it nears the bar,
// instead of being cut at its edge: a blur faded in through a gradient mask, under a light veil of the
// background that settles it. Over a screen already blurred (the Foreman's overlay) the veil stays off.
export function ProgressiveBlur({ height, veiled = true }: { height: number; veiled?: boolean }) {
    const theme = useTheme()
    // The pager keeps neighbouring conversations mounted: each blur names its own gradients.
    const id = useId().replace(/[^a-zA-Z0-9]/g, '')
    return (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { top: undefined, height }]}>
            <MaskedView
                key={`${theme.scheme}-${height}`}
                style={StyleSheet.absoluteFill}
                maskElement={
                    <Ramp
                        id={`blur-mask-${id}`}
                        color="#000"
                        height={height}
                        stops={[
                            [0, 0],
                            [0.45, 0.9],
                            [1, 1],
                        ]}
                    />
                }
            >
                <BlurView intensity={BLUR_INTENSITY} tint={theme.scheme === 'dark' ? 'systemUltraThinMaterialDark' : 'systemUltraThinMaterialLight'} style={StyleSheet.absoluteFill} />
            </MaskedView>
            {veiled && (
                <View style={StyleSheet.absoluteFill}>
                    <Ramp
                        id={`blur-veil-${id}`}
                        color={theme.background}
                        height={height}
                        stops={[
                            [0, 0],
                            [0.5, 0.55],
                            [1, 0.85],
                        ]}
                    />
                </View>
            )}
        </View>
    )
}
