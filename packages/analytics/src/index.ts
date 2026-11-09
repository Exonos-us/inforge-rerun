export type SignupMethod = 'google' | 'apple' | 'email' | 'phone'

// Holds the SignupMethod of an account about to be born, until the app sees it born and emits
// `account_created`. Shared across the subdomains, so whoever clears it server-side needs the domain.
export const SIGNUP_INTENT_COOKIE = 'rr_signup_intent'

export function sharedCookieDomain(hostname: string): string | undefined {
    return hostname.endsWith('rerun.build') ? '.rerun.build' : undefined
}
// Where the account form was shown. The wall is the one every anonymous visitor meets on arrival, so
// it dwarfs the other two: the funnel is only readable when they are counted apart.
export type SignupSurface = 'welcome_wall' | 'foreman_intake' | 'signin_dialog' | 'auth_page' | 'ready_made_arrival'
// Before 2026-10-13 the phone form reported no step at all, so its abandons read 'email', and the
// email code step read 'code'.
export type SignupStep = 'phone' | 'phone_code' | 'email' | 'email_code'
export type SignupAbandonTrigger = 'tab_hidden' | 'page_left' | 'dismissed'
export type BillingPeriod = 'monthly' | 'annual'
// A trial lasts five days, started through the card form ('card_required_5d') or, on the cardless
// arm of the trial test relaunched on 2026-10-22, without one ('no_card_5d'). The other literals name
// the trials of before and stay so those events keep a name: 'no_card_7d' between 2026-08-19 and
// 2026-09-05, then 'card_required_7d', then three days with a card ('card_required_3d') or without
// one ('no_card_3d').
export type TrialType = 'card_required_5d' | 'no_card_5d' | 'no_card_3d' | 'card_required_3d' | 'card_required_7d' | 'no_card_7d'

export type ExpertProps = {
    expert_id: string
    expert_slug: string
}

// One PostHog person per expert, shared by the admin app and the landing claim flow: the invite
// address is the stable key across both. Reads of `email` must happen before a claim can rewrite it.
export function expertDistinctId(expert: { id: string; email?: string | null }): string {
    return expert.email?.trim().toLowerCase() || `expert:${expert.id}`
}

// A phone number typed to sign in, the one the wall asks of an account that already exists, or the
// one an account moves to from its settings.
export type PhoneVerificationContext = 'sign_in' | 'wall' | 'settings'
export type CaptchaProvider = 'turnstile' | 'hcaptcha'
export type PhoneDeliveryStatus = 'sent' | 'delivered' | 'undelivered' | 'failed' | 'verified'

export type OnboardingArrival = 'template' | 'share' | 'prompt' | 'none'

export type AgentRunProps = {
    agent_id: string
    workspace_id?: number
    session_id?: string
    run_id?: string
    steps?: number
    model?: string
    cost_micros?: number
}

export type Attribution = {
    referrer_domain?: string
    utm_source?: string
    utm_campaign?: string
}

// The shared payload of every server-side Stripe lifecycle event, so any of them can be joined
// back to the workspace and the Stripe objects. `mrr` is in the currency it was billed in, not
// normalized: a rate hardcoded here would drift, so the split lives in the PostHog dashboard.
export type SubscriptionLifecycleProps = {
    plan: string
    workspace_id: number
    user_id?: string
    stripe_customer_id: string
    stripe_subscription_id: string
    addons: Record<string, number>
    mrr: number
    currency: string
    billing_period: BillingPeriod
    trial_start?: string
    trial_end?: string
}

// Le bras tiré pour chaque dimension du test A/B de la landing. Le sac reste ouvert parce qu'il suit
// `EXPERIMENT_VALUES` : le typer clé par clé obligerait ce fichier à connaître le catalogue des
// tests en cours, qui change à chaque expérience.
export type ExperimentExposure = Record<string, string>

// `composer` et `video` sont des appels à l'action à part entière : la bande visuelle et le champ de
// saisie remplacent les deux boutons plutôt que de s'y ajouter. Sur mobile le hero n'a pas de
// composer, ce sont les deux boutons (`start_trial`, `explore_library`) qui le remplacent.
export type HeroCta =
    | 'start_trial'
    | 'explore_library'
    | 'mockup'
    | 'video'
    | 'composer'

// A paying customer, or a trial whose end charges a card.
export type CancelFlowPhase = 'paid' | 'trial'

// `oauth` is a sign-in the app ran (Claude's "Get token", Codex's device code), `token` a Claude
// setup-token pasted by hand, `api_key` any provider billed per token.
export type AiConnectionMethod = 'oauth' | 'token' | 'api_key'
// The AI providers panel, the sign-in again of a connection the provider turned away, or the offer
// made over the first install.
export type AiConnectionSurface = 'add_provider' | 'reconnect' | 'subscription_offer'
// `rejected` is the engine or the hub refusing the credential; the others fail in the browser,
// before anything is saved.
export type AiConnectionFailureReason = 'rejected' | 'invalid_token' | 'oauth_exchange_failed' | 'code_expired' | 'device_auth_failed' | 'start_failed'

export type AiConnectionProps = { provider: string; method: AiConnectionMethod; surface: AiConnectionSurface }

export interface AnalyticsEventMap {
    account_created: { method: SignupMethod } & Attribution
    // The card form opening. The lifecycle events below come from the webhook, so this is the only
    // place an abandoned checkout leaves a trace. A trial started without a card never opens it,
    // and is not counted here.
    checkout_started: { plan: string; source: 'template_cta' | 'billing_dialog' | 'agent_share' | 'foreman' | 'pay_now' | 'ai_providers' }
    paywall_viewed: { trigger: string; addon_shown?: string; variant?: string }
    // `origin` is where the trial was started: the app's are all cardless, whatever the test's arm.
    trial_started: SubscriptionLifecycleProps & { trial_type: TrialType; origin?: 'web' | 'ios' }
    trial_converted: SubscriptionLifecycleProps
    trial_payment_failed: SubscriptionLifecycleProps & { invoice_id: string; amount_due: number }
    // A trial ended the second it began, because the card had already spent one elsewhere. Not a
    // fraud verdict: one person with one card and two workspaces lands here too, and is simply
    // billed from day one. The card fingerprint stays out of it, PostHog has no business holding it.
    trial_skipped_card_reused: SubscriptionLifecycleProps
    // A subscription that opens directly on `active`, without a trial. The trial path emits
    // `trial_started` then `trial_converted` instead.
    subscription_started: SubscriptionLifecycleProps
    // `cancellation_comment` is what the customer wrote in the cancel flow, `cancellation_feedback`
    // the reason it was filed under, `cancel_reason_check` whether it read as a reason at all, and
    // `cancel_comeback` the answer to "will you use Rerun again?".
    subscription_cancel_requested: SubscriptionLifecycleProps & {
        cancel_at?: string
        cancellation_reason?: string
        cancellation_feedback?: string
        cancellation_comment?: string
        cancel_comeback?: string
        cancel_reason_check?: string
    }
    subscription_cancelled: SubscriptionLifecycleProps & { cancellation_reason?: string; cancellation_feedback?: string; cancellation_comment?: string }

    // The in-app cancel flow, from the billing dialog. The cancellation itself is reported by the
    // webhook as `subscription_cancel_requested`; these say what happened on the way to it.
    cancel_flow_started: { phase: CancelFlowPhase }
    cancel_flow_abandoned: { phase: CancelFlowPhase; step: string }
    renewal_reminder_requested: { phase: CancelFlowPhase }
    retention_offer_shown: { phase: CancelFlowPhase; reason: string; offer: string }
    retention_offer_accepted: { phase: CancelFlowPhase; reason: string; offer: string }
    retention_offer_declined: { phase: CancelFlowPhase; reason: string; offer: string }
    invoice_paid: SubscriptionLifecycleProps & { invoice_id: string; amount_paid: number; billing_reason?: string }

    // The account gate that replaces the foreman's composer once an anonymous visitor has answered
    // the welcome card. Shown is not clicked: the gap with `signup_started` is the whole drop between
    // a filled card and an account.
    signup_gate_viewed: { surface: SignupSurface }
    signup_started: { surface?: SignupSurface; in_app_browser?: string }
    signup_method_selected: { method: SignupMethod; in_app_browser?: string }
    // A provider sign-in that came back failed. Supabase sends these returns to `/`, not to
    // `/auth/callback`: `bad_oauth_state` is a state older than its five minutes.
    oauth_sign_in_failed: { code: string; provider: SignupMethod | null }
    signup_field_error: { field: string; error_type: string }
    email_verification_sent: Record<string, never>
    // A "Send code" by email that sent nothing, the counterpart of `phone_verification_failed`:
    // `reason` is the server's refusal, `captcha_failed` / `captcha_timeout` for a robot check that
    // turned the visitor away in the browser, `client_error` for what broke before the server answered.
    email_verification_failed: { reason: string; captcha_provider?: CaptchaProvider; captcha_code?: string; in_app_browser?: string; message?: string }
    // Cloudflare could not vouch for a visitor, who was handed the hCaptcha puzzle instead.
    // `turnstile_code` is Cloudflare's client error, or `script` when its script never loaded.
    captcha_puzzle_shown: { turnstile_reason?: string; turnstile_code?: string }
    captcha_puzzle_solved: Record<string, never>
    // `code` is the one typed in the form, `link` the button of the same email.
    email_verification_completed: { via: 'code' | 'link'; delay_seconds?: number }
    // The wall a new account meets once it exists, whichever door it was born through. Viewed is not
    // sent: the gap between the two is the accounts that stop at the phone number.
    phone_wall_viewed: Record<string, never>
    // "Skip for now" on the wall: the account enters without a number, the checklist asks again.
    phone_wall_skipped: Record<string, never>
    // A number given on the wall, kept as typed without a code.
    phone_wall_submitted: { country: string }
    phone_verification_sent: { channel: 'sms' | 'whatsapp'; context: PhoneVerificationContext }
    phone_verification_completed: { channel: 'sms' | 'whatsapp'; context: PhoneVerificationContext }
    // A "Send by…" that sent nothing: `reason` is the server's refusal, or `captcha_timeout`,
    // `captcha_failed`, `client_error` for what broke before it answered. `country` is the one picked
    // in the form. Sent plus failed is every click.
    phone_verification_failed: { channel: 'sms' | 'whatsapp'; context: PhoneVerificationContext; reason: string; country: string; message?: string; captcha_provider?: CaptchaProvider; captcha_code?: string }
    // What Bird says became of a code once it left, from its verify.* webhook. `sent` and `delivered`
    // are per attempt, `undelivered` carries Bird's reason, `failed` means no code got out on any
    // channel, `verified` that the right one came back.
    phone_verification_delivery: { status: PhoneDeliveryStatus; channel?: string; reason?: string; country?: string; context?: string }
    signup_abandoned: { last_step: SignupStep; seconds_spent: number; surface?: SignupSurface; trigger: SignupAbandonTrigger }

    expert_application_submitted: ExpertProps & { expert_type: string }
    expert_invite_sent: ExpertProps & { email_id?: string }
    expert_profile_published: ExpertProps
    expert_invite_declined: ExpertProps

    creator_application_accepted: ExpertProps & { email_id?: string }
    creator_application_rejected: ExpertProps
    creator_sandbox_claimed: ExpertProps
    creator_terms_accepted: ExpertProps

    template_link_opened: { slug: string; has_space: boolean }
    template_import_completed: { slug: string; imported: number; failed: number }
    template_purchase_started: { slug: string; price_kind: string; amount_cents: number }
    template_purchase_completed: { slug: string }

    // Sending an agent to someone by link. `carries_*` is what will say, in a month, whether the
    // safe defaults held or whether everybody turns everything on.
    agent_share_created: { carries_memories: boolean; carries_database: boolean; carries_files: boolean }
    agent_share_opened: { has_account: boolean }
    agent_share_installed: { inactive: boolean }

    // Copying an agent inside its own Box. The two counts say what the copy carries that now runs
    // twice, which is what would make the feature a nuisance rather than a shortcut.
    agent_duplicated: { schedules: number; triggers: number }

    // What the visitor arrived with, read from the link that brought them: a template, a shared agent,
    // a prompt typed in the landing's hero composer, or nothing. Only on the welcome card, never on a
    // return with answers already parked.
    onboarding_started: { mode: 'foreman'; arrival: OnboardingArrival }
    onboarding_step_viewed: { step: string }
    // `via` is only on the plan step, which closes four ways: the plan card confirmed, a template
    // picked on its own card, coworkers hired off the starter pack, or the one coworker they
    // described instead of picking.
    onboarding_step_completed: { step: string; via?: 'plan_card' | 'template' | 'starter_pack' | 'custom' }
    // The chips under a freshly built team: 'open_chat', 'billing', or the label of a request sent to the foreman.
    onboarding_next_step_clicked: { step: string }
    // The board's getting-started checklist. `completed` is server-side, the moment the thing exists;
    // `clicked` is the step handed to the Foreman. Kept apart from `onboarding_step_*`, the funnel's.
    getting_started_step_completed: { step: string }
    getting_started_step_clicked: { step: string }
    // Days added to a running trial, and what earned them.
    trial_extended: { days: number; source: 'getting_started' }
    // The welcome card's submit. `industry` is where the card ended: picked by hand, or decided from
    // their site while they answered.
    onboarding_website_submitted: { provided: boolean; industry?: string }
    // One per site the card read in the background, so it is a success rate of the read, not a count
    // of people: a pause while typing reads the address as it stands.
    onboarding_company_analyzed: { ok: boolean }
    // The interview's first question: how many jobs the foreman offered and how many they took, two
    // and one since the question became a two-button card. `custom` says they wrote their own
    // instead of taking one of the offered jobs, which that card cannot do.
    onboarding_use_cases_selected: { proposed: number; selected: number; custom: boolean }
    // Every two-button card of the interview, however it closed: `picked` a button, `neither` of them,
    // answered by typing in the composer instead, closed, or left open on a reload. `neither` over
    // the total is how often the foreman guessed both answers wrong.
    onboarding_either_answered: { outcome: 'picked' | 'neither' | 'typed' | 'dismissed' | 'abandoned' }
    // Every answer to the plan card, a "Change something" included: the confirmed ones against the
    // others is how many rounds a plan takes. The starter pack answers it once, with `via` and the
    // slugs of the templates `picked` off its cards.
    onboarding_plan_answered: { confirmed: boolean; agents: number; via?: 'starter_pack' | 'custom'; picked?: string[] }
    // The answer to the trial card, for a workspace whose plan was not already on when the plan
    // closed. `reason` is why it did not start: a card that already spent a trial, or the form closed.
    onboarding_checkout_answered: { ok: boolean; reason?: 'trial_refused' | 'dismissed' | 'pending' }
    // The foreman offering to hand a stuck user to the team, and whether they sent it: offered without
    // being sent is someone who kept typing instead, which says whether the offer came too early.
    onboarding_help_answered: { sent: boolean }
    // The build the app runs once the plan is confirmed. `error` is a build that threw before
    // returning anything; `failed` counts the agents that could not be created in a build that did.
    onboarding_team_built: { agents: number; failed: number; error: boolean }
    first_agent_created: { template: string }
    agent_run_started: { agent_id: string }
    // A chat run that ended, captured by the hub when the engine reports it, so it counts whether or
    // not a tab was open: the lead's first run is started by the server. Activation is the first of
    // these for a person; `steps` is what tells a run that did the job from one that said hello.
    agent_run_completed: AgentRunProps
    // `error_type` is the engine's error code server-side. Budget errors are the client's, mid-run or
    // refused before a run existed ('budget_exhausted'), so the hub skips that code; the client also
    // reports a kickoff that failed ('kickoff_error', 'agent_gone').
    agent_run_failed: Partial<AgentRunProps> & { error_type: string }
    // The install an agent built by the foreman, other than the lead, waits on in its chat.
    agent_install_started: { agent_id: string }
    agent_install_skipped: { agent_id: string }

    connection_cta_clicked: { source: string }
    // A workspace's own AI credential saved, which is what `connection_cta_clicked` cannot say. A
    // `reconnect` is the same connection signed in again, so a first connection is the first of
    // these for a person, or any with another surface.
    ai_connection_connected: AiConnectionProps
    // `error` is the message the user was shown, cut short.
    ai_connection_failed: AiConnectionProps & { reason: AiConnectionFailureReason; error?: string }
    ai_connection_disconnected: { provider: string }

    // One row per lifecycle email that actually left, so the funnel can be read against the sends
    // rather than against the Resend dashboard.
    lifecycle_email_sent: { sequence: string; category: string }

    api_key_created: Record<string, never>
    agent_import_prepared: { source: string }

    // L'exposition au test, premier pas de tout funnel découpé par bras.
    experiment_viewed: ExperimentExposure
    // Le prompt est tronqué à la source : c'est du texte libre, et il vaut surtout pour ce qu'il dit
    // des agents que les gens veulent, pas pour sa longueur exacte. Le reste est ce que le composer a
    // lu dans ce prompt, ou la suggestion dont il est parti.
    hero_cta_clicked: { cta: HeroCta; prompt?: string; prompt_length?: number; agent_name?: string; apps_count?: number; scheduled?: boolean; suggestion?: string }
    // Émis une fois par visite. Sans lui on ne sait pas distinguer « le champ n'attire personne » de
    // « le champ attire mais ne convertit pas », deux verdicts opposés sur la même variante.
    hero_composer_engaged: { via: 'typing' | 'suggestion' }
    // La preview jouable du workspace sous le hero. `agent` est l'id de tuile du plateau du tour,
    // stable d'une version à l'autre, pas le nom affiché.
    workspace_preview_agent_opened: { agent: string }
    workspace_preview_hitl_answered: { agent: string; kind: 'question' | 'permission' | 'approval' }
    workspace_preview_cta_clicked: { agent: string }
    workspace_preview_inbox_opened: Record<string, never>
    workspace_preview_foreman_opened: Record<string, never>
    workspace_preview_foreman_asked: { prompt: string }
    workspace_preview_foreman_tab: { tab: 'assistant' | 'routines' }

    // La relance d'un onglet laissé en arrière-plan. `tab_nudge_shown` ne part qu'une fois le titre
    // effectivement en train d'alterner, jamais au montage : c'est le dénominateur, et l'écart avec
    // `tab_nudge_returned` est le nombre d'onglets jamais rouverts, que rien d'autre ne sait compter.
    tab_nudge_shown: { path: string; reduced_motion: boolean }
    // `away_seconds` se mesure sur l'horloge et pas sur les ticks : les timers d'un onglet caché sont
    // clampés à la minute au bout de cinq minutes, les compter donnerait n'importe quoi.
    tab_nudge_returned: { away_seconds: number; nudge_index: number; bar_shown: boolean }
    tab_nudge_cta_clicked: { signed_in: boolean; away_seconds: number }
    // Le signal négatif : une barre fermée à la main dit autre chose qu'une barre ignorée, donc
    // l'auto-masquage n'émet rien.
    tab_nudge_dismissed: { seconds_visible: number }

    // Le panneau d'une template en mode lead magnet, sur un téléphone arrivé droit sur la page. Son
    // clic part dans `template_cta_clicked` avec `placement: 'lead_magnet'`.
    template_lead_magnet_shown: { slug: string }
    template_lead_magnet_dismissed: { slug: string; seconds_visible: number }

    // Paid apps, LinkedIn Pro first. `allowance` says how the account got its slot: a paid one, the
    // workspace trial's, the subscriber's free week. `app_trial_converted` reads the end of that week.
    app_connected: { app: string; allowance: string; reconnect: boolean }
    app_slot_added: { app: string; trial_slot: boolean }
    app_trial_started: { app: string }
    app_trial_converted: { app: string; outcome: 'charged' | 'declined' | 'nothing_to_charge' }
    // A coworker stopped by a daily limit: how often the caps bite, and on what.
    app_quota_hit: { app: string; action: string }
    // One provider event and the coworkers it woke, zero included.
    app_event_fired: { app: string; event: string; woken: number }
}

export type EventName = keyof AnalyticsEventMap
