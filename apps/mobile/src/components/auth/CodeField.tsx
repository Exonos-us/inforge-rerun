import { useRef } from 'react'
import { Pressable, TextInput, View, type TextInputInstance } from 'react-native'

import { AppText } from '@/components/ui/AppText'
import { fieldOutline } from '@/theme/field'
import { useTheme } from '@/theme/theme'
import { controlSize, fonts, spacing } from '@/theme/tokens'

type CodeFieldProps = {
    length: number
    value: string
    onChangeText: (value: string) => void
    onComplete: (code: string) => void
    disabled?: boolean
    invalid?: boolean
}

// One hidden input behind the boxes, so iOS can fill the code from the message it just received.
export function CodeField({ length, value, onChangeText, onComplete, disabled, invalid }: CodeFieldProps) {
    const theme = useTheme()
    const input = useRef<TextInputInstance>(null)

    const change = (text: string) => {
        const digits = text.replace(/\D/g, '').slice(0, length)
        onChangeText(digits)
        if (digits.length === length) onComplete(digits)
    }

    return (
        <Pressable onPress={() => input.current?.focus()} accessibilityLabel="Verification code" style={{ alignSelf: 'stretch' }}>
            <View style={{ flexDirection: 'row', gap: spacing.sm, justifyContent: 'center' }}>
                {Array.from({ length }, (_, index) => {
                    const active = !disabled && index === Math.min(value.length, length - 1)
                    return (
                        <View key={index} style={{ flex: 1, maxWidth: 52, aspectRatio: 0.85, alignItems: 'center', justifyContent: 'center', borderRadius: controlSize.md.radius, borderCurve: 'continuous', ...fieldOutline(theme, { focused: active, invalid }), backgroundColor: theme.card }}>
                            <AppText style={{ fontFamily: fonts.medium, fontSize: 24, lineHeight: 30 }} maxFontSizeMultiplier={1.2}>
                                {value[index] ?? ''}
                            </AppText>
                        </View>
                    )
                })}
            </View>
            <TextInput
                ref={input}
                value={value}
                onChangeText={change}
                editable={!disabled}
                autoFocus
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                maxLength={length}
                caretHidden
                style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
            />
        </Pressable>
    )
}
