import * as WebBrowser from 'expo-web-browser'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { FORM_COLUMN_MAX_WIDTH } from '@/components/layout/split'
import { ForemanOrb } from '@/components/orb/ForemanOrb'
import { AppText } from '@/components/ui/AppText'
import { Button } from '@/components/ui/Button'
import { spacing } from '@/theme/tokens'

const PRIVACY_URL = 'https://rerun.build/privacy'

// Asked before anything the person types or shares leaves for an AI provider (App Store guideline
// 5.1.2(i)): the website of the onboarding is the first, then every message, photo and voice note.
export function AiConsent({ onAgree, onDecline }: { onAgree: () => Promise<void>; onDecline: () => void }) {
    const insets = useSafeAreaInsets()
    const [agreeing, setAgreeing] = useState(false)

    const agree = async () => {
        setAgreeing(true)
        await onAgree().finally(() => setAgreeing(false))
    }

    return (
        <View style={{ flex: 1, width: '100%', maxWidth: FORM_COLUMN_MAX_WIDTH, alignSelf: 'center' }}>
            <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.xl, gap: spacing.lg }}>
                <ForemanOrb size={48} />
                <View style={{ gap: spacing.sm }}>
                    <AppText variant="title">Your coworkers run on AI</AppText>
                    <AppText variant="callout" tone="muted">
                        To do your tasks, Rerun sends your messages, photos, voice messages, files and website to AI providers: OpenAI, Anthropic and Google through OpenRouter, and any provider you connect yourself.
                    </AppText>
                    <AppText variant="callout" tone="muted">
                        Rerun&apos;s providers don&apos;t train on your data.{' '}
                        <AppText variant="callout" style={{ textDecorationLine: 'underline' }} onPress={() => WebBrowser.openBrowserAsync(PRIVACY_URL)} accessibilityRole="link">
                            Privacy Policy
                        </AppText>
                    </AppText>
                </View>
            </ScrollView>

            <View style={{ flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.xl, paddingBottom: insets.bottom + spacing.md }}>
                <Button label="Not now" variant="ghost" size="lg" onPress={onDecline} disabled={agreeing} />
                <View style={{ flex: 1 }}>
                    <Button label="Agree and continue" size="lg" onPress={() => void agree()} loading={agreeing} />
                </View>
            </View>
        </View>
    )
}
