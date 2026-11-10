import type { ChildProcess } from 'node:child_process'

// The screen processes (Xvfb, x11vnc, openbox, tint2, ffmpeg, the apps) would outlive an engine that
// exits: x11vnc keeps its port, Xvfb its display number, and the next engine on the box starts on a
// screen already taken. Every one is registered here until it has really exited, so a child still in
// the grace of its own stop is reaped too, and SIGKILL is sent because x11vnc can wedge in its own
// SIGTERM handler.
const live = new Set<ChildProcess>()
let hooked = false

const hasExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null

export function reapOnExit(child: ChildProcess): void {
    if (hasExited(child)) return
    live.add(child)
    child.once('exit', () => live.delete(child))
    if (hooked) return
    hooked = true
    process.once('exit', reapLiveChildren)
}

// Runs inside the exit hook, where nothing can be awaited.
export function reapLiveChildren(): void {
    for (const child of live) if (!hasExited(child)) child.kill('SIGKILL')
    live.clear()
}

export const childrenToReap = (): number => live.size
