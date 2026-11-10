// What the person copies inside the coworker's computer, pushed out to this one. A browser only
// lets a page write the clipboard while its document is focused and the permission is granted, so
// when the write is refused the text is shown instead, for the person to copy by hand.

export type RemoteClipboardOutcome = 'copied' | 'shown' | 'ignored'

type RemoteClipboardSink = {
    write: (text: string) => Promise<void>
    show: (text: string) => void
}

export function remoteClipboardReceiver({ write, show }: RemoteClipboardSink): (text: string) => Promise<RemoteClipboardOutcome> {
    let last = ''
    return async text => {
        // The VNC server replays the current selection on connect and repeats it on owner changes:
        // the empty one and the repeats are not something the person just copied.
        if (!text || text === last) return 'ignored'
        last = text
        try {
            await write(text)
            return 'copied'
        } catch {
            show(text)
            return 'shown'
        }
    }
}
