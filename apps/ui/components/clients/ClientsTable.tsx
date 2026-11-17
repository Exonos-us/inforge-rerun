'use client'

import type { ClientListEntry } from '@/app/api/_actions/client.actions'
import { ClientShortCode, ClientStatusBadge, HighlightMatch } from '@/components/clients/ClientCells'
import { ClientStackedRows } from '@/components/clients/ClientStackedRows'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SkeletonPanelRows } from '@/components/ui/skeleton'
import { Building2, ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, PlusIcon, SearchIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@rerun/ui/primitives'
import { useState, type KeyboardEvent } from 'react'

// The front page of the panel: every client of the workspace, searched and sorted in the browser.
// The list is the whole workspace's and comes down in one action, so neither has to go back out.

type SortKey = 'name' | 'skills' | 'docs' | 'coworkers'

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
    { key: 'name', label: 'Client', numeric: false },
    { key: 'skills', label: 'Skills', numeric: true },
    { key: 'docs', label: 'Docs', numeric: true },
    { key: 'coworkers', label: 'Coworkers', numeric: true },
]

const EMPTY_CELL = '—'

function countOf(client: ClientListEntry, key: SortKey): number {
    if (key === 'skills') return client.skills.length
    if (key === 'docs') return client.knowledgeDocs.length
    return client.coworkers
}

function sorted(clients: ClientListEntry[], sort: { key: SortKey; asc: boolean }): ClientListEntry[] {
    const direction = sort.asc ? 1 : -1
    return [...clients].sort((left, right) => {
        if (sort.key === 'name') return direction * left.name.localeCompare(right.name)
        const gap = countOf(left, sort.key) - countOf(right, sort.key)
        return gap !== 0 ? direction * gap : left.name.localeCompare(right.name)
    })
}

const STICKY_HEAD = 'sticky top-0 z-10 bg-popover'

function SortHead({ column, sort, onToggle, className }: { column: (typeof COLUMNS)[number]; sort: { key: SortKey; asc: boolean }; onToggle: (key: SortKey) => void; className?: string }) {
    const on = sort.key === column.key
    return (
        <TableHead className={cn(STICKY_HEAD, column.numeric && 'text-right', className)}>
            <button type="button" onClick={() => onToggle(column.key)} className={cn('inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground', on && 'text-foreground')}>
                {column.label}
                {on && (sort.asc ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />)}
            </button>
        </TableHead>
    )
}

function NumberCell({ value }: { value: number }) {
    return <TableCell className={cn('text-right tabular-nums', value === 0 && 'text-muted-foreground')}>{value === 0 ? EMPTY_CELL : value}</TableCell>
}

type ClientsTableProps = {
    clients: ClientListEntry[] | null
    creating: boolean
    onOpen: (clientId: string) => void
    onCreate: (name: string) => Promise<void>
}

export function ClientsTable({ clients, creating, onOpen, onCreate }: ClientsTableProps) {
    const [query, setQuery] = useState('')
    const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'name', asc: true })
    const [draft, setDraft] = useState<string | null>(null)

    const needle = query.trim().toLowerCase()
    const matching = (clients ?? []).filter(client => !needle || `${client.name} ${client.shortCode}`.toLowerCase().includes(needle))
    const rows = sorted(matching, sort)

    const toggle = (key: SortKey) => setSort(current => (current.key === key ? { key, asc: !current.asc } : { key, asc: key === 'name' }))

    const create = async (name: string) => {
        if (!name.trim()) return
        setDraft(null)
        setQuery('')
        await onCreate(name.trim())
    }

    const openRow = (event: KeyboardEvent<HTMLTableRowElement>, clientId: string) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen(clientId)
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                <div className="relative min-w-[9rem] flex-1">
                    <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input aria-label="Search clients" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search clients" className="h-8 pl-8 text-xs" />
                </div>
                {needle && (
                    <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setQuery('')}>
                        Clear
                    </Button>
                )}
                <Button size="sm" onClick={() => setDraft(query.trim())}>
                    <PlusIcon />
                    New client
                </Button>
            </div>

            {draft !== null && (
                <div className="flex flex-wrap items-end gap-2 border-b border-border px-3 py-2">
                    <Field label="Client name" htmlFor="new-client-name" className="min-w-[12rem] flex-1">
                        <Input
                            autoFocus
                            id="new-client-name"
                            className="h-8 text-xs"
                            value={draft}
                            onChange={event => setDraft(event.target.value)}
                            onKeyDown={event => {
                                if (event.key === 'Enter') void create(draft)
                                if (event.key === 'Escape') setDraft(null)
                            }}
                            placeholder="Miami Dade County"
                        />
                    </Field>
                    <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                        Cancel
                    </Button>
                    <Button size="sm" loading={creating} disabled={!draft.trim()} onClick={() => void create(draft)}>
                        Create
                    </Button>
                </div>
            )}

            <div
                className={cn(
                    'min-h-0 flex-1 overflow-y-auto',
                    // The sticky header only sticks to the scroller it lives in, and the Table
                    // primitive always wraps itself in one. Above `sm` that wrapper is the
                    // scroller; below it the stacked rows scroll in this one.
                    rows.length > 0 && 'sm:overflow-y-hidden sm:[&>[data-slot=table-container]]:h-full sm:[&>[data-slot=table-container]]:overflow-y-auto',
                )}
            >
                {clients === null ? (
                    <SkeletonPanelRows rows={6} badge />
                ) : rows.length === 0 ? (
                    <EmptyState
                        className="h-full"
                        icon={Building2}
                        title={needle ? `No client matches “${query.trim()}”` : 'No client yet'}
                        description={needle ? 'Create it, and it is ready for the next Box.' : 'A client carries the skills and documents every coworker on its engagement starts with.'}
                        action={
                            <Button size="sm" loading={creating} onClick={() => (needle ? void create(query) : setDraft(''))}>
                                <PlusIcon />
                                {needle ? `Create “${query.trim()}”` : 'New client'}
                            </Button>
                        }
                    />
                ) : (
                    <>
                        <div className="sm:hidden">
                            <ClientStackedRows clients={rows} query={query} onOpen={onOpen} />
                        </div>
                        <Table className="hidden sm:table">
                            <TableHeader>
                                <TableRow className="hover:bg-transparent">
                                    <SortHead column={COLUMNS[0]} sort={sort} onToggle={toggle} className="pl-4" />
                                    <TableHead className={cn(STICKY_HEAD, 'hidden text-xs font-medium text-muted-foreground md:table-cell')}>Code</TableHead>
                                    {COLUMNS.slice(1).map(column => (
                                        <SortHead key={column.key} column={column} sort={sort} onToggle={toggle} />
                                    ))}
                                    <TableHead className={cn(STICKY_HEAD, 'text-xs font-medium text-muted-foreground')}>Status</TableHead>
                                    <TableHead className={cn(STICKY_HEAD, 'w-8')} />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.map(client => (
                                    <TableRow key={client.id} tabIndex={0} className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onOpen(client.id)} onKeyDown={event => openRow(event, client.id)}>
                                        <TableCell className="max-w-[10rem] truncate pl-4 font-medium md:max-w-[16rem]">
                                            <HighlightMatch text={client.name} query={query} />
                                        </TableCell>
                                        <TableCell className="hidden md:table-cell">
                                            <ClientShortCode code={client.shortCode} />
                                        </TableCell>
                                        <NumberCell value={client.skills.length} />
                                        <NumberCell value={client.knowledgeDocs.length} />
                                        <NumberCell value={client.coworkers} />
                                        <TableCell>
                                            <ClientStatusBadge coworkers={client.coworkers} pending={client.pending} />
                                        </TableCell>
                                        <TableCell className="w-8 pr-4 text-right">
                                            <ChevronRightIcon className="size-4 text-muted-foreground" />
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </>
                )}
            </div>

            <div className="flex flex-wrap items-center gap-x-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
                <ClientsFooterLine clients={clients} matching={matching.length} query={query} />
            </div>
        </div>
    )
}

function ClientsFooterLine({ clients, matching, query }: { clients: ClientListEntry[] | null; matching: number; query: string }) {
    if (clients === null) return <span>Reading the clients…</span>
    const trimmed = query.trim()
    if (trimmed) {
        return (
            <span>
                {matching} of {clients.length} match “{trimmed}”
            </span>
        )
    }
    const inUse = clients.filter(client => client.coworkers > 0).length
    const waiting = clients.filter(client => client.pending > 0).length
    return (
        <span>
            {clients.length} client{clients.length === 1 ? '' : 's'} · {inUse} in use{waiting > 0 ? ` · ${waiting} waiting to sync` : ''}
        </span>
    )
}
