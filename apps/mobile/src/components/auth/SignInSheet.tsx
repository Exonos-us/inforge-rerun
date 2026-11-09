import * as Haptics from 'expo-haptics'
import { useState } from 'react'
import { Pressable, ScrollView, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native'
import Animated, { FadeInLeft, FadeInRight, FadeOut, useAnimatedKeyboard, useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AuthBoard } from '@/components/auth/AuthBoard'
import { useSignInFlow } from '@/components/auth/SignInFlow'
import { CodeStep } from '@/components/auth/steps/CodeStep'
import { EmailStep } from '@/components/auth/steps/EmailStep'
import { PhoneStep } from '@/components/auth/steps/PhoneStep'
import { ServerStep } from '@/components/auth/steps/ServerStep'
import { StartStep, type StartLayout } from '@/components/auth/steps/StartStep'
import { ForemanOrb } from '@/components/orb/ForemanOrb'
import { GlassButton } from '@/components/ui/GlassButton'
import { EASE_OUT, MOTION } from '@/theme/motion'
import { useTheme } from '@/theme/theme'
import { radius, spacing } from '@/theme/tokens'

const FOREMAN_SIZE = 72
const CONTENT_MAX_WIDTH = 440
// The sheet runs this far below the screen, so lifting it over the keyboard never uncovers a gap
// under its bottom edge.
const SHEET_RUNOFF = 400
const STEP_ENTER_MS = 260
const STEP_EXIT_MS = 140

function Foreman({ thinking }: { thinking: boolean }) {
    const bounce = useSharedValue(1)
    const bounceStyle = useAnimatedStyle(() => ({ transform: [{ scale: bounce.get() }] }))
    const poke = () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        bounce.set(withSequence(withTiming(0.92, { duration: 90 }), withTiming(1, { duration: MOTION.fast, easing: EASE_OUT })))
    }
    return (
        <Pressable onPress={poke} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" hitSlop={8} style={{ position: 'absolute', top: -FOREMAN_SIZE / 2 - spacing.sm, alignSelf: 'center' }}>
            <Animated.View style={bounceStyle}>
                <ForemanOrb size={FOREMAN_SIZE} state={thinking ? 'thinking' : 'idle'} />
            </Animated.View>
        </Pressable>
    )
}

// The sign-in screen: the board of coworkers at work fills the top, the Foreman sits on the edge of a
// sheet that holds every step. The sheet is the screen, so it never closes: it grows and shrinks to
// the step it shows and rides over the keyboard.
export function SignInSheet({ startLayout = 'phone-first' }: { startLayout?: StartLayout }) {
    const theme = useTheme()
    const insets = useSafeAreaInsets()
    const { height: windowHeight } = useWindowDimensions()
    const { step, direction, back, thinking } = useSignInFlow()
    const keyboard = useAnimatedKeyboard()

    const paddingTop = FOREMAN_SIZE / 2 + spacing.lg
    const paddingBottom = insets.bottom + spacing.lg
    const topRoom = insets.top + FOREMAN_SIZE

    const [restingContent, setRestingContent] = useState(windowHeight / 3)
    const contentHeight = useSharedValue(windowHeight / 3)

    const onContentLayout = (event: LayoutChangeEvent) => {
        const measured = Math.ceil(event.nativeEvent.layout.height)
        contentHeight.set(withTiming(measured, { duration: MOTION.base, easing: EASE_OUT }))
        setRestingContent(measured)
    }

    const lift = useAnimatedStyle(() => ({ transform: [{ translateY: -Math.max(0, keyboard.height.get() - insets.bottom) }] }))
    const frame = useAnimatedStyle(() => {
        const covered = Math.max(paddingBottom, keyboard.height.get() + spacing.lg)
        return { height: Math.min(contentHeight.get(), windowHeight - topRoom - paddingTop - covered) }
    })

    const sheetHeight = Math.min(restingContent, windowHeight - topRoom - paddingTop - paddingBottom) + paddingTop + paddingBottom
    const boardHeight = windowHeight - sheetHeight + radius.xl
    const stepKey = step.name === 'code' ? `code-${step.method}` : step.name

    return (
        <View style={{ flex: 1, backgroundColor: theme.background }}>
            <AuthBoard height={boardHeight} />
            <Animated.View
                style={[
                    {
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        bottom: -SHEET_RUNOFF,
                        paddingTop,
                        paddingBottom: paddingBottom + SHEET_RUNOFF,
                        borderTopLeftRadius: radius.xl,
                        borderTopRightRadius: radius.xl,
                        borderCurve: 'continuous',
                        backgroundColor: theme.card,
                        boxShadow: theme.scheme === 'dark' ? '0 -1px 0 rgba(255,255,255,0.06), 0 -12px 40px rgba(0,0,0,0.5)' : '0 -1px 0 rgba(0,0,0,0.04), 0 -12px 40px rgba(0,0,0,0.08)',
                    },
                    lift,
                ]}
            >
                <Foreman thinking={thinking} />
                {step.name !== 'start' && (
                    <View style={{ position: 'absolute', top: spacing.lg, left: spacing.lg, zIndex: 1 }}>
                        <GlassButton symbol="chevron.left" label="Back" onPress={back} />
                    </View>
                )}
                <Animated.View style={[{ overflow: 'hidden' }, frame]}>
                    <ScrollView keyboardShouldPersistTaps="handled" bounces={false} showsVerticalScrollIndicator={false}>
                        <View onLayout={onContentLayout} style={{ paddingHorizontal: spacing.xl }}>
                            <Animated.View
                                key={stepKey}
                                entering={(direction === 'forward' ? FadeInRight : FadeInLeft).duration(STEP_ENTER_MS)}
                                exiting={FadeOut.duration(STEP_EXIT_MS)}
                                style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', gap: spacing.lg, paddingTop: step.name === 'start' ? 0 : spacing.xl }}
                            >
                                {step.name === 'start' && <StartStep layout={startLayout} />}
                                {step.name === 'phone' && <PhoneStep />}
                                {step.name === 'email' && <EmailStep />}
                                {step.name === 'server' && <ServerStep />}
                                {step.name === 'code' && <CodeStep step={step} />}
                            </Animated.View>
                        </View>
                    </ScrollView>
                </Animated.View>
            </Animated.View>
        </View>
    )
}
