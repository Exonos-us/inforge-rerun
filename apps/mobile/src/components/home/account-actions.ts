import type { Me } from '@rerun/contracts'
import * as WebBrowser from 'expo-web-browser'
import { Alert } from 'react-native'

import { deleteAccount, fetchDeletionBlockers } from '@/api/account'
import { ApiError } from '@/api/client'
import { switchServer } from '@/config/custom-server'
import { webHost } from '@/config/environment'

// The web opens the same Crisp chat; the app has no widget of its own, so it opens the chat page.
const CRISP_WEBSITE_ID = 'fa9be3a1-b3f1-4813-840f-d6e235a05179'

export function initialsOf(user: Me['user'] | undefined): string | null {
    const words = user?.name?.trim().split(/\s+/).filter(Boolean) ?? []
    if (words.length) return words.slice(0, 2).map(word => word[0].toUpperCase()).join('')
    return user?.email?.[0]?.toUpperCase() ?? null
}

export function contactSupport(user: Me['user'] | undefined) {
    const email = user?.email && !user.email.endsWith('@phone.rerun.build') ? `&user_email=${encodeURIComponent(user.email)}` : ''
    return WebBrowser.openBrowserAsync(`https://go.crisp.chat/chat/embed/?website_id=${CRISP_WEBSITE_ID}${email}`)
}

const confirm = (title: string, message: string, action: string) =>
    new Promise<boolean>(resolve =>
        Alert.alert(title, message, [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: action, style: 'destructive', onPress: () => resolve(true) },
        ])
    )

export async function askToLeaveServer(signOut: () => Promise<void>) {
    const confirmed = await confirm(`Leave ${webHost}?`, 'You will be signed out, and Rerun reopens on Rerun Cloud.', 'Leave')
    if (!confirmed) return
    await signOut()
    await switchServer(null)
}

// Same rule as the web: a workspace only this account holds and that still bills stops the deletion,
// and is named so it can be cancelled first.
export async function askToDeleteAccount(accessToken: string, signOut: () => Promise<void>) {
    try {
        const blockers = await fetchDeletionBlockers({ accessToken })
        if (blockers.length) {
            Alert.alert('Cancel the subscription first', `${blockers.map(blocker => blocker.name).join(', ')} still renews. Cancel it from Billing on rerun.build, then delete your account.`)
            return
        }
        const confirmed = await confirm('Delete your account?', 'You leave the workspaces you share. A workspace only you are in stops for good, with its coworkers and its files. This cannot be undone.', 'Delete')
        if (!confirmed) return
        await deleteAccount({ accessToken })
        await signOut()
    } catch (error) {
        // The hub wants a sign-in from the last minutes behind an irreversible step: the person signs
        // in again and asks once more.
        if (error instanceof ApiError && error.status === 403) {
            Alert.alert('Sign in again to delete your account', 'For your safety, deleting your account needs a fresh sign-in. Sign in again, then delete it from here.', [{ text: 'Sign out', onPress: () => void signOut() }, { text: 'Cancel', style: 'cancel' }])
            return
        }
        Alert.alert('Could not delete your account', 'Try again in a moment.')
    }
}
