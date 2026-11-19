import { ArchiveIcon, AudioWaveformIcon, BinaryIcon, Code2, FilmIcon, type LucideIcon } from '@/lib/icons'

export type FilePreviewKind = 'image' | 'pdf' | 'audio' | 'video' | 'text' | 'binary'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'bmp'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac'])
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v'])
const BINARY_EXTS = new Set(['zip', 'gz', 'tar', 'rar', '7z', 'exe', 'bin', 'dmg', 'iso', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'parquet', 'sqlite', 'db', 'wasm', 'so', 'dylib', 'class', 'jar'])
const ARCHIVE_EXTS = new Set(['zip', 'gz', 'tar', 'rar', '7z', 'dmg', 'iso', 'jar'])
const CODE_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cs', 'php', 'swift', 'sh', 'bash', 'zsh', 'sql', 'json', 'yml', 'yaml', 'toml', 'html', 'css', 'scss'])

export function fileExtension(name: string): string {
    return name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
}

export function filePreviewKind(name: string): FilePreviewKind {
    const ext = fileExtension(name)
    if (IMAGE_EXTS.has(ext)) return 'image'
    if (ext === 'pdf') return 'pdf'
    if (AUDIO_EXTS.has(ext)) return 'audio'
    if (VIDEO_EXTS.has(ext)) return 'video'
    if (BINARY_EXTS.has(ext)) return 'binary'
    return 'text'
}

const HTML_EXTS = new Set(['html', 'htm'])

// Kept apart from `isCode`: html is both, and which one it is decides whether the viewer opens on
// the page or on its source.
export function isHtmlDocument(name: string): boolean {
    return HTML_EXTS.has(fileExtension(name))
}

export function isArchive(name: string): boolean {
    return ARCHIVE_EXTS.has(fileExtension(name))
}

export function isCode(name: string): boolean {
    return CODE_EXTS.has(fileExtension(name))
}

// A thumbnail is worth at most one small request. Past these sizes the tile falls back to a
// typed glyph rather than pulling megabytes through the engine proxy for a 64px square.
export const THUMB_IMAGE_MAX_BYTES = 3_000_000
export const THUMB_TEXT_MAX_BYTES = 262_144

// The icon standing in for a file whose bytes are not worth rendering. `null` means the kind
// carries no icon of its own: an image shows itself, a pdf and a plain text file read as the
// default sheet.
export function fileTypeIcon(name: string): LucideIcon | null {
    switch (filePreviewKind(name)) {
        case 'audio':
            return AudioWaveformIcon
        case 'video':
            return FilmIcon
        case 'binary':
            return isArchive(name) ? ArchiveIcon : BinaryIcon
        case 'text':
            return isCode(name) ? Code2 : null
        default:
            return null
    }
}
