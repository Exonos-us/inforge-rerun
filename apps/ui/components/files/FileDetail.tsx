'use client'

import type { SaveFileResult } from '@/app/api/_services/file.service'
import { Button } from '@/components/ui/button'
import { PanelEditorHeader, PanelEditorShell } from '@/components/ui/panel-editor'
import { editDisabledTooltip, fileEditBlockReason } from '@/lib/files/editable'
import { ChevronLeftIcon, ChevronRightIcon } from '@/lib/icons'
import { useCallback, useEffect, useRef, useState } from 'react'

import { FileDetailActions } from './FileDetailActions'
import { FileEditorDialog } from './FileEditorDialog'
import { FilePreview } from './FilePreview'
import { useFileContent } from './useFileContent'
import type { SiblingFiles } from './useSiblingFiles'

type FileDetailProps = {
    name: string
    path: string
    rawUrl: string
    readFile: (path: string) => Promise<{ content: string; truncated: boolean }>
    siblings?: SiblingFiles | null
    onBack: () => void
    onDownload: () => void
    onDelete: () => void
    // Editing: omitted where files are read-only, which drops the Edit button entirely.
    writeFile?: (path: string, content: string, baseHash: string | null) => Promise<SaveFileResult>
    onSaved?: (path: string) => void
    // Publishing (agent files only): the public URL when the file is published, and the handlers.
    // Omitted for space/shared files, which cannot be published.
    publicUrl?: string
    onPublish?: () => void
    onUnpublish?: () => void
    onShareSettings?: () => void
    openUrl?: string
}

export function FileDetail({ name, path, rawUrl, readFile, siblings, onBack, onDownload, onDelete, writeFile, onSaved, publicUrl, onPublish, onUnpublish, onShareSettings, openUrl }: FileDetailProps) {
    const { content, truncated, loading, error, replaceContent } = useFileContent({ path, name, read: readFile })
    // Keyed on the path rather than a boolean, so opening another file leaves the editor by itself.
    const [editingPath, setEditingPath] = useState<string | null>(null)
    const previewRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!siblings || editingPath) return
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
            if (!previewRef.current || isTypingTarget(event.target) || isInsideForeignOverlay(document.activeElement, previewRef.current)) return
            event.preventDefault()
            if (event.key === 'ArrowLeft') siblings.previous()
            else siblings.next()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [siblings, editingPath])

    const save = useCallback(
        async (next: string, baseHash: string | null): Promise<SaveFileResult> => {
            if (!writeFile) return { success: false, error: 'This file is read-only' }
            return writeFile(path, next, baseHash)
        },
        [writeFile, path],
    )

    const saved = useCallback(
        (next: string) => {
            replaceContent(next)
            setEditingPath(null)
            onSaved?.(path)
        },
        [replaceContent, onSaved, path],
    )

    const blocked = loading ? null : fileEditBlockReason({ name, truncated, content })
    const editDisabledReason = loading ? 'Still loading this file' : blocked ? editDisabledTooltip(blocked) : undefined

    return (
        <PanelEditorShell>
            <PanelEditorHeader title={name} onBack={onBack} mono>
                {siblings && (
                    <>
                        <Button size="icon-sm" variant="ghost" onClick={siblings.previous} title="Previous file" aria-label="Previous file">
                            <ChevronLeftIcon className="size-4" />
                        </Button>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {siblings.index + 1} / {siblings.total}
                        </span>
                        <Button size="icon-sm" variant="ghost" onClick={siblings.next} title="Next file" aria-label="Next file">
                            <ChevronRightIcon className="size-4" />
                        </Button>
                    </>
                )}
                <FileDetailActions
                    name={name}
                    truncated={truncated}
                    editDisabledReason={editDisabledReason}
                    onEdit={writeFile ? () => setEditingPath(path) : undefined}
                    onDownload={onDownload}
                    onDelete={onDelete}
                    publicUrl={publicUrl}
                    onPublish={onPublish}
                    onUnpublish={onUnpublish}
                    onShareSettings={onShareSettings}
                    openUrl={openUrl}
                />
            </PanelEditorHeader>
            <div key={path} ref={previewRef} className="flex-1 min-h-0 overflow-hidden">
                {error ? <p className="p-3 text-xs text-destructive">{error}</p> : <FilePreview fileName={name} content={content} rawUrl={rawUrl} loading={loading} truncated={truncated} />}
            </div>
            {editingPath === path && <FileEditorDialog fileName={name} initialContent={content ?? ''} onSave={save} onSaved={saved} onClose={() => setEditingPath(null)} />}
        </PanelEditorShell>
    )
}

function isTypingTarget(target: EventTarget | null) {
    return target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
}

// The workspace files live inside the Knowledge base dialog, so being in a dialog is fine; being in
// one stacked on top of the viewer (editor, delete confirm, context menu) is not.
function isInsideForeignOverlay(active: Element | null, viewer: HTMLElement) {
    const overlay = active?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')
    return Boolean(overlay && !overlay.contains(viewer))
}
