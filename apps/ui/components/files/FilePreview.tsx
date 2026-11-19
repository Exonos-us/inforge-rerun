'use client'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { filePreviewKind, isHtmlDocument } from '@/lib/files/preview'
import { DownloadIcon, FileIcon } from '@/lib/icons'

import { HtmlFilePreview } from './HtmlFilePreview'

type FilePreviewProps = {
    fileName: string
    content: string | null
    rawUrl: string
    loading: boolean
    truncated?: boolean
}

export function FilePreview({ fileName, content, rawUrl, loading, truncated = false }: FilePreviewProps) {
    if (loading) return <FilePreviewSkeleton />

    const kind = filePreviewKind(fileName)

    if (kind === 'image') {
        return (
            <div className="flex h-full items-center justify-center overflow-auto bg-muted p-3">
                {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary proxied file bytes, no fixed dimensions or configured loader */}
                <img src={rawUrl} alt={fileName} className="max-h-full max-w-full object-contain" />
            </div>
        )
    }
    if (kind === 'pdf') return <iframe src={rawUrl} title={fileName} className="h-full w-full bg-white" />
    if (kind === 'audio') {
        return (
            <div className="flex h-full items-center justify-center p-4">
                <audio controls src={rawUrl} className="w-full max-w-md" />
            </div>
        )
    }
    if (kind === 'video') {
        return (
            <div className="flex h-full items-center justify-center overflow-auto bg-muted p-3">
                <video controls src={rawUrl} className="max-h-full max-w-full" />
            </div>
        )
    }
    if (kind === 'text' && content !== null) {
        if (isHtmlDocument(fileName)) return <HtmlFilePreview fileName={fileName} content={content} truncated={truncated} />
        return <pre className="h-full overflow-auto p-3 text-xs font-mono whitespace-pre-wrap break-all">{content}</pre>
    }

    return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
            <FileIcon className="size-8" />
            <p className="text-xs">No preview available for this file type</p>
            <Button asChild variant="outline" size="sm">
                <a href={rawUrl} download={fileName}>
                    <DownloadIcon className="size-3.5" />
                    Download
                </a>
            </Button>
        </div>
    )
}

const BODY_WIDTHS = ['w-4/5', 'w-full', 'w-3/5', 'w-11/12', 'w-2/3', 'w-3/4', 'w-1/2']

function FilePreviewSkeleton() {
    return (
        <div className="h-full space-y-1.5 p-3">
            {BODY_WIDTHS.map((width, index) => (
                <Skeleton key={index} className={`h-3 ${width}`} />
            ))}
        </div>
    )
}
