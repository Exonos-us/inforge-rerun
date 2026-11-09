import { handleAccountMcp } from '@/lib/mcp/account-rpc'

export const dynamic = 'force-dynamic'

// The same server with the key in the path, for chat apps whose custom connectors take a URL and
// nothing else (Grok). Only an import key gets in this way: it lives a day and reaches one coworker.
export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }): Promise<Response> {
    const { key } = await params
    return handleAccountMcp(req, key, { importOnly: true })
}
