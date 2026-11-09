import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { TEMPLATE_CATEGORIES } from '@rerun/contracts'
import { z } from 'zod'
import type { ForemanIntake } from '@/lib/onboarding/intake'
import type { PendingAgentDraft } from './board.store'

// The first-agent draft captured during onboarding, persisted (store + localStorage) so it survives
// the "Create your account" dialog being cancelled, and a full page reload. It is replayed once the
// user converts / pays, then the real agent is created inside a claimed Space. Cleared only after
// that real placement — never at the placeholder drop.
// Where the user dropped the agent, as an offset from the corner of the space it was dropped on.
// Absolute grid coordinates would not survive the trip: the drop happens on the onboarding
// placeholder (cols 2→9) while the Space the chain later claims starts at 0→7.
const spaceOffsetSchema = z.object({ col: z.number().int(), row: z.number().int() })
export type SpaceOffset = z.infer<typeof spaceOffsetSchema>

const pendingFirstAgentSchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    serviceSlugs: z.array(z.string()),
    kickoff: z.string().optional(),
    offset: spaceOffsetSchema.optional(),
})

export type PendingFirstAgent = PendingAgentDraft & { offset?: SpaceOffset }

// A shared template link parked under the same contract as the first-agent draft: it survives the
// account dialog being cancelled, a reload and the Stripe round-trip, and is replayed once the
// workspace is entitled. The payload is a slug because the install re-reads the template server
// side; the title and count are only here for the copy.
const pendingTemplateSchema = z.object({
    slug: z.string().min(1),
    title: z.string().min(1),
    agentCount: z.number().int().nonnegative(),
    offsets: z.array(spaceOffsetSchema).optional(),
    // Parkée depuis une fiche, donc avant le moindre placement : la reprise rend la main au board
    // pour que l'utilisateur pose ses tuiles, au lieu d'installer directement. Une entrée parkée
    // depuis un drop sur le placeholder porte déjà ses `offsets` et n'a rien à replacer.
    needsPlacement: z.boolean().optional(),
})

export type PendingTemplate = z.infer<typeof pendingTemplateSchema>

const templateCategorySchema = z.enum(TEMPLATE_CATEGORIES)

const pendingIntakeSchema = z.object({
    companyUrl: z.string().nullable(),
    industry: templateCategorySchema.nullable(),
    decidedIndustry: templateCategorySchema.nullable(),
    industryLabel: z.string().nullable(),
    position: z.string().nullable(),
    firstName: z.string().nullable(),
}) satisfies z.ZodType<ForemanIntake>

const pendingTemplateLinkSchema = z.string().min(1)
const pendingShareLinkSchema = z.string().min(1)

// Nothing parked outlives a day: a draft left by a visit months ago, still valid against the schema,
// was replayed by the first sign-in in that browser and opened the paywall out of nowhere. An entry
// stored without a date is treated as one of those.
const PARKED_TTL_MS = 24 * 60 * 60 * 1000

type ParkedEntry = 'pendingFirstAgent' | 'pendingTemplate' | 'pendingTemplateLink' | 'pendingShareLink' | 'pendingIntake' | 'resumeRequested'
type ParkedAt = Partial<Record<ParkedEntry, number>>

export type OnboardingState = {
    pendingFirstAgent: PendingFirstAgent | null
    pendingTemplate: PendingTemplate | null
    // A shared template link met before the account wall. Only the slug, and deliberately outside
    // the pair above: nothing is confirmed yet, it is a dialog waiting to be opened once the visitor
    // has an account. Persisted because the Google round-trip drops the query string.
    pendingTemplateLink: string | null
    // The same, for a shared agent link met before the account wall. Only the token: the card it
    // opens is fetched fresh, and nothing is confirmed until the agent is dropped on the board.
    pendingShareLink: string | null
    // The welcome card answered by an anonymous visitor. Nothing is written for an anonymous row: the
    // answers wait here, through the account wall and the Google round-trip, and are saved on
    // whichever workspace the visitor ends up signed into.
    pendingIntake: ForemanIntake | null
    // The line they wrote in the composer under the welcome card instead of finishing it. Parked with
    // the answers it cut short and dropped with them: it is what the foreman opens on once the
    // account exists.
    pendingOwnAsk: string | null
    // One-shot flag set right before an anonymous user converts (email link, existing account, or
    // Google). It survives the account switch / OAuth redirect so the board can replay the parked
    // draft once the real session is in place.
    resumeRequested: boolean
    // Un brouillon posé par le composer de la landing (`?prompt=`) chez quelqu'un qui n'a jamais vu
    // Rerun : c'est avec ça que le Foreman ouvre la conversation, au lieu de le créer dans son dos.
    // Marqueur explicite plutôt que déduit du couple (brouillon parké, ligne user pas encore
    // onboardée) : un brouillon posé au drop vient du wizard, chez quelqu'un qui connaît déjà le
    // produit. Persisté comme le brouillon, donc il survit au signup et au reload.
    firstAgentFromPrompt: boolean
    // When each entry above was parked, read at rehydration to drop what has gone stale.
    parkedAt: ParkedAt
    setPendingFirstAgent: (draft: PendingFirstAgent) => void
    clearPendingFirstAgent: () => void
    setPendingTemplate: (template: PendingTemplate) => void
    clearPendingTemplate: () => void
    setPendingTemplateLink: (slug: string) => void
    clearPendingTemplateLink: () => void
    setPendingShareLink: (token: string) => void
    clearPendingShareLink: () => void
    setPendingIntake: (intake: ForemanIntake, ownAsk?: string | null) => void
    clearPendingIntake: () => void
    markResume: () => void
    consumeResume: () => boolean
    markFirstAgentFromPrompt: () => void
}

type PersistedOnboarding = Pick<
    OnboardingState,
    'pendingFirstAgent' | 'pendingTemplate' | 'pendingTemplateLink' | 'pendingShareLink' | 'pendingIntake' | 'pendingOwnAsk' | 'resumeRequested' | 'firstAgentFromPrompt' | 'parkedAt'
>

// Validate each entry on its own, dropping a corrupted one rather than tripping on it or taking the
// others down with it. Shared by the localStorage rehydration and by the state another browser
// hands over, which is no more trustworthy.
export function parsePersistedOnboarding(raw: unknown, now = Date.now()): PersistedOnboarding {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof PersistedOnboarding, unknown>>
    const stamps = (p.parkedAt && typeof p.parkedAt === 'object' ? p.parkedAt : {}) as Partial<Record<ParkedEntry, unknown>>
    const parkedAt: ParkedAt = {}
    function fresh<T>(entry: ParkedEntry, schema: z.ZodType<T>): T | null {
        const stamp = stamps[entry]
        if (p[entry] == null || typeof stamp !== 'number' || now - stamp >= PARKED_TTL_MS) return null
        const parsed = schema.safeParse(p[entry])
        if (!parsed.success) return null
        parkedAt[entry] = stamp
        return parsed.data
    }
    const pendingFirstAgent = fresh('pendingFirstAgent', pendingFirstAgentSchema)
    const pendingIntake = fresh('pendingIntake', pendingIntakeSchema)
    const ownAsk = typeof p.pendingOwnAsk === 'string' ? p.pendingOwnAsk.trim() : ''
    return {
        pendingFirstAgent,
        pendingTemplate: fresh('pendingTemplate', pendingTemplateSchema),
        pendingTemplateLink: fresh('pendingTemplateLink', pendingTemplateLinkSchema),
        pendingShareLink: fresh('pendingShareLink', pendingShareLinkSchema),
        pendingIntake,
        pendingOwnAsk: pendingIntake && ownAsk ? ownAsk : null,
        resumeRequested: fresh('resumeRequested', z.literal(true)) === true,
        // Adossé au brouillon qu'il qualifie : un brouillon tombé au parse laisserait sinon un
        // marqueur qui ne désigne plus rien.
        firstAgentFromPrompt: pendingFirstAgent !== null && p.firstAgentFromPrompt === true,
        parkedAt,
    }
}

// Whether anything is waiting to land. Read this rather than one field: every step of the chain
// (conversion, checkout return, board placeholder) treats a parked draft, a parked template and a
// parked share link the same way, and only the terminus tells them apart.
export function hasPendingStart(state: Pick<OnboardingState, 'pendingFirstAgent' | 'pendingTemplate' | 'pendingShareLink'>): boolean {
    return !!state.pendingFirstAgent || !!state.pendingTemplate || !!state.pendingShareLink
}

export const useOnboardingStore = create<OnboardingState>()(
    persist(
        (set, get) => ({
            pendingFirstAgent: null,
            pendingTemplate: null,
            pendingTemplateLink: null,
            pendingShareLink: null,
            pendingIntake: null,
            pendingOwnAsk: null,
            resumeRequested: false,
            firstAgentFromPrompt: false,
            parkedAt: {},
            // Only one thing can be waiting to land: the chain claims a Space for whatever is
            // parked, so keeping both would strand the loser on a Space of its own.
            setPendingFirstAgent: draft => set(s => ({ pendingFirstAgent: draft, pendingTemplate: null, parkedAt: { ...s.parkedAt, pendingFirstAgent: Date.now() } })),
            // Le marqueur ne survit jamais au brouillon qu'il qualifie.
            clearPendingFirstAgent: () => set({ pendingFirstAgent: null, firstAgentFromPrompt: false }),
            setPendingTemplate: template => set(s => ({ pendingTemplate: template, pendingFirstAgent: null, firstAgentFromPrompt: false, parkedAt: { ...s.parkedAt, pendingTemplate: Date.now() } })),
            clearPendingTemplate: () => set({ pendingTemplate: null }),
            setPendingTemplateLink: slug => set(s => ({ pendingTemplateLink: slug, parkedAt: { ...s.parkedAt, pendingTemplateLink: Date.now() } })),
            clearPendingTemplateLink: () => set({ pendingTemplateLink: null }),
            setPendingShareLink: token => set(s => ({ pendingShareLink: token, parkedAt: { ...s.parkedAt, pendingShareLink: Date.now() } })),
            clearPendingShareLink: () => set({ pendingShareLink: null }),
            setPendingIntake: (intake, ownAsk = null) => set(s => ({ pendingIntake: intake, pendingOwnAsk: ownAsk?.trim() || null, parkedAt: { ...s.parkedAt, pendingIntake: Date.now() } })),
            clearPendingIntake: () => set({ pendingIntake: null, pendingOwnAsk: null }),
            markResume: () => set(s => ({ resumeRequested: true, parkedAt: { ...s.parkedAt, resumeRequested: Date.now() } })),
            consumeResume: () => {
                if (!get().resumeRequested) return false
                set({ resumeRequested: false })
                return true
            },
            markFirstAgentFromPrompt: () => set({ firstAgentFromPrompt: true }),
        }),
        {
            name: 'rerun:pending-first-agent',
            partialize: state => ({
                pendingFirstAgent: state.pendingFirstAgent,
                pendingTemplate: state.pendingTemplate,
                pendingTemplateLink: state.pendingTemplateLink,
                pendingShareLink: state.pendingShareLink,
                pendingIntake: state.pendingIntake,
                pendingOwnAsk: state.pendingOwnAsk,
                resumeRequested: state.resumeRequested,
                firstAgentFromPrompt: state.firstAgentFromPrompt,
                parkedAt: state.parkedAt,
            }),
            merge: (persisted, current) => ({ ...current, ...parsePersistedOnboarding(persisted) }),
        }
    )
)
