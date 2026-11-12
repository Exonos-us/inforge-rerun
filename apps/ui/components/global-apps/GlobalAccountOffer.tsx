'use client'

import { Button } from '@/components/ui/button'
import type { GlobalAppOption } from '@/lib/services/types'
import { Loader2Icon } from '@/lib/icons'
import { Badge } from '@rerun/ui/primitives'

type GlobalAccountOfferProps = {
    appName: string
    options: GlobalAppOption[]
    busy: string | null
    onUse: (option: GlobalAppOption) => void
    onOwn: () => void
}

// Shown while installing an app the workspace already holds: one click on a workspace account,
// or the usual per-coworker sign-in. Neither is hidden behind the other.
export function GlobalAccountOffer({ appName, options, busy, onUse, onOwn }: GlobalAccountOfferProps) {
    return (
        <div className="space-y-3">
            <p className="text-xs text-muted-foreground">The workspace already has {appName} connected. This coworker can use a workspace account with no sign-in, or sign in with an account of its own.</p>
            <div className="space-y-1.5">
                {options.map(option => (
                    <div key={option.id} className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2.5">
                        <div className="min-w-0 flex-1">
                            <p className="flex items-center gap-1.5 text-sm font-medium">
                                <span className="truncate">{option.label}</span>
                                <Badge size="xs" tone="green" glow={false}>
                                    Connected
                                </Badge>
                            </p>
                            <p className="text-xs text-muted-foreground">{option.usedBy === 0 ? 'Not used by any coworker yet' : `Used by ${option.usedBy} coworker${option.usedBy === 1 ? '' : 's'}`}</p>
                        </div>
                        <Button size="sm" disabled={busy !== null} onClick={() => onUse(option)}>
                            {busy === option.id ? <Loader2Icon className="size-3.5 animate-spin" /> : 'Use this account'}
                        </Button>
                    </div>
                ))}
            </div>
            <div className="flex items-center justify-between gap-2 rounded-md border border-dashed border-border px-3 py-2.5">
                <p className="text-xs text-muted-foreground">A separate sign-in just for this coworker. The credential stays private to it.</p>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={onOwn}>
                    Its own account
                </Button>
            </div>
        </div>
    )
}
