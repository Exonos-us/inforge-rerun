'use client'

import { listShareableCatalogAction } from '@/app/api/_actions/global-apps.actions'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Icon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { PanelEditorBody, PanelEditorHeader, PanelEditorShell } from '@/components/ui/panel-editor'
import { PanelList } from '@/components/ui/panel-list'
import { PanelRow } from '@/components/ui/panel-row'
import { SkeletonPanelRows } from '@/components/ui/skeleton'
import { TooltipLabeled } from '@/components/ui/tooltip'
import { serviceIconProps } from '@/lib/services/icons'
import { SERVICE_CATEGORIES, SERVICE_CATEGORY_LABELS, type ServiceCategory } from '@/lib/services/manifest'
import type { ShareableService } from '@/lib/services/types'
import { HScrollFade, Badge } from '@rerun/ui/primitives'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

// Pick the app to connect for the workspace. Every catalog service shows; the ones whose
// sign-in cannot be shared yet say why instead of hiding.
export function GlobalAppConnectPage({ onBack, onPick }: { onBack: () => void; onPick: (slug: string) => void }) {
    const [services, setServices] = useState<ShareableService[] | null>(null)
    const [query, setQuery] = useState('')
    const [category, setCategory] = useState<ServiceCategory | null>(null)

    useEffect(() => {
        let active = true
        listShareableCatalogAction().then(res => {
            if (!active) return
            if (res.ok) setServices(res.services)
            else toast.error(res.error)
        })
        return () => {
            active = false
        }
    }, [])

    const shown = useMemo(() => {
        if (!services) return []
        const needle = query.trim().toLowerCase()
        return services.filter(service => {
            if (category && service.category !== category) return false
            if (!needle) return true
            return `${service.name} ${service.slug} ${service.summary}`.toLowerCase().includes(needle)
        })
    }, [services, query, category])

    return (
        <PanelEditorShell>
            <PanelEditorHeader title="Connect an app" onBack={onBack} />
            <div className="space-y-2 border-b border-border p-3">
                <Input value={query} placeholder="Search apps…" aria-label="Search apps" className="h-8 text-sm" onChange={e => setQuery(e.target.value)} />
                <HScrollFade className="-mx-1 gap-1.5 px-1" fadeClassName="from-background">
                    <Chip selected={category === null} onClick={() => setCategory(null)}>
                        All
                    </Chip>
                    {SERVICE_CATEGORIES.filter(c => c !== 'other').map(c => (
                        <Chip key={c} selected={category === c} onClick={() => setCategory(c)}>
                            {SERVICE_CATEGORY_LABELS[c]}
                        </Chip>
                    ))}
                </HScrollFade>
            </div>
            <PanelEditorBody>
                {services === null ? (
                    <SkeletonPanelRows rows={6} leading className="p-0" />
                ) : shown.length === 0 ? (
                    <p className="py-6 text-center text-xs text-muted-foreground">No app matches.</p>
                ) : (
                    <PanelList>
                        {shown.map(service => (
                            <PanelRow
                                key={service.slug}
                                leading={<Icon {...serviceIconProps(service.icon, service.category)} size="sm" />}
                                title={service.name}
                                description={service.summary}
                                actions={
                                    service.shareable ? (
                                        <Button size="sm" variant="outline" onClick={() => onPick(service.slug)}>
                                            Connect
                                        </Button>
                                    ) : (
                                        <TooltipLabeled label={service.shareableReason ?? 'Signs in per coworker for now.'}>
                                            <Badge size="xs" tone="neutral" glow={false}>
                                                Per coworker
                                            </Badge>
                                        </TooltipLabeled>
                                    )
                                }
                            />
                        ))}
                    </PanelList>
                )}
            </PanelEditorBody>
        </PanelEditorShell>
    )
}
