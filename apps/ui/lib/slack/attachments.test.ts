import { describe, expect, it } from 'vitest'
import { attachmentComment, attachmentsFor, filesNamedIn, filesWorthPosting, isShareable, MAX_ATTACHMENT_BYTES, type WorkspaceFile } from './attachments'

const RUN_STARTED = new Date('2026-11-10T15:00:00Z')

function file(path: string, overrides: Partial<WorkspaceFile> = {}): WorkspaceFile {
    return { path, name: path.split('/').pop() ?? path, size: 1024, modifiedAt: '2026-11-10T15:00:30Z', ...overrides }
}

describe('isShareable', () => {
    it('takes what Slack shows usefully', () => {
        expect(['report.html', 'sheet.xlsx', 'chart.png', 'recording.mp4', 'deck.pptx'].every(isShareable)).toBe(true)
    })

    it('leaves out what belongs in the message instead', () => {
        expect(['notes.md', 'answer.txt', 'scratch', 'data.json', 'script.py'].some(isShareable)).toBe(false)
    })
})

describe('filesWorthPosting', () => {
    it('keeps only what the run itself wrote', () => {
        const picked = filesWorthPosting([file('report.html'), file('old.pdf', { modifiedAt: '2026-11-09T10:00:00Z' })], RUN_STARTED)
        expect(picked.map(f => f.name)).toEqual(['report.html'])
    })

    it('keeps a file written in the same second the run started', () => {
        expect(filesWorthPosting([file('report.html', { modifiedAt: RUN_STARTED.toISOString() })], RUN_STARTED)).toHaveLength(1)
    })

    it('skips the coworker own machinery', () => {
        const picked = filesWorthPosting([file('.rerun/services.html'), file('node_modules/pkg/readme.html'), file('work/report.html')], RUN_STARTED)
        expect(picked.map(f => f.path)).toEqual(['work/report.html'])
    })

    it('skips what is too big to hand through a chat, and what is empty', () => {
        const picked = filesWorthPosting([file('huge.mp4', { size: MAX_ATTACHMENT_BYTES + 1 }), file('empty.pdf', { size: 0 }), file('fine.pdf')], RUN_STARTED)
        expect(picked.map(f => f.name)).toEqual(['fine.pdf'])
    })

    it('posts the newest three and no more', () => {
        const many = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf'].map((name, i) => file(name, { modifiedAt: new Date(RUN_STARTED.getTime() + i * 1000).toISOString() }))
        expect(filesWorthPosting(many, RUN_STARTED).map(f => f.name)).toEqual(['e.pdf', 'd.pdf', 'c.pdf'])
    })

    it('ignores a file whose age is unknown rather than guessing', () => {
        expect(filesWorthPosting([file('report.html', { modifiedAt: null })], RUN_STARTED)).toEqual([])
    })
})

describe('filesNamedIn', () => {
    const files = [file('work/build-status.html'), file('work/notes.md'), file('old/report.pdf')]

    it('hands over the file the answer says it is handing over', () => {
        expect(filesNamedIn('Here is build-status.html, attached below.', files).map(f => f.name)).toEqual(['build-status.html'])
    })

    it('matches however the answer capitalises it', () => {
        expect(filesNamedIn('See Build-Status.HTML', files).map(f => f.name)).toEqual(['build-status.html'])
    })

    it('ignores a name that is not a file of this coworker', () => {
        expect(filesNamedIn('I looked at example.com and report.xlsx', files)).toEqual([])
    })

    it('still refuses what does not belong in a channel', () => {
        expect(filesNamedIn('see notes.md', files)).toEqual([])
    })
})

describe('attachmentsFor', () => {
    const since = RUN_STARTED

    it('posts what the run wrote and what the answer names, once each', () => {
        const files = [file('fresh.pdf'), file('old.html', { modifiedAt: '2026-11-09T09:00:00Z' })]
        const picked = attachmentsFor({ answer: 'Built fresh.pdf, and here is old.html again', files, since })
        expect(picked.map(f => f.name)).toEqual(['fresh.pdf', 'old.html'])
    })

    it('answers a "send me that file" about something written days ago', () => {
        const files = [file('report.pdf', { modifiedAt: '2026-11-01T09:00:00Z' })]
        expect(attachmentsFor({ answer: 'Here is report.pdf', files, since }).map(f => f.name)).toEqual(['report.pdf'])
    })

    it('never goes past the cap, whichever side the files come from', () => {
        const files = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf'].map(name => file(name))
        expect(attachmentsFor({ answer: 'a.pdf b.pdf c.pdf d.pdf', files, since })).toHaveLength(3)
    })

    it('leaves the raw screen frames home: the recording is the deliverable', () => {
        const files = [file('screen/2026-11-10/recording.mp4'), file('screen/2026-11-10/001.jpg'), file('screen/2026-11-10/002.jpg')]
        expect(attachmentsFor({ answer: 'Done.', files, since }).map(f => f.name)).toEqual(['recording.mp4'])
    })

    it('posts the renamed copy of a screen recording once, not the raw twin beside it', () => {
        const files = [file('landing-tour.mp4', { size: 6_100_000 }), file('screen/2026-11-10/recording.mp4', { size: 6_100_000 })]
        expect(attachmentsFor({ answer: 'Here is landing-tour.mp4', files, since }).map(f => f.name)).toEqual(['landing-tour.mp4'])
    })

    it('does not repost what an earlier turn of the same exchange already sent', () => {
        const files = [file('landing-tour.mp4')]
        expect(attachmentsFor({ answer: 'As I said, landing-tour.mp4 is up.', files, since, alreadyPosted: new Set(['landing-tour.mp4']) })).toHaveLength(0)
    })

    it('in a convened turn a live screen recording rides along only when named', () => {
        const files = [file('screen/2026-11-10/recording.mp4'), file('report.pdf')]
        expect(attachmentsFor({ answer: 'Done.', files, since, screenAutoPick: false }).map(f => f.name)).toEqual(['report.pdf'])
        expect(attachmentsFor({ answer: 'Here is recording.mp4', files, since, screenAutoPick: false }).map(f => f.name)).toEqual(['recording.mp4', 'report.pdf'])
    })

    it('one name travels once, however many copies of the file exist', () => {
        const files = [file('landing.mp4'), file('shared/inforge/landing.mp4')]
        expect(attachmentsFor({ answer: 'Copied landing.mp4 to the shared space.', files, since })).toHaveLength(1)
        expect(attachmentsFor({ answer: 'landing.mp4 is in the shared space now.', files, since, alreadyPostedNames: new Set(['landing.mp4']) })).toHaveLength(0)
    })
})

describe('attachmentComment', () => {
    it('names a recording as one', () => {
        expect(attachmentComment(file('screen/2026-11-10/recording.mp4'))).toContain('recording')
    })

    it('lets a picture speak for itself', () => {
        expect(attachmentComment(file('chart.png'))).toBe('*chart.png*')
    })

    it('introduces a document', () => {
        expect(attachmentComment(file('october.pdf'))).toBe('Here is *october.pdf*')
    })

    it('signs the line, because Slack posts a file under the app whatever the message said', () => {
        expect(attachmentComment(file('october.pdf'), 'engineer-1')).toBe('_from engineer-1_ · Here is *october.pdf*')
    })
})
