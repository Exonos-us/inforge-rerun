'use client'

import { Group } from '@/components/connections/AiProvidersPanel'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PanelRow } from '@/components/ui/panel-row'
import { Textarea } from '@/components/ui/textarea'
import { clientSkillSlug } from '@/lib/clients/naming'
import { parseSkillMeta } from '@/lib/presets/skill-markdown'
import type { AuthoredSkill } from '@/lib/presets/types'
import { readSkillFolders } from '@/lib/skills/folder-import'
import { Badge } from '@rerun/ui/primitives'
import { useRef, useState } from 'react'
import { toast } from 'sonner'

// The skills every coworker of this client starts with, written here or uploaded the Claude way —
// a SKILL.md on its own, or the whole folder, because a real skill opens by telling the coworker to
// read its references and without them it improvises while believing it has the rulebook.
// Nothing leaves the draft: the detail page's one Save is what pushes them to the coworkers.

type SkillForm = { index: number | null; name: string; description: string; body: string }

export function ClientSkillsEditor({ clientId, skills, onChange }: { clientId: string; skills: AuthoredSkill[]; onChange: (skills: AuthoredSkill[]) => void }) {
    const [form, setForm] = useState<SkillForm | null>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)
    const folderInputRef = useRef<HTMLInputElement>(null)

    const submit = () => {
        if (!form || !form.name.trim()) return
        const written = { name: form.name.trim(), description: form.description.trim(), body: form.body }
        onChange(form.index === null ? [...skills, { ...written, raw: '', files: [] }] : skills.map((skill, index) => (index === form.index ? { ...skill, ...written } : skill)))
        setForm(null)
    }

    const add = (added: AuthoredSkill[]) => {
        if (!added.length) return
        onChange([...skills, ...added])
        toast.success(`${added.length} skill${added.length === 1 ? '' : 's'} added. Save to push ${added.length === 1 ? 'it' : 'them'} to the coworkers.`)
    }

    const uploadFile = async (file: File) => {
        const raw = await file.text()
        add([{ ...parseSkillMeta(raw, file.name.replace(/\.(md|markdown)$/i, '')), body: '', raw, files: [] }])
    }

    const uploadFolders = async (list: FileList) => {
        try {
            const folders = await readSkillFolders(list)
            const skipped = folders.flatMap(folder => folder.skipped)
            if (skipped.length) toast.warning(`${skipped.length} non-text file${skipped.length === 1 ? '' : 's'} left out — a client skill carries text files only.`)
            add(folders.map(folder => ({ ...parseSkillMeta(folder.content, folder.name), body: '', raw: folder.content, files: folder.files })))
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
                        <DropdownMenuItem onSelect={() => setForm({ index: null, name: '', description: '', body: '' })}>Write it from scratch</DropdownMenuItem>
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
                aria-label="Upload a SKILL.md"
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
                {...{ webkitdirectory: '' }}
                aria-label="Upload a skill folder"
                className="hidden"
                onChange={event => {
                    const list = event.target.files
                    if (list?.length) void uploadFolders(list)
                    event.target.value = ''
                }}
            />
            {skills.map((skill, index) => (
                <PanelRow
                    key={`${skill.name}-${index}`}
                    className="max-sm:flex-col max-sm:items-stretch max-sm:gap-2"
                    title={
                        <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate">{skill.name}</span>
                            {skill.raw && (
                                <Badge size="xs" tone="brand" glow={false} className="font-medium">
                                    uploaded
                                </Badge>
                            )}
                        </span>
                    }
                    description={skill.description || undefined}
                    footer={clientSkillSlug(clientId, skill.name)}
                    actions={
                        <>
                            {skill.files.length > 0 && (
                                <span className="shrink-0 text-[10px] text-muted-foreground">
                                    {skill.files.length} file{skill.files.length === 1 ? '' : 's'}
                                </span>
                            )}
                            {!skill.raw && (
                                <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setForm({ index, name: skill.name, description: skill.description, body: skill.body })}>
                                    Edit
                                </Button>
                            )}
                            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => onChange(skills.filter((_, other) => other !== index))}>
                                Remove
                            </Button>
                        </>
                    }
                />
            ))}
            {skills.length === 0 && !form && (
                <p className="rounded-md border border-dashed px-3 py-3 text-xs text-muted-foreground">No skill yet. Write one here, or upload it the Claude way — a SKILL.md on its own, or its whole folder with its reference files. Every coworker hired into a Box of this client gets it.</p>
            )}
            {form && (
                <div className="flex flex-col gap-3 rounded-md border p-3">
                    <div className="flex flex-col gap-3 sm:flex-row">
                        <Field label="Skill name" htmlFor="client-skill-name" className="flex-1">
                            <Input id="client-skill-name" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="county-doc-format" />
                        </Field>
                        <Field label="When to use it" htmlFor="client-skill-description" className="flex-[2]">
                            <Input id="client-skill-description" value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} placeholder="Writing anything the County will read" />
                        </Field>
                    </div>
                    <Field label="How it works" htmlFor="client-skill-body">
                        <Textarea id="client-skill-body" rows={5} value={form.body} onChange={event => setForm({ ...form, body: event.target.value })} placeholder="Brand, structure, reading level, and the three things the County always asks for…" />
                    </Field>
                    <div className="flex flex-wrap justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
                            Cancel
                        </Button>
                        <Button size="sm" disabled={!form.name.trim()} onClick={submit}>
                            {form.index === null ? 'Add skill' : 'Save skill'}
                        </Button>
                    </div>
                </div>
            )}
            <p className="text-xs text-muted-foreground">Installed on every hire of a Box that points at this client, under the slug shown on each row. A coworker’s own skills are never touched.</p>
        </Group>
    )
}
