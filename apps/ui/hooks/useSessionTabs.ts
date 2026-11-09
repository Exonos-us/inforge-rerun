'use client'

import { nanoid } from 'nanoid'
import { useCallback, useEffect, useRef, useState } from 'react'

export type SessionTab = {
    uid: string
    id: string | null
    title: string
    // The coworker's main conversation: pinned first, never closed, never written to storage.
    kind?: 'general'
}

export type SessionTabsState = {
    tabs: SessionTab[]
    activeIndex: number
}

export const GENERAL_TAB_TITLE = 'General'
export const NEW_THREAD_TITLE = 'New conversation'

// The threads opened in this panel, most recent last, each one a tab after General. Past this many
// the oldest are forgotten, and reopened from the coworker's threads list.
export const MAX_REMEMBERED_TABS = 8

export const isGeneralTab = (tab: SessionTab | undefined): boolean => tab?.kind === 'general'

export const generalTabUid = (agentId: string) => `general:${agentId}`

// Its id is null until the row is known: read on mount, or created by the first message sent there.
function generalTab(agentId: string): SessionTab {
    return { uid: generalTabUid(agentId), id: null, title: GENERAL_TAB_TITLE, kind: 'general' }
}

// General learns its row id. A thread tab opened on that same id before it was known (a notification,
// the inbox, the search) folds into the pinned tab, so one conversation never has two tabs.
export function adoptGeneralId(state: SessionTabsState, sessionId: string): SessionTabsState {
    const general = state.tabs[0]
    if (!isGeneralTab(general)) return state
    const duplicates = state.tabs.map((tab, index) => (index > 0 && tab.id === sessionId ? index : -1)).filter(index => index !== -1)
    if (general.id === sessionId && duplicates.length === 0) return state
    const tabs = [{ ...general, id: sessionId }, ...state.tabs.filter((_, index) => index > 0 && !duplicates.includes(index))]
    const activeIndex = duplicates.includes(state.activeIndex) ? 0 : state.activeIndex - duplicates.filter(index => index < state.activeIndex).length
    return { tabs, activeIndex }
}

// Keeps the newest threads, and always the active one: a list saved under the old, higher ceiling
// can hold it among the oldest. General, when it leads the list, is neither counted nor dropped.
export function remember(state: SessionTabsState): SessionTabsState {
    const pinned = isGeneralTab(state.tabs[0]) ? state.tabs.slice(0, 1) : []
    const threads = state.tabs.slice(pinned.length)
    if (threads.length <= MAX_REMEMBERED_TABS) return state
    const active = state.tabs[state.activeIndex]
    const newest = threads.slice(-MAX_REMEMBERED_TABS)
    const kept = !active || isGeneralTab(active) || newest.includes(active) ? newest : [active, ...newest.slice(1)]
    const tabs = [...pinned, ...kept]
    return { tabs, activeIndex: Math.max(0, tabs.indexOf(active)) }
}

function getStorageKey(agentId: string) {
    return `session-tabs-${agentId}`
}

function newTab(): SessionTab {
    return { uid: nanoid(), id: null, title: NEW_THREAD_TITLE }
}

// What the storage holds: the threads only. `pinned` says the saved `activeIndex` already counts
// General in front; a state saved before General existed counted threads from zero.
type StoredState = { tabs: SessionTab[]; activeIndex: number; pinned?: 'general' }

export function loadFromStorage(agentId: string): SessionTabsState | null {
    try {
        const raw = localStorage.getItem(getStorageKey(agentId))
        if (!raw) return null
        const parsed = JSON.parse(raw) as StoredState
        if (!parsed?.tabs) return null
        // Migration: anciens onglets stockés sans `uid` → en générer un. Le plafond a baissé
        // depuis que les onglets se voient : un état sauvé au-dessus est ramené dessous.
        const threads = parsed.tabs.filter(t => !isGeneralTab(t)).map(t => (t.uid ? t : { ...t, uid: nanoid() }))
        const activeIndex = Math.min(Math.max(0, (parsed.activeIndex ?? 0) + (parsed.pinned === 'general' ? 0 : 1)), threads.length)
        return remember({ tabs: [generalTab(agentId), ...threads], activeIndex })
    } catch {
        return null
    }
}

export function saveToStorage(agentId: string, state: SessionTabsState) {
    try {
        const stored: StoredState = { tabs: state.tabs.filter(t => !isGeneralTab(t)), activeIndex: state.activeIndex, pinned: 'general' }
        localStorage.setItem(getStorageKey(agentId), JSON.stringify(stored))
    } catch {}
}

const freshState = (agentId: string): SessionTabsState => ({ tabs: [generalTab(agentId)], activeIndex: 0 })

export function useSessionTabs(agentId: string) {
    const [state, setState] = useState<SessionTabsState>(() => loadFromStorage(agentId) ?? freshState(agentId))

    const stateRef = useRef(state)
    stateRef.current = state

    useEffect(() => {
        // The General id resolved so far belongs to the previous coworker: the new one resolves its own.
        setState(loadFromStorage(agentId) ?? freshState(agentId))
    }, [agentId])

    useEffect(() => {
        saveToStorage(agentId, state)
    }, [agentId, state])

    const activeSessionId = state.tabs[state.activeIndex]?.id ?? null

    // A conversation nobody has spoken in yet is the new one: asking again lands on it.
    const createNew = useCallback(() => {
        setState(prev => {
            const blank = prev.tabs.findIndex(t => t.id === null && !isGeneralTab(t))
            if (blank !== -1) return { ...prev, activeIndex: blank }
            return remember({ tabs: [...prev.tabs, newTab()], activeIndex: prev.tabs.length })
        })
    }, [])

    const selectTab = useCallback((index: number) => {
        setState(prev => (index === prev.activeIndex ? prev : { ...prev, activeIndex: index }))
    }, [])

    // Closing the last thread leaves General on screen: it is never closed itself.
    const closeTab = useCallback((index: number) => {
        setState(prev => {
            if (isGeneralTab(prev.tabs[index])) return prev
            const newTabs = prev.tabs.filter((_, i) => i !== index)
            let newActive = prev.activeIndex
            if (index === prev.activeIndex) {
                newActive = Math.min(index, newTabs.length - 1)
            } else if (index < prev.activeIndex) {
                newActive = prev.activeIndex - 1
            }
            return { tabs: newTabs, activeIndex: Math.max(0, newActive) }
        })
    }, [])

    const openTab = useCallback((sessionId: string, title: string) => {
        setState(prev => {
            const existing = prev.tabs.findIndex(t => t.id === sessionId)
            if (existing !== -1) {
                return { ...prev, activeIndex: existing }
            }
            return remember({
                tabs: [...prev.tabs, { uid: nanoid(), id: sessionId, title }],
                activeIndex: prev.tabs.length,
            })
        })
    }, [])

    const updateTabByUid = useCallback((uid: string, sessionId: string, title?: string) => {
        setState(prev => ({
            ...prev,
            tabs: prev.tabs.map(t => (t.uid === uid ? { ...t, id: sessionId, title: isGeneralTab(t) ? t.title : (title ?? t.title) } : t)),
        }))
    }, [])

    // General keeps its name whatever the hub writes on its row.
    const updateTabTitle = useCallback((sessionId: string, title: string) => {
        setState(prev => ({
            ...prev,
            tabs: prev.tabs.map(t => (t.id === sessionId && !isGeneralTab(t) ? { ...t, title } : t)),
        }))
    }, [])

    const setGeneralSessionId = useCallback((sessionId: string) => {
        setState(prev => adoptGeneralId(prev, sessionId))
    }, [])

    return {
        tabs: state.tabs,
        activeIndex: state.activeIndex,
        activeSessionId,
        createNew,
        selectTab,
        closeTab,
        openTab,
        updateTabByUid,
        updateTabTitle,
        setGeneralSessionId,
    }
}
