import { bearerToken, handleAccountMcp } from '@/lib/mcp/account-rpc'

export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<Response> {
    return handleAccountMcp(req, bearerToken(req))
}
