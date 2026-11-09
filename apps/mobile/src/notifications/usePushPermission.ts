import type { PermissionStatus } from 'expo-notifications'
import { useEffect, useState } from 'react'
import { AppState } from 'react-native'

import { useAuth } from '@/auth/AuthProvider'
import { pushAvailable, pushPermission, turnOnPush } from '@/notifications/push'

// Read again each time the app comes back, the person may have just flipped it in iOS Settings. Left
// unknown where push is not offered, so nothing asks to turn it on.
export function usePushPermission() {
    const { session, me } = useAuth()
    const [status, setStatus] = useState<PermissionStatus | null>(null)

    useEffect(() => {
        if (!pushAvailable) return
        const read = () =>
            pushPermission()
                .then(setStatus)
                .catch(() => {})
        read()
        const subscription = AppState.addEventListener('change', state => {
            if (state === 'active') read()
        })
        return () => subscription.remove()
    }, [])

    const enable = async () => {
        if (!session || !me) return
        setStatus(await turnOnPush({ accessToken: session.access_token, workspaceId: me.workspace.id }).catch(() => 'denied' as PermissionStatus))
    }

    return { status, enable }
}
