import { useFonts } from 'expo-font'
import { DarkTheme, DefaultTheme, router, Stack, ThemeProvider, usePathname } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { useEffect, useState } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import { AuthProvider, useAuth } from '@/auth/AuthProvider'
import { BuddyClock } from '@/components/buddy/motion'
import { AiConsent } from '@/components/consent/AiConsent'
import { NoPlan } from '@/components/home/NoPlan'
import { SplitShell } from '@/components/layout/SplitShell'
import { Onboarding, type LeadStarted } from '@/components/onboarding/Onboarding'
import { OnboardingShell } from '@/components/onboarding/OnboardingShell'
import { useOnboardingRoute } from '@/components/onboarding/useOnboardingRoute'
import { WaitlistNotice } from '@/components/onboarding/widgets/TeamCards'
import { UpdateRequired } from '@/components/update/UpdateRequired'
import { useUpdateRequired } from '@/components/update/useUpdateRequired'
import { MediaViewerHost } from '@/components/viewer/MediaViewerHost'
import { InboxProvider } from '@/data/InboxProvider'
import { useAiConsent } from '@/lib/ai-consent'
import { posthog } from '@/lib/analytics'
import { MockStore } from '@/mocks/store'
import { PushRouting } from '@/notifications/PushRouting'
import { useAppearanceLoaded } from '@/theme/appearance'
import { useColorSchemeName } from '@/theme/theme'
import { brand, palette } from '@/theme/tokens'

SplashScreen.preventAutoHideAsync()
SplashScreen.setOptions({ fade: true, duration: 250 })

function App() {
    const [fontsLoaded] = useFonts({
        'Inter-Regular': require('@/assets/fonts/Inter-Regular.ttf'),
        'Inter-Medium': require('@/assets/fonts/Inter-Medium.ttf'),
        'Inter-SemiBold': require('@/assets/fonts/Inter-SemiBold.ttf'),
        'Inter-Italic': require('@/assets/fonts/Inter-Italic.ttf'),
        'GeistMono-Regular': require('@/assets/fonts/GeistMono-Regular.ttf'),
    })
    const appearanceLoaded = useAppearanceLoaded()
    const scheme = useColorSchemeName()
    const updateRequired = useUpdateRequired()
    const { ready, session, me, refreshMe, signOut } = useAuth()
    const signedIn = Boolean(session)
    const inactiveWorkspace = signedIn && me !== null && !me.workspace.subscribed
    const { route, reload } = useOnboardingRoute()
    const settled = signedIn && me !== null
    const aiConsent = useAiConsent(session?.user.id ?? null)
    const consentKnown = !signedIn || aiConsent.state !== 'loading'
    // The first coworker the onboarding started, opened once the app has taken over from it.
    const [lead, setLead] = useState<LeadStarted | null>(null)

    useEffect(() => {
        if (!lead || route.kind !== 'app') return
        const timer = setTimeout(() => {
            router.push({ pathname: '/chat/[id]', params: { id: lead.conversationId, to: lead.agentId } })
            setLead(null)
        }, 0)
        return () => clearTimeout(timer)
    }, [lead, route.kind])

    const onLeadStarted = async (started: LeadStarted) => {
        setLead(started)
        await refreshMe().catch(() => {})
        await reload()
    }

    useEffect(() => {
        if (fontsLoaded && ready && appearanceLoaded && consentKnown) SplashScreen.hideAsync()
    }, [fontsLoaded, ready, appearanceLoaded, consentKnown])

    const pathname = usePathname()
    useEffect(() => {
        posthog.screen(pathname)
    }, [pathname])

    if (!fontsLoaded || !ready || !appearanceLoaded || !consentKnown) return null

    const base = scheme === 'dark' ? DarkTheme : DefaultTheme
    const navigationTheme = { ...base, colors: { ...base.colors, primary: brand.base, background: palette[scheme].background, card: palette[scheme].card, text: palette[scheme].foreground, border: palette[scheme].border } }

    return (
        <ThemeProvider value={navigationTheme}>
            <BuddyClock>
                {updateRequired ? (
                    <UpdateRequired />
                ) : signedIn && aiConsent.state === 'needed' ? (
                    <OnboardingShell>
                        <AiConsent onAgree={aiConsent.grant} onDecline={() => void signOut()} />
                    </OnboardingShell>
                ) : settled && route.kind === 'onboarding' ? (
                    <OnboardingShell>
                        <Onboarding key={me.workspace.id} state={route.state} onLeadStarted={started => void onLeadStarted(started)} />
                    </OnboardingShell>
                ) : settled && route.kind === 'waitlist' ? (
                    <OnboardingShell>
                        <WaitlistNotice />
                    </OnboardingShell>
                ) : inactiveWorkspace && route.kind === 'loading' ? (
                    <OnboardingShell>{null}</OnboardingShell>
                ) : inactiveWorkspace ? (
                    <NoPlan />
                ) : (
                    <MockStore>
                        <InboxProvider>
                            {signedIn && <PushRouting />}
                            <SplitShell enabled={signedIn}>
                                <Stack screenOptions={{ headerShown: false }}>
                                    <Stack.Protected guard={signedIn} redirectTo="/sign-in">
                                        <Stack.Screen name="index" />
                                        <Stack.Screen name="chat/[id]" />
                                        <Stack.Screen name="search" options={{ animation: 'fade' }} />
                                        <Stack.Screen name="coworker/[id]/index" />
                                        <Stack.Screen name="coworker/[id]/files" />
                                        <Stack.Screen name="coworker/[id]/apps" />
                                        <Stack.Screen name="coworker/[id]/routines" />
                                        <Stack.Screen name="coworker/[id]/notifications" />
                                        <Stack.Screen name="inbox" options={{ presentation: 'formSheet', sheetAllowedDetents: [0.6, 1], sheetGrabberVisible: true, contentStyle: { backgroundColor: palette[scheme].background } }} />
                                        <Stack.Screen name="model" options={{ presentation: 'formSheet', sheetAllowedDetents: [0.6, 1], sheetGrabberVisible: true, contentStyle: { backgroundColor: palette[scheme].background } }} />
                                        <Stack.Screen name="desktop" options={{ presentation: 'fullScreenModal' }} />
                                        <Stack.Screen name="settings" options={{ presentation: 'formSheet', sheetAllowedDetents: [1], sheetGrabberVisible: true, contentStyle: { backgroundColor: palette[scheme].background } }} />
                                        <Stack.Screen name="new-coworker" options={{ presentation: 'formSheet', sheetAllowedDetents: [1], sheetGrabberVisible: true, contentStyle: { backgroundColor: palette[scheme].background } }} />
                                        <Stack.Screen name="providers" options={{ presentation: 'formSheet', sheetAllowedDetents: [1], sheetGrabberVisible: true, contentStyle: { backgroundColor: palette[scheme].background } }} />
                                    </Stack.Protected>
                                    <Stack.Protected guard={!signedIn} redirectTo="/">
                                        <Stack.Screen name="sign-in" />
                                    </Stack.Protected>
                                    <Stack.Protected guard={__DEV__}>
                                        <Stack.Screen name="lab" />
                                        <Stack.Screen name="lab-chat" />
                                        <Stack.Screen name="lab-message-times" />
                                        <Stack.Screen name="lab-sign-in" />
                                        <Stack.Screen name="lab-hitl" />
                                        <Stack.Screen name="lab-screen" />
                                        <Stack.Screen name="lab-delegate" />
                                        <Stack.Screen name="lab-steps" />
                                        <Stack.Screen name="lab-skill" />
                                        <Stack.Screen name="lab-composer" />
                                        <Stack.Screen name="lab-foreman" />
                                        <Stack.Screen name="lab-home" />
                                        <Stack.Screen name="lab-markdown" />
                                        <Stack.Screen name="lab-onboarding" />
                                        <Stack.Screen name="lab-consent" />
                                        <Stack.Screen name="lab-splash" options={{ animation: 'none', gestureEnabled: true }} />
                                        <Stack.Screen name="lab-coworker" />
                                        <Stack.Screen name="lab-notifications" />
                                        <Stack.Screen name="lab-conversations" />
                                        <Stack.Screen name="lab-conversations-sheet" options={{ presentation: 'formSheet', sheetAllowedDetents: [0.6, 1], sheetGrabberVisible: true, contentStyle: { backgroundColor: palette[scheme].background } }} />
                                        <Stack.Screen name="lab-providers" options={{ presentation: 'formSheet', sheetAllowedDetents: [1], sheetGrabberVisible: true, contentStyle: { backgroundColor: palette[scheme].background } }} />
                                    </Stack.Protected>
                                </Stack>
                            </SplitShell>
                            <MediaViewerHost />
                        </InboxProvider>
                    </MockStore>
                )}
            </BuddyClock>
        </ThemeProvider>
    )
}

export default function RootLayout() {
    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <AuthProvider>
                <App />
            </AuthProvider>
        </GestureHandlerRootView>
    )
}
