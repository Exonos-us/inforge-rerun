'use client'

import { DEFAULT_PRICE_ARM, type PriceArm } from '@rerun/contracts'

import type { SubscriptionProvider } from '@/components/agent/ModelPickerProviders'
import type { TrialStep } from '@/lib/foreman/next-steps'

// Nothing is sold in this build, so every surface that would sell or meter the plan renders
// nothing. Their callers only reach them on states a self-hosted workspace never takes.
export function BillingDialog() {
    return null
}

export function PostPaymentDialog(_props: { open: boolean; onOpenChange: (open: boolean) => void }) {
    return null
}

export function TemplatePurchaseSuccessDialog(_props: { slug: string; sessionId: string | null; onOpenChange: (open: boolean) => void }) {
    return null
}

export function UpgradePill() {
    return null
}

export function CreditMeter(_props: { usedMicros: number; wholeMicros: number; trial: boolean; onOpen: () => void; onAdd?: () => void }) {
    return null
}

export function CreditsUsageBar(_props: { usedMicros?: number | null; budgetMicros?: number | null; resetAt?: string | null; className?: string }) {
    return null
}

export function BudgetExhaustedNotice(_props: {
    onConnectProvider?: (provider: SubscriptionProvider) => void
    ownConnection?: { label: string; provider: string; onUse: () => void }
    preTrial?: boolean
    trialing?: boolean
    paused?: boolean
    noCredit?: boolean
    coworker?: string
    priceArm?: PriceArm
    onPaid?: () => void
    resuming?: boolean
    onResumeNow?: () => void
}) {
    return null
}

export function ForemanTrialGate(_props: { step: TrialStep }) {
    return null
}

export function CheckoutWidget(_props: { output?: unknown; onDone: (result: { ok: true; status: 'entitled' } | { ok: false; reason: 'trial_refused' | 'dismissed' | 'pending'; error?: string }) => void }) {
    return null
}

export function TemplatePurchaseWidget(_props: { input: unknown; output?: unknown; onDone: (result: { ok: true } | { ok: false; reason: 'dismissed' }) => void }) {
    return null
}

export async function startPlan(_source: 'template_cta' | 'agent_share' | 'billing_dialog' | 'ai_providers'): Promise<void> {}

export function usePriceArm(): PriceArm {
    return DEFAULT_PRICE_ARM
}
