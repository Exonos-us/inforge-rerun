// What a coworker made during a run, and which of it is worth putting in the channel.
//
// A coworker writes freely in its own workspace: scratch notes, half-finished drafts, a database
// it keeps between runs. Posting all of that into Slack would be noise, so this picks only what
// someone would actually want handed to them — a report, a sheet, a picture, a recording — and
// only what the run itself produced.

export type WorkspaceFile = { path: string; name: string; size: number; modifiedAt: string | null }

// Formats Slack renders usefully: a preview, a player, or a download that means something. Plain
// text and markdown are left out on purpose — a coworker's answer belongs in the message, not as
// an attachment to it.
const SHAREABLE = new Set(['html', 'htm', 'pdf', 'csv', 'tsv', 'xlsx', 'xls', 'docx', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'mov', 'webm', 'zip'])

// Slack's own limit is 1 GB, but a run that writes a 300 MB file into a chat is a mistake, not a
// deliverable, and the hub holds the bytes in memory on the way through.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

// Three is enough to carry a report with its chart; past that the channel is a dumping ground.
export const MAX_ATTACHMENTS = 3

// Never from the folders that hold a coworker's own machinery rather than its work.
const SKIPPED = ['.rerun/', '.git/', 'node_modules/', '.cache/']

// A screen session leaves one numbered frame per action beside its recording. The recording is
// the deliverable; the frames are raw material and would bury it.
function isScreenFrame(file: WorkspaceFile): boolean {
    return /(^|\/)screen\//.test(file.path) && /^\d+\.(jpe?g|png)$/i.test(file.name)
}

export function extensionOf(name: string): string {
    const dot = name.lastIndexOf('.')
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function isShareable(name: string): boolean {
    return SHAREABLE.has(extensionOf(name))
}

// `since` is when the run started: a file the coworker only read is not something it made.
export function filesWorthPosting(files: WorkspaceFile[], since: Date): WorkspaceFile[] {
    return files
        .filter(file => {
            if (!isShareable(file.name)) return false
            if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) return false
            if (SKIPPED.some(prefix => file.path.startsWith(prefix) || file.path.includes(`/${prefix}`))) return false
            if (isScreenFrame(file)) return false
            if (!file.modifiedAt) return false
            return new Date(file.modifiedAt).getTime() >= since.getTime()
        })
        .sort((a, b) => new Date(b.modifiedAt ?? 0).getTime() - new Date(a.modifiedAt ?? 0).getTime())
        .slice(0, MAX_ATTACHMENTS)
}

// A coworker that says "here is build-status.html" means it. The file may well have been written
// in an earlier run — "send me that page you made" is a normal thing to ask — so naming it in the
// answer is as good a reason to attach it as having just written it.
export function filesNamedIn(text: string, files: WorkspaceFile[]): WorkspaceFile[] {
    const named = new Set((text.match(/[\w.-]+\.[a-z0-9]{2,5}\b/gi) ?? []).map(match => match.toLowerCase()))
    if (named.size === 0) return []
    return files.filter(file => named.has(file.name.toLowerCase()) && isShareable(file.name) && file.size > 0 && file.size <= MAX_ATTACHMENT_BYTES).slice(0, MAX_ATTACHMENTS)
}

// What goes into the thread under one answer: what the run just made, and what the answer says it
// is handing over. Named files first, because what the answer hands over is the point.
// `alreadyPosted` carries the paths earlier turns of the same exchange put in the thread, so a
// convened conversation does not repost its own files every time someone mentions them. And a raw
// screen recording whose same-sized copy is already going up stays home: the coworker renamed it
// to hand it over, and the same bytes under two names would read as two videos.
// `screenAutoPick: false` is for the turns of a convened exchange: a live screen session keeps
// appending to its recording, so the raw file reads as freshly written on every turn and would
// ride along again and again. There, a screen file travels only when the answer names it.
export function attachmentsFor(params: { answer: string; files: WorkspaceFile[]; since: Date; alreadyPosted?: ReadonlySet<string>; screenAutoPick?: boolean }): WorkspaceFile[] {
    const named = filesNamedIn(params.answer, params.files)
    const namedPaths = new Set(named.map(file => file.path))
    const picked: WorkspaceFile[] = []
    for (const file of [...named, ...filesWorthPosting(params.files, params.since)]) {
        if (picked.length >= MAX_ATTACHMENTS) break
        if (params.alreadyPosted?.has(file.path)) continue
        if (picked.some(already => already.path === file.path)) continue
        if (/(^|\/)screen\//.test(file.path)) {
            if (params.screenAutoPick === false && !namedPaths.has(file.path)) continue
            if (picked.some(already => already.size === file.size)) continue
        }
        picked.push(file)
    }
    return picked
}

// Said in the thread above the file, so the channel knows why it is there — and who sent it.
//
// Slack's upload has no `username`: a file always lands under the app itself, whatever name the
// message above it carried. Nothing to be done about that from here, so the coworker signs the
// line instead, and the thread still reads as one voice.
export function attachmentComment(file: WorkspaceFile, from?: string): string {
    const kind = extensionOf(file.name)
    const body = ['mp4', 'mov', 'webm'].includes(kind)
        ? `Here is the recording: *${file.name}*`
        : ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(kind)
          ? `*${file.name}*`
          : `Here is *${file.name}*`
    return from ? `_from ${from}_ · ${body}` : body
}
