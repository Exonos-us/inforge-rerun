'use client'

import { IMPORT_SOURCES, type ImportSourceId } from '@/lib/agent-import/sources'
import { cn } from '@/lib/utils'
import { MODEL_ICONS } from '@rerun/ui/beams'
import Image from 'next/image'
import type { ReactNode } from 'react'

const SOURCE_MARKS: Record<ImportSourceId, ReactNode> = {
    openclaw: <Image src="/og/competitors/openclaw.svg" alt="" width={14} height={14} className="size-3.5 shrink-0" />,
    hermes: <Image src="/og/competitors/hermes.png" alt="" width={14} height={14} className="size-3.5 shrink-0 rounded-[3px]" />,
    grok: <MODEL_ICONS.grok className="size-3.5 shrink-0" />,
    other: null,
}

// The sibling of McpClientPicker, so the two connect panels read the same: a wrapping row of
// chips that survives the mobile bottom sheet.
export function ImportSourcePicker({ value, onChange, className }: { value: ImportSourceId | null; onChange: (source: ImportSourceId) => void; className?: string }) {
    return (
        <div className={cn('flex flex-wrap gap-1.5', className)}>
            {IMPORT_SOURCES.map(source => {
                const active = source.id === value
                return (
                    <button
                        key={source.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onChange(source.id)}
                        className={cn(
                            'flex h-8 items-center gap-1.5 rounded-md border bg-background/40 px-3 text-xs font-medium transition-colors',
                            'text-muted-foreground hover:border-foreground/20 hover:text-foreground',
                            active && 'border-primary/40 text-primary ring-1 ring-primary/40',
                        )}
                    >
                        {SOURCE_MARKS[source.id]}
                        {source.label}
                    </button>
                )
            })}
        </div>
    )
}
