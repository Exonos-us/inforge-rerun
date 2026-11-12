'use client'

import { hireFromPresetAction } from '@/app/api/_actions/preset.actions'
import type { CoworkerPresetView } from '@/app/api/_services/preset.service'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useBoardStore } from '@/stores/board.store'
import { useSession } from '@/supabase/session/SessionProvider'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'

import { guarded } from './action-guard'

// One hire into an existing Box, as a dialog on the preset's Hire button: name it, find it a Box,
// answer the preset's questions, done. The answers become the hire's first memories.
export function PresetHireDialog({ preset, onHired, children }: { preset: CoworkerPresetView; onHired: () => void; children: ReactNode }) {
    const spaces = useBoardStore(state => state.spaces)
    const { workspace } = useSession()
    const [open, setOpen] = useState(false)
    const [spaceId, setSpaceId] = useState<string>('')
    const [name, setName] = useState(preset.name)
    const [answers, setAnswers] = useState<Record<string, string>>({})
    const [hiring, setHiring] = useState(false)

    const hire = async () => {
        setHiring(true)
        const result = await guarded(() =>
            hireFromPresetAction({
                spaceId,
                roster: { presetId: preset.id, name, icon: preset.icon || null },
                answers: preset.questions.map(question => ({ question: question.question, answer: answers[question.key] ?? '' })),
            })
        )
        setHiring(false)
        if (!result) return
        if (!result.ok) return toast.error(result.error)
        for (const warning of result.outcome.warnings) toast.warning(warning)
        toast.success(`${name} is hired.`)
        if (workspace) void useBoardStore.getState().hydrate(workspace.id)
        setOpen(false)
        onHired()
    }

    return (
        <Dialog
            open={open}
            onOpenChange={next => {
                setOpen(next)
                if (next) setName(preset.name)
            }}
        >
            <DialogTrigger asChild>{children}</DialogTrigger>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Hire “{preset.name}”</DialogTitle>
                    <DialogDescription>Starts fresh, wired like the preset. Pick the Box it lands in.</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <Field label="Name" htmlFor="hire-name">
                        <Input id="hire-name" value={name} onChange={e => setName(e.target.value)} />
                    </Field>
                    <Field label="Into Box" htmlFor="hire-space">
                        <Select value={spaceId} onValueChange={setSpaceId}>
                            <SelectTrigger id="hire-space" className="w-full">
                                <SelectValue placeholder="Pick a Box" />
                            </SelectTrigger>
                            <SelectContent>
                                {spaces.map(space => (
                                    <SelectItem key={space.id} value={space.id}>
                                        {space.name?.trim() || 'Unnamed Box'}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Field>
                    {preset.questions.map(question => (
                        <Field key={question.key} label={question.question} htmlFor={`hire-${question.key}`}>
                            {question.multiline ? (
                                <Textarea id={`hire-${question.key}`} rows={2} value={answers[question.key] ?? ''} onChange={e => setAnswers({ ...answers, [question.key]: e.target.value })} />
                            ) : (
                                <Input id={`hire-${question.key}`} value={answers[question.key] ?? ''} onChange={e => setAnswers({ ...answers, [question.key]: e.target.value })} />
                            )}
                        </Field>
                    ))}
                </div>
                <DialogFooter>
                    <Button size="sm" disabled={!spaceId || !name.trim()} loading={hiring} onClick={hire}>
                        Hire
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
