import { pushDataSchema, type PushData } from '@rerun/contracts'
import * as Application from 'expo-application'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import * as SecureStore from 'expo-secure-store'

import { api, appBuild } from '@/api/client'
import { onCustomServer } from '@/config/environment'

type Caller = { accessToken: string; workspaceId: number }

const ASKED_KEY = 'rerun.push-asked'

// Pushes go out through Rerun's Expo project, which only Rerun Cloud sends with: on a server of the
// person's own, the app never asks for them.
export const pushAvailable = !onCustomServer

let registeredToken: string | null = null

// The conversation on screen: a push about it is not shown while the person is reading it.
let conversationOnScreen: string | null = null

export function setConversationOnScreen(id: string | null) {
    conversationOnScreen = id
}

export function pushDataOf(notification: Notifications.Notification): PushData | null {
    const parsed = pushDataSchema.safeParse(notification.request.content.data)
    return parsed.success ? parsed.data : null
}

Notifications.setNotificationHandler({
    handleNotification: async notification => {
        const id = pushDataOf(notification)?.conversationId
        const visible = !(id && id === conversationOnScreen)
        return { shouldShowBanner: visible, shouldShowList: visible, shouldPlaySound: visible, shouldSetBadge: false }
    },
})

// Registered on every launch once allowed: Expo can rotate the token, and the hub keeps the last
// time it was seen. A simulator has no token to give.
export async function registerDevice(caller: Caller): Promise<void> {
    if (!pushAvailable || !Device.isDevice) return
    const { status } = await Notifications.getPermissionsAsync()
    if (status !== 'granted') return
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: Constants.expoConfig?.extra?.eas?.projectId })
    await api('/api/v1/me/devices', { ...caller, method: 'POST', body: { token, platform: 'ios', appVersion: `${Application.nativeApplicationVersion ?? '0.0.0'} (${appBuild})` } })
    registeredToken = token
}

// Asked once, after the first message the person sends: by then a coworker has something to say back.
export async function askForPushOnce(caller: Caller): Promise<void> {
    if (!pushAvailable) return
    if (await SecureStore.getItemAsync(ASKED_KEY)) return
    await SecureStore.setItemAsync(ASKED_KEY, '1')
    const { status } = await Notifications.requestPermissionsAsync()
    if (status === 'granted') await registerDevice(caller)
}

export async function pushPermission(): Promise<Notifications.PermissionStatus> {
    return (await Notifications.getPermissionsAsync()).status
}

export async function turnOnPush(caller: Caller): Promise<Notifications.PermissionStatus> {
    await SecureStore.setItemAsync(ASKED_KEY, '1')
    const { status } = await Notifications.requestPermissionsAsync()
    if (status === 'granted') await registerDevice(caller)
    return status
}

// Signing out stops this phone ringing for that account.
export async function unregisterDevice(caller: Caller): Promise<void> {
    if (!registeredToken) return
    await api('/api/v1/me/devices', { ...caller, method: 'DELETE', body: { token: registeredToken, platform: 'ios' } })
    registeredToken = null
}

export async function setBadge(count: number): Promise<void> {
    await Notifications.setBadgeCountAsync(count)
}
