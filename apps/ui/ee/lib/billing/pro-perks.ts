import { BrainIcon, CoinsIcon, CpuIcon, UserPlus, type LucideIcon } from '@/lib/icons'

import { BASE_PLAN_CREDITS, CREDITS_PER_PACK, TRIAL_ACTIVE_AGENTS, TRIAL_CREDITS, creditsLabel } from './plans'

// `trialDetail` and `proDetail` sit under their cell in a smaller line, for what needs naming.
export type ProPerk = { id: string; icon: LucideIcon; title: string; trial: string; trialDetail?: string; pro: string; proDetail?: string; headline: string }

// What paying changes, against what the trial gives. The trial runs the lighter twin of every
// premium model (`trialModelFor` in @rerun/contracts), which is what the models row names.
export const PRO_PERKS: ProPerk[] = [
    { id: 'credits', icon: CoinsIcon, title: 'AI usage', trial: `${creditsLabel(TRIAL_CREDITS)}, once`, pro: `${creditsLabel(BASE_PLAN_CREDITS)} every month`, headline: `${BASE_PLAN_CREDITS.toLocaleString('en-US')} credits/mo` },
    { id: 'models', icon: BrainIcon, title: 'Models', trial: 'Lighter models', trialDetail: 'Sonnet 5.5, GPT-6 Sol', pro: 'Every premium model unlocked', proDetail: 'Opus 5.5, Fable 5.1, GPT-6 Astra', headline: 'Premium models' },
    { id: 'coworkers', icon: CpuIcon, title: 'Coworkers', trial: `${TRIAL_ACTIVE_AGENTS} active`, pro: 'Unlimited', headline: 'Unlimited coworkers' },
    { id: 'team', icon: UserPlus, title: 'Teammates', trial: 'Just you', pro: 'Invite your whole team', headline: 'Invite your team' },
    { id: 'topup', icon: CoinsIcon, title: 'Top-ups', trial: 'Not available', pro: `+${creditsLabel(CREDITS_PER_PACK)} when you need them`, headline: 'Top-ups anytime' },
]

export const NOTICE_PERKS = PRO_PERKS.slice(0, 3)
