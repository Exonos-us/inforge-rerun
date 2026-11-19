import { describe, expect, it } from 'vitest'
import { ArchiveIcon, BinaryIcon, Code2 } from '@/lib/icons'
import { fileExtension, filePreviewKind, fileTypeIcon, isArchive, isCode, isHtmlDocument } from './preview'

describe('fileExtension', () => {
    it('lowercases the last extension and has none without a dot', () => {
        expect(fileExtension('Archive.TAR.GZ')).toBe('gz')
        expect(fileExtension('Makefile')).toBe('')
        expect(fileExtension('.env')).toBe('env')
    })
})

describe('filePreviewKind', () => {
    it('recognises each renderable kind whatever the case', () => {
        expect(filePreviewKind('photo.JPG')).toBe('image')
        expect(filePreviewKind('doc.pdf')).toBe('pdf')
        expect(filePreviewKind('voice.m4a')).toBe('audio')
        expect(filePreviewKind('clip.MOV')).toBe('video')
        expect(filePreviewKind('font.woff2')).toBe('binary')
    })

    it('reads anything unknown or without extension as text', () => {
        expect(filePreviewKind('notes.md')).toBe('text')
        expect(filePreviewKind('Dockerfile')).toBe('text')
        expect(filePreviewKind('data.xyz')).toBe('text')
    })
})

describe('isHtmlDocument', () => {
    it('is a page whatever the case or the spelling of the extension', () => {
        expect(isHtmlDocument('brief.html')).toBe(true)
        expect(isHtmlDocument('BRIEF.HTM')).toBe(true)
    })

    it('leaves the other text files alone', () => {
        expect(isHtmlDocument('index.ts')).toBe(false)
        expect(isHtmlDocument('notes.md')).toBe(false)
        expect(isHtmlDocument('page.html.bak')).toBe(false)
    })

    // A page is still read as text, which is what gets it a `content` to render.
    it('stays a text file to the viewer', () => {
        expect(filePreviewKind('brief.html')).toBe('text')
    })
})

describe('fileTypeIcon', () => {
    it('tells an archive from another binary', () => {
        expect(fileTypeIcon('bundle.zip')).toBe(ArchiveIcon)
        expect(isArchive('bundle.zip')).toBe(true)
        expect(fileTypeIcon('lib.wasm')).toBe(BinaryIcon)
    })

    it('gives code a glyph and leaves plain text, images and pdfs without one', () => {
        expect(isCode('index.ts')).toBe(true)
        expect(fileTypeIcon('index.ts')).toBe(Code2)
        expect(fileTypeIcon('notes.txt')).toBeNull()
        expect(fileTypeIcon('photo.png')).toBeNull()
        expect(fileTypeIcon('doc.pdf')).toBeNull()
    })
})
