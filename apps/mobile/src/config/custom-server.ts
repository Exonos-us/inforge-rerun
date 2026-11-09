import { clientServerSchema, type ClientServer } from '@rerun/contracts'
import { reloadAppAsync } from 'expo'
import * as SecureStore from 'expo-secure-store'

const CUSTOM_SERVER_KEY = 'rerun.server'

const customServerSchema = clientServerSchema.extend({ apiUrl: clientServerSchema.shape.supabaseUrl })
export type CustomServer = ClientServer & { apiUrl: string }

// Read synchronously, before the first module that talks to a server is evaluated: the whole app is
// bound to one server for as long as it runs, and changing it relaunches the app.
export function readCustomServer(): CustomServer | null {
    const raw = SecureStore.getItem(CUSTOM_SERVER_KEY)
    if (!raw) return null
    try {
        const parsed = customServerSchema.safeParse(JSON.parse(raw))
        return parsed.success ? parsed.data : null
    } catch {
        return null
    }
}

// Null goes back to the server the build was made for. The person is signed out before: a session
// belongs to one server's Supabase.
export async function switchServer(server: CustomServer | null): Promise<void> {
    if (server) await SecureStore.setItemAsync(CUSTOM_SERVER_KEY, JSON.stringify(server))
    else await SecureStore.deleteItemAsync(CUSTOM_SERVER_KEY)
    await reloadAppAsync('server changed')
}
