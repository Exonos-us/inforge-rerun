'use client'

import type { ClientConfluenceSpace } from '@/app/api/_services/client.service'
import { Group } from '@/components/connections/AiProvidersPanel'
import { Button } from '@/components/ui/button'
import { PanelRow } from '@/components/ui/panel-row'
import { BookOpenIcon, ExternalLinkIcon } from '@/lib/icons'
import { Badge } from '@rerun/ui/primitives'

// The Confluence space a project of this client starts on. Read-only here: it is the Start project
// wizard that links one, the way Project knowledge links a Box's engagement.
export function ClientConfluenceRow({ confluence }: { confluence: ClientConfluenceSpace | null }) {
    return (
        <Group title="Default Confluence space">
            {confluence ? (
                <PanelRow
                    className="max-sm:flex-col max-sm:items-stretch max-sm:gap-2"
                    leading={
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                            <BookOpenIcon className="size-4 text-muted-foreground" />
                        </span>
                    }
                    title={
                        <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate">
                                {confluence.spaceKey} — {confluence.spaceName}
                            </span>
                            <Badge size="xs" tone="green" glow={false} className="font-medium">
                                Linked
                            </Badge>
                        </span>
                    }
                    description={confluence.siteUrl.replace(/^https?:\/\//, '')}
                    actions={
                        <Button size="sm" variant="outline" onClick={() => window.open(`${confluence.siteUrl}/wiki/spaces/${confluence.spaceKey}`, '_blank', 'noopener')}>
                            <ExternalLinkIcon className="mr-1.5 size-3.5" />
                            Open
                        </Button>
                    }
                />
            ) : (
                <p className="rounded-md border border-dashed px-3 py-3 text-xs text-muted-foreground">No space yet. Starting a project for this client links one, and every project after that starts there.</p>
            )}
        </Group>
    )
}
