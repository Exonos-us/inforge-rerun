import type { BadgeTone } from '@rerun/ui/primitives'

// The store's filterable areas. A preset's tags are free-form; the ones that match this list get a
// color and a filter chip, the rest render neutral. Matching ignores case so a hand-typed
// "engineering" still filters.
export const PRESET_AREAS = ['Engineering', 'Design', 'Marketing', 'Sales', 'Ops', 'Finance', 'Legal', 'Support'] as const

export type PresetArea = (typeof PRESET_AREAS)[number]

const AREA_TONES: Record<PresetArea, BadgeTone> = {
    Engineering: 'cyan',
    Design: 'brand',
    Marketing: 'orange',
    Sales: 'yellow',
    Ops: 'neutral',
    Finance: 'green',
    Legal: 'neutral',
    Support: 'neutral',
}

export function areaOfTag(tag: string): PresetArea | null {
    return PRESET_AREAS.find(area => area.toLowerCase() === tag.trim().toLowerCase()) ?? null
}

export function tagTone(tag: string): BadgeTone {
    const area = areaOfTag(tag)
    return area ? AREA_TONES[area] : 'neutral'
}

export function hasArea(tags: string[], area: PresetArea): boolean {
    return tags.some(tag => areaOfTag(tag) === area)
}
