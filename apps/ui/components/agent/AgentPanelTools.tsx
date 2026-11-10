'use client'

import { getAgentDetailAction, listAgentToolsAction, updateAgentConfigAction } from '@/app/api/_actions/agent.actions'
import { Icon } from '@/components/ui/icon'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipDisabledReason, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useCanManageAgent } from '@/hooks/useBoxAccess'
import { BOX_MANAGE_REASON } from '@/lib/board/box-access'
import { ENGINE_SELF_IMPROVEMENT_KEYS } from '@/lib/engine/constants'
import type { EngineSelfImprovement, EngineToolFamily } from '@/lib/engine/types'
import { ActivityIcon, BrainIcon, CalendarClockIcon, CardsIcon, CircleCheckIcon, CoinsIcon, DatabaseIcon, FilmIcon, FolderIcon, GlobeIcon, InfoIcon, LayersIcon, Loader2Icon, LockIcon, type LucideIcon, MessageCircleQuestionIcon, MonitorIcon, QuickReplyIcon, TerminalIcon, UsersIcon, WandSparklesIcon, WebhookIcon, WrenchIcon } from '@/lib/icons'
import { EmptyState } from '@/components/ui/empty-state'
import { PanelGrid, PanelListHeader, PanelScroller } from '@/components/ui/panel-list'
import { PANEL_CARD, PANEL_CARD_INTERACTIVE } from '@/components/ui/panel-row'
import { SkeletonCardGrid } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useCallback, useEffect, useState } from 'react'

type SelfImprovementKey = (typeof ENGINE_SELF_IMPROVEMENT_KEYS)[number]

const SELF_IMPROVEMENT_LABELS: Record<Exclude<SelfImprovementKey, 'enabled'>, { label: string; description: string }> = {
    allowToolInstall: { label: 'Install tools & MCP', description: 'Let the coworker npm-install packages and register MCP servers.' },
    allowSoulEdit: { label: 'Edit own soul', description: 'Let the coworker rewrite its SOUL.md identity.' },
    autoMemory: { label: 'Auto-memory', description: 'Automatically curate memories after each turn.' },
}

const SELF_IMPROVEMENT_SUBKEYS = ENGINE_SELF_IMPROVEMENT_KEYS.filter((key): key is Exclude<SelfImprovementKey, 'enabled'> => key !== 'enabled')

type AgentPanelToolsProps = {
    agentId: string
}

type CapabilityMeta = {
    icon: LucideIcon
    label: string
    blurb: string
    help: string
}

export const CAPABILITY_META: Record<string, CapabilityMeta> = {
    filesystem: { icon: FolderIcon, label: 'Read & write files', blurb: 'Work with files in its workspace', help: 'Lets the coworker open, create and edit files in its own workspace.' },
    shell: { icon: TerminalIcon, label: 'Run commands', blurb: 'Execute commands on its machine', help: 'Lets the coworker run terminal commands to install tools and automate tasks.' },
    web: { icon: GlobeIcon, label: 'Browse the web', blurb: 'Search and read web pages', help: 'Lets the coworker search the internet and read web pages to find information.' },
    memory: { icon: BrainIcon, label: 'Remember things', blurb: 'Save and recall information', help: 'Lets the coworker store facts across runs and recall them later.' },
    db: { icon: DatabaseIcon, label: 'Access data', blurb: 'Query its database', help: 'Lets the coworker read and write structured data in its own database.' },
    brain: { icon: BrainIcon, label: 'Use the company brain', blurb: 'Read what the company validated', help: 'Lets the coworker search and read the Brain, the pages your team validated about the company, and propose changes you review before anything is saved.' },
    sharedDb: { icon: DatabaseIcon, label: 'Access shared data', blurb: 'Query the shared database', help: 'Lets the coworker read and write the database every coworker of the workspace shares.' },
    skills: { icon: LayersIcon, label: 'Use skills', blurb: 'Run installed skills', help: "Lets the coworker use the skills you've installed for specialized tasks." },
    self: { icon: WandSparklesIcon, label: 'Improve itself', blurb: 'Adjust its own setup', help: 'Lets the coworker refine its own instructions and configuration over time.' },
    schedule: { icon: CalendarClockIcon, label: 'Schedule tasks', blurb: 'Plan work for later', help: 'Lets the coworker schedule tasks to run automatically at a chosen time.' },
    trigger: { icon: WebhookIcon, label: 'React to webhooks', blurb: 'Run when another app calls it', help: 'Lets the coworker expose public URLs that start a run when an external service calls them.' },
    callAgent: { icon: UsersIcon, label: 'Work with other coworkers', blurb: 'Delegate to teammates', help: 'Lets the coworker hand off work to other coworkers of the workspace.' },
    team: { icon: ActivityIcon, label: 'See other coworkers', blurb: 'Read their routines and runs', help: "Lets the coworker check the other coworkers of the workspace: their status, scheduled tasks, triggers and recent runs, with the tools each run called when it needs to understand a failure. It cannot change anything. A run can hold data from the other coworker's connected apps." },
    askUser: { icon: MessageCircleQuestionIcon, label: 'Ask you questions', blurb: 'Pause to ask with answer options', help: 'Lets the coworker pause and ask you a question with answer options before continuing.' },
    requestApproval: { icon: CircleCheckIcon, label: 'Request approval', blurb: 'Pause for your go-ahead', help: 'Lets the coworker pause and ask you to approve or decline an action before it runs.' },
    cards: { icon: CardsIcon, label: 'Show cards in chat', blurb: 'Preview a table or a file inline', help: 'Lets the coworker drop a preview card in the conversation: the first rows of one of its tables, or a file from its workspace, that you can open in one click.' },
    quickReplies: { icon: QuickReplyIcon, label: 'Suggest replies', blurb: 'Offer one-click answers', help: 'Lets the coworker end a message with up to three short replies you can send in one click, such as "Find 100 more".' },
    computer: { icon: MonitorIcon, label: 'Use its computer', blurb: 'See and drive its own screen', help: 'Lets the coworker look at its own desktop and click, type and scroll in its browser, its files and its terminal, for work that has to be done by hand in an app or a site. You can watch it live, and it pauses while you drive the screen yourself.' },
    computerRecording: { icon: FilmIcon, label: 'Record its screen', blurb: 'Keep a video of screen work', help: 'Keeps the evidence of every screen session in the screen folder of the coworker workspace: a video recording and the screenshot of each action, shown as the screen activity of the conversation. The 20 most recent sessions are kept.' },
    paidData: { icon: CoinsIcon, label: 'Leads, SEO & social data', blurb: 'Paid from your Rerun credits', help: 'Lets the coworker find prospects, their work emails and phone numbers and company data, check search volumes, keyword ideas and backlinks, read Google results and local businesses, and read public profiles and posts on LinkedIn, TikTok, Instagram, X, YouTube, Facebook and Reddit, without an Apollo, Semrush or scraping subscription. Each call is paid from your Rerun credits, spent by the coworker when a task needs it.' },
    requestSecret: { icon: LockIcon, label: 'Ask for a credential', blurb: 'Pause for a key, entered securely', help: 'Lets the coworker pause and ask you for an API key or token in a masked form. The value is stored as a coworker variable and never enters the conversation.' },
}

function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1)
}

function metaFor(family: EngineToolFamily): CapabilityMeta {
    return CAPABILITY_META[family.family] ?? { icon: WrenchIcon, label: capitalize(family.family), blurb: family.description, help: family.description }
}

export function AgentPanelTools({ agentId }: AgentPanelToolsProps) {
    const [families, setFamilies] = useState<EngineToolFamily[]>([])
    const [selfImprovement, setSelfImprovement] = useState<EngineSelfImprovement | null>(null)
    const [loading, setLoading] = useState(true)
    const [pending, setPending] = useState<Set<string>>(new Set())
    const [error, setError] = useState<string | null>(null)
    const canManage = useCanManageAgent(agentId)
    const manageReason = canManage ? undefined : BOX_MANAGE_REASON

    useEffect(() => {
        setLoading(true)
        setError(null)
        Promise.all([listAgentToolsAction(agentId), getAgentDetailAction(agentId)])
            .then(([tools, detail]) => {
                if (tools.length === 0 || !detail) {
                    setError('Could not reach the engine for this coworker.')
                    return
                }
                setFamilies(tools)
                setSelfImprovement(detail.config.selfImprovement)
            })
            .catch(() => setError('Could not reach the engine for this coworker.'))
            .finally(() => setLoading(false))
    }, [agentId])

    const withPending = useCallback(async (key: string, apply: () => void, revert: () => void, patch: Parameters<typeof updateAgentConfigAction>[1]) => {
        apply()
        setPending(prev => new Set(prev).add(key))
        const result = await updateAgentConfigAction(agentId, patch)
        if (!result.success) {
            revert()
            setError(result.error ?? 'Failed to update')
        }
        setPending(prev => {
            const s = new Set(prev)
            s.delete(key)
            return s
        })
    }, [agentId])

    const handleToggle = useCallback(
        async (family: string, value: boolean) => {
            if (family === 'self') {
                await withPending(
                    'self',
                    () => {
                        setFamilies(prev => prev.map(f => (f.family === 'self' ? { ...f, enabled: value } : f)))
                        setSelfImprovement(prev => (prev ? { ...prev, enabled: value } : prev))
                    },
                    () => {
                        setFamilies(prev => prev.map(f => (f.family === 'self' ? { ...f, enabled: !value } : f)))
                        setSelfImprovement(prev => (prev ? { ...prev, enabled: !value } : prev))
                    },
                    { selfImprovement: { enabled: value } }
                )
                return
            }
            await withPending(
                family,
                () => setFamilies(prev => prev.map(f => (f.family === family ? { ...f, enabled: value } : f))),
                () => setFamilies(prev => prev.map(f => (f.family === family ? { ...f, enabled: !value } : f))),
                { tools: { [family]: value } }
            )
        },
        [withPending]
    )

    const handleSelfImprovement = useCallback(
        async (key: Exclude<SelfImprovementKey, 'enabled'>, value: boolean) => {
            await withPending(
                key,
                () => setSelfImprovement(prev => (prev ? { ...prev, [key]: value } : prev)),
                () => setSelfImprovement(prev => (prev ? { ...prev, [key]: !value } : prev)),
                { selfImprovement: { [key]: value } }
            )
        },
        [withPending]
    )

    if (loading) {
        return <SkeletonCardGrid rows={6} className="p-3" />
    }

    if (error) {
        return <EmptyState className="h-full" icon={WrenchIcon} title="Capabilities unavailable" description={error} />
    }

    return (
        <div className="flex flex-col h-full">
            <PanelListHeader>
                <p className="text-xs text-muted-foreground">Choose what this coworker can do. Changes apply on the next run.</p>
            </PanelListHeader>
            <TooltipProvider>
            <PanelScroller>
                <PanelGrid>
                {[...families].sort((a, b) => Number(a.family === 'self') - Number(b.family === 'self')).map(family => {
                    const checked = !!family.enabled
                    const isPending = pending.has(family.family)
                    const meta = metaFor(family)
                    const isSelf = family.family === 'self'
                    const expanded = isSelf && checked
                    return (
                        <div key={family.family} className={cn('flex flex-col gap-2 p-3', PANEL_CARD, PANEL_CARD_INTERACTIVE, expanded && 'col-span-2')}>
                            <div className="flex items-start justify-between gap-2">
                                <Icon icon={meta.icon} size="md" />
                                {isPending ? (
                                    <Loader2Icon className="size-3.5 animate-spin text-muted-foreground shrink-0 mt-1" />
                                ) : (
                                    <TooltipDisabledReason reason={manageReason} className="shrink-0">
                                        <Switch checked={checked} disabled={!canManage} onCheckedChange={value => handleToggle(family.family, value)} className="shrink-0 mt-0.5" />
                                    </TooltipDisabledReason>
                                )}
                            </div>
                            <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                    <span className="text-sm font-medium truncate">{meta.label}</span>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <button type="button" aria-label={`About ${meta.label}`} className="text-muted-foreground/60 hover:text-foreground shrink-0 transition-colors">
                                                <InfoIcon className="size-3.5" />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent side="left" className="max-w-65 flex-col items-start">
                                            <p className="text-xs">{meta.help}</p>
                                            {family.tools.length > 0 && (
                                                <div className="mt-1.5 w-full border-t border-background/20 pt-1.5">
                                                    <p className="text-[10px] uppercase tracking-wide text-background/60 mb-1">Includes</p>
                                                    <ul className="space-y-0.5">
                                                        {family.tools.map(tool => (
                                                            <li key={tool.name} className="text-[11px] text-background/80">
                                                                {tool.description || tool.name}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                </div>
                                            )}
                                        </TooltipContent>
                                    </Tooltip>
                                </div>
                                <span className="text-xs text-muted-foreground block line-clamp-2">{meta.blurb}</span>
                            </div>
                            {expanded && isSelf && selfImprovement && (
                                <div className="mt-1 flex flex-col border-t border-border pt-1">
                                    {SELF_IMPROVEMENT_SUBKEYS.map(key => (
                                        <label key={key} className="flex items-center gap-2 py-1.5 px-1 rounded-md hover:bg-accent/40 transition-colors cursor-pointer">
                                            <span className="flex-1 min-w-0">
                                                <span className="text-sm block truncate">{SELF_IMPROVEMENT_LABELS[key].label}</span>
                                                <span className="text-xs text-muted-foreground block">{SELF_IMPROVEMENT_LABELS[key].description}</span>
                                            </span>
                                            {pending.has(key) ? (
                                                <Loader2Icon className="size-3.5 animate-spin text-muted-foreground shrink-0" />
                                            ) : (
                                                <TooltipDisabledReason reason={manageReason} className="shrink-0">
                                                    <Switch checked={!!selfImprovement[key]} disabled={!canManage} onCheckedChange={value => handleSelfImprovement(key, value)} className="shrink-0" />
                                                </TooltipDisabledReason>
                                            )}
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>
                    )
                })}
                </PanelGrid>
            </PanelScroller>
            </TooltipProvider>
        </div>
    )
}
