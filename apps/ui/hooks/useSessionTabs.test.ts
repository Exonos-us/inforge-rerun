import { beforeEach, describe, expect, it, vi } from 'vitest'

import { adoptGeneralId, loadFromStorage, MAX_REMEMBERED_TABS, remember, saveToStorage, type SessionTab } from '@/hooks/useSessionTabs'

function tab(n: number): SessionTab {
    return { uid: `uid-${n}`, id: `session-${n}`, title: `Conversation ${n}` }
}

describe('remember', () => {
    it('keeps a list under the ceiling as it is', () => {
        const state = { tabs: [tab(1), tab(2)], activeIndex: 1 }
        expect(remember(state)).toBe(state)
    })

    it('forgets the oldest tabs and follows the active one, appended last', () => {
        const tabs = Array.from({ length: MAX_REMEMBERED_TABS + 3 }, (_, i) => tab(i))
        const kept = remember({ tabs, activeIndex: tabs.length - 1 })
        expect(kept.tabs).toHaveLength(MAX_REMEMBERED_TABS)
        expect(kept.tabs[0]).toBe(tabs[3])
        expect(kept.tabs[kept.activeIndex]).toBe(tabs[tabs.length - 1])
    })

    it('keeps an old active tab ahead of the newest ones', () => {
        const tabs = Array.from({ length: MAX_REMEMBERED_TABS + 3 }, (_, i) => tab(i))
        const kept = remember({ tabs, activeIndex: 1 })
        expect(kept.tabs).toHaveLength(MAX_REMEMBERED_TABS)
        expect(kept.tabs[kept.activeIndex]).toBe(tabs[1])
        expect(kept.tabs.at(-1)).toBe(tabs[tabs.length - 1])
    })
})

describe('General', () => {
    // The suite runs in a bare Node environment: the storage is a map standing in for the browser's.
    beforeEach(() => {
        const store = new Map<string, string>()
        vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), clear: () => store.clear() })
    })

    const general: SessionTab = { uid: 'general:a1', id: null, title: 'General', kind: 'general' }

    it('keeps General in front of the threads the ceiling trims, and never counts it', () => {
        const threads = Array.from({ length: MAX_REMEMBERED_TABS + 2 }, (_, i) => tab(i))
        const kept = remember({ tabs: [general, ...threads], activeIndex: 0 })
        expect(kept.tabs[0]).toBe(general)
        expect(kept.tabs).toHaveLength(MAX_REMEMBERED_TABS + 1)
        expect(kept.tabs.at(-1)).toBe(threads.at(-1))
        expect(kept.activeIndex).toBe(0)

        const full = { tabs: [general, ...threads.slice(0, MAX_REMEMBERED_TABS)], activeIndex: 3 }
        expect(remember(full)).toBe(full)
    })

    it('comes back in front of a stored list, with the active thread shifted past it', () => {
        localStorage.setItem('session-tabs-a1', JSON.stringify({ tabs: [tab(1), tab(2)], activeIndex: 1 }))
        const loaded = loadFromStorage('a1')
        expect(loaded?.tabs.map(t => t.kind ?? t.id)).toEqual(['general', 'session-1', 'session-2'])
        expect(loaded?.tabs[0].id).toBeNull()
        expect(loaded?.activeIndex).toBe(2)
    })

    it('learns its row id, and folds a thread tab opened on that id into the pinned tab', () => {
        const opened: SessionTab = { uid: 'uid-general-row', id: 'general-row', title: 'General' }
        const state = { tabs: [general, tab(1), opened], activeIndex: 2 }

        const adopted = adoptGeneralId(state, 'general-row')

        expect(adopted.tabs.map(t => t.id)).toEqual(['general-row', 'session-1'])
        expect(adopted.tabs[0].kind).toBe('general')
        expect(adopted.activeIndex).toBe(0)
        expect(adoptGeneralId({ tabs: [general, tab(1)], activeIndex: 1 }, 'general-row').activeIndex).toBe(1)
        expect(adoptGeneralId(adopted, 'general-row')).toBe(adopted)
    })

    it('is never written to storage, and a saved index already counts it', () => {
        saveToStorage('a1', { tabs: [general, tab(1)], activeIndex: 1 })
        const stored = JSON.parse(localStorage.getItem('session-tabs-a1')!)
        expect(stored.tabs.map((t: SessionTab) => t.id)).toEqual(['session-1'])
        expect(stored.pinned).toBe('general')
        expect(loadFromStorage('a1')?.activeIndex).toBe(1)
    })
})
