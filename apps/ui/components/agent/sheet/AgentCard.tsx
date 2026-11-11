'use client'

import { AgentBuddy } from '@rerun/ui/iso-grid'
import { type ComponentType, type MouseEvent, useEffect, useRef, useState } from 'react'

import { AgentComputerThumbnail } from '@/components/agent/sheet/AgentComputerThumbnail'
import { CoworkerNotificationBell } from '@/components/agent/sheet/CoworkerNotificationBell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TooltipDisabledReason } from '@/components/ui/tooltip'
import { useAgentBuddyMood } from '@/hooks/useAgentBuddyMood'
import { useCanManageAgent } from '@/hooks/useBoxAccess'
import { BOX_MANAGE_REASON } from '@/lib/board/box-access'
import type { AgentViewTab } from '@/lib/board/agent-sheet-views'
import { type IsoAgent, UNNAMED_BOX_LABEL } from '@/lib/board/types'
import { BlocksIcon, BrainIcon, CalendarClockIcon, ChevronRightIcon, FolderIcon, GaugeIcon, Layers, Link2, MessagesSquare, SettingsIcon, TableIcon, Trash2Icon, XIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useBoardStore } from '@/stores/board.store'

type IconType = ComponentType<{ className?: string }>

// The look of the button a destination sits on: the screen grows out of it and folds back into it.
export type CardDestinationShape = 'tile' | 'row' | 'button'

export type CardDestination = Extract<AgentViewTab, 'services' | 'skills' | 'memories' | 'scheduled' | 'channels' | 'files' | 'data' | 'monitoring' | 'settings'>

const DESTINATIONS: Record<CardDestination, { label: string; icon: IconType }> = {
    services: { label: 'Apps', icon: BlocksIcon },
    skills: { label: 'Skills', icon: Layers },
    memories: { label: 'Knowledge', icon: BrainIcon },
    scheduled: { label: 'Routines', icon: CalendarClockIcon },
    channels: { label: 'Chats', icon: MessagesSquare },
    files: { label: 'Files', icon: FolderIcon },
    data: { label: 'Database', icon: TableIcon },
    monitoring: { label: 'Activity', icon: GaugeIcon },
    settings: { label: 'Settings', icon: SettingsIcon },
}

const TILES: CardDestination[] = ['services', 'skills', 'memories', 'scheduled']
const ROWS: CardDestination[] = ['channels', 'files', 'data']
const FOOTER: CardDestination[] = ['monitoring', 'settings']

export type CardOpenHandler = (tab: CardDestination, from: HTMLElement, shape: CardDestinationShape) => void

type AgentCardProps = {
    agent: IsoAgent
    onOpen: CardOpenHandler
    onClose: () => void
    onShare: () => void
    onDelete: () => void
    onOpenComputer: () => void
    computerEnabled: boolean
    working: boolean
    servicesNeedConfig: boolean
    // Why what needs the machine is out of reach: the workspace is paused or has none yet.
    needsMachineReason: string | null
}

/**
 * Who the coworker is, what it has at hand and the screen it is looking at. A glance, never a full
 * screen: a destination picked here grows out of its button to fill the panel, the card waiting behind.
 */
export function AgentCard({ agent, onOpen, onClose, onShare, onDelete, onOpenComputer, computerEnabled, working, servicesNeedConfig, needsMachineReason }: AgentCardProps) {
    const canManage = useCanManageAgent(agent.id)
    const manageDisabledReason = needsMachineReason ?? (canManage ? null : BOX_MANAGE_REASON)
    return (
        <div className="flex min-h-0 flex-col overflow-y-auto">
            <CardIdentity agent={agent} canRename={canManage} onClose={onClose} onShare={onShare} shareDisabledReason={manageDisabledReason} />
            <div className="grid shrink-0 grid-cols-4 gap-1.5 px-3 pb-3">
                {TILES.map(tab => {
                    const { label, icon: Glyph } = DESTINATIONS[tab]
                    return (
                        <Button key={tab} variant="outline" onClick={event => onOpen(tab, event.currentTarget, 'tile')} className="relative h-auto flex-col gap-1 py-2 text-[11px]">
                            <Glyph className="size-4" />
                            {label}
                            {tab === 'services' && servicesNeedConfig && <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-red-500 ring-2 ring-background" />}
                        </Button>
                    )
                })}
            </div>
            <div className="shrink-0 space-y-4 px-3 pb-3">
                <div className="space-y-1.5">
                    {ROWS.map(tab => (
                        <DestinationRow key={tab} tab={tab} onClick={event => onOpen(tab, event.currentTarget, 'row')} />
                    ))}
                </div>
                {computerEnabled && <AgentComputerThumbnail key={`${agent.id}:${needsMachineReason}`} agentId={agent.id} working={working} disabledReason={needsMachineReason} onOpen={onOpenComputer} />}
            </div>
            <div className="shrink-0 space-y-2 border-t border-border p-3">
                <div className="grid grid-cols-2 gap-2">
                    {FOOTER.map(tab => {
                        const { label, icon: Glyph } = DESTINATIONS[tab]
                        return (
                            <Button key={tab} variant="outline" size="sm" className="w-full" onClick={event => onOpen(tab, event.currentTarget, 'button')}>
                                <Glyph className="size-4" />
                                {label}
                            </Button>
                        )
                    })}
                </div>
                <TooltipDisabledReason reason={manageDisabledReason ?? undefined} className="flex w-full">
                    <button
                        type="button"
                        disabled={!!manageDisabledReason}
                        onClick={onDelete}
                        className="flex w-full items-center justify-center gap-2 rounded-lg bg-destructive/10 py-2.5 text-sm font-medium text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-50 disabled:hover:bg-destructive/10"
                    >
                        <Trash2Icon className="size-4" />
                        Delete this coworker
                    </button>
                </TooltipDisabledReason>
            </div>
        </div>
    )
}

/** The name is the field that renames it: one click, Enter or a click away keeps it, Escape drops it. */
function CardIdentity({ agent, canRename, onClose, onShare, shareDisabledReason }: { agent: IsoAgent; canRename: boolean; onClose: () => void; onShare: () => void; shareDisabledReason: string | null }) {
    const renameAgent = useBoardStore(s => s.renameAgent)
    const boxName = useBoardStore(s => s.spaces.find(space => space.id === agent.spaceId)?.name) || UNNAMED_BOX_LABEL
    const mood = useAgentBuddyMood(agent.id)
    const [editing, setEditing] = useState(false)
    const [name, setName] = useState(agent.name)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (editing) inputRef.current?.select()
    }, [editing])

    const commit = () => {
        setEditing(false)
        const trimmed = name.trim()
        if (trimmed && trimmed !== agent.name) renameAgent(agent.id, trimmed)
        else setName(agent.name)
    }

    return (
        <div className="relative flex shrink-0 flex-col items-center px-4 pb-3 pt-4">
            <div className="absolute left-3 top-3 flex items-center gap-0.5">
                <CoworkerNotificationBell agentId={agent.id} name={agent.name} />
                <TooltipDisabledReason reason={shareDisabledReason ?? undefined}>
                    <Button variant="ghost" size="sm" disabled={!!shareDisabledReason} onClick={onShare} className="text-muted-foreground">
                        <Link2 className="size-4" />
                        Share
                    </Button>
                </TooltipDisabledReason>
            </div>
            <div className="absolute right-3 top-3">
                <Button aria-label="Close the card" variant="ghost" size="icon-sm" onClick={onClose}>
                    <XIcon className="size-4" />
                </Button>
            </div>
            <AgentBuddy agentId={agent.id} mood={mood} size={116} facing="left" />
            {editing ? (
                <Input
                    ref={inputRef}
                    aria-label="Coworker name"
                    hideRequired
                    value={name}
                    onChange={event => setName(event.target.value)}
                    onBlur={commit}
                    onKeyDown={event => {
                        if (event.key === 'Enter') event.currentTarget.blur()
                        if (event.key === 'Escape') {
                            setName(agent.name)
                            setEditing(false)
                        }
                    }}
                    className="-mt-1 h-8 w-48 text-center text-base font-semibold"
                />
            ) : (
                <TooltipDisabledReason reason={canRename ? undefined : BOX_MANAGE_REASON} className="-mt-1 max-w-full">
                    <button
                        type="button"
                        aria-label={`Rename ${agent.name}`}
                        disabled={!canRename}
                        onClick={() => {
                            setName(agent.name)
                            setEditing(true)
                        }}
                        className={cn('max-w-full truncate rounded-md px-2 py-0.5 text-base font-semibold leading-tight', canRename && '-mt-1 transition-colors hover:bg-accent')}
                    >
                        {agent.name}
                    </button>
                </TooltipDisabledReason>
            )}
            <span className="text-xs text-muted-foreground">{boxName}</span>
        </div>
    )
}

function DestinationRow({ tab, onClick }: { tab: CardDestination; onClick: (event: MouseEvent<HTMLButtonElement>) => void }) {
    const { label, icon: Glyph } = DESTINATIONS[tab]
    return (
        <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-lg bg-muted/60 px-3 py-2.5 text-left transition-colors hover:bg-muted">
            <Glyph className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
        </button>
    )
}

/** The button as it sat on the card, drawn over the surface while it leaves its place. */
export function CardDestinationGhost({ tab, shape }: { tab: CardDestination; shape: CardDestinationShape }) {
    const { label, icon: Glyph } = DESTINATIONS[tab]

    if (shape === 'tile') {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-[11px] font-medium">
                <Glyph className="size-4" />
                {label}
            </div>
        )
    }
    if (shape === 'row') {
        return (
            <div className="flex h-full items-center gap-3 bg-muted/60 px-3">
                <Glyph className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
                <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
            </div>
        )
    }
    return (
        <div className="flex h-full items-center justify-center gap-2 text-sm font-medium">
            <Glyph className="size-4" />
            {label}
        </div>
    )
}
