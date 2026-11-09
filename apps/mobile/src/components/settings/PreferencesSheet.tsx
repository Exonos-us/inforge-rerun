import { Host, Picker, Text } from '@expo/ui/swift-ui'
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers'
import * as Application from 'expo-application'
import { router } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import { Pressable, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { appBuild } from '@/api/client'
import { useAuth } from '@/auth/AuthProvider'
import { askToDeleteAccount, askToLeaveServer, contactSupport, initialsOf } from '@/components/home/account-actions'
import { workspaceLabel } from '@/components/home/workspace-logos'
import { AppText } from '@/components/ui/AppText'
import { GlassButton, GLASS_BUTTON_SIZE } from '@/components/ui/GlassButton'
import { Card, Section, SectionTitle, Separator, SettingsRow } from '@/components/ui/GroupedList'
import { environment, onCustomServer, webHost } from '@/config/environment'
import { track } from '@/lib/analytics'
import { usePushPermission } from '@/notifications/usePushPermission'
import { useAppearancePreference, type AppearancePreference } from '@/theme/appearance'
import { useTheme } from '@/theme/theme'
import { radius, spacing } from '@/theme/tokens'

const APPEARANCES: { value: AppearancePreference; label: string }[] = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
]

const AVATAR_SIZE = 44

const isPhoneAlias = (email: string) => email.endsWith('@phone.rerun.build')

export function PreferencesSheet() {
    const theme = useTheme()
    const insets = useSafeAreaInsets()
    const { me, session, signOut } = useAuth()
    const [appearance, chooseAppearance] = useAppearancePreference()
    const push = usePushPermission().status

    const user = me?.user
    const email = user?.email && !isPhoneAlias(user.email) ? user.email : null
    const version = `${Application.nativeApplicationVersion ?? '0.0.0'} (${appBuild})`

    const openAiProviders = () => {
        track('connection_cta_clicked', { source: 'ios_settings' })
        router.push('/providers')
    }

    // A form sheet lays out its scroll view itself: wrapped in a view, it is laid out at no height.
    return (
        <ScrollView style={{ backgroundColor: theme.background }} contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.xl, paddingBottom: insets.bottom + spacing.xl, gap: spacing.xl }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <GlassButton symbol="xmark" label="Close" onPress={() => router.back()} />
                <AppText variant="headline" numberOfLines={1} maxFontSizeMultiplier={1.2} style={{ flex: 1, textAlign: 'center' }}>
                    Preferences
                </AppText>
                <View style={{ width: GLASS_BUTTON_SIZE }} />
            </View>

            <Card>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg }}>
                    <View style={{ width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.muted }}>
                        <AppText variant="headline" maxFontSizeMultiplier={1}>
                            {initialsOf(user) ?? '?'}
                        </AppText>
                    </View>
                    <View style={{ flex: 1 }}>
                        <AppText variant="headline" numberOfLines={1}>
                            {user?.name?.trim() || email || 'Your account'}
                        </AppText>
                        {email && user?.name?.trim() ? (
                            <AppText variant="footnote" tone="muted" numberOfLines={1}>
                                {email}
                            </AppText>
                        ) : null}
                    </View>
                </View>
                <Separator />
                <SettingsRow label="Workspace" value={workspaceLabel(me?.workspace)} />
                <Separator />
                <SettingsRow label="AI providers" onPress={openAiProviders} />
            </Card>

            <View style={{ gap: spacing.sm }}>
                <SectionTitle>Appearance</SectionTitle>
                <Host matchContents={{ vertical: true }} colorScheme={theme.scheme} style={{ alignSelf: 'stretch' }}>
                    <Picker selection={appearance} onSelectionChange={chooseAppearance} modifiers={[pickerStyle('segmented')]}>
                        {APPEARANCES.map(option => (
                            <Text key={option.value} modifiers={[tag(option.value)]}>
                                {option.label}
                            </Text>
                        ))}
                    </Picker>
                </Host>
            </View>

            <Section>
                <SettingsRow testID="row-notifications" label="Notifications" value={push !== null && push !== 'granted' ? 'Push off' : undefined} accessory="chevron" onPress={() => router.push('/settings/notifications')} />
            </Section>

            <Section title="Support">
                {!onCustomServer && (
                    <>
                        <SettingsRow label="Contact support" onPress={() => contactSupport(user)} />
                        <Separator />
                    </>
                )}
                <SettingsRow label="Privacy Policy" accessory="external" onPress={() => WebBrowser.openBrowserAsync('https://rerun.build/privacy')} />
                <Separator />
                <SettingsRow label="Terms of Service" accessory="external" onPress={() => WebBrowser.openBrowserAsync('https://rerun.build/terms')} />
            </Section>

            <Section title="About">
                <SettingsRow label="Version" value={version} />
                {onCustomServer ? (
                    <>
                        <Separator />
                        <SettingsRow testID="row-server" label="Server" value={webHost} onPress={() => askToLeaveServer(signOut)} />
                    </>
                ) : (
                    environment.name !== 'production' && (
                        <>
                            <Separator />
                            <SettingsRow label="Environment" value={environment.name} />
                        </>
                    )
                )}
            </Section>

            <Section>
                <SettingsRow label="Sign out" onPress={signOut} />
            </Section>

            <Pressable onPress={() => session && askToDeleteAccount(session.access_token, signOut)} accessibilityRole="button" hitSlop={spacing.md} style={({ pressed }) => ({ alignSelf: 'center', opacity: pressed ? 0.5 : 1 })}>
                <AppText variant="footnote" tone="destructive">
                    Delete account
                </AppText>
            </Pressable>
        </ScrollView>
    )
}
