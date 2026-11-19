'use client'

import { readFileAction } from '@/app/api/_actions/file.actions'
import { FilePreview } from '@/components/files/FilePreview'
import { useFileContent } from '@/components/files/useFileContent'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { attachmentDisplayName } from '@/lib/chat/attachments-marker'
import { rawUrlResolver, type RawUrlFor } from '@/lib/files/raw-url'
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon } from '@/lib/icons'
import { useCallback } from 'react'

export type ReadChatFile = (path: string) => Promise<{ content: string; truncated: boolean }>

type AttachmentLightboxProps = {
    agentId?: string
    paths: readonly string[]
    /** Shown instead of the name read from each path, when the caller knows the real one. */
    names?: readonly string[]
    index: number
    rawUrlFor?: RawUrlFor
    /** Reads the text of a file that does not live on a Box (the foreman's bucket). */
    readFile?: ReadChatFile
    onIndexChange: (index: number) => void
    onClose: () => void
}

/** Full-screen view of one attachment, with arrows across the message's other files. */
export function AttachmentLightbox({ agentId, paths, names, index, rawUrlFor, readFile, onIndexChange, onClose }: AttachmentLightboxProps) {
    const path = paths[index]
    const name = names?.[index] ?? attachmentDisplayName(path)
    const rawUrl = rawUrlResolver(agentId, rawUrlFor)?.(path) ?? ''

    const read = useCallback<ReadChatFile>(
        filePath => (readFile ? readFile(filePath) : agentId ? readFileAction(agentId, filePath) : Promise.resolve({ content: '', truncated: false })),
        [readFile, agentId]
    )
    const { content, truncated, loading, error } = useFileContent({ path, name, read })

    return (
        <Dialog open onOpenChange={open => !open && onClose()}>
            <DialogContent aria-describedby={undefined} className="flex h-[80vh] flex-col gap-0 p-0 sm:max-w-4xl">
                <div className="flex shrink-0 items-center gap-2 border-b border-border py-2 pl-4 pr-12">
                    <DialogTitle className="min-w-0 flex-1 truncate text-left font-mono text-xs font-normal text-muted-foreground">{name}</DialogTitle>
                    {paths.length > 1 && (
                        <>
                            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                {index + 1} / {paths.length}
                            </span>
                            <Button size="icon-sm" variant="ghost" onClick={() => onIndexChange((index - 1 + paths.length) % paths.length)} aria-label="Previous attachment">
                                <ChevronLeftIcon className="size-4" />
                            </Button>
                            <Button size="icon-sm" variant="ghost" onClick={() => onIndexChange((index + 1) % paths.length)} aria-label="Next attachment">
                                <ChevronRightIcon className="size-4" />
                            </Button>
                        </>
                    )}
                    <Button size="icon-sm" variant="ghost" asChild title="Download" aria-label="Download">
                        <a href={rawUrl} download={name}>
                            <DownloadIcon className="size-4" />
                        </a>
                    </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden pb-[env(safe-area-inset-bottom)] sm:pb-0">
                    {error ? <p className="p-3 text-xs text-destructive">{error}</p> : <FilePreview fileName={name} content={content} rawUrl={rawUrl} loading={loading} truncated={truncated} />}
                </div>
            </DialogContent>
        </Dialog>
    )
}
