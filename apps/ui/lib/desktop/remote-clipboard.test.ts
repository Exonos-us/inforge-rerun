import { describe, expect, it } from 'vitest'

import { remoteClipboardReceiver } from './remote-clipboard'

function sink({ broken = false } = {}) {
    const written: string[] = []
    const shown: string[] = []
    const receive = remoteClipboardReceiver({
        write: async text => {
            if (broken) throw new Error('not allowed')
            written.push(text)
        },
        show: text => shown.push(text),
    })
    return { receive, written, shown }
}

describe('remoteClipboardReceiver', () => {
    it('writes what the person copied in the remote computer to this clipboard', async () => {
        const { receive, written, shown } = sink()
        expect(await receive('a secret token')).toBe('copied')
        expect(written).toEqual(['a secret token'])
        expect(shown).toEqual([])
    })

    it('shows the text for a manual copy when the browser refuses the write', async () => {
        const { receive, written, shown } = sink({ broken: true })
        expect(await receive('hello')).toBe('shown')
        expect(written).toEqual([])
        expect(shown).toEqual(['hello'])
    })

    it('ignores the empty replay on connect and the repeats of the same selection', async () => {
        const { receive, written } = sink()
        expect(await receive('')).toBe('ignored')
        expect(await receive('once')).toBe('copied')
        expect(await receive('once')).toBe('ignored')
        expect(await receive('twice')).toBe('copied')
        expect(written).toEqual(['once', 'twice'])
    })
})
