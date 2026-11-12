'use client'

import { deletePresetAction, updatePresetAction } from '@/app/api/_actions/preset.actions'
import type { CoworkerPresetView } from '@/app/api/_services/preset.service'
import { Group } from '@/components/connections/AiProvidersPanel'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field } from '@/components/ui/field'
import { Icon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { PanelRow } from '@/components/ui/panel-row'
import { Textarea } from '@/components/ui/textarea'
import { listCatalogServicesAction } from '@/app/api/_actions/services.actions'
import type { ServiceSearchResult } from '@/lib/services/types'
import { useCatalogServices } from '@/hooks/useCatalogServices'
import { ChevronLeftIcon } from '@/lib/icons'
import { slugOf } from '@/lib/presets/naming'
import type { AuthoredRoutine, AuthoredSkill, KnowledgeDoc, PresetQuestion } from '@/lib/presets/types'
import { isTextSkillFile, readSkillFolders } from '@/lib/skills/folder-import'
import { serviceIconProps } from '@/lib/services/icons'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { guarded } from './action-guard'
import { PresetHireDialog } from './PresetHireDialog'
import { nextPresetIcon, presetGlyph } from './preset-icons'
import { TagsEditor } from './TagsEditor'

// One coworker of the store, opened: a rail of sections on the left — a definition has many parts
// and the list will keep growing — and everything editable. The text fields share one draft and
// one save bar that names what changed; the list sections (skills, apps, questions) apply their
// operations on the spot.
const SECTION_IDS = ['identity', 'instructions', 'skills', 'routines', 'apps', 'knowledge'] as const

type SectionId = (typeof SECTION_IDS)[number]

type Draft = { name: string; role: string; description: string; tags: string[]; soul: string }

function draftOf(preset: CoworkerPresetView): Draft {
    return { name: preset.name, role: preset.role, description: preset.description, tags: preset.tags, soul: preset.soul ?? '' }
}

export function PresetDetailPage({ preset, onBack, reload, onHired }: { preset: CoworkerPresetView; onBack: () => void; reload: () => Promise<void>; onHired: () => void }) {
    const scrollerRef = useRef<HTMLDivElement>(null)
    const [active, setActive] = useState<SectionId>('identity')
    const [draft, setDraft] = useState<Draft>(() => draftOf(preset))
    const [saving, setSaving] = useState(false)

    // A reload hands back the saved values; the draft follows so the bar disappears.
    useEffect(() => {
        setDraft(draftOf(preset))
    }, [preset])

    const base = draftOf(preset)
    const fields: { label: string; key: keyof Draft }[] = [
        { label: 'Name', key: 'name' },
        { label: 'Role', key: 'role' },
        { label: 'Description', key: 'description' },
        { label: 'Tags', key: 'tags' },
        { label: 'Instructions', key: 'soul' },
    ]
    const changed = fields.filter(field => JSON.stringify(draft[field.key]) !== JSON.stringify(base[field.key]))

    const save = async () => {
        if (!draft.name.trim()) return toast.error('The coworker needs a name.')
        setSaving(true)
        const patch = Object.fromEntries(changed.map(field => [field.key, draft[field.key]]))
        const result = await guarded(() => updatePresetAction({ presetId: preset.id, ...patch }))
        setSaving(false)
        if (!result) return
        if (!result.ok) return toast.error(result.error)
        await reload()
        toast.success('Saved')
    }

    const sections: { id: SectionId; label: string; count?: number }[] = [
        { id: 'identity', label: 'Identity' },
        { id: 'instructions', label: 'Instructions' },
        { id: 'skills', label: 'Skills', count: preset.summary.skills.length + preset.authoredSkills.length },
        { id: 'routines', label: 'Routines', count: preset.summary.schedules.length + preset.authoredRoutines.length },
        { id: 'apps', label: 'Apps', count: preset.connectorSlugs.length },
        { id: 'knowledge', label: 'Knowledge', count: preset.knowledgeDocs.length },
    ]

    const scrollTo = (id: SectionId) => {
        setActive(id)
        scrollerRef.current?.querySelector(`[data-section="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }

    // Scroll spy: the active section is the last one whose top has passed the scroller's top.
    useEffect(() => {
        const scroller = scrollerRef.current
        if (!scroller) return
        const onScroll = () => {
            const top = scroller.getBoundingClientRect().top + 60
            let current: SectionId = 'identity'
            for (const id of SECTION_IDS) {
                const el = scroller.querySelector(`[data-section="${id}"]`)
                if (el && el.getBoundingClientRect().top <= top) current = id
            }
            setActive(current)
        }
        scroller.addEventListener('scroll', onScroll, { passive: true })
        return () => scroller.removeEventListener('scroll', onScroll)
    }, [])

    const cycleIcon = async () => {
        const result = await guarded(() => updatePresetAction({ presetId: preset.id, icon: nextPresetIcon(preset.icon) }))
        if (!result) return
        if (!result.ok) return toast.error(result.error)
        await reload()
    }

    const rail = sections.map(section => (
        <button
            key={section.id}
            type="button"
            className={`flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${active === section.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => scrollTo(section.id)}
        >
            <span className="truncate">{section.label}</span>
            {section.count !== undefined && section.count > 0 && <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">{section.count}</span>}
        </button>
    ))

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-3 border-b px-3 py-2.5">
                <Button aria-label="Back to presets" variant="ghost" size="icon-sm" className="shrink-0" onClick={onBack}>
                    <ChevronLeftIcon className="size-4" />
                </Button>
                <button type="button" aria-label="Change icon" title="Change icon" className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-lg" onClick={cycleIcon}>
                    {presetGlyph(preset.icon)}
                </button>
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{preset.name}</span>
                    <span className="truncate text-[11px] text-muted-foreground">
                        {preset.role || 'Coworker'} · hired {preset.hires}× · {preset.captured ? 'captured from a live coworker' : 'written from scratch'}
                    </span>
                </div>
                <DeletePresetButton presetId={preset.id} presetName={preset.name} onDeleted={onBack} reload={reload} />
                <PresetHireDialog preset={preset} onHired={onHired}>
                    <Button size="sm" className="shrink-0">
                        Hire
                    </Button>
                </PresetHireDialog>
            </div>

            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
                <nav className="hidden w-40 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2 md:flex">{rail}</nav>
                <nav className="flex shrink-0 gap-0.5 overflow-x-auto border-b p-1.5 [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden">{rail}</nav>

                <div ref={scrollerRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
                    <div className="flex flex-col gap-6 p-4">
                        <section data-section="identity" className="scroll-mt-2">
                            <IdentitySection draft={draft} onChange={setDraft} />
                        </section>

                        <section data-section="instructions" className="scroll-mt-2">
                            <InstructionsSection preset={preset} draft={draft} onChange={setDraft} reload={reload} />
                        </section>

                        <section data-section="skills" className="scroll-mt-2">
                            <SkillsSection preset={preset} reload={reload} />
                        </section>

                        <section data-section="routines" className="scroll-mt-2">
                            <RoutinesSection preset={preset} reload={reload} />
                        </section>

                        <section data-section="apps" className="scroll-mt-2">
                            <AppsSection preset={preset} reload={reload} />
                        </section>

                        <section data-section="knowledge" className="scroll-mt-2">
                            <KnowledgeSection preset={preset} reload={reload} />
                        </section>

                    </div>
                </div>
            </div>

            {changed.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-4 py-2.5">
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        You changed {humanList(changed.map(field => field.label))} — not saved yet.
                    </span>
                    <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(draftOf(preset))}>
                        Discard
                    </Button>
                    <Button size="sm" loading={saving} onClick={save}>
                        Save {changed.length} change{changed.length === 1 ? '' : 's'}
                    </Button>
                </div>
            )}
        </div>
    )
}

function humanList(items: string[]): string {
    if (items.length === 1) return items[0]
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

// The name and description a SKILL.md declares in its frontmatter, for the row the store shows.
// The raw text stays untouched: it is what the hire imports.
function parseSkillMeta(content: string, fallback: string): { name: string; description: string } {
    const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? ''
    const pick = (key: string) =>
        frontmatter
            .match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]
            .trim()
            .replace(/^['"]|['"]$/g, '') ?? ''
    return { name: pick('name') || fallback, description: pick('description') }
}

function IdentitySection({ draft, onChange }: { draft: Draft; onChange: (draft: Draft) => void }) {
    return (
        <Group title="Identity">
            <div className="flex flex-col gap-3 sm:flex-row">
                <Field label="Name" htmlFor="preset-name" className="flex-1">
                    <Input id="preset-name" value={draft.name} onChange={e => onChange({ ...draft, name: e.target.value })} />
                </Field>
                <Field label="Role" htmlFor="preset-role" className="flex-1">
                    <Input id="preset-role" value={draft.role} onChange={e => onChange({ ...draft, role: e.target.value })} placeholder="Project Engineer" />
                </Field>
            </div>
            <Field label="Description — the card's pitch in the store" htmlFor="preset-description">
                <Textarea id="preset-description" rows={2} value={draft.description} onChange={e => onChange({ ...draft, description: e.target.value })} />
            </Field>
            <TagsEditor tags={draft.tags} onChange={tags => onChange({ ...draft, tags })} idPrefix="preset" />
        </Group>
    )
}

function InstructionsSection({ preset, draft, onChange, reload }: { preset: CoworkerPresetView; draft: Draft; onChange: (draft: Draft) => void; reload: () => Promise<void> }) {
    const missing = preset.captured && preset.soul === null
    return (
        <Group title="Instructions">
            <Field label="Every hire starts from these, word for word" htmlFor="preset-soul">
                <Textarea id="preset-soul" rows={8} value={draft.soul} onChange={e => onChange({ ...draft, soul: e.target.value })} placeholder="You are a project engineer. You own the repo you are given at hire…" />
            </Field>
            <p className="text-xs text-muted-foreground">
                {missing
                    ? 'This preset was captured before instructions were stored: hires use the archive’s. Write them here to take over, or save the coworker again to load them.'
                    : preset.captured
                      ? 'Loaded from the capture; edits here win over the archive at every hire.'
                      : 'The soul of every coworker hired from this preset.'}
            </p>
            <QuestionsEditor preset={preset} reload={reload} />
        </Group>
    )
}

// Skills in two layers: what the capture carries (read-only, refreshed by re-saving the coworker)
// and the ones the preset itself holds — written in the form, or uploaded the Claude way: a
// SKILL.md, alone or with its folder of reference files.
type SkillForm = { index: number | null; name: string; description: string; body: string; files: { path: string; content: string }[] }

function SkillsSection({ preset, reload }: { preset: CoworkerPresetView; reload: () => Promise<void> }) {
    const [form, setForm] = useState<SkillForm | null>(null)
    const [saving, setSaving] = useState(false)
    const fileInputRef = useRef<HTMLInputElement>(null)
    const folderInputRef = useRef<HTMLInputElement>(null)
    const attachInputRef = useRef<HTMLInputElement>(null)

    const save = async (skills: AuthoredSkill[]) => {
        setSaving(true)
        const result = await guarded(() => updatePresetAction({ presetId: preset.id, skills }))
        setSaving(false)
        if (!result) return false
        if (!result.ok) {
            toast.error(result.error)
            return false
        }
        await reload()
        return true
    }

    const submit = async () => {
        if (!form || !form.name.trim()) return
        const entry: AuthoredSkill = { name: form.name.trim(), description: form.description.trim(), body: form.body, raw: '', files: form.files }
        const next = form.index === null ? [...preset.authoredSkills, entry] : preset.authoredSkills.map((skill, index) => (index === form.index ? entry : skill))
        if (await save(next)) setForm(null)
    }

    const attach = async (list: FileList) => {
        if (!form) return
        const kept: { path: string; content: string }[] = []
        const skipped: string[] = []
        for (const file of Array.from(list)) {
            if (!isTextSkillFile(file.name)) {
                skipped.push(file.name)
                continue
            }
            kept.push({ path: file.name, content: await file.text() })
        }
        if (skipped.length) toast.warning(`${skipped.join(', ')} left out — a preset skill carries text files only.`)
        if (kept.length) setForm({ ...form, files: [...form.files.filter(existing => !kept.some(file => file.path === existing.path)), ...kept] })
    }

    const uploadFile = async (file: File) => {
        const raw = await file.text()
        const meta = parseSkillMeta(raw, file.name.replace(/\.(md|markdown)$/i, ''))
        if (await save([...preset.authoredSkills, { ...meta, body: '', raw, files: [] }])) toast.success(`“${meta.name}” added to the preset.`)
    }

    const uploadFolders = async (files: FileList) => {
        try {
            const folders = await readSkillFolders(files)
            const added: AuthoredSkill[] = folders.map(folder => ({ ...parseSkillMeta(folder.content, folder.name), body: '', raw: folder.content, files: folder.files }))
            const skipped = folders.flatMap(folder => folder.skipped)
            if (skipped.length) toast.warning(`${skipped.length} non-text file${skipped.length === 1 ? '' : 's'} left out — a preset skill carries text files only.`)
            if (added.length && (await save([...preset.authoredSkills, ...added]))) toast.success(`${added.length} skill${added.length === 1 ? '' : 's'} added to the preset.`)
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Could not read the skill folder')
        }
    }

    return (
        <Group
            title="Skills"
            addMenu={
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button size="xs" variant="secondary">
                            + Add skill
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setForm({ index: null, name: '', description: '', body: '', files: [] })}>Write it from scratch</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => folderInputRef.current?.click()}>Upload a skill folder</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>Upload a SKILL.md</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            }
        >
            <input
                ref={fileInputRef}
                type="file"
                accept=".md,.markdown"
                className="hidden"
                onChange={event => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (file) void uploadFile(file)
                }}
            />
            <input
                ref={folderInputRef}
                type="file"
                multiple
                className="hidden"
                {...{ webkitdirectory: '' }}
                onChange={event => {
                    const files = event.target.files
                    if (files?.length) void uploadFolders(files)
                    event.target.value = ''
                }}
            />
            {preset.summary.skills.map(skill => (
                <PanelRow key={skill.name} title={skill.name} description={skill.description || undefined} actions={<span className="text-[10px] text-muted-foreground uppercase">capture</span>} />
            ))}
            {preset.authoredSkills.map((skill, index) => (
                <PanelRow
                    key={`${skill.name}-${index}`}
                    title={skill.name}
                    description={skill.description || undefined}
                    actions={
                        <>
                            {skill.files.length > 0 && (
                                <span className="text-[10px] text-muted-foreground">
                                    {skill.files.length} file{skill.files.length === 1 ? '' : 's'}
                                </span>
                            )}
                            {!skill.raw && (
                                <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setForm({ index, name: skill.name, description: skill.description, body: skill.body, files: skill.files })}>
                                    Edit
                                </Button>
                            )}
                            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => save(preset.authoredSkills.filter((_, other) => other !== index))}>
                                Remove
                            </Button>
                        </>
                    }
                />
            ))}
            {preset.summary.skills.length === 0 && preset.authoredSkills.length === 0 && !form && (
                <p className="rounded-md border border-dashed px-3 py-3 text-xs text-muted-foreground">
                    No skill yet. Write one in the form, or upload it the Claude way — a SKILL.md alone, or its whole folder with reference files{preset.captured ? ' — beside what the capture carries' : ''}.
                </p>
            )}
            {form && (
                <div className="flex flex-col gap-3 rounded-md border p-3">
                    <div className="flex flex-col gap-3 sm:flex-row">
                        <Field label="Skill name" htmlFor="skill-name" className="flex-1">
                            <Input id="skill-name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="release-notes" />
                        </Field>
                        <Field label="When to use it" htmlFor="skill-description" className="flex-[2]">
                            <Input id="skill-description" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Turning merged PRs into release notes" />
                        </Field>
                    </div>
                    <Field label="How it works" htmlFor="skill-body">
                        <Textarea id="skill-body" rows={5} value={form.body} onChange={e => setForm({ ...form, body: e.target.value })} placeholder="Read the merged PRs since the last tag, group them by area, write one line per change a customer understands…" />
                    </Field>
                    <input
                        ref={attachInputRef}
                        type="file"
                        multiple
                        aria-label="Attach skill files"
                        className="hidden"
                        onChange={event => {
                            const list = event.target.files
                            if (list?.length) void attach(list)
                            event.target.value = ''
                        }}
                    />
                    <div className="flex flex-wrap items-center gap-1.5">
                        {form.files.map(file => (
                            <button key={file.path} type="button" title={`Remove ${file.path}`} className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] hover:border-foreground/30" onClick={() => setForm({ ...form, files: form.files.filter(other => other.path !== file.path) })}>
                                {file.path} <span className="text-muted-foreground">✕</span>
                            </button>
                        ))}
                        <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => attachInputRef.current?.click()}>
                            + Attach files
                        </Button>
                        <span className="text-[11px] text-muted-foreground">Scripts and reference docs the instructions can call — a hire gets them beside the SKILL.md.</span>
                    </div>
                    <div className="flex justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
                            Cancel
                        </Button>
                        <Button size="sm" loading={saving} disabled={!form.name.trim()} onClick={submit}>
                            {form.index === null ? 'Add skill' : 'Save skill'}
                        </Button>
                    </div>
                </div>
            )}
            {preset.captured && preset.summary.skills.length > 0 && <p className="text-xs text-muted-foreground">Capture skills refresh when the coworker is saved again; the ones written here belong to the preset and are created on every hire.</p>}
        </Group>
    )
}

// Routines in the same two layers as skills: the capture's (read-only) and the preset's own,
// created as live schedules on every hire.
type RoutineForm = { index: number | null; name: string; cron: string; body: string }

function RoutinesSection({ preset, reload }: { preset: CoworkerPresetView; reload: () => Promise<void> }) {
    const [form, setForm] = useState<RoutineForm | null>(null)
    const [saving, setSaving] = useState(false)

    const save = async (routines: AuthoredRoutine[]) => {
        setSaving(true)
        const result = await guarded(() => updatePresetAction({ presetId: preset.id, routines }))
        setSaving(false)
        if (!result) return false
        if (!result.ok) {
            toast.error(result.error)
            return false
        }
        await reload()
        return true
    }

    const submit = async () => {
        if (!form || !form.name.trim()) return
        const entry: AuthoredRoutine = { name: form.name.trim(), cron: form.cron.trim(), body: form.body }
        const next = form.index === null ? [...preset.authoredRoutines, entry] : preset.authoredRoutines.map((routine, index) => (index === form.index ? entry : routine))
        if (await save(next)) setForm(null)
    }

    return (
        <Group title="Routines" addMenu={<AddButtonInline label="Add routine" onClick={() => setForm({ index: null, name: '', cron: '0 9 * * 1-5', body: '' })} />}>
            {preset.summary.schedules.map(schedule => (
                <PanelRow key={schedule.name} title={schedule.name} description={schedule.cron} actions={<span className="text-[10px] text-muted-foreground uppercase">capture</span>} />
            ))}
            {preset.authoredRoutines.map((routine, index) => (
                <PanelRow
                    key={`${routine.name}-${index}`}
                    title={routine.name}
                    description={routine.cron || 'No schedule yet'}
                    actions={
                        <>
                            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setForm({ index, ...routine })}>
                                Edit
                            </Button>
                            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => save(preset.authoredRoutines.filter((_, other) => other !== index))}>
                                Remove
                            </Button>
                        </>
                    }
                />
            ))}
            {preset.summary.schedules.length === 0 && preset.authoredRoutines.length === 0 && !form && (
                <p className="rounded-md border border-dashed px-3 py-3 text-xs text-muted-foreground">No routine yet. Write one here and every hire starts with it scheduled{preset.captured ? ', beside what the capture carries' : ''}.</p>
            )}
            {form && (
                <div className="flex flex-col gap-3 rounded-md border p-3">
                    <div className="flex flex-col gap-3 sm:flex-row">
                        <Field label="Routine name" htmlFor="routine-name" className="flex-1">
                            <Input id="routine-name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Morning standup" />
                        </Field>
                        <Field label="When (cron)" htmlFor="routine-cron" className="w-full sm:w-44">
                            <Input id="routine-cron" className="font-mono" value={form.cron} onChange={e => setForm({ ...form, cron: e.target.value })} placeholder="0 9 * * 1-5" />
                        </Field>
                    </div>
                    <Field label="What it does each run" htmlFor="routine-body">
                        <Textarea id="routine-body" rows={4} value={form.body} onChange={e => setForm({ ...form, body: e.target.value })} placeholder="Post yesterday / today / blockers to the project channel, two lines each." />
                    </Field>
                    <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">Cron, five fields: minute hour day month weekday — 0 9 * * 1-5 is weekdays at 9:00.</span>
                        <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
                            Cancel
                        </Button>
                        <Button size="sm" loading={saving} disabled={!form.name.trim()} onClick={submit}>
                            {form.index === null ? 'Add routine' : 'Save routine'}
                        </Button>
                    </div>
                </div>
            )}
        </Group>
    )
}

// Knowledge the preset carries: text documents written into every hire's files under knowledge/,
// read like its own notes. Written here or uploaded; never credentials, never binaries.
type DocForm = { index: number | null; path: string; content: string }

function KnowledgeSection({ preset, reload }: { preset: CoworkerPresetView; reload: () => Promise<void> }) {
    const [form, setForm] = useState<DocForm | null>(null)
    const [saving, setSaving] = useState(false)
    const uploadRef = useRef<HTMLInputElement>(null)

    const save = async (knowledge: KnowledgeDoc[]) => {
        setSaving(true)
        const result = await guarded(() => updatePresetAction({ presetId: preset.id, knowledge }))
        setSaving(false)
        if (!result) return false
        if (!result.ok) {
            toast.error(result.error)
            return false
        }
        await reload()
        return true
    }

    const submit = async () => {
        if (!form || !form.path.trim()) return
        const entry: KnowledgeDoc = { path: form.path.trim(), content: form.content }
        const next = form.index === null ? [...preset.knowledgeDocs, entry] : preset.knowledgeDocs.map((doc, index) => (index === form.index ? entry : doc))
        if (await save(next)) setForm(null)
    }

    const upload = async (list: FileList) => {
        const kept: KnowledgeDoc[] = []
        const skipped: string[] = []
        for (const file of Array.from(list)) {
            if (!isTextSkillFile(file.name)) {
                skipped.push(file.name)
                continue
            }
            kept.push({ path: file.name, content: await file.text() })
        }
        if (skipped.length) toast.warning(`${skipped.join(', ')} left out — preset knowledge carries text files only.`)
        if (kept.length && (await save([...preset.knowledgeDocs.filter(doc => !kept.some(file => file.path === doc.path)), ...kept]))) toast.success(`${kept.length} document${kept.length === 1 ? '' : 's'} added.`)
    }

    return (
        <Group
            title="Knowledge"
            addMenu={
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button size="xs" variant="secondary">
                            + Add document
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setForm({ index: null, path: '', content: '' })}>Write a note</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => uploadRef.current?.click()}>Upload text files</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            }
        >
            <input
                ref={uploadRef}
                type="file"
                multiple
                aria-label="Upload knowledge files"
                className="hidden"
                onChange={event => {
                    const list = event.target.files
                    if (list?.length) void upload(list)
                    event.target.value = ''
                }}
            />
            {preset.knowledgeDocs.map((doc, index) => (
                <PanelRow
                    key={`${doc.path}-${index}`}
                    title={doc.path}
                    description={`${Math.max(1, Math.round(doc.content.length / 1000))} k characters`}
                    actions={
                        <>
                            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setForm({ index, path: doc.path, content: doc.content })}>
                                Edit
                            </Button>
                            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => save(preset.knowledgeDocs.filter((_, other) => other !== index))}>
                                Remove
                            </Button>
                        </>
                    }
                />
            ))}
            {preset.knowledgeDocs.length === 0 && !form && (
                <p className="rounded-md border border-dashed px-3 py-3 text-xs text-muted-foreground">Nothing yet. Notes and documents added here land in every hire's files under knowledge/ — playbooks, conventions, the things it should read before working.</p>
            )}
            {form && (
                <div className="flex flex-col gap-3 rounded-md border p-3">
                    <Field label="File name" htmlFor="doc-path">
                        <Input id="doc-path" className="font-mono" value={form.path} onChange={e => setForm({ ...form, path: e.target.value })} placeholder="conventions.md" />
                    </Field>
                    <Field label="Content" htmlFor="doc-content">
                        <Textarea id="doc-content" rows={6} value={form.content} onChange={e => setForm({ ...form, content: e.target.value })} placeholder="How we name branches, what a done ticket looks like, who signs off on what…" />
                    </Field>
                    <div className="flex justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
                            Cancel
                        </Button>
                        <Button size="sm" loading={saving} disabled={!form.path.trim()} onClick={submit}>
                            {form.index === null ? 'Add document' : 'Save document'}
                        </Button>
                    </div>
                </div>
            )}
            {preset.knowledgeDocs.length > 0 && <p className="text-xs text-muted-foreground">Written to every hire's files under knowledge/ at hire — it reads them like its own notes.</p>}
        </Group>
    )
}

// The apps the preset assigns: added from the catalog here, marked "needs setup" on each hire so
// its own card asks for the keys. Never credentials.
function AppsSection({ preset, reload }: { preset: CoworkerPresetView; reload: () => Promise<void> }) {
    const { resolved } = useCatalogServices(preset.connectorSlugs)
    const [picking, setPicking] = useState(false)
    const [query, setQuery] = useState('')
    const [catalog, setCatalog] = useState<ServiceSearchResult[] | null>(null)

    useEffect(() => {
        if (!picking || catalog) return
        listCatalogServicesAction({ limit: 400 })
            .then(setCatalog)
            .catch(() => toast.error('The app catalog did not load.'))
    }, [picking, catalog])

    const save = async (connectorSlugs: string[]) => {
        const result = await guarded(() => updatePresetAction({ presetId: preset.id, connectorSlugs }))
        if (!result) return
        if (!result.ok) return toast.error(result.error)
        await reload()
    }

    const matches = (catalog ?? [])
        .filter(service => !preset.connectorSlugs.includes(service.slug))
        .filter(service => !query.trim() || `${service.name} ${service.slug} ${service.category}`.toLowerCase().includes(query.trim().toLowerCase()))
        .slice(0, 6)

    return (
        <Group title="Apps" addMenu={<AddButtonInline label="Add app" onClick={() => setPicking(!picking)} />}>
            {preset.connectorSlugs.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {preset.connectorSlugs.map(slug => (
                        <button key={slug} type="button" title={`Remove ${resolved.get(slug)?.name ?? slug}`} className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs hover:border-foreground/30" onClick={() => save(preset.connectorSlugs.filter(other => other !== slug))}>
                            <Icon {...serviceIconProps(resolved.get(slug)?.icon ?? null, 'productivity')} size="xs" />
                            {resolved.get(slug)?.name ?? slug}
                            <span className="text-muted-foreground">✕</span>
                        </button>
                    ))}
                </div>
            )}
            {preset.connectorSlugs.length === 0 && !picking && <p className="rounded-md border border-dashed px-3 py-3 text-xs text-muted-foreground">No app assigned. Add one and every hire asks for its keys on its own card — credentials never enter the preset.</p>}
            {picking && (
                <div aria-label="App catalog results" className="flex flex-col gap-1.5 rounded-md border p-3">
                    <Input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search the catalog — GitHub, Notion, Stripe…" className="h-8 text-xs" aria-label="Search apps" />
                    {catalog === null ? (
                        <p className="px-1 py-2 text-xs text-muted-foreground">Loading the catalog…</p>
                    ) : matches.length === 0 ? (
                        <p className="px-1 py-2 text-xs text-muted-foreground">Nothing matches.</p>
                    ) : (
                        matches.map(service => (
                            <button
                                key={service.slug}
                                type="button"
                                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                                onClick={() => {
                                    setPicking(false)
                                    setQuery('')
                                    void save([...preset.connectorSlugs, service.slug])
                                }}
                            >
                                <Icon {...serviceIconProps(service.icon, 'productivity')} size="xs" />
                                <span className="font-medium">{service.name}</span>
                                <span className="truncate text-muted-foreground">{service.summary}</span>
                            </button>
                        ))
                    )}
                </div>
            )}
            <p className="text-xs text-muted-foreground">Assigned, not set up: a hire that needs one of these asks for its keys on its own card.{preset.captured ? ' Apps inside the capture come along regardless; removing one here does not strip it from the archive.' : ''}</p>
        </Group>
    )
}

function AddButtonInline({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <Button size="xs" variant="secondary" onClick={onClick}>
            + {label}
        </Button>
    )
}

// The questions whose answers are per-project: the hire wizard turns them into a fill-in-the-blanks
// step, and the answers land as memories on every coworker of the hire.
function QuestionsEditor({ preset, reload }: { preset: CoworkerPresetView; reload: () => Promise<void> }) {
    const [draft, setDraft] = useState('')

    const save = async (questions: PresetQuestion[]) => {
        const result = await guarded(() => updatePresetAction({ presetId: preset.id, questions }))
        if (!result) return
        if (!result.ok) return toast.error(result.error)
        await reload()
    }

    const add = async () => {
        const question = draft.trim()
        if (!question) return
        setDraft('')
        await save([...preset.questions, { key: `${slugOf(question).slice(0, 40) || 'question'}-${preset.questions.length}`, question, multiline: false }])
    }

    return (
        <div className="mt-1 flex flex-col gap-2 border-t pt-3">
            {preset.questions.map(question => (
                <PanelRow
                    key={question.key}
                    title={question.question}
                    actions={
                        <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => save(preset.questions.filter(other => other.key !== question.key))}>
                            Remove
                        </Button>
                    }
                />
            ))}
            <div className="flex items-end gap-2">
                <Field label="Blanks asked at every hire" htmlFor="preset-question" className="flex-1">
                    <Input
                        id="preset-question"
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') void add()
                        }}
                        placeholder="Where does this project's code live?"
                    />
                </Field>
                <Button size="sm" variant="secondary" disabled={!draft.trim()} onClick={add}>
                    Add
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">The instructions are fixed, these are the blanks: each hire answers them once and the answers land in its memory.</p>
        </div>
    )
}

function DeletePresetButton({ presetId, presetName, onDeleted, reload }: { presetId: string; presetName: string; onDeleted: () => void; reload: () => Promise<void> }) {
    const remove = async () => {
        const result = await guarded(() => deletePresetAction({ presetId }))
        if (!result) return
        if (!result.ok) return toast.error(result.error)
        toast.success('Preset deleted')
        await reload()
        onDeleted()
    }

    return (
        <ConfirmDialog
            title={`Delete “${presetName}”?`}
            description="The saved definition and its archive are gone for good. Coworkers already hired from it are not touched."
            confirmLabel="Delete preset"
            onConfirm={remove}
        >
            <Button size="xs" variant="ghost" className="text-muted-foreground">
                Delete
            </Button>
        </ConfirmDialog>
    )
}
