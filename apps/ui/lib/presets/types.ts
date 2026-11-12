import { z } from 'zod'

// What a preset row's jsonb columns hold. Parsed with .catch everywhere a row is read: a preset
// written by an older build must render, not crash the store.

export const presetQuestionSchema = z.object({
    key: z.string(),
    question: z.string(),
    multiline: z.boolean().default(false),
})
export type PresetQuestion = z.infer<typeof presetQuestionSchema>
export const presetQuestionsFromRow = z.array(presetQuestionSchema).catch([])

export const presetSummarySchema = z.object({
    skills: z.array(z.object({ name: z.string(), description: z.string().default('') })).default([]),
    schedules: z.array(z.object({ name: z.string(), cron: z.string() })).default([]),
    tools: z.array(z.string()).default([]),
})
export type PresetSummary = z.infer<typeof presetSummarySchema>
export const presetSummaryFromRow = presetSummarySchema.catch({ skills: [], schedules: [], tools: [] })

export const connectorSlugsFromRow = z.array(z.string()).catch([])

export const tagsFromRow = z.array(z.string()).catch([])

// Skills carried by the preset itself, created on the fresh agent at hire. Distinct from
// summary.skills, which is the read-only projection of a captured archive. The same shape a Claude
// skill has: either instructions written in the form (body), or an uploaded SKILL.md kept verbatim
// (raw) with its bundled text files.
export const authoredSkillSchema = z.object({
    name: z.string(),
    description: z.string().default(''),
    body: z.string().default(''),
    raw: z.string().default(''),
    files: z.array(z.object({ path: z.string(), content: z.string() })).default([]),
})
export type AuthoredSkill = z.infer<typeof authoredSkillSchema>
export const authoredSkillsFromRow = z.array(authoredSkillSchema).catch([])

// Routines carried by the preset: created as schedules on every hire, switched on.
export const authoredRoutineSchema = z.object({
    name: z.string(),
    cron: z.string().default(''),
    body: z.string().default(''),
})
export type AuthoredRoutine = z.infer<typeof authoredRoutineSchema>
export const authoredRoutinesFromRow = z.array(authoredRoutineSchema).catch([])

// Knowledge carried by the preset: text documents written into every hire's files under knowledge/.
export const knowledgeDocSchema = z.object({
    path: z.string(),
    content: z.string(),
})
export type KnowledgeDoc = z.infer<typeof knowledgeDocSchema>
export const knowledgeDocsFromRow = z.array(knowledgeDocSchema).catch([])

// Stored inside the preset row, so a hard cap per list: anything heavier belongs on a live
// coworker, where capturing it puts it in the archive instead.
export const MAX_PRESET_SKILLS_BYTES = 2_000_000
export const MAX_PRESET_KNOWLEDGE_BYTES = 2_000_000

export const teamMemberSchema = z.object({
    presetId: z.string(),
    count: z.number().int().min(1).max(8),
})
export type TeamPresetMember = z.infer<typeof teamMemberSchema>
export const teamMembersFromRow = z.array(teamMemberSchema).catch([])
