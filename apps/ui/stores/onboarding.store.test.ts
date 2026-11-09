import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForemanIntake } from '@/lib/onboarding/intake'

const STORAGE_KEY = 'rerun:pending-first-agent'

function memoryStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial))
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
        removeItem: (key: string) => void values.delete(key),
        read: (key: string) => values.get(key),
    }
}

async function loadStore(persisted?: Record<string, unknown>) {
    const storage = memoryStorage(persisted ? { [STORAGE_KEY]: JSON.stringify({ state: persisted, version: 0 }) } : {})
    vi.stubGlobal('window', { localStorage: storage })
    vi.resetModules()
    const store = await import('./onboarding.store')
    return { ...store, storage }
}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

const NOW = Date.parse('2026-10-16T12:00:00Z')
const HOUR = 60 * 60 * 1000
const FRESH = { pendingFirstAgent: NOW, pendingTemplate: NOW, pendingTemplateLink: NOW, pendingShareLink: NOW, pendingIntake: NOW, resumeRequested: NOW }

const DRAFT = { name: 'Scout', serviceSlugs: ['hubspot'], kickoff: 'Find leads', offset: { col: 1, row: 2 } }
const TEMPLATE = { slug: 'crm-kit', title: 'CRM kit', agentCount: 3 }
const INTAKE: ForemanIntake = { companyUrl: 'https://acme.com', industry: 'saas', decidedIndustry: null, industryLabel: null, position: 'CEO', firstName: 'Jane' }

describe('onboarding store rehydration', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(NOW)
    })

    it('restores every valid parked entry', async () => {
        const { useOnboardingStore } = await loadStore({ pendingFirstAgent: DRAFT, pendingTemplateLink: 'kit', pendingShareLink: 'tok', pendingIntake: INTAKE, resumeRequested: true, firstAgentFromPrompt: true, parkedAt: FRESH })
        expect(useOnboardingStore.getState()).toMatchObject({ pendingFirstAgent: DRAFT, pendingTemplateLink: 'kit', pendingShareLink: 'tok', pendingIntake: INTAKE, resumeRequested: true, firstAgentFromPrompt: true })
    })

    it('drops a corrupted entry without taking the others down', async () => {
        const { useOnboardingStore } = await loadStore({
            pendingFirstAgent: { name: '', serviceSlugs: [] },
            pendingTemplate: TEMPLATE,
            pendingTemplateLink: 42,
            pendingIntake: { ...INTAKE, industry: 'mining' },
            parkedAt: FRESH,
        })
        expect(useOnboardingStore.getState()).toMatchObject({ pendingFirstAgent: null, pendingTemplate: TEMPLATE, pendingTemplateLink: null, pendingIntake: null })
    })

    it('rejects an offset that is not a whole cell', async () => {
        const { useOnboardingStore } = await loadStore({ pendingFirstAgent: { ...DRAFT, offset: { col: 1.5, row: 0 } }, parkedAt: FRESH })
        expect(useOnboardingStore.getState().pendingFirstAgent).toBeNull()
    })

    it('drops the prompt marker when the draft it qualifies did not survive', async () => {
        const { useOnboardingStore } = await loadStore({ pendingFirstAgent: { name: 'x' }, firstAgentFromPrompt: true, parkedAt: FRESH })
        expect(useOnboardingStore.getState().firstAgentFromPrompt).toBe(false)
    })

    it('keeps the line written under the welcome card only beside the answers it cut short', async () => {
        const kept = await loadStore({ pendingIntake: INTAKE, pendingOwnAsk: ' Chase my invoices ', parkedAt: FRESH })
        expect(kept.useOnboardingStore.getState()).toMatchObject({ pendingIntake: INTAKE, pendingOwnAsk: 'Chase my invoices' })
        const orphan = await loadStore({ pendingIntake: { ...INTAKE, industry: 'mining' }, pendingOwnAsk: 'Chase my invoices', parkedAt: FRESH })
        expect(orphan.useOnboardingStore.getState().pendingOwnAsk).toBeNull()
    })

    it('drops an entry parked without a date', async () => {
        const { useOnboardingStore, hasPendingStart } = await loadStore({ pendingFirstAgent: DRAFT, resumeRequested: true })
        expect(hasPendingStart(useOnboardingStore.getState())).toBe(false)
        expect(useOnboardingStore.getState().resumeRequested).toBe(false)
    })

    it('drops an entry parked more than a day ago and keeps a fresh one beside it', async () => {
        const { useOnboardingStore } = await loadStore({
            pendingFirstAgent: DRAFT,
            pendingShareLink: 'tok',
            firstAgentFromPrompt: true,
            parkedAt: { pendingFirstAgent: NOW - 24 * HOUR, pendingShareLink: NOW - 23 * HOUR },
        })
        expect(useOnboardingStore.getState()).toMatchObject({ pendingFirstAgent: null, firstAgentFromPrompt: false, pendingShareLink: 'tok', parkedAt: { pendingShareLink: NOW - 23 * HOUR } })
        expect(useOnboardingStore.getState().parkedAt).not.toHaveProperty('pendingFirstAgent')
    })

    it('starts empty with nothing stored', async () => {
        const { useOnboardingStore, hasPendingStart } = await loadStore()
        expect(hasPendingStart(useOnboardingStore.getState())).toBe(false)
        expect(useOnboardingStore.getState().resumeRequested).toBe(false)
    })
})

describe('onboarding store actions', () => {
    it('dates every entry it parks', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(NOW)
        const { useOnboardingStore } = await loadStore()
        const store = useOnboardingStore.getState()
        store.setPendingFirstAgent(DRAFT)
        store.setPendingTemplate(TEMPLATE)
        store.setPendingTemplateLink('kit')
        store.setPendingShareLink('tok')
        store.setPendingIntake(INTAKE)
        store.markResume()
        expect(useOnboardingStore.getState().parkedAt).toEqual(FRESH)
    })

    it('keeps a single thing waiting to land', async () => {
        const { useOnboardingStore } = await loadStore()
        const store = useOnboardingStore.getState()
        store.setPendingTemplate(TEMPLATE)
        store.setPendingFirstAgent(DRAFT)
        expect(useOnboardingStore.getState()).toMatchObject({ pendingFirstAgent: DRAFT, pendingTemplate: null })
        store.markFirstAgentFromPrompt()
        store.setPendingTemplate(TEMPLATE)
        expect(useOnboardingStore.getState()).toMatchObject({ pendingFirstAgent: null, pendingTemplate: TEMPLATE, firstAgentFromPrompt: false })
    })

    it('clears the line written under the welcome card with the answers', async () => {
        const { useOnboardingStore } = await loadStore({})
        useOnboardingStore.getState().setPendingIntake(INTAKE, 'Chase my invoices')
        expect(useOnboardingStore.getState().pendingOwnAsk).toBe('Chase my invoices')
        useOnboardingStore.getState().clearPendingIntake()
        expect(useOnboardingStore.getState()).toMatchObject({ pendingIntake: null, pendingOwnAsk: null })
    })

    it('clears the prompt marker with the draft', async () => {
        const { useOnboardingStore } = await loadStore({ pendingFirstAgent: DRAFT, firstAgentFromPrompt: true })
        useOnboardingStore.getState().clearPendingFirstAgent()
        expect(useOnboardingStore.getState()).toMatchObject({ pendingFirstAgent: null, firstAgentFromPrompt: false })
    })

    it('consumes the resume flag exactly once', async () => {
        const { useOnboardingStore } = await loadStore()
        const store = useOnboardingStore.getState()
        expect(store.consumeResume()).toBe(false)
        store.markResume()
        expect(store.consumeResume()).toBe(true)
        expect(store.consumeResume()).toBe(false)
    })

    it('counts a parked share link as a pending start', async () => {
        const { useOnboardingStore, hasPendingStart } = await loadStore()
        useOnboardingStore.getState().setPendingShareLink('tok')
        expect(hasPendingStart(useOnboardingStore.getState())).toBe(true)
    })

    it('persists the parked state and none of the actions', async () => {
        const { useOnboardingStore, storage } = await loadStore()
        useOnboardingStore.getState().setPendingTemplateLink('kit')
        const saved = JSON.parse(storage.read(STORAGE_KEY)!).state
        expect(saved.pendingTemplateLink).toBe('kit')
        expect(Object.keys(saved).sort()).toEqual(['firstAgentFromPrompt', 'parkedAt', 'pendingFirstAgent', 'pendingIntake', 'pendingOwnAsk', 'pendingShareLink', 'pendingTemplate', 'pendingTemplateLink', 'resumeRequested'])
    })
})
