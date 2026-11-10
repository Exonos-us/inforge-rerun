import { describe, expect, it } from 'vitest'
import { attachmentComment, filesWorthPosting, isShareable, MAX_ATTACHMENT_BYTES, type WorkspaceFile } from './attachments'

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
})
