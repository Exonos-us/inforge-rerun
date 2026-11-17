'use client'

import { deleteClientAction, updateClientAction, type ClientListEntry } from '@/app/api/_actions/client.actions'
import { boxCount, ClientStatusBadge, clientUsageLine } from '@/components/clients/ClientCells'
import { ClientConfluenceRow } from '@/components/clients/ClientConfluenceRow'
import { ClientKnowledgeEditor } from '@/components/clients/ClientKnowledgeEditor'
import { ClientSkillsEditor } from '@/components/clients/ClientSkillsEditor'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PanelEditorBody, PanelEditorHeader, PanelEditorShell } from '@/components/ui/panel-editor'
import type { AuthoredSkill, KnowledgeDoc } from '@/lib/presets/types'
import { useState } from 'react'
import { toast } from 'sonner'

// One client, open: what it is called, the skills and documents it carries, and the one Save that
// pushes them to every coworker standing in a Box of this client.

type Draft = { name: string; shortCode: string; skills: AuthoredSkill[]; knowledge: KnowledgeDoc[] }

function draftOf(client: ClientListEntry): Draft {
    return { name: client.name, shortCode: client.shortCode, skills: client.skills, knowledge: client.knowledgeDocs }
}

function syncLine(sync: { synced: number; pending: number }): string {
    if (sync.synced === 0 && sync.pending === 0) return 'Saved. No coworker carries this client yet.'
    const landed = `${sync.synced} coworker${sync.synced === 1 ? '' : 's'} updated`
    return sync.pending > 0 ? `${landed}, ${sync.pending} still to sync.` : `${landed}.`
}

export function ClientDetail({ client, onBack, reload }: { client: ClientListEntry; onBack: () => void; reload: () => Promise<void> }) {
    const [draft, setDraft] = useState<Draft>(() => draftOf(client))
    const [codeError, setCodeError] = useState<string | undefined>(undefined)
    const [saving, setSaving] = useState(false)
    const [deleting, setDeleting] = useState(false)

    const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(client))

    const save = async () => {
        setSaving(true)
        setCodeError(undefined)
        const result = await updateClientAction({ clientId: client.id, name: draft.name, shortCode: draft.shortCode, skills: draft.skills, knowledge: draft.knowledge }).catch(() => null)
        setSaving(false)
        if (!result) return toast.error('Could not save the client')
        // The short-code collision is the one error that belongs on an input rather than in a
        // toast: it is the field the user has to change.
        if ('field' in result) return setCodeError(result.error)
        if (!result.ok) return toast.error(result.error)
        for (const warning of result.sync.warnings.slice(0, 2)) toast.warning(warning)
        toast.success(syncLine(result.sync))
        await reload()
    }

    const remove = async () => {
        setDeleting(true)
        const result = await deleteClientAction({ clientId: client.id }).catch(() => null)
        setDeleting(false)
        if (!result) return toast.error('Could not delete the client')
        if (!result.ok) return toast.error(result.error)
        toast.success(`“${client.name}” deleted.`)
        onBack()
        await reload()
    }

    const deleteDescription =
        client.boxes.length === 0
            ? 'No Box points at it, so nothing changes anywhere else.'
            : `${boxCount(client.boxes.length)} lose their client (${client.boxes.map(box => box.name).join(', ')}). The skills and documents already installed stay on their ${client.coworkers} coworker${client.coworkers === 1 ? '' : 's'}: nothing is removed from a live engagement.`

    const saveLabel = client.coworkers > 0 ? `Save and sync ${client.coworkers} coworker${client.coworkers === 1 ? '' : 's'}` : 'Save'

    const saveButton = (
        <Button size="sm" disabled={!dirty} loading={saving} onClick={client.coworkers > 0 ? undefined : save}>
            {saveLabel}
        </Button>
    )

    return (
        <PanelEditorShell>
            <PanelEditorHeader title={client.name} onBack={onBack}>
                <ClientStatusBadge coworkers={client.coworkers} pending={client.pending} />
            </PanelEditorHeader>
            <PanelEditorBody>
                <p className="text-xs text-muted-foreground">{clientUsageLine(client)}</p>

                <div className="flex flex-col gap-3 sm:flex-row">
                    <Field label="Name" htmlFor="client-name" className="flex-[2]">
                        <Input id="client-name" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} />
                    </Field>
                    <Field label="Short code" htmlFor="client-short-code" className="flex-1" error={codeError}>
                        <Input
                            id="client-short-code"
                            aria-invalid={codeError ? true : undefined}
                            value={draft.shortCode}
                            onChange={event => {
                                setCodeError(undefined)
                                setDraft({ ...draft, shortCode: event.target.value })
                            }}
                        />
                    </Field>
                </div>
                <p className="-mt-1 text-xs text-muted-foreground">
                    Names Boxes, channels and coworkers: <span className="font-mono">{draft.shortCode.trim() || 'mdc'}-permitting-po</span>, <span className="font-mono">#{draft.shortCode.trim() || 'mdc'}-permitting</span>.
                </p>

                <ClientSkillsEditor clientId={client.id} skills={draft.skills} onChange={skills => setDraft({ ...draft, skills })} />
                <ClientKnowledgeEditor knowledge={draft.knowledge} onChange={knowledge => setDraft({ ...draft, knowledge })} />
                <ClientConfluenceRow confluence={client.confluence} />
            </PanelEditorBody>

            <div className="flex flex-wrap items-center gap-2 border-t border-border p-3">
                <ConfirmDialog title={`Delete “${client.name}”?`} description={deleteDescription} confirmLabel="Delete client" pending={deleting} onConfirm={remove}>
                    <Button size="sm" variant="ghost" className="text-destructive">
                        Delete client
                    </Button>
                </ConfirmDialog>
                <div className="ml-auto flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={onBack}>
                        Cancel
                    </Button>
                    {client.coworkers > 0 ? (
                        <ConfirmDialog
                            title={`Update ${client.coworkers} coworker${client.coworkers === 1 ? '' : 's'}?`}
                            description={`${boxCount(client.boxes.length)} work to this client: ${client.boxes.map(box => box.name).join(', ')}. Their own skills and instructions are untouched — only this client’s are replaced.`}
                            confirmLabel="Update them"
                            confirmVariant="default"
                            pending={saving}
                            onConfirm={save}
                        >
                            {saveButton}
                        </ConfirmDialog>
                    ) : (
                        saveButton
                    )}
                </div>
            </div>
        </PanelEditorShell>
    )
}
