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
// is handing over. Written first, because that is the thing most likely to be the point.
export function attachmentsFor(params: { answer: string; files: WorkspaceFile[]; since: Date }): WorkspaceFile[] {
    const picked: WorkspaceFile[] = []
    for (const file of [...filesWorthPosting(params.files, params.since), ...filesNamedIn(params.answer, params.files)]) {
        if (picked.length >= MAX_ATTACHMENTS) break
        if (!picked.some(already => already.path === file.path)) picked.push(file)
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
