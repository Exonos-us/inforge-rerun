// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    answerSecretRequestAction: vi.fn(async () => ({ success: true })),
    updateAgentKeysAction: vi.fn(async () => ({ success: true })),
    getAgentKeysAction: vi.fn(async () => ({ keys: [], engineKeys: [] })),
}))

vi.mock('@/app/api/_actions/agent.actions', () => ({
    answerSecretRequestAction: mocks.answerSecretRequestAction,
    updateAgentKeysAction: mocks.updateAgentKeysAction,
    getAgentKeysAction: mocks.getAgentKeysAction,
}))

const { SecretRequestBlock } = await import('./SecretRequestBlock')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
})

const SECRETS = [
    { key: 'GH_PASSWORD', label: 'GitHub password', site: 'github.com' },
    { key: 'API_KEY', label: 'API key' },
]

async function render(onDone = vi.fn()) {
    await act(async () => {
        root.render(createElement(SecretRequestBlock, { agentId: 'a1', sessionId: 's1', secrets: SECRETS, onDone, onSkip: vi.fn(), onDismiss: vi.fn() }))
    })
    return onDone
}

const input = (key: string) => container.querySelector(`[data-hitl="secret-${key}"]`) as HTMLInputElement
const allowSwitch = (key: string) => container.querySelector(`[data-hitl="allow-${key}"]`) as HTMLButtonElement

async function fill(key: string, value: string) {
    await act(async () => {
        const field = input(key)
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(field, value)
        field.dispatchEvent(new Event('input', { bubbles: true }))
    })
}

const save = async () => {
    await act(async () => {
        ;(container.querySelector('[data-hitl="save"]') as HTMLButtonElement).click()
    })
}

describe('SecretRequestBlock', () => {
    it('shows the site a screen secret signs in to, with its allow toggle, and none for a plain key', async () => {
        await render()
        expect(container.textContent).toContain('Sign-in for github.com')
        expect(container.textContent).toContain('Let it sign in on github.com without asking each time')
        expect(allowSwitch('GH_PASSWORD')).not.toBeNull()
        expect(allowSwitch('API_KEY')).toBeNull()
    })

    it('answers the conversation with the values and no standing allowance by default', async () => {
        const onDone = await render()
        await fill('GH_PASSWORD', 'hunter2')
        await save()
        expect(mocks.answerSecretRequestAction).toHaveBeenCalledWith('s1', { GH_PASSWORD: 'hunter2' }, [])
        expect(onDone).toHaveBeenCalledWith(expect.stringContaining('GH_PASSWORD: provided'))
        expect(onDone.mock.calls[0][0]).not.toContain('hunter2')
    })

    it('carries the keys whose allow toggle the user switched on', async () => {
        await render()
        await fill('GH_PASSWORD', 'hunter2')
        await act(async () => allowSwitch('GH_PASSWORD').click())
        await save()
        expect(mocks.answerSecretRequestAction).toHaveBeenCalledWith('s1', { GH_PASSWORD: 'hunter2' }, ['GH_PASSWORD'])
    })

    it('drops the typed values from the form once the engine has them', async () => {
        await render()
        await fill('GH_PASSWORD', 'hunter2')
        await save()
        expect(input('GH_PASSWORD').value).toBe('')
    })

    it('falls back to the keys route, site metadata included, when there is no conversation', async () => {
        await act(async () => {
            root.render(createElement(SecretRequestBlock, { agentId: 'a1', sessionId: null, secrets: SECRETS, onDone: vi.fn(), onSkip: vi.fn(), onDismiss: vi.fn() }))
        })
        await fill('GH_PASSWORD', 'hunter2')
        await act(async () => allowSwitch('GH_PASSWORD').click())
        await save()
        expect(mocks.updateAgentKeysAction).toHaveBeenCalledWith('a1', { set: { GH_PASSWORD: 'hunter2' }, screen: { GH_PASSWORD: { site: 'github.com', allowAlways: true } } })
    })
})
