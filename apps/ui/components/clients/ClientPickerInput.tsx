'use client'

import type { ClientListEntry } from '@/app/api/_actions/client.actions'
import type { ClientView } from '@/app/api/_services/client.service'
import { ClientShortCode, HighlightMatch, plural } from '@/components/clients/ClientCells'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { SkeletonList } from '@/components/ui/skeleton'
import { Building2, CheckIcon, PlusIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useClientsStore } from '@/stores/clients.store'
import { useRef, useState, type KeyboardEvent } from 'react'
import { toast } from 'sonner'

// The Client field of the Start project wizard: a plain text input that happens to know the
// workspace's clients. Typing stays the primary gesture — a project for someone the workspace has
// never worked for is normal — so the list only offers, and a name matching nothing offers to
// create the client instead of refusing it.

type ClientPickerInputProps = {
    id: string
    value: string
    clients: ClientListEntry[] | null
    picked: ClientView | null
    placeholder?: string
    onType: (value: string) => void
    onPick: (client: ClientView) => void
}

type Row = { kind: 'client'; client: ClientListEntry } | { kind: 'create'; name: string }

function carriesLine(client: ClientListEntry): string {
    return `${plural(client.skills.length, 'skill')} · ${plural(client.knowledgeDocs.length, 'doc')}`
}

// Prefix first, then the rest in the order the list came in (by name): typing "mi" puts
// "Miami Dade County" above "Greater Miami Transit", which is what the keystrokes meant.
function matching(clients: readonly ClientListEntry[], needle: string): ClientListEntry[] {
    if (!needle) return [...clients]
    const hits = clients.filter(client => `${client.name} ${client.shortCode}`.toLowerCase().includes(needle))
    return hits.sort((a, b) => Number(b.name.toLowerCase().startsWith(needle)) - Number(a.name.toLowerCase().startsWith(needle)))
}

export function ClientPickerInput({ id, value, clients, picked, placeholder, onType, onPick }: ClientPickerInputProps) {
    const [open, setOpen] = useState(false)
    const [highlight, setHighlight] = useState(0)
    const [creating, setCreating] = useState(false)
    const createClient = useClientsStore(state => state.create)
    const anchor = useRef<HTMLDivElement>(null)
    const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)

    const needle = value.trim().toLowerCase()
    const hits = matching(clients ?? [], needle)
    // The client just created from here is known before the list has been read again, so the row
    // that created it cannot be clicked twice into two clients of the same name.
    const known = picked?.name.trim().toLowerCase() === needle || (clients ?? []).some(client => client.name.trim().toLowerCase() === needle)
    const rows: Row[] = [...hits.map(client => ({ kind: 'client' as const, client })), ...(needle && !known ? [{ kind: 'create' as const, name: value.trim() }] : [])]

    const show = (next: boolean) => {
        if (next) setPortalContainer(anchor.current?.closest<HTMLElement>('[data-slot="dialog-content"]') ?? null)
        setOpen(next)
        setHighlight(0)
    }

    const create = async (name: string) => {
        setCreating(true)
        const result = await createClient({ name }).catch(() => null)
        setCreating(false)
        if (!result) return toast.error('Could not create the client')
        if (!result.ok) return toast.error(result.error)
        setOpen(false)
        onPick(result.client)
        toast.success(`${result.client.name} added to your clients.`)
    }

    const choose = (row: Row) => {
        if (row.kind === 'create') return void create(row.name)
        setOpen(false)
        onPick(row.client)
    }

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Escape' && open) {
            event.preventDefault()
            return setOpen(false)
        }
        if (event.key === 'ArrowDown' && !open) {
            event.preventDefault()
            return show(true)
        }
        if (!open || rows.length === 0) return
        if (event.key === 'ArrowDown') {
            event.preventDefault()
            setHighlight(current => (current + 1) % rows.length)
        } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setHighlight(current => (current - 1 + rows.length) % rows.length)
        } else if (event.key === 'Enter') {
            event.preventDefault()
            choose(rows[highlight])
        }
    }

    const listed = clients === null || rows.length > 0

    return (
        <Popover open={open && listed} onOpenChange={show}>
            <PopoverAnchor asChild>
                <div ref={anchor}>
                    <Input
                        id={id}
                        role="combobox"
                        aria-expanded={open && listed}
                        aria-autocomplete="list"
                        aria-controls={`${id}-options`}
                        aria-activedescendant={open && listed && rows[highlight] ? `${id}-option-${highlight}` : undefined}
                        autoComplete="off"
                        value={value}
                        placeholder={placeholder}
                        onChange={event => {
                            onType(event.target.value)
                            show(true)
                        }}
                        onFocus={() => show(true)}
                        onBlur={() => setOpen(false)}
                        onKeyDown={onKeyDown}
                    />
                </div>
            </PopoverAnchor>
            <PopoverContent
                container={portalContainer}
                align="start"
                className="w-(--radix-popover-trigger-width) max-w-[calc(100vw-2rem)] gap-0 p-1"
                onOpenAutoFocus={event => event.preventDefault()}
                onCloseAutoFocus={event => event.preventDefault()}
                onInteractOutside={event => {
                    if (anchor.current?.contains(event.target as Node)) event.preventDefault()
                }}
            >
                {clients === null ? (
                    <SkeletonList rows={3} className="space-y-0" />
                ) : (
                    <ul id={`${id}-options`} role="listbox" className="max-h-[min(14rem,var(--radix-popover-content-available-height))] overflow-y-auto">
                        {rows.map((row, index) => (
                            <li key={row.kind === 'create' ? 'create' : row.client.id}>
                                <button
                                    type="button"
                                    role="option"
                                    id={`${id}-option-${index}`}
                                    aria-selected={index === highlight}
                                    disabled={creating}
                                    className={cn(
                                        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm disabled:opacity-60',
                                        index === highlight && 'bg-accent text-accent-foreground'
                                    )}
                                    onMouseEnter={() => setHighlight(index)}
                                    onMouseDown={event => {
                                        event.preventDefault()
                                        choose(row)
                                    }}
                                >
                                    {row.kind === 'create' ? (
                                        <>
                                            <PlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
                                            <span className="min-w-0 flex-1 truncate">Create “{row.name}”</span>
                                            <span className="shrink-0 text-xs text-muted-foreground">new client</span>
                                        </>
                                    ) : (
                                        <>
                                            <Building2 className="size-3.5 shrink-0 text-muted-foreground" />
                                            <span className="min-w-0 flex-1 truncate">
                                                <HighlightMatch text={row.client.name} query={value} />
                                            </span>
                                            <ClientShortCode code={row.client.shortCode} />
                                            <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">{carriesLine(row.client)}</span>
                                            {picked?.id === row.client.id && <CheckIcon className="size-3.5 shrink-0" />}
                                        </>
                                    )}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </PopoverContent>
        </Popover>
    )
}
