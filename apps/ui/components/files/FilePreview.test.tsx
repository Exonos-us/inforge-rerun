// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const { FilePreview } = await import('./FilePreview')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
})

const PAGE = '<!doctype html><html><body><h1>Brief</h1></body></html>'

async function render(props: { fileName: string; content: string | null; truncated?: boolean }) {
    await act(async () => root.render(createElement(FilePreview, { rawUrl: '/api/files/raw?path=x', loading: false, ...props })))
}

function toggle() {
    return [...container.querySelectorAll('button')].find(button => ['Code', 'Preview'].includes(button.textContent?.trim() ?? ''))
}

describe('FilePreview on an html file', () => {
    it('opens on the rendered page, not its source', async () => {
        await render({ fileName: 'brief.html', content: PAGE })
        const frame = container.querySelector('iframe')
        expect(frame?.getAttribute('srcdoc')).toBe(PAGE)
        expect(container.querySelector('pre')).toBeNull()
        expect(toggle()?.textContent).toContain('Code')
    })

    // No allow-* flag at all: an opaque origin and no script. /api/files/raw refuses to serve
    // text/html from our own origin for the same reason, and this must not reopen that door.
    it('draws it in a frame that can do nothing', async () => {
        await render({ fileName: 'brief.html', content: PAGE })
        expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('')
    })

    it('shows the source when asked, and goes back', async () => {
        await render({ fileName: 'brief.html', content: PAGE })
        await act(async () => toggle()!.click())
        expect(container.querySelector('pre')?.textContent).toBe(PAGE)
        expect(container.querySelector('iframe')).toBeNull()

        await act(async () => toggle()!.click())
        expect(container.querySelector('iframe')).not.toBeNull()
    })

    it('says so when only part of the file was read', async () => {
        await render({ fileName: 'brief.html', content: PAGE })
        expect(container.textContent).not.toContain('the end is missing')

        await render({ fileName: 'brief.html', content: PAGE, truncated: true })
        expect(container.textContent).toContain('the end is missing')
    })
})

describe('FilePreview on everything else', () => {
    it('leaves another text file as source', async () => {
        await render({ fileName: 'notes.md', content: '# Brief' })
        expect(container.querySelector('pre')?.textContent).toBe('# Brief')
        expect(container.querySelector('iframe')).toBeNull()
        expect(toggle()).toBeUndefined()
    })
})
