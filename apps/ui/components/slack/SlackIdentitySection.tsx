'use client'

import { saveSlackEmailAction, type SlackStateView } from '@/app/api/_actions/slack.actions'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

// Private channels Rerun creates can only be reached by invitation, and the invitation finds the
// member by email. This field covers the accounts whose Slack lives under another address than
// their Rerun sign-in. Each member sets their own.
export function SlackIdentitySection({ state, reload }: { state: SlackStateView; reload: () => Promise<void> }) {
    const [email, setEmail] = useState(state.mySlackEmail ?? '')
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        setEmail(state.mySlackEmail ?? '')
    }, [state.mySlackEmail])

    const unchanged = email.trim().toLowerCase() === (state.mySlackEmail ?? '')

    const save = async () => {
        setSaving(true)
        const result = await saveSlackEmailAction({ email }).catch(() => null)
        setSaving(false)
        if (!result) return toast.error('The server did not answer. Reload the page and try again.')
        if (!result.ok) return toast.error(result.error)
        toast.success(email.trim() ? 'Saved — private channels now invite you at this address.' : 'Cleared — your sign-in email is used again.')
        await reload()
    }

    return (
        <Field label="Your Slack email" helperText="When Rerun creates a private channel, it invites you by finding this address in Slack. Leave it empty if you sign in to Rerun with the same email you use on Slack.">
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    type="email"
                    value={email}
                    onChange={event => setEmail(event.target.value)}
                    onKeyDown={event => {
                        if (event.key === 'Enter' && !unchanged) void save()
                    }}
                    placeholder="you@company.com"
                    className="h-8 min-w-48 flex-1 text-xs"
                />
                <Button type="button" variant="outline" size="sm" loading={saving} disabled={unchanged} onClick={save}>
                    Save
                </Button>
            </div>
        </Field>
    )
}
