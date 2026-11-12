import { spawn } from 'node:child_process'

// Node-only on purpose: instrumentation.ts imports this file dynamically after its runtime guard,
// so the edge bundle never parses the node builtins used here.
export function openDevDoor(): void {
    const flag = process.argv.findIndex(arg => arg === '-p' || arg === '--port')
    const port = flag >= 0 ? process.argv[flag + 1] : (process.env.PORT ?? '3000')

    const child = spawn(process.execPath, ['scripts/dev-h2-door.mjs', port], { cwd: process.cwd(), stdio: ['ignore', 'inherit', 'inherit'] })
    child.unref()
    process.on('exit', () => child.kill())
}
