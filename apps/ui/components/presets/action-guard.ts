import { toast } from 'sonner'

// A server action that never answers — a dev reload that retired the action id this tab holds, a
// starved connection — must not leave a button spinning forever. The caller gets null back, its
// pending state resets, and the user learns what to do instead of watching dots.
export async function guarded<T>(call: () => Promise<T>): Promise<T | null> {
    try {
        return await call()
    } catch {
        toast.error('The server did not answer. Reload the page and try again.')
        return null
    }
}
