import { Button } from '@expo/ui/swift-ui'
import { Image } from 'expo-image'
import { router } from 'expo-router'
import { SymbolView } from 'expo-symbols'
import { useState } from 'react'

import { useAuth } from '@/auth/AuthProvider'
import { contactSupport, initialsOf } from '@/components/home/account-actions'
import { WorkspaceSubmenu } from '@/components/home/WorkspaceMenu'
import { AppText } from '@/components/ui/AppText'
import { CircleTrigger, NativeMenu } from '@/components/ui/NativeMenu'
import { onCustomServer } from '@/config/environment'
import { useTheme } from '@/theme/theme'

export function AccountMenu() {
    const theme = useTheme()
    const { me, signOut } = useAuth()
    const initials = initialsOf(me?.user)
    const avatarUrl = me?.user?.avatarUrl
    const [brokenAvatar, setBrokenAvatar] = useState<string | null>(null)
    return (
        <NativeMenu
            glass="circle"
            label="Account"
            trigger={
                <CircleTrigger>
                        {avatarUrl && brokenAvatar !== avatarUrl ? (
                            <Image source={{ uri: avatarUrl }} contentFit="cover" onError={() => setBrokenAvatar(avatarUrl)} style={{ width: '100%', height: '100%' }} />
                        ) : initials ? (
                            <AppText variant="footnote" medium maxFontSizeMultiplier={1}>
                                {initials}
                            </AppText>
                        ) : (
                            <SymbolView name="person.fill" size={17} weight="medium" tintColor={theme.foreground} />
                        )}
                </CircleTrigger>
            }
        >
            <WorkspaceSubmenu />
            <Button label="Preferences" systemImage="gearshape" onPress={() => router.push('/settings')} />
            {!onCustomServer && <Button label="Contact support" systemImage="bubble.left" onPress={() => contactSupport(me?.user)} />}
            <Button label="Sign out" systemImage="rectangle.portrait.and.arrow.right" role="destructive" onPress={signOut} />
        </NativeMenu>
    )
}
