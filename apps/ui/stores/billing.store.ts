import { create } from 'zustand'
import type { AddonKey } from '@rerun/cloud/billing'

// The trial's coworker cap: the checkout opens straight on paying now, which is what lifts it. The
// value is the one `paywall_viewed` has always carried for this gate, so its series stays whole.
export const AGENT_LIMIT_TRIGGER = 'entitlement_gate'

// A paywall opened from a coworker that stopped: the checkout names it, and `onPaid` lets the chat
// pick the stopped task back up once the plan is paid.
export type BillingUpgrade = { coworker?: string; onPaid?: () => void }

type BillingState = {
    open: boolean
    highlightAddon: AddonKey | null
    // What surfaced the paywall (trial_pill, budget_exhausted, entitlement_gate, template_content, …), for `paywall_viewed`.
    trigger: string | null
    upgrade: BillingUpgrade | null
    // Ouvre le dialog billing, optionnellement en mettant un add-on en avant (ex. depuis un feature gate).
    openBilling: (highlight?: AddonKey, trigger?: string, upgrade?: BillingUpgrade) => void
    setOpen: (open: boolean) => void
}

export const useBillingStore = create<BillingState>(set => ({
    open: false,
    highlightAddon: null,
    trigger: null,
    upgrade: null,
    openBilling: (highlight, trigger, upgrade) => set({ open: true, highlightAddon: highlight ?? null, trigger: trigger ?? 'manual', upgrade: upgrade ?? null }),
    // Reset du highlight à la fermeture pour ne pas le retrouver à la réouverture via le menu.
    setOpen: open => set(open ? { open } : { open: false, highlightAddon: null, trigger: null, upgrade: null }),
}))
