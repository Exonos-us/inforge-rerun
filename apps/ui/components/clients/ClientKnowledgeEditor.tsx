'use client'

import { Group } from '@/components/connections/AiProvidersPanel'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PanelRow } from '@/components/ui/panel-row'
import { Textarea } from '@/components/ui/textarea'
import { isTextSkillFile } from '@/lib/skills/folder-import'
import type { KnowledgeDoc } from '@/lib/presets/types'
import { useRef, useState } from 'react'
import { toast } from 'sonner'

// The documents written into every coworker's knowledge/ folder: acronyms, contacts, the org
// chart. Text only, and never credentials. Like the skills, they land when the page is saved.

type DocForm = { index: number | null; path: string; content: string }

function sizeOf(doc: KnowledgeDoc): string {
    const bytes = new Blob([doc.content]).size
    return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

export function ClientKnowledgeEditor({ knowledge, onChange }: { knowledge: KnowledgeDoc[]; onChange: (knowledge: KnowledgeDoc[]) => void }) {
    const [form, setForm] = useState<DocForm | null>(null)
    const uploadRef = useRef<HTMLInputElement>(null)

    const submit = () => {
        if (!form || !form.path.trim()) return
        const entry: KnowledgeDoc = { path: form.path.trim(), content: form.content }
        onChange(form.index === null ? [...knowledge, entry] : knowledge.map((doc, index) => (index === form.index ? entry : doc)))
        setForm(null)
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
        if (skipped.length) toast.warning(`${skipped.join(', ')} left out — a client carries text documents only.`)
        if (!kept.length) return
        onChange([...knowledge.filter(doc => !kept.some(file => file.path === doc.path)), ...kept])
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
            {knowledge.map((doc, index) => (
                <PanelRow
                    key={`${doc.path}-${index}`}
                    className="max-sm:flex-col max-sm:items-stretch max-sm:gap-2"
                    title={doc.path}
                    description={sizeOf(doc)}
                    actions={
                        <>
                            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setForm({ index, path: doc.path, content: doc.content })}>
                                Edit
                            </Button>
                            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => onChange(knowledge.filter((_, other) => other !== index))}>
                                Remove
                            </Button>
                        </>
                    }
                />
            ))}
            {knowledge.length === 0 && !form && <p className="rounded-md border border-dashed px-3 py-3 text-xs text-muted-foreground">No document yet. Acronyms, key contacts, the org chart — what a newcomer on this engagement would ask for.</p>}
            {form && (
                <div className="flex flex-col gap-3 rounded-md border p-3">
                    <Field label="File name" htmlFor="client-doc-path">
                        <Input id="client-doc-path" value={form.path} onChange={event => setForm({ ...form, path: event.target.value })} placeholder="acronyms.md" />
                    </Field>
                    <Field label="What it says" htmlFor="client-doc-content">
                        <Textarea id="client-doc-content" rows={6} value={form.content} onChange={event => setForm({ ...form, content: event.target.value })} placeholder="PO — Permitting Office. RFI — Request For Information…" />
                    </Field>
                    <div className="flex flex-wrap justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
                            Cancel
                        </Button>
                        <Button size="sm" disabled={!form.path.trim()} onClick={submit}>
                            {form.index === null ? 'Add document' : 'Save document'}
                        </Button>
                    </div>
                </div>
            )}
            <p className="text-xs text-muted-foreground">Written into every coworker’s knowledge folder, read like its own notes.</p>
        </Group>
    )
}
