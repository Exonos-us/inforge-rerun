import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { childrenToReap, reapLiveChildren, reapOnExit } from './child-reaper.js'

const deafToSigterm = () => spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' })

describe('child reaper', () => {
    it('kills on exit a child that ignores SIGTERM, and forgets the ones that already left', async () => {
        const wedged = deafToSigterm()
        const leaving = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
        reapOnExit(wedged)
        reapOnExit(leaving)
        await once(leaving, 'exit')
        expect(childrenToReap()).toBe(1)
        const exited = once(wedged, 'exit')
        reapLiveChildren()
        const [, signal] = await exited
        expect(signal).toBe('SIGKILL')
        expect(childrenToReap()).toBe(0)
    })
})
