import * as AppleAuthentication from 'expo-apple-authentication'
import { router } from 'expo-router'
import { View } from 'react-native'

import { OrDivider } from '@/components/auth/OrDivider'
import { PhoneField } from '@/components/auth/PhoneField'
import { useSignInFlow } from '@/components/auth/SignInFlow'
import { StepTitle } from '@/components/auth/steps/StepTitle'
import { TextLink } from '@/components/auth/TextLink'
import { CHANNEL_LABELS, useOAuthSignIn, usePhoneCode } from '@/components/auth/useSignInActions'
import { AppText } from '@/components/ui/AppText'
import { Button } from '@/components/ui/Button'
import { ProviderLogo } from '@/components/ui/ProviderLogo'
import { switchServer } from '@/config/custom-server'
import { onCustomServer, webHost } from '@/config/environment'
import { useTheme } from '@/theme/theme'
import { controlSize, spacing } from '@/theme/tokens'

export type StartLayout = 'phone-first' | 'choices'

function OAuthError({ message }: { message: string | null }) {
    if (!message) return null
    return (
        <AppText variant="footnote" tone="destructive" style={{ textAlign: 'center' }}>
            {message}
        </AppText>
    )
}

function PhoneFirst() {
    const { country, phone, setPhone, goTo } = useSignInFlow()
    const { channels, send, sending, error, clearError } = usePhoneCode()
    const oauth = useOAuthSignIn()
    const [lead, ...others] = channels

    return (
        <>
            <PhoneField
                country={country}
                value={phone}
                onChangeText={text => {
                    setPhone(text)
                    clearError()
                }}
                onPickCountry={() => router.push('/sign-in/country')}
                onSubmit={() => lead && send(lead)}
                invalid={Boolean(error)}
            />
            {error && (
                <AppText variant="footnote" tone="destructive">
                    {error}
                </AppText>
            )}
            {lead ? (
                <View style={{ gap: spacing.md, alignItems: 'center' }}>
                    <View style={{ alignSelf: 'stretch' }}>
                        <Button label={CHANNEL_LABELS[lead]} size="lg" loading={sending === lead} disabled={sending !== null || !phone} onPress={() => send(lead)} />
                    </View>
                    {others.map(channel => (
                        <TextLink key={channel} label={CHANNEL_LABELS[channel]} disabled={sending !== null || !phone} onPress={() => send(channel)} />
                    ))}
                </View>
            ) : (
                <AppText variant="callout" tone="muted" style={{ textAlign: 'center' }}>
                    We can&apos;t send codes to this country yet.
                </AppText>
            )}
            <OrDivider />
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <Button label="Continue with Apple" variant="outline" size="lg" iconOnly stretch symbol="apple.logo" loading={oauth.signingIn === 'apple'} onPress={() => oauth.continueWith('apple')} />
                <Button label="Continue with Google" variant="outline" size="lg" iconOnly stretch icon={<ProviderLogo provider="google" size={17} />} loading={oauth.signingIn === 'google'} onPress={() => oauth.continueWith('google')} />
                <Button label="Continue with email" variant="outline" size="lg" iconOnly stretch symbol="envelope" onPress={() => goTo({ name: 'email' })} />
            </View>
            <OAuthError message={oauth.error} />
            <AppText variant="caption" tone="muted" style={{ textAlign: 'center' }}>
                By continuing, you agree to be contacted by Rerun on WhatsApp or SMS.
            </AppText>
        </>
    )
}

function Choices() {
    const theme = useTheme()
    const { goTo } = useSignInFlow()
    const oauth = useOAuthSignIn()

    return (
        <View style={{ gap: spacing.sm }}>
            <AppleAuthentication.AppleAuthenticationButton
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
                buttonStyle={theme.scheme === 'dark' ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
                cornerRadius={controlSize.lg.radius}
                onPress={() => oauth.continueWith('apple')}
                style={{ height: controlSize.lg.height }}
            />
            <Button label="Continue with Google" variant="outline" size="lg" icon={<ProviderLogo provider="google" size={17} />} loading={oauth.signingIn === 'google'} onPress={() => oauth.continueWith('google')} />
            <Button label="Continue with phone" variant="outline" size="lg" symbol="phone" onPress={() => goTo({ name: 'phone' })} />
            <Button label="Continue with email" variant="outline" size="lg" symbol="envelope" onPress={() => goTo({ name: 'email' })} />
            <OAuthError message={oauth.error} />
        </View>
    )
}

// A server of the person's own signs in by email code only: phone codes go out through Rerun Cloud,
// and Apple and Google answer for Rerun's app, not for that server.
function OwnServer() {
    const { goTo } = useSignInFlow()
    return (
        <View style={{ gap: spacing.lg, alignItems: 'center' }}>
            <View style={{ alignSelf: 'stretch' }}>
                <Button label="Continue with email" size="lg" symbol="envelope" onPress={() => goTo({ name: 'email' })} />
            </View>
            <TextLink label="Use Rerun Cloud" onPress={() => switchServer(null)} />
        </View>
    )
}

export function StartStep({ layout }: { layout: StartLayout }) {
    const { goTo } = useSignInFlow()
    if (onCustomServer) {
        return (
            <>
                <StepTitle title="Welcome to Rerun" subtitle={webHost} />
                <OwnServer />
            </>
        )
    }
    return (
        <>
            <StepTitle title="Welcome to Rerun" />
            {layout === 'phone-first' ? <PhoneFirst /> : <Choices />}
            <View style={{ alignItems: 'center' }}>
                <TextLink label="Use your own server" onPress={() => goTo({ name: 'server' })} />
            </View>
        </>
    )
}
