// Hiring a team starts from two words — the client and the project — and everything else is
// derived from them: the Slack channel, the space name, every coworker's name. All of it stays
// editable; these are the defaults a hire should never have to type.

export function slugOf(text: string): string {
    return text
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
}

// "Miami Dade County" → "mdc"; a one-word client keeps its own first letters.
export function shortCodeOf(client: string): string {
    const words = client.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) return ''
    if (words.length === 1) return slugOf(words[0]).replace(/-/g, '').slice(0, 6)
    return words
        .map(word => word[0])
        .join('')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
}

export function channelNameFor(code: string, project: string): string {
    return [slugOf(code), slugOf(project)].filter(Boolean).join('-')
}

export function spaceNameFor(code: string, project: string): string {
    const name = [code.trim().toUpperCase(), project.trim()].filter(Boolean).join(' ')
    return name ? `${name} Project` : ''
}

// "Product Owner" → "po", "Solution Architect" → "sa", "Engineer" → "engineer". The initials of a
// multi-word role read like the job titles people already shorten; a single word is itself.
export function roleKeyOf(role: string): string {
    const words = role.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) return 'coworker'
    if (words.length === 1) return slugOf(words[0]) || 'coworker'
    return (
        words
            .map(word => word[0])
            .join('')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '') || 'coworker'
    )
}

// mdc-acme-pe-1, mdc-acme-pe-2, mdc-acme-po. The ordinal only appears when the role is hired
// more than once: a team with one PO does not call it po-1.
export function coworkerNameFor(code: string, project: string, role: string, ordinal: number, countOfRole: number): string {
    const base = [slugOf(code), slugOf(project), roleKeyOf(role)].filter(Boolean).join('-')
    return countOfRole > 1 ? `${base}-${ordinal}` : base
}
