'use client'

import { Button } from '@/components/ui/button'
import { HandIcon } from '@/lib/icons'
import { useBoardStore } from '@/stores/board.store'
import { useDesktopStore } from '@/stores/desktop.store'

// The slim state the chat keeps while the person has a coworker's screen: they may have closed the
// full-screen view to read the thread, so this says the screen is still theirs, with the way back
// and the way out. Clearing the store is enough to let go: the keeper releases the engine hold.
export function ScreenHoldNotice({ agentId }: { agentId: string }) {
    const holding = useDesktopStore(s => s.holdingAgentId === agentId)
    const viewOpen = useDesktopStore(s => s.agentId === agentId)
    const openDesktop = useDesktopStore(s => s.openDesktop)
    const setHolding = useDesktopStore(s => s.setHolding)
    const agentName = useBoardStore(s => s.agents.find(agent => agent.id === agentId)?.name)

    if (!holding || viewOpen) return null
    return (
        <div className="pointer-events-none absolute inset-x-3 top-1 z-40 flex justify-center">
            <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full bg-popover py-1 pr-1 pl-3 text-xs font-medium text-popover-foreground shadow-lg ring-1 ring-border">
                <HandIcon className="size-3.5 shrink-0 text-primary" />
                <span className="truncate">You have the screen — {agentName ?? 'your coworker'} is waiting</span>
                <Button size="sm" variant="ghost" className="h-6 shrink-0 rounded-full px-2 text-xs" onClick={() => openDesktop(agentId)}>
                    Open
                </Button>
                <Button size="sm" className="h-6 shrink-0 rounded-full px-2 text-xs" onClick={() => setHolding(null)}>
                    I’m done
                </Button>
            </div>
        </div>
    )
}
