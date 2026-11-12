import { AtlassianMcpSession } from '@/lib/atlassian/mcp'

// Reads the Confluence shapes Project knowledge works with: the sites, the non-personal spaces,
// and the engagements of a client space, which are the child pages of its "70-79 Engagements"
// page (Inforge's client template). A space without that page falls back to its top-level page
// trees, so any wiki layout stays linkable.

export type ConfluenceSite = { cloudId: string; url: string }
export type ConfluenceSpace = { id: string; key: string; name: string; homepageId: string | null; client: boolean }
export type ConfluenceEngagement = { id: string; title: string; pageCount: number }
export type EngagementListing = { engagements: ConfluenceEngagement[]; fallback: boolean }
export type PageIndexEntry = { id: string; title: string }

type ResourceRow = { id: string; url: string }
type SpaceRow = { id: string; key: string; name: string; type: string; homepageId?: string | null }
type DescendantRow = { id: string; title: string; parentId: string; depth: number; type: string; status: string }

// The engagements hub of the client template: "70-79 Engagements" (a bare "Engagements" also
// counts). Never a page that merely mentions the word, like "20-29 Client and engagements".
const ENGAGEMENTS_TITLE = /^\s*(?:\d+(?:[-–]\d+)?\s+)?engagements\s*$/i
const CLIENT_NAME = /^\d+\.\d+\s/
export const PAGE_INDEX_LIMIT = 40

export function atlassianSession(mcpUrl: string, accessToken: string): AtlassianMcpSession {
    return new AtlassianMcpSession(mcpUrl, accessToken)
}

export async function getSite(session: AtlassianMcpSession): Promise<ConfluenceSite> {
    const resources = await session.callTool<ResourceRow[]>('getAccessibleAtlassianResources', {})
    const first = resources[0]
    if (!first) throw new Error('The workspace Atlassian account reaches no site')
    return { cloudId: first.id, url: first.url }
}

export async function listSpaces(session: AtlassianMcpSession, cloudId: string): Promise<ConfluenceSpace[]> {
    const data = await session.callTool<{ results: SpaceRow[] }>('getConfluenceSpaces', { cloudId, limit: 250 })
    const spaces = (data.results ?? [])
        .filter(space => space.type !== 'personal')
        .map(space => ({ id: space.id, key: space.key, name: space.name, homepageId: space.homepageId ?? null, client: CLIENT_NAME.test(space.name) }))
    return spaces.sort((a, b) => Number(b.client) - Number(a.client) || a.name.localeCompare(b.name))
}

async function descendants(session: AtlassianMcpSession, cloudId: string, pageId: string, depth: number, limit: number): Promise<DescendantRow[]> {
    const data = await session.callTool<{ results: DescendantRow[] }>('getConfluencePageDescendants', { cloudId, pageId, depth, limit })
    return (data.results ?? []).filter(row => row.status === 'current')
}

function countUnder(rows: DescendantRow[], rootId: string): number {
    const children = new Map<string, string[]>()
    for (const row of rows) {
        const siblings = children.get(row.parentId) ?? []
        siblings.push(row.id)
        children.set(row.parentId, siblings)
    }
    let count = 0
    const queue = [...(children.get(rootId) ?? [])]
    while (queue.length) {
        const id = queue.pop() as string
        count += 1
        queue.push(...(children.get(id) ?? []))
    }
    return count
}

export async function listEngagements(session: AtlassianMcpSession, cloudId: string, homepageId: string): Promise<EngagementListing> {
    const rows = await descendants(session, cloudId, homepageId, 5, 250)
    const hub = rows.filter(row => ENGAGEMENTS_TITLE.test(row.title) && rows.some(child => child.parentId === row.id)).sort((a, b) => a.depth - b.depth)[0]
    if (hub) {
        const engagements = rows.filter(row => row.parentId === hub.id).map(row => ({ id: row.id, title: row.title, pageCount: countUnder(rows, row.id) }))
        if (engagements.length) return { engagements, fallback: false }
    }
    const topLevel = rows.filter(row => row.parentId === homepageId).map(row => ({ id: row.id, title: row.title, pageCount: countUnder(rows, row.id) }))
    return { engagements: topLevel, fallback: true }
}

// The titles coworkers carry in their prompt: the engagement's own tree, shallow-first so the
// numbered sections survive the cap.
export async function pageIndex(session: AtlassianMcpSession, cloudId: string, pageId: string): Promise<PageIndexEntry[]> {
    const rows = await descendants(session, cloudId, pageId, 3, 150)
    return rows
        .sort((a, b) => a.depth - b.depth)
        .slice(0, PAGE_INDEX_LIMIT)
        .map(row => ({ id: row.id, title: row.title }))
}
