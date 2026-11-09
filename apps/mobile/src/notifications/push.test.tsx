import { render } from '@testing-library/react-native'
import { FOREMAN_AGENT_ID } from '@rerun/contracts'
import * as Notifications from 'expo-notifications'

import { askForPushOnce, registerDevice, setConversationOnScreen, unregisterDevice } from './push'
import { PushRouting } from './PushRouting'

const mockApi = jest.fn().mockResolvedValue(undefined)
jest.mock('@/api/client', () => ({ api: (...args: unknown[]) => mockApi(...args), appBuild: 7 }))
jest.mock('expo-application', () => ({ nativeApplicationVersion: '1.0.0' }))
jest.mock('expo-constants', () => ({ expoConfig: { extra: { eas: { projectId: 'project-1' } } } }))
const mockDevice = { isDevice: true }
jest.mock('expo-device', () => ({ get isDevice() { return mockDevice.isDevice } }))
const mockStore = new Map<string, string>()
jest.mock('expo-secure-store', () => ({ getItem: () => null, getItemAsync: async (key: string) => mockStore.get(key) ?? null, setItemAsync: async (key: string, value: string) => void mockStore.set(key, value) }))

const mockPermissions = { status: 'granted' }
const mockRequestPermissions = jest.fn(async () => mockPermissions)
let mockLastResponse: unknown = null
jest.mock('expo-notifications', () => ({
    setNotificationHandler: jest.fn(),
    getPermissionsAsync: async () => mockPermissions,
    requestPermissionsAsync: () => mockRequestPermissions(),
    getExpoPushTokenAsync: async () => ({ data: 'ExponentPushToken[abc]' }),
    setBadgeCountAsync: jest.fn(),
    useLastNotificationResponse: () => mockLastResponse,
}))
const mockPush = jest.fn()
jest.mock('expo-router', () => ({ router: { push: (...args: unknown[]) => mockPush(...args) } }))


const caller = { accessToken: 'jwt', workspaceId: 7 }
const notification = (data: object, identifier = 'n1') => ({ request: { identifier, content: { data } } }) as unknown as Notifications.Notification

describe('push registration', () => {
    beforeEach(() => {
        mockApi.mockClear()
        mockRequestPermissions.mockClear()
        mockStore.clear()
        mockDevice.isDevice = true
        mockPermissions.status = 'granted'
    })

    it('registers the token of an allowed phone, and nothing from a simulator', async () => {
        await registerDevice(caller)
        expect(mockApi).toHaveBeenCalledWith('/api/v1/me/devices', { ...caller, method: 'POST', body: { token: 'ExponentPushToken[abc]', platform: 'ios', appVersion: '1.0.0 (7)' } })
        mockApi.mockClear()
        mockDevice.isDevice = false
        await registerDevice(caller)
        expect(mockApi).not.toHaveBeenCalled()
    })

    it('asks for permission once, ever', async () => {
        await askForPushOnce(caller)
        await askForPushOnce(caller)
        expect(mockRequestPermissions).toHaveBeenCalledTimes(1)
    })

    it('drops the token on sign-out', async () => {
        await registerDevice(caller)
        await unregisterDevice(caller)
        expect(mockApi).toHaveBeenLastCalledWith('/api/v1/me/devices', { ...caller, method: 'DELETE', body: { token: 'ExponentPushToken[abc]', platform: 'ios' } })
    })
})

describe('push display and taps', () => {
    it('keeps quiet about the conversation on screen, and shows the others', async () => {
        const mockHandler = jest.mocked(Notifications.setNotificationHandler).mock.calls[0][0]
        setConversationOnScreen('conv-1')
        expect(await mockHandler!.handleNotification(notification({ agentId: 'a1', conversationId: 'conv-1', kind: 'question' }))).toMatchObject({ shouldShowBanner: false })
        expect(await mockHandler!.handleNotification(notification({ agentId: 'a1', conversationId: 'conv-2', kind: 'question' }))).toMatchObject({ shouldShowBanner: true })
        setConversationOnScreen(null)
    })

    it('opens the conversation a tapped push is about, once', async () => {
        mockLastResponse = { notification: notification({ agentId: 'a1', conversationId: 'conv-2', kind: 'question' }, 'n9') }
        const view = await render(<PushRouting />)
        await view.rerender(<PushRouting />)
        expect(mockPush).toHaveBeenCalledTimes(1)
        expect(mockPush).toHaveBeenCalledWith({ pathname: '/chat/[id]', params: { id: 'conv-2', to: 'a1' } })
    })

    it('opens a push from the Foreman on its own chat page', async () => {
        mockPush.mockClear()
        mockLastResponse = { notification: notification({ agentId: FOREMAN_AGENT_ID, conversationId: 'conv-3', kind: 'question' }, 'n10') }
        await render(<PushRouting />)
        expect(mockPush).toHaveBeenCalledWith({ pathname: '/chat/[id]', params: { id: 'conv-3' } })
    })
})
