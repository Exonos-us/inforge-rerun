'use client'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { areaOfTag, PRESET_AREAS, tagTone } from '@/lib/presets/areas'
import { Badge } from '@rerun/ui/primitives'
import { useState } from 'react'

// The tags a card wears in the store. An area tag (Engineering, Design, …) is colored and drives
// the store's filter chips; everything else is a free-form specialty. The areas not yet picked are
// offered as one-click suggestions so the filterable one is never a spelling exercise.
export function TagsEditor({ tags, onChange, idPrefix }: { tags: string[]; onChange: (tags: string[]) => void; idPrefix: string }) {
    const [draft, setDraft] = useState('')

    const add = (tag: string) => {
        const trimmed = tag.trim()
        if (!trimmed) return
        if (tags.some(other => other.toLowerCase() === trimmed.toLowerCase())) return setDraft('')
        onChange([...tags, trimmed])
        setDraft('')
    }

    const missingAreas = PRESET_AREAS.filter(area => !tags.some(tag => areaOfTag(tag) === area))

    return (
        <Field label="Tags" htmlFor={`${idPrefix}-tag`}>
            {tags.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                    {tags.map(tag => (
                        <button key={tag} type="button" title={`Remove “${tag}”`} onClick={() => onChange(tags.filter(other => other !== tag))}>
                            <Badge size="xs" tone={tagTone(tag)}>
                                {tag} ✕
                            </Badge>
                        </button>
                    ))}
                </div>
            )}
            <div className="flex items-center gap-2">
                <Input
                    id={`${idPrefix}-tag`}
                    className="h-8 flex-1 text-xs"
                    value={draft}
                    onChange={event => setDraft(event.target.value)}
                    onKeyDown={event => {
                        if (event.key === 'Enter') {
                            event.preventDefault()
                            add(draft)
                        }
                    }}
                    placeholder="Add a tag…"
                />
                <Button type="button" size="sm" variant="secondary" disabled={!draft.trim()} onClick={() => add(draft)}>
                    Add
                </Button>
            </div>
            {missingAreas.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                    <span className="text-[11px] text-muted-foreground">Areas:</span>
                    {missingAreas.map(area => (
                        <button key={area} type="button" className="rounded-full border border-dashed px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => add(area)}>
                            {area}
                        </button>
                    ))}
                </div>
            )}
        </Field>
    )
}
