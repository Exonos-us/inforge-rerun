// Runs once when the Next server boots. In dev it opens the HTTP/2 door beside the h1 server
// (scripts/dev-h2-door.mjs has the whole story): the h1 origin keeps serving the engine and the
// webhooks, the https door is what browsers should open. DEV_H2_DOOR=off skips it. The node-only
// code lives behind a dynamic import, so the edge bundle of this file stays parseable.
export async function register() {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return
    if (process.env.NODE_ENV !== 'development' || process.env.DEV_H2_DOOR === 'off') return
    const { openDevDoor } = await import('@/lib/dev/h2-door-start')
    openDevDoor()
}
