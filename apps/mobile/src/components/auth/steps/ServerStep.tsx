import { useState } from 'react'
import { TextInput } from 'react-native'

import { FIELD_HEIGHT, FIELD_RADIUS } from '@/components/auth/PhoneField'
import { StepTitle } from '@/components/auth/steps/StepTitle'
import { useServerConnect } from '@/components/auth/useServerConnect'
import { AppText } from '@/components/ui/AppText'
import { Button } from '@/components/ui/Button'
import { fieldOutline } from '@/theme/field'
import { useTheme } from '@/theme/theme'
import { fonts, spacing } from '@/theme/tokens'

export function ServerStep() {
    const theme = useTheme()
    const [focused, setFocused] = useState(false)
    const { address, type, connect, connecting, error } = useServerConnect()

    return (
        <>
            <StepTitle title="Your Rerun server" />
            <TextInput
                testID="server-address"
                value={address}
                onChangeText={type}
                onSubmitEditing={connect}
                placeholder="rerun.example.com"
                placeholderTextColor={theme.mutedForeground}
                keyboardType="url"
                textContentType="URL"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                returnKeyType="go"
                accessibilityLabel="Server address"
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                maxFontSizeMultiplier={1.3}
                style={{ height: FIELD_HEIGHT, paddingHorizontal: spacing.lg, borderRadius: FIELD_RADIUS, borderCurve: 'continuous', ...fieldOutline(theme, { focused, invalid: !!error }), backgroundColor: theme.card, fontFamily: fonts.regular, fontSize: 17, color: theme.foreground }}
            />
            {error && (
                <AppText variant="footnote" tone="destructive">
                    {error}
                </AppText>
            )}
            <Button label="Connect" size="lg" loading={connecting} disabled={!address.trim()} onPress={connect} />
        </>
    )
}
