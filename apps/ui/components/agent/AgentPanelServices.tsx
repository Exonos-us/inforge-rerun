'use client'

import { parseServiceRegistryKey } from '@rerun/contracts'

import { getServiceAlternativesAction, getServiceDetailsAction, installServiceAction, listCatalogServicesAction, resetServiceConnectionAction, searchServicesAction, uninstallServiceAction } from '@/app/api/_actions/services.actions'
import { enableGlobalAppAction, listGlobalOptionsForSlugAction } from '@/app/api/_actions/global-apps.actions'
import { getAgentDetailAction, patchAgentMcpServersAction } from '@/app/api/_actions/agent.actions'
import { GlobalAccountOffer } from '@/components/global-apps/GlobalAccountOffer'
import { listAgentConnectorsAction, removeCustomMcpServerAction } from '@/app/api/_actions/custom-mcp.actions'
import { McpOAuthAuthorize } from '@/components/agent/McpOAuthAuthorize'
import { McpServerEditor } from '@/components/agent/McpServerEditor'
import { CustomMcpRow } from '@/components/services/CustomMcpRow'
import { openPendingSignInPopup } from '@/components/services/sign-in-popup'
import { setConnectorServices } from '@/hooks/useConnectorServices'
import { refreshMcpServerStatuses, useMcpServerStatuses } from '@/hooks/useMcpServerStatuses'
import type { EngineMcpServer } from '@/lib/engine/types'
import { PanelDeleteButton, PanelEditorBody, PanelEditorHeader, PanelEditorShell } from '@/components/ui/panel-editor'
import { PanelSteps } from '@/components/ui/panel-steps'
import { RequestConnectorDialog } from '@/components/services/RequestConnectorDialog'
import { ServiceAlternatives } from '@/components/services/ServiceAlternatives'
import { ServiceConfigForm } from '@/components/services/ServiceConfigForm'
import { ServiceList } from '@/components/services/ServiceList'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { HScrollFade } from '@rerun/ui/primitives'
import { Icon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { TooltipDisabledReason, TooltipLabeled } from '@/components/ui/tooltip'
import { useCanManageAgent } from '@/hooks/useBoxAccess'
import { BOX_MANAGE_REASON } from '@/lib/board/box-access'
import { serviceIconProps } from '@/lib/services/icons'
import { SERVICE_CATEGORIES, SERVICE_CATEGORY_LABELS, type ServiceCategory } from '@/lib/services/manifest'
import { MAX_OFFERED_ALTERNATIVES } from '@/lib/services/alternatives'
import type { AppTarget, AuthMethodSummary, ComposioTarget, CustomMcpServer, GlobalAppOption, InstalledService, ManagedTarget, OAuthTarget, ServiceAlternative, ServiceDetails, ServiceSearchResult } from '@/lib/services/types'
import { Badge } from '@rerun/ui/primitives'
import { AlertTriangleIcon, Loader2Icon, RefreshCwIcon } from '@/lib/icons'
import { PanelList, PanelScroller, PanelSection } from '@/components/ui/panel-list'
import { PanelRow } from '@/components/ui/panel-row'
import { SkeletonPanelRows } from '@/components/ui/skeleton'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type AgentPanelServicesProps = {
    agentId: string
}

type AuthTargets = { oauth?: OAuthTarget; managed?: ManagedTarget; composio?: ComposioTarget; app?: AppTarget }

type SetupTarget = {
    slug: string
    // The account being set up; absent while a new account has not been allocated yet.
    key?: string
    newInstance?: boolean
    name: string
    category: string
    icon: string | null
    authMethods: AuthMethodSummary[]
    initialMethodId?: string
    initialAuthTarget?: AuthTargets
    alternatives: ServiceAlternative[]
}

// A custom server is edited where it is listed, with the same editor as the MCP tab. The sign-in
// window opens inside the Connect click, before anything is fetched, or the browser blocks it.
type CustomStep = { kind: 'connect'; server: CustomMcpServer; popup: Window | null } | { kind: 'edit'; server: EngineMcpServer }

function pendingAuthTarget(targets: AuthTargets): AuthTargets | undefined {
    return targets.oauth || targets.managed || targets.composio || targets.app ? { oauth: targets.oauth, managed: targets.managed, composio: targets.composio, app: targets.app } : undefined
}

function toSetupTarget(details: ServiceDetails, icon: string | null, alternatives: ServiceAlternative[]): SetupTarget {
    return {
        slug: details.slug,
        key: details.key,
        name: details.name,
        category: details.category,
        icon,
        authMethods: details.authMethods,
        initialMethodId: details.installedMethodId,
        initialAuthTarget: details.installStatus === 'needs_auth' ? pendingAuthTarget(details) : undefined,
        alternatives,
    }
}

const STATUS_RANK: Record<InstalledService['status'], number> = { active: 0, needs_auth: 1, needs_config: 2, error: 3 }

// One status per app for the library tiles: the base account's, else the best account left.
function statusByApp(installed: InstalledService[]): Map<string, InstalledService['status']> {
    const statuses = new Map<string, InstalledService['status']>()
    for (const s of installed) {
        const current = statuses.get(s.slug)
        if (s.key === s.slug || current === undefined || (!installed.some(o => o.key === s.slug) && STATUS_RANK[s.status] < STATUS_RANK[current])) statuses.set(s.slug, s.status)
    }
    return statuses
}

// Browse page size for the paginated catalog. Matches the server default; a full page back
// means there may be more, so infinite scroll keeps going.
const BROWSE_PAGE_SIZE = 60

// Services tab: browse the library and manage installed services. Reuses the exact
// same ServiceConfigForm shown inline in chat, so config is identical on both sides.
export function AgentPanelServices({ agentId }: AgentPanelServicesProps) {
    const [installed, setInstalled] = useState<InstalledService[]>([])
    const [custom, setCustom] = useState<CustomMcpServer[]>([])
    const [customStep, setCustomStep] = useState<CustomStep | null>(null)
    const { statuses: customStatuses, loading: customStatusesLoading } = useMcpServerStatuses(agentId)
    const [selectedCategory, setSelectedCategory] = useState<ServiceCategory | null>(null)
    const [query, setQuery] = useState('')
    const [debouncedQuery, setDebouncedQuery] = useState('')
    const [loading, setLoading] = useState(true)
    const [setupTarget, setSetupTarget] = useState<SetupTarget | null>(null)
    // A workspace account exists for the app being installed: the user picks it or signs in anyway.
    const [globalOffer, setGlobalOffer] = useState<{ target: SetupTarget; options: GlobalAppOption[] } | null>(null)
    const [enablingGlobal, setEnablingGlobal] = useState<string | null>(null)
    const [swapping, setSwapping] = useState<string | null>(null)
    const [swapError, setSwapError] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [reconnecting, setReconnecting] = useState<string | null>(null)
    const canManage = useCanManageAgent(agentId)
    const manageReason = canManage ? undefined : BOX_MANAGE_REASON

    // Paginated browse accumulation (empty query). A ref tracks server rows fetched so
    // client-side dedup can't drift the offset, and a ref guard blocks the concurrent calls a
    // fast scroll or observer re-fire would otherwise make.
    const [browseServices, setBrowseServices] = useState<ServiceSearchResult[]>([])
    const [browseHasMore, setBrowseHasMore] = useState(true)
    const [browseLoading, setBrowseLoading] = useState(false)
    const browseOffsetRef = useRef(0)
    const browseLoadingRef = useRef(false)
    const sentinelRef = useRef<HTMLDivElement | null>(null)

    // Ranked search results (non-empty query) — bounded, flat, no infinite scroll.
    const [searchResults, setSearchResults] = useState<ServiceSearchResult[]>([])
    const [searching, setSearching] = useState(false)

    const isSearchActive = query.trim().length > 0
    // True while a query is typed but its results aren't ready yet — covers both the debounce
    // window and the in-flight semantic search, so the skeleton shows immediately.
    const searchLoading = isSearchActive && (searching || query.trim() !== debouncedQuery.trim())

    // Semantic search embeds the query, so debounce keystrokes to avoid one call each.
    useEffect(() => {
        const id = setTimeout(() => setDebouncedQuery(query), 300)
        return () => clearTimeout(id)
    }, [query])

    const loadMoreBrowse = useCallback(async () => {
        if (browseLoadingRef.current || !browseHasMore) return
        browseLoadingRef.current = true
        setBrowseLoading(true)
        const offset = browseOffsetRef.current
        const page = await listCatalogServicesAction({ limit: BROWSE_PAGE_SIZE, offset, category: selectedCategory ?? undefined })
        browseOffsetRef.current = offset + page.length
        setBrowseServices(prev => {
            const seen = new Set(prev.map(s => s.slug))
            return [...prev, ...page.filter(s => !seen.has(s.slug))]
        })
        setBrowseHasMore(page.length === BROWSE_PAGE_SIZE)
        setBrowseLoading(false)
        browseLoadingRef.current = false
    }, [browseHasMore, selectedCategory])

    const resetBrowse = useCallback(() => {
        browseOffsetRef.current = 0
        setBrowseServices([])
        setBrowseHasMore(true)
    }, [])

    // Reload the installed section and re-seed the first browse page. Called on mount and after
    // any (un)install so the "Installed" badge on browse tiles stays coherent.
    const load = useCallback(async () => {
        setLoading(true)
        const { services, custom: customServers } = await listAgentConnectorsAction(agentId)
        setInstalled(services)
        setCustom(customServers)
        resetBrowse()
        setLoading(false)
        setConnectorServices(agentId, services, customServers)
    }, [agentId, resetBrowse])

    useEffect(() => {
        load()
    }, [load])

    // Seed the first browse page once the initial load has cleared it.
    useEffect(() => {
        if (isSearchActive) return
        if (browseServices.length === 0) loadMoreBrowse()
    }, [isSearchActive, browseServices.length, loadMoreBrowse])

    // Changing the category filter restarts the browse from an empty set, which the seed effect
    // above then re-fetches with the new category.
    useEffect(() => {
        resetBrowse()
    }, [selectedCategory, resetBrowse])

    // Run the ranked search when a query is active; annulable so a stale response can't clobber
    // a newer one.
    useEffect(() => {
        const q = debouncedQuery.trim()
        if (!q) {
            setSearchResults([])
            setSearching(false)
            return
        }
        let active = true
        setSearching(true)
        searchServicesAction(agentId, q, selectedCategory ?? undefined).then(results => {
            if (!active) return
            setSearchResults(results)
            setSearching(false)
        })
        return () => {
            active = false
        }
    }, [agentId, debouncedQuery, selectedCategory])

    // The tail of an install: a single method with no fields installs straight away (OAuth
    // sign-in or skill-only) and lands on Connect when it returns needs_auth; anything with
    // fields or a choice of methods opens the config form.
    const openSetup = useCallback(
        async (target: SetupTarget) => {
            const single = target.authMethods.length === 1 ? target.authMethods[0] : null
            if (single && single.inputs.length === 0) {
                const res = await installServiceAction(agentId, target.key ?? target.slug, {}, single.id)
                if (res.ok && res.result.status === 'needs_auth') {
                    setSetupTarget({ ...target, initialAuthTarget: pendingAuthTarget(res.result) })
                    return
                }
                await load()
                return
            }
            setSetupTarget(target)
        },
        [agentId, load],
    )

    const onInstall = useCallback(
        async (key: string, authTarget?: AuthTargets) => {
            const { slug } = parseServiceRegistryKey(key)
            const [details, alternatives, globalRes] = await Promise.all([getServiceDetailsAction(agentId, key), getServiceAlternativesAction([slug]), listGlobalOptionsForSlugAction({ slug })])
            if (!details) return
            const icon = [...installed, ...browseServices, ...searchResults].find(s => s.slug === slug)?.icon ?? null
            const target = { ...toSetupTarget(details, icon, alternatives[slug] ?? []), ...(authTarget ? { initialAuthTarget: authTarget } : {}) }
            setSwapError(null)
            // Already compiled and only waiting on the sign-in → the form opens straight on
            // Connect rather than recompiling the service to rediscover a target we already hold.
            if (target.initialAuthTarget) {
                setSetupTarget(target)
                return
            }
            // The workspace holds this app: offer its accounts before any per-coworker sign-in.
            // Never on an app the coworker already set up, where the click means "finish it".
            const workspaceAccounts = globalRes.ok ? globalRes.options.filter(option => option.status === 'connected') : []
            if (workspaceAccounts.length > 0 && !installed.some(s => s.slug === slug)) {
                setGlobalOffer({ target, options: workspaceAccounts })
                return
            }
            await openSetup(target)
        },
        [agentId, openSetup, installed, browseServices, searchResults],
    )

    // Same shortcut as onInstall, except the install allocates a fresh account instead of
    // reopening the one the coworker already holds.
    const onAddAccount = useCallback(
        async (slug: string) => {
            const details = await getServiceDetailsAction(agentId, slug)
            if (!details) return
            const icon = [...installed, ...browseServices, ...searchResults].find(s => s.slug === slug)?.icon ?? null
            const target: SetupTarget = { ...toSetupTarget(details, icon, []), key: undefined, newInstance: true, initialAuthTarget: undefined }
            setSwapError(null)
            const single = details.authMethods.length === 1 ? details.authMethods[0] : null
            if (single && single.inputs.length === 0) {
                const res = await installServiceAction(agentId, slug, {}, single.id, { newInstance: true })
                if (res.ok && res.result.status === 'needs_auth') {
                    setSetupTarget({ ...target, key: res.result.key, newInstance: false, initialAuthTarget: pendingAuthTarget(res.result) })
                    return
                }
                if (!res.ok) setError(res.error)
                await load()
                return
            }
            setSetupTarget(target)
        },
        [agentId, load, installed, browseServices, searchResults],
    )


    // Clear the stored sign-in, then hand over to onInstall: the entry now reads needs_auth, so
    // it lands straight on Connect without recompiling anything. A paid app still bound to an
    // account stays active, so its picker is opened explicitly.
    const onReconnect = useCallback(
        async (key: string) => {
            setError(null)
            setReconnecting(key)
            const res = await resetServiceConnectionAction(agentId, key)
            setReconnecting(null)
            if (!res.ok) {
                setError(res.error)
                return
            }
            await onInstall(key, res.result.mode === 'auth' && res.result.app ? { app: res.result.app } : undefined)
            await load()
        },
        [agentId, onInstall, load],
    )

    const onUninstall = useCallback(
        async (key: string) => {
            setError(null)
            const res = await uninstallServiceAction(agentId, key)
            if (!res.success) setError(res.error ?? 'Failed to uninstall app')
            await load()
        },
        [agentId, load],
    )

    const afterCustomChange = useCallback(async () => {
        setCustomStep(null)
        refreshMcpServerStatuses(agentId)
        await load()
    }, [agentId, load])

    const onRemoveCustom = useCallback(
        async (name: string) => {
            setError(null)
            const res = await removeCustomMcpServerAction(agentId, name)
            if (!res.success) setError(res.error ?? 'Failed to remove the server')
            await afterCustomChange()
        },
        [agentId, afterCustomChange],
    )

    const onEditCustom = useCallback(
        async (name: string) => {
            setError(null)
            const server = (await getAgentDetailAction(agentId))?.config.mcpServers?.find(s => s.name === name)
            if (server) setCustomStep({ kind: 'edit', server: server as EngineMcpServer })
            else setError('Could not load this server from the engine.')
        },
        [agentId],
    )

    const swapTo = async (alternative: ServiceAlternative) => {
        if (!setupTarget || swapping) return
        setSwapping(alternative.slug)
        setSwapError(null)
        const details = await getServiceDetailsAction(agentId, alternative.slug)
        setSwapping(null)
        if (!details || details.authMethods.length === 0) {
            setSwapError(`${alternative.name} could not be loaded.`)
            return
        }
        const current: ServiceAlternative = { slug: setupTarget.slug, name: setupTarget.name, category: setupTarget.category, icon: setupTarget.icon }
        setSetupTarget(toSetupTarget(details, alternative.icon, [current, ...setupTarget.alternatives.filter(a => a.slug !== alternative.slug)].slice(0, MAX_OFFERED_ALTERNATIVES)))
    }

    // Browse pages come back agent-less (never installed), so mark them from the separately
    // loaded installed set. Search results already carry the correct status.
    const statusBySlug = useMemo(() => statusByApp(installed), [installed])
    const browseWithInstalled = useMemo(
        () => browseServices.map(s => ({ ...s, installStatus: statusBySlug.get(s.slug) ?? null, installed: statusBySlug.get(s.slug) === 'active' })),
        [browseServices, statusBySlug],
    )

    // Load more browse pages while the sentinel is visible. The observer is recreated whenever
    // the loaded set grows so it re-fires when a short page leaves the sentinel still in view.
    useEffect(() => {
        if (isSearchActive || !browseHasMore) return
        const el = sentinelRef.current
        if (!el) return
        const io = new IntersectionObserver(entries => entries[0].isIntersecting && loadMoreBrowse(), { rootMargin: '200px' })
        io.observe(el)
        return () => io.disconnect()
    }, [isSearchActive, browseHasMore, browseServices.length, loadMoreBrowse])

    const signInUrl = customStep?.kind === 'connect' ? customStep.server.signInUrl : null
    if (customStep?.kind === 'connect' && signInUrl) {
        const { server, popup } = customStep
        return (
            <PanelSteps stepKey={`connect:${server.name}`} depth={1}>
                <PanelEditorShell>
                    <PanelEditorHeader title={server.displayName} onBack={() => setCustomStep(null)} />
                    <PanelEditorBody>
                        <p className="text-xs text-muted-foreground">Sign in to {server.host ?? server.displayName} so the coworker can use its tools.</p>
                        <McpOAuthAuthorize url={signInUrl} agentId={agentId} serverName={server.name} autoStart pendingPopup={popup} onAuthorized={afterCustomChange} />
                    </PanelEditorBody>
                </PanelEditorShell>
            </PanelSteps>
        )
    }

    if (customStep?.kind === 'edit') {
        const current = customStep.server
        return (
            <PanelSteps stepKey={`edit:${current.name}`} depth={1}>
                <McpServerEditor
                    agentId={agentId}
                    server={current}
                    onSave={server => patchAgentMcpServersAction(agentId, { remove: current.name !== server.name ? [current.name] : [], upsert: [server] })}
                    onDelete={() => removeCustomMcpServerAction(agentId, current.name)}
                    onDone={afterCustomChange}
                    onBack={() => setCustomStep(null)}
                />
            </PanelSteps>
        )
    }

    if (globalOffer) {
        return (
            <PanelSteps stepKey={`global:${globalOffer.target.slug}`} depth={1}>
                <PanelEditorShell>
                    <PanelEditorHeader title={globalOffer.target.name} onBack={() => setGlobalOffer(null)} />
                    <PanelEditorBody>
                        <GlobalAccountOffer
                            appName={globalOffer.target.name}
                            options={globalOffer.options}
                            busy={enablingGlobal}
                            onUse={async option => {
                                setEnablingGlobal(option.id)
                                const res = await enableGlobalAppAction({ connectionId: option.id, agentId })
                                setEnablingGlobal(null)
                                if (!res.ok) {
                                    setError(res.error)
                                    setGlobalOffer(null)
                                    return
                                }
                                setGlobalOffer(null)
                                await load()
                            }}
                            onOwn={() => {
                                const target = globalOffer.target
                                setGlobalOffer(null)
                                void openSetup(target)
                            }}
                        />
                    </PanelEditorBody>
                </PanelEditorShell>
            </PanelSteps>
        )
    }

    if (setupTarget) {
        // An app the agent already runs would only be offered to be set up a second time.
        const alternatives = setupTarget.alternatives.filter(a => statusBySlug.get(a.slug) !== 'active')
        // Two accounts of one app never share a form's state.
        const setupKey = setupTarget.key ?? `${setupTarget.slug}:new`
        return (
            <PanelSteps stepKey={`setup:${setupKey}`} depth={1}>
                <PanelEditorShell>
                    <PanelEditorHeader title={setupTarget.name} onBack={() => setSetupTarget(null)} />
                    <PanelEditorBody>
                        <ServiceConfigForm
                            key={setupKey}
                            agentId={agentId}
                            slug={setupTarget.slug}
                            instanceKey={setupTarget.key}
                            newInstance={setupTarget.newInstance}
                            name={setupTarget.name}
                            authMethods={setupTarget.authMethods}
                            initialMethodId={setupTarget.initialMethodId}
                            initialAuthTarget={setupTarget.initialAuthTarget}
                            onInstalled={async () => {
                                setSetupTarget(null)
                                await load()
                            }}
                        />
                        <ServiceAlternatives alternatives={alternatives} swapping={swapping} error={swapError} onPick={swapTo} />
                    </PanelEditorBody>
                </PanelEditorShell>
            </PanelSteps>
        )
    }

    return (
        <PanelSteps stepKey="list" depth={0}>
            <div className="flex h-full flex-col">
                <div className="space-y-2 border-b border-border p-3">
                    <Input value={query} placeholder="Search apps…" className="h-8 text-sm" onChange={e => setQuery(e.target.value)} />
                    <HScrollFade className="-mx-1 gap-1.5 px-1" fadeClassName="from-background">
                        <Chip selected={selectedCategory === null} onClick={() => setSelectedCategory(null)}>
                            All
                        </Chip>
                        {SERVICE_CATEGORIES.filter(c => c !== 'other').map(c => (
                            <Chip key={c} selected={selectedCategory === c} onClick={() => setSelectedCategory(c)}>
                                {SERVICE_CATEGORY_LABELS[c]}
                            </Chip>
                        ))}
                    </HScrollFade>
                </div>
                <PanelScroller className="space-y-4">
                    {error && <p className="text-xs text-destructive">{error}</p>}
                    {loading || (!isSearchActive && browseServices.length === 0 && browseHasMore) ? (
                        <SkeletonPanelRows rows={6} leading className="p-0" />
                    ) : (
                        <>
                            {installed.length + custom.length > 0 && (
                                <PanelSection label="Installed">
                                    <PanelList>
                                        {installed.map(s => (
                                            <PanelRow
                                                key={s.key}
                                                leading={<Icon {...serviceIconProps(s.icon, s.category)} size="sm" />}
                                                description={s.label}
                                                title={
                                                    <span className="flex min-w-0 items-center gap-1.5">
                                                        <span className="truncate">{s.name}</span>
                                                        {s.global && (
                                                            <TooltipLabeled label="Runs on a workspace account. Reconnecting and disconnecting live in Global apps.">
                                                                <Badge size="xs" tone="brand" glow={false}>
                                                                    Global
                                                                </Badge>
                                                            </TooltipLabeled>
                                                        )}
                                                        {(s.status === 'needs_config' || s.status === 'needs_auth') && (
                                                            <TooltipLabeled label={s.status === 'needs_auth' ? 'This app needs you to sign in before the coworker can use it. Click Connect.' : 'This app needs credentials before the coworker can use it. Click Configure to set it up.'}>
                                                                <AlertTriangleIcon className="size-3.5 shrink-0 text-amber-400" />
                                                            </TooltipLabeled>
                                                        )}
                                                    </span>
                                                }
                                                actions={
                                                    <>
                                                        {s.status === 'needs_config' && (
                                                            <TooltipDisabledReason reason={manageReason}>
                                                                <Button size="sm" variant="outline" disabled={!canManage} onClick={() => onInstall(s.key)}>
                                                                    Configure
                                                                </Button>
                                                            </TooltipDisabledReason>
                                                        )}
                                                        {s.status === 'needs_auth' && (
                                                            <TooltipDisabledReason reason={manageReason}>
                                                                <Button size="sm" variant="outline" disabled={!canManage} onClick={() => onInstall(s.key)}>
                                                                    Connect
                                                                </Button>
                                                            </TooltipDisabledReason>
                                                        )}
                                                        {s.status === 'active' && !s.global && (
                                                            <TooltipDisabledReason reason={manageReason}>
                                                                <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={!canManage || reconnecting === s.key} onClick={() => onReconnect(s.key)}>
                                                                    {reconnecting === s.key ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
                                                                    {s.app ? 'Account' : 'Reconnect'}
                                                                </Button>
                                                            </TooltipDisabledReason>
                                                        )}
                                                        <TooltipDisabledReason reason={manageReason}>
                                                            <PanelDeleteButton
                                                                label={`Uninstall ${s.label ? `${s.name} (${s.label})` : s.name}`}
                                                                disabled={!canManage}
                                                                onClick={() => onUninstall(s.key)}
                                                                confirmTitle={s.global ? `Remove ${s.name} from this coworker?` : `Uninstall ${s.label ? `${s.name} (${s.label})` : s.name}?`}
                                                                confirmDescription={
                                                                    s.global
                                                                        ? `This coworker stops using the workspace account${s.global.label ? ` ${s.global.label}` : ''}. The account stays connected for everyone else.`
                                                                        : 'The coworker loses this service and its tools. Its connection is revoked, so reinstalling means connecting again.'
                                                                }
                                                                confirmLabel={s.global ? 'Remove' : 'Uninstall'}
                                                            />
                                                        </TooltipDisabledReason>
                                                    </>
                                                }
                                            />
                                        ))}
                                        {custom.map(server => (
                                            <CustomMcpRow
                                                key={`mcp:${server.name}`}
                                                server={server}
                                                status={customStatuses.get(server.name)}
                                                statusLoading={customStatusesLoading}
                                                onConnect={() => setCustomStep({ kind: 'connect', server, popup: openPendingSignInPopup(server.displayName) })}
                                                onEdit={() => onEditCustom(server.name)}
                                                onRemove={() => onRemoveCustom(server.name)}
                                                disabledReason={manageReason}
                                            />
                                        ))}
                                    </PanelList>
                                </PanelSection>
                            )}
                            <PanelSection label="Library">
                                {searchLoading ? <SkeletonPanelRows rows={6} leading className="p-0" /> : <ServiceList services={isSearchActive ? searchResults : browseWithInstalled} onInstall={onInstall} onUninstall={onUninstall} onAddAccount={onAddAccount} disabledReason={manageReason} />}
                                {!isSearchActive && (
                                    <>
                                        <div ref={sentinelRef} className="h-px" />
                                        {browseLoading && (
                                            <div className="flex justify-center py-2">
                                                <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
                                            </div>
                                        )}
                                        {!browseHasMore && browseServices.length > 0 && (
                                            <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border py-6 text-center">
                                                <p className="text-xs text-muted-foreground">Still looking? We can add the app you need.</p>
                                                <RequestConnectorDialog agentId={agentId}>
                                                    <Button size="sm" variant="outline">
                                                        Request an app
                                                    </Button>
                                                </RequestConnectorDialog>
                                            </div>
                                        )}
                                    </>
                                )}
                            </PanelSection>
                        </>
                    )}
                </PanelScroller>
            </div>
        </PanelSteps>
    )
}
