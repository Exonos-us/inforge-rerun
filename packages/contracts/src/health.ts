import { z } from 'zod'

// `capabilities` stays optional with an empty default: Boxes self-update on their own schedule, so
// the UI keeps talking to engines that predate any given feature and has to detect them, not assume.
export const healthSchema = z.object({
    status: z.string(),
    activeAgents: z.number(),
    capabilities: z.array(z.string()).default([]),
    // The data-dir migration ladder: where the folder is, and where this build takes it.
    dataVersion: z.number().optional(),
    dataVersionTarget: z.number().optional(),
})
export type Health = z.infer<typeof healthSchema>

export const engineDoctorCheckSchema = z.object({ name: z.string(), ok: z.boolean(), detail: z.string().optional() })
export type EngineDoctorCheck = z.infer<typeof engineDoctorCheckSchema>

// What `GET /doctor` finds on disk, without fixing anything. `agentIds` is the engine's agent index,
// for the hub to hold against the agents it has on record.
export const engineDoctorSchema = z.object({
    ok: z.boolean(),
    dataVersion: z.number(),
    dataVersionTarget: z.number(),
    agentIds: z.array(z.string()),
    checks: z.array(engineDoctorCheckSchema),
})
export type EngineDoctor = z.infer<typeof engineDoctorSchema>

export const ENGINE_CAPABILITY_FILES_STREAM = 'files.stream'

// The foreman's own workspace takes the files of a chat message, and its runs can be read back.
export const ENGINE_CAPABILITY_FOREMAN_FILES = 'foreman.files'

// The box has a window manager and a VNC server, so its screen can be watched and driven.
export const ENGINE_CAPABILITY_DESKTOP = 'desktop'

// A person can take an explicit hold on an agent's screen (`POST /agents/:id/desktop/hold`) and
// pause its recording, so the app can offer "Take over" / "I'm done".
export const ENGINE_CAPABILITY_DESKTOP_HOLD = 'desktop.hold'

// The box can capture its screens (maim), so its agents get the `computer` tools.
export const ENGINE_CAPABILITY_COMPUTER = 'computer'

// The box records its screen sessions to MP4 (ffmpeg, and RERUN_COMPUTER_RECORDING not `off`).
export const ENGINE_CAPABILITY_COMPUTER_RECORDING = 'computer.recording'

// A schedule's PATCH takes a new `name` and writes it into the schedule's own file, its slug unchanged.
export const ENGINE_CAPABILITY_SCHEDULE_RENAME = 'schedules.rename'

// `POST /update` takes a prebuilt artifact (`{ artifact: { url, sha256, commit } }`) instead of pulling and building.
export const ENGINE_CAPABILITY_ARTIFACT_UPDATE = 'update.artifact'

// The engine runs OpenCode connections: the hub offers OpenCode only to a box that says so.
export const ENGINE_CAPABILITY_OPENCODE = 'connections.opencode'

// The engine runs custom OpenAI-compatible connections and answers `POST /connections/probe`.
export const ENGINE_CAPABILITY_CUSTOM = 'connections.custom'

// What the last `rerun update` on a box did, as `/health` reports it.
export const engineLastUpdateSchema = z.object({
    status: z.enum(['running', 'error', 'restarting', 'success']),
    commit: z.string().nullable(),
    error: z.string().optional(),
    at: z.string(),
})
export type EngineLastUpdate = z.infer<typeof engineLastUpdateSchema>

export const ENGINE_LAYOUTS = ['release', 'monorepo', 'image'] as const
export type EngineLayout = (typeof ENGINE_LAYOUTS)[number]
