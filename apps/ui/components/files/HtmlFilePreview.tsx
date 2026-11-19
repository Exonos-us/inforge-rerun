'use client'

import { Button } from '@/components/ui/button'
import { Code2, EyeIcon } from '@/lib/icons'
import { useState } from 'react'

// A page a coworker wrote is a finished document, not source, so it opens rendered and the code is
// one click away.
//
// Drawn from `srcdoc` in an iframe sandboxed with no allow-* flag at all: the frame gets an opaque
// origin and runs no script. /api/files/raw deliberately refuses to serve text/html from our own
// origin (lib/files/content-type.ts) — rendered there, a document would run with the session's
// cookies in reach — and this is how the same bytes are shown without reopening that door.
export function HtmlFilePreview({ fileName, content, truncated }: { fileName: string; content: string; truncated: boolean }) {
    const [showCode, setShowCode] = useState(false)

    return (
        <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
                {truncated && <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">Only the first part of this file was read, so the end is missing.</p>}
                <Button size="xs" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => setShowCode(code => !code)} aria-pressed={showCode}>
                    {showCode ? <EyeIcon /> : <Code2 />}
                    {showCode ? 'Preview' : 'Code'}
                </Button>
            </div>
            <div className="min-h-0 flex-1">
                {showCode ? (
                    <pre className="h-full overflow-auto p-3 text-xs font-mono whitespace-pre-wrap break-all">{content}</pre>
                ) : (
                    <iframe title={fileName} srcDoc={content} sandbox="" className="h-full w-full border-0 bg-white" />
                )}
            </div>
        </div>
    )
}
