import { readAgentConfig } from '../agents/loader.js'
import { holdScreenSession, resumeScreenRecording, type ScreenSessionHold } from './recording.js'
import { HOLD_TTL_MS, endHumanHold, holdDesktop, renewHumanHold } from './session.js'

// The explicit "Take over" a person asks for on an agent's screen. One hold per agent: taking it
// again renews it. It keeps the desktop up and the screen session recording, like a run on the
// screen does, and expires on its own when the app stops renewing it (a closed tab, a lost
// connection), so the agent never waits on a person who left.

type ActiveHold = { timer: NodeJS.Timeout; evidence: ScreenSessionHold; releaseDesktop: () => void }

const holds = new Map<string, ActiveHold>()

const recordingWanted = (agentId: string): Promise<boolean> =>
    readAgentConfig(agentId).then(
        config => config.tools.computerRecording,
        () => true,
    )

export async function takeScreenHold(agentId: string): Promise<void> {
    renewHumanHold(agentId)
    if (refresh(agentId)) return
    const record = await recordingWanted(agentId)
    // Asked again after the await: two concurrent takes must not each hold the resources.
    if (refresh(agentId)) return
    const releaseDesktop = holdDesktop(agentId)
    const evidence = holdScreenSession(agentId, { record })
    const timer = setTimeout(() => releaseScreenHold(agentId), HOLD_TTL_MS)
    timer.unref()
    holds.set(agentId, { timer, evidence, releaseDesktop })
}

function refresh(agentId: string): boolean {
    const hold = holds.get(agentId)
    if (hold) hold.timer.refresh()
    return !!hold
}

export function releaseScreenHold(agentId: string): void {
    endHumanHold(agentId)
    const hold = holds.get(agentId)
    if (!hold) return
    holds.delete(agentId)
    clearTimeout(hold.timer)
    // Only a person pauses the capture, so no person on the screen means nothing left to hide: a
    // run still recording this session carries on recorded.
    resumeScreenRecording(agentId)
    hold.evidence.release()
    hold.releaseDesktop()
}
