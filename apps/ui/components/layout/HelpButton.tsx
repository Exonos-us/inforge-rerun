'use client'

import { SUPPORT_CHAT_ENABLED } from '@rerun/cloud/support'
import { ChromePill } from '@rerun/ui/chrome'
import { HelpMenuItems } from '@/components/layout/ToolbarActions'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { TooltipLabeled } from '@/components/ui/tooltip'
import { HeadsetIcon, HelpCircleIcon } from '@/lib/icons'
import { openCrisp } from '@/lib/crisp'
import { useSession } from '@/supabase/session/SessionProvider'
import { useRef } from 'react'

export function HelpButton() {
    const { session } = useSession()
    // The menu hands focus back to its trigger as it closes, which the checklist popover would read
    // as a click outside and close on the spot.
    const openingGettingStarted = useRef(false)

    return (
        <DropdownMenu>
            <TooltipLabeled label="Help" side="bottom">
                <DropdownMenuTrigger asChild>
                    <ChromePill start="icon" end="icon" aria-label="Help">
                        <HelpCircleIcon className="size-4 text-muted-foreground" />
                    </ChromePill>
                </DropdownMenuTrigger>
            </TooltipLabeled>
            <DropdownMenuContent
                align="start"
                side="bottom"
                className="w-56 max-h-[calc(100dvh-5rem)] overflow-y-auto"
                onCloseAutoFocus={event => {
                    if (!openingGettingStarted.current) return
                    openingGettingStarted.current = false
                    event.preventDefault()
                }}
            >
                {SUPPORT_CHAT_ENABLED && (
                    <>
                        <DropdownMenuItem onSelect={() => openCrisp(session?.user?.email)} className="gap-2 text-muted-foreground">
                            <HeadsetIcon className="size-4" />
                            Contact support
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                    </>
                )}
                <HelpMenuItems
                    onOpenGettingStarted={() => {
                        openingGettingStarted.current = true
                    }}
                />
            </DropdownMenuContent>
        </DropdownMenu>
    )
}
