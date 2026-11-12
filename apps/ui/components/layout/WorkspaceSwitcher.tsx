'use client'

import { accountLabel } from '@/lib/auth/placeholder-email'
import { enterSandboxAction, switchWorkspaceAction } from '@/app/api/_actions/workspace.actions'
import { AccountDialog } from '@/components/dialogs/AccountDialog'
import { AiProvidersDialog } from '@/components/dialogs/AiProvidersDialog'
import { ApiKeysDialog } from '@/components/dialogs/ApiKeysDialog'
import { ServersDialog } from '@/components/dialogs/ServersDialog'
import { ChatAppsConnectedHint } from '@/components/chat-apps/ChatAppsConnectedHint'
import { ChatAppsDialog } from '@/components/dialogs/ChatAppsDialog'
import { CoworkerPresetsDialog } from '@/components/presets/CoworkerPresetsDialog'
import { ADMIN_URL } from '@rerun/cloud/admin'
import { RERUN_CLOUD } from '@rerun/cloud/edition'
import { SERVERS_ENABLED } from '@rerun/cloud/servers'
import { CreateWorkspaceDialog } from '@/components/dialogs/CreateWorkspaceDialog'
import { CreditMeter, UpgradePill } from '@rerun/cloud/billing.client'
import { ExpertProfileDialog } from '@/components/dialogs/ExpertProfileDialog'
import { KnowledgeBaseDialog } from '@/components/dialogs/KnowledgeBaseDialog'
import { PaidAppDialogs, usePaidAppsStore, AppsMenuSection } from '@rerun/cloud/apps.client'
import { useEnabledPaidApps } from '@/components/layout/FeatureFlagsProvider'
import { WorkspaceMembersDialog } from '@/components/dialogs/WorkspaceMembersDialog'
import { WorkspaceSettingsDialog } from '@/components/dialogs/WorkspaceSettingsDialog'
import { SignInPillButton } from '@/components/layout/SignInPill'
import { ThemeMenuRow } from '@/components/layout/ThemeMenuRow'
import { HelpButton } from '@/components/layout/HelpButton'
import { WeeklyRewindMenuItem, WhatsNewMenuItem } from '@/components/layout/ToolbarActions'
import { WorkspacePowerDialog, WorkspacePowerMenuItems, type PowerAction } from '@/components/layout/WorkspacePowerControl'
import { WorkspaceLogoImage, WorkspacePill } from '@rerun/ui/chrome'
import { Badge } from '@rerun/ui/primitives'
import { TooltipDisabledReason } from '@/components/ui/tooltip'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { activeAgentLimitFor, BILLING_ENABLED, isWorkspaceApiEntitled } from '@rerun/cloud/billing'
import { useBrainProposalCount } from '@/hooks/useBrainProposalCount'
import { useIsAdmin } from '@/hooks/useIsAdmin'
import { useIsTemplateAuthor } from '@/hooks/useIsTemplateAuthor'
import { useRerunCredit } from '@/hooks/useRerunCredit'
import { useAccountStore } from '@/stores/account.store'
import { useBillingStore } from '@/stores/billing.store'
import { useCreatorStore } from '@/stores/creator.store'
import { useBrainStore } from '@/stores/brain.store'
import { useForemanStore } from '@/stores/foreman.store'
import { useNotificationsStore } from '@/stores/notifications.store'
import { useWorkspaceSettingsStore } from '@/stores/workspace-settings.store'
import { useIsWorkspaceAdmin, useSession } from '@/supabase/session/SessionProvider'
import { BadgeCheck, BellIcon, BrainIcon, CheckIcon, CreditCardIcon, FlaskConical, GaugeIcon, GridIcon, IdCardIcon, KeyIcon, LayersIcon, Loader2Icon, LockKeyholeIcon, LogOutIcon, MessagesSquare, PlusIcon, ServerIcon, SettingsIcon, ShieldCheckIcon, StoreIcon, UserRoundIcon, UsersIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { abortWorkspaceSwitch, beginWorkspaceSwitch, enterActiveWorkspace } from '@/lib/workspace/workspace-switch'
import Link from 'next/link'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'

const PRICING_ICONS = ['/pricing/solo.png', '/pricing/team.png', '/pricing/scale.png']

type SessionWorkspace = NonNullable<ReturnType<typeof useSession>['workspace']>

// A menu entry an admin uses and a member sees, disabled, with the reason on hover.
function AdminOnly({ allowed, reason, className = 'flex w-full', children }: { allowed: boolean; reason: string; className?: string; children: ReactNode }) {
    if (allowed) return <>{children}</>
    return (
        <TooltipDisabledReason reason={reason} side="right" className={className}>
            {children}
        </TooltipDisabledReason>
    )
}

function workspaceSummary(workspace: SessionWorkspace): string {
    if (workspace.is_sandbox) return 'Expert sandbox'
    const trialing = workspace.subscription_status === 'trialing'
    const agents = trialing ? activeAgentLimitFor(workspace.max_agents, workspace.subscription_status) : workspace.max_agents
    const seats = workspace.max_seats == null ? 'unlimited seats' : `${workspace.max_seats} ${workspace.max_seats === 1 ? 'seat' : 'seats'}`
    const limits = `${agents ?? 'unlimited'} coworkers · ${seats}`
    return trialing ? `Trial · ${limits}` : limits
}

export function WorkspaceSwitcher() {
    const { user, workspace, workspaces, session, isAnonymous, signOut } = useSession()
    const openBilling = useBillingStore(s => s.openBilling)
    const paidApps = useEnabledPaidApps()
    const openApp = usePaidAppsStore(s => s.openApp)
    const appAccounts = usePaidAppsStore(s => s.accountCounts)
    const appsRevision = usePaidAppsStore(s => s.revision)
    const refreshAppAccounts = usePaidAppsStore(s => s.refreshAccountCount)
    const openAccount = useAccountStore(s => s.openAccount)
    const isAdmin = useIsAdmin()
    const workspaceAdmin = useIsWorkspaceAdmin()
    const isTemplateAuthor = useIsTemplateAuthor()
    // In a store rather than here: the return from Stripe's hosted onboarding lands on the home
    // page and has to reopen this panel on its payouts pane.
    const openCreator = useCreatorStore(s => s.openCreator)
    const setCreateTemplateOpen = useCreatorStore(s => s.setCreateOpen)
    // Held in a store rather than here: the foreman opens these three panels too, from a chat that
    // does not own this menu.
    const panel = useWorkspaceSettingsStore(s => s.panel)
    const openWorkspacePanel = useWorkspaceSettingsStore(s => s.openWorkspacePanel)
    const setPanel = useWorkspaceSettingsStore(s => s.setPanel)
    const [serversOpen, setServersOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [entering, setEntering] = useState(false)
    const [createOpen, setCreateOpen] = useState(false)
    // The team invite email links straight to this dialog. Read rather than mirrored into state, and
    // closing drops the param so a refresh does not reopen it.
    const searchParams = useSearchParams()
    const router = useRouter()
    const pathname = usePathname()
    const membersLinked = searchParams.get('members') === '1'
    const [profileOpen, setProfileOpen] = useState(false)
    // The confirmation cannot live inside the menu: closing the menu would unmount it before it
    // ever opens.
    const [powerAction, setPowerAction] = useState<PowerAction | null>(null)
    const refreshBrainProposals = useBrainStore(s => s.refreshProposalCount)
    const brainProposals = useBrainProposalCount(Boolean(workspace) && !isAnonymous)
    const guided = useForemanStore(state => state.funnel === 'guided')
    const credit = useRerunCredit()

    // An app joins the Apps section of the menu with its first account: counted on mount and again
    // each time a dialog connects or removes one.
    const sandbox = workspace?.is_sandbox ?? true
    useEffect(() => {
        if (sandbox) return
        for (const slug of paidApps) refreshAppAccounts(slug).catch(() => {})
    }, [paidApps, sandbox, appsRevision, refreshAppAccounts])
    const appsInMenu = paidApps.filter(slug => (appAccounts[slug] ?? 0) > 0)

    if (!workspace) return null

    // A returning user on a fresh browser lands here anonymous: an empty board under "My workspace"
    // reads as a lost account, so this corner is where the way back in sits. On a phone the funnel's
    // sheet cannot be closed and carries its own sign-in, so the pill would only crowd the board.
    if (isAnonymous) {
        return (
            <div className={cn('absolute top-4 left-4 z-40', guided && 'max-md:hidden')}>
                <SignInPillButton />
            </div>
        )
    }

    const isExpert = user?.account_role === 'expert'
    const apiEntitled = isWorkspaceApiEntitled(workspace)
    const regular = workspaces.filter(w => !w.is_sandbox)
    const email = accountLabel(session?.user?.email)

    const sorted = [...regular].sort((a, b) => a.id - b.id)
    const activeIndex = Math.max(0, sorted.findIndex(w => w.id === workspace.id))
    const activeIcon = PRICING_ICONS[activeIndex % PRICING_ICONS.length]

    async function handleSwitch(workspaceId: number) {
        if (busy || workspaceId === workspace?.id) return
        setBusy(true)
        beginWorkspaceSwitch()
        const result = await switchWorkspaceAction(workspaceId)
        if (result.ok) return enterActiveWorkspace()
        abortWorkspaceSwitch()
        toast.error(result.error)
        setBusy(false)
    }

    // Toujours par enterSandboxAction, jamais un simple switch même quand le sandbox existe déjà :
    // l'action est un get-or-create qui réattribue aussi un engine au sandbox qui n'en a pas. Si le
    // pool est vide, elle échoue sans basculer — on reste sur le workspace courant.
    async function handleEnterSandbox() {
        if (busy || entering) return
        setEntering(true)
        beginWorkspaceSwitch()
        const result = await enterSandboxAction()
        if (result.ok) return enterActiveWorkspace()
        abortWorkspaceSwitch()
        toast.error(result.error)
        setEntering(false)
    }

    const trialing = workspace.subscription_status === 'trialing'
    const showCredit = !workspace.is_sandbox && credit.budgetMicros > 0 && workspace.subscription_status !== 'past_due'

    const apiKeysItem = (
        <AdminOnly allowed={workspaceAdmin} reason="Only an admin can manage API keys">
            <DropdownMenuItem disabled={!workspaceAdmin} onSelect={() => (apiEntitled ? openWorkspacePanel('api_keys') : openBilling(undefined, 'api_keys'))} className="gap-2 text-muted-foreground">
                <KeyIcon className="size-4" />
                API keys & MCP
                {!apiEntitled && (
                    <Badge size="xs" tone="brand" glow={false} className="ml-auto font-medium">
                        PRO
                    </Badge>
                )}
            </DropdownMenuItem>
        </AdminOnly>
    )

    // A sandbox has no settings, members nor billing of its own, but it runs on a machine of its own,
    // so it keeps its providers, its knowledge base and the API key the template tools require.
    const headerSection = (
        <div className="flex flex-col gap-2.5 p-1.5">
            <div className="flex items-center gap-2.5">
                <WorkspaceLogoImage src={workspace.icon_url || activeIcon} fallbackSrc={activeIcon} className="size-8 shrink-0 rounded-full object-cover" />
                <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-foreground">{workspace.name || 'Workspace'}</div>
                    <div className="truncate text-xs text-muted-foreground">{workspaceSummary(workspace)}</div>
                </div>
            </div>
            {showCredit && (
                <CreditMeter
                    usedMicros={credit.usedMicros}
                    wholeMicros={credit.budgetMicros}
                    trial={trialing}
                    onOpen={() => (workspaceAdmin ? openBilling(undefined, 'workspace_menu') : undefined)}
                    onAdd={workspaceAdmin ? () => openBilling(trialing ? undefined : 'credit_pack', 'workspace_menu') : undefined}
                />
            )}
            {!workspace.is_sandbox && (
                <div className="flex gap-1.5">
                    <AdminOnly allowed={workspaceAdmin} reason="Only an admin can change the workspace settings" className="flex flex-1">
                        <DropdownMenuItem disabled={!workspaceAdmin} onSelect={() => openWorkspacePanel('workspace')} className="h-7 flex-1 justify-center gap-1.5 rounded-md border border-border text-xs text-foreground">
                            <SettingsIcon className="size-3.5" />
                            Settings
                        </DropdownMenuItem>
                    </AdminOnly>
                    <DropdownMenuItem onSelect={() => openWorkspacePanel('members')} className="h-7 flex-1 justify-center gap-1.5 rounded-md border border-border text-xs text-foreground">
                        <UsersIcon className="size-3.5" />
                        Members
                    </DropdownMenuItem>
                </div>
            )}
        </div>
    )

    const workspaceItemsSection = (
        <>
            <DropdownMenuItem onSelect={() => openWorkspacePanel('knowledge_base')} className="gap-2 text-muted-foreground">
                <BrainIcon className="size-4" />
                Brain
                {brainProposals > 0 && (
                    <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] text-white tabular-nums" aria-label={`${brainProposals} proposals to review`}>
                        {brainProposals}
                    </span>
                )}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openWorkspacePanel('ai_providers')} className="gap-2 text-muted-foreground">
                <LockKeyholeIcon className="size-4" />
                AI providers
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openWorkspacePanel('chat_apps')} className="gap-2 text-muted-foreground">
                <MessagesSquare className="size-4" />
                Chat apps
                <ChatAppsConnectedHint />
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openWorkspacePanel('coworker_presets')} className="gap-2 text-muted-foreground">
                <StoreIcon className="size-4" />
                Coworkers Store
            </DropdownMenuItem>
            {apiKeysItem}
            {SERVERS_ENABLED && (
                <AdminOnly allowed={workspaceAdmin} reason="Only an admin can manage servers">
                    <DropdownMenuItem disabled={!workspaceAdmin} onSelect={() => setServersOpen(true)} className="gap-2 text-muted-foreground">
                        <ServerIcon className="size-4" />
                        Servers
                    </DropdownMenuItem>
                </AdminOnly>
            )}
            {BILLING_ENABLED && !workspace.is_sandbox && (
                <AdminOnly allowed={workspaceAdmin} reason="Only an admin can manage billing">
                    <DropdownMenuItem disabled={!workspaceAdmin} onSelect={() => openBilling()} className="gap-2 text-muted-foreground">
                        <CreditCardIcon className="size-4" />
                        Billing
                    </DropdownMenuItem>
                </AdminOnly>
            )}
            <WhatsNewMenuItem />
            <WeeklyRewindMenuItem />
            {!workspace.is_sandbox && appsInMenu.length > 0 && <AppsMenuSection apps={appsInMenu} onOpen={slug => openApp(slug)} />}
        </>
    )

    const workspacesSection = (
        <>
            {email && <DropdownMenuLabel className="truncate pl-7.5 text-xs font-normal text-muted-foreground">{email}</DropdownMenuLabel>}
            {sorted.map((w, index) => {
                const active = w.id === workspace.id
                const fallbackIcon = PRICING_ICONS[index % PRICING_ICONS.length]
                return (
                    <DropdownMenuItem key={w.id} disabled={busy} onSelect={() => handleSwitch(w.id)} className={cn('gap-2', !active && 'text-muted-foreground')}>
                        <WorkspaceLogoImage src={w.icon_url || fallbackIcon} fallbackSrc={fallbackIcon} className="size-5 shrink-0 rounded-full object-cover" />
                        <span className="flex-1 truncate">{w.name || 'Workspace'}</span>
                        {active && <CheckIcon className="size-4" />}
                    </DropdownMenuItem>
                )
            })}
            <DropdownMenuItem onSelect={() => setCreateOpen(true)} className="gap-2 text-muted-foreground">
                <PlusIcon className="size-4" />
                New workspace
            </DropdownMenuItem>
        </>
    )

    const templatesMenu = isTemplateAuthor && (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2 text-muted-foreground">
                <LayersIcon className="size-4" />
                Templates
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-48">
                <DropdownMenuItem onSelect={() => openCreator()} className="gap-2 text-muted-foreground">
                    <GridIcon className="size-4" />
                    My templates
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setCreateTemplateOpen(true)} className="gap-2 text-muted-foreground">
                    <PlusIcon className="size-4" />
                    New template
                </DropdownMenuItem>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    )

    const expertMenu = isExpert && (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger className={cn('gap-2', workspace.is_sandbox ? 'text-primary' : 'text-muted-foreground')}>
                <BadgeCheck className="size-4" />
                Expert
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-48">
                <DropdownMenuItem
                    disabled={entering || workspace.is_sandbox}
                    onSelect={() => handleEnterSandbox()}
                    className={cn('gap-2', workspace.is_sandbox ? 'text-primary' : 'text-primary/90 focus:text-primary')}
                >
                    {entering ? <Loader2Icon className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}
                    <span className="flex-1">{entering ? 'Preparing sandbox…' : 'Sandbox'}</span>
                </DropdownMenuItem>
                {user?.expert_profile_id && (
                    <DropdownMenuItem onSelect={() => setProfileOpen(true)} className="gap-2 text-muted-foreground">
                        <IdCardIcon className="size-4" />
                        Public profile
                    </DropdownMenuItem>
                )}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    )

    // The admin panel and the machine controls belong to Rerun Cloud; a self-hosted install has neither.
    const adminMenu = RERUN_CLOUD && isAdmin && (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2 text-muted-foreground">
                <ShieldCheckIcon className="size-4" />
                Admin
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-48">
                <DropdownMenuItem asChild className="gap-2 text-muted-foreground">
                    <Link href={`${ADMIN_URL}/admin`}>
                        <GaugeIcon className="size-4" />
                        Admin panel
                    </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <WorkspacePowerMenuItems onPick={setPowerAction} />
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    )

    const rolesSection = (templatesMenu || expertMenu || adminMenu) && (
        <>
            {templatesMenu}
            {expertMenu}
            {adminMenu}
        </>
    )

    const footerSection = (
        <>
            <ThemeMenuRow />
            <DropdownMenuItem onSelect={() => useNotificationsStore.getState().openNotifications()} className="gap-2 text-muted-foreground">
                <BellIcon className="size-4" />
                Notifications
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openAccount()} className="gap-2 text-muted-foreground">
                <UserRoundIcon className="size-4" />
                Account
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={signOut} className="gap-2 text-muted-foreground">
                <LogOutIcon className="size-4" />
                Sign out
            </DropdownMenuItem>
        </>
    )

    // From the workspace and what runs on it, to switching away from it, to the person using it.
    const sections = [headerSection, workspaceItemsSection, workspacesSection, rolesSection, footerSection].filter(Boolean)

    return (
        // Leaves room for the view controls in the top-right corner: on a phone the workspace name
        // truncates rather than pushing the row under them.
        <div className="absolute top-4 left-4 z-40 flex max-w-[calc(100%-2*var(--chrome-edge)-var(--chrome-size)-var(--chrome-gap))] items-center gap-2">
            <DropdownMenu
                onOpenChange={open => {
                    if (!open) return
                    void refreshBrainProposals()
                    if (!workspace.is_sandbox) for (const slug of paidApps) refreshAppAccounts(slug).catch(() => {})
                }}
            >
                <div className="relative min-w-0">
                    <DropdownMenuTrigger asChild>
                        <WorkspacePill className="max-w-full shrink" name={workspace.name || 'Workspace'} iconUrl={workspace.icon_url || activeIcon} fallbackIconUrl={activeIcon} stripes={workspace.is_sandbox} />
                    </DropdownMenuTrigger>
                    {brainProposals > 0 && <span className="pointer-events-none absolute top-0.5 right-0.5 size-2 rounded-full bg-red-500 ring-2 ring-card" />}
                </div>
                <DropdownMenuContent
                    align="start"
                    side="bottom"
                    className="w-64 max-h-[calc(100dvh-5rem)] overflow-y-auto"
                >
                    {sections.map((section, index) => (
                        <Fragment key={index}>
                            {index > 0 && <DropdownMenuSeparator />}
                            {section}
                        </Fragment>
                    ))}
                </DropdownMenuContent>
            </DropdownMenu>
            <HelpButton />
            <UpgradePill />

            <AccountDialog />
            <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
            <WorkspaceSettingsDialog open={panel === 'workspace'} onOpenChange={open => setPanel(open ? 'workspace' : null)} fallbackIconUrl={activeIcon} />
            <WorkspaceMembersDialog
                open={panel === 'members' || membersLinked}
                onOpenChange={open => {
                    setPanel(open ? 'members' : null)
                    if (!open && membersLinked) router.replace(pathname, { scroll: false })
                }}
            />
            <ApiKeysDialog open={panel === 'api_keys'} onOpenChange={open => setPanel(open ? 'api_keys' : null)} />
            {SERVERS_ENABLED && <ServersDialog open={serversOpen} onOpenChange={setServersOpen} />}
            <AiProvidersDialog open={panel === 'ai_providers'} onOpenChange={open => setPanel(open ? 'ai_providers' : null)} />
            <ChatAppsDialog open={panel === 'chat_apps'} onOpenChange={open => setPanel(open ? 'chat_apps' : null)} />
            <CoworkerPresetsDialog open={panel === 'coworker_presets'} onOpenChange={open => setPanel(open ? 'coworker_presets' : null)} />
            <KnowledgeBaseDialog open={panel === 'knowledge_base'} onOpenChange={open => setPanel(open ? 'knowledge_base' : null)} />
            <PaidAppDialogs apps={paidApps} />
            <WorkspacePowerDialog action={powerAction} onOpenChange={open => setPowerAction(open ? powerAction : null)} />
            {isExpert && <ExpertProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />}
        </div>
    )
}
