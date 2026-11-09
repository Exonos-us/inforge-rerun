'use client'

import type { ReactNode } from 'react'

import { DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

// The one frame both billing dialogs share: what is sold or changed on the left, how it is paid or
// what it costs on the right, `intro` heading the left column. Below sm the dialog is a bottom sheet,
// the columns stack and the sheet scrolls as a whole. `payment-first` puts the payment right under
// the intro there, the plan's details after it: with nothing to choose, the button is what matters,
// and it would otherwise sit two or three screens down.
export function BillingDialogShell({
    title,
    intro,
    left,
    right,
    mobileOrder = 'plan-first',
}: {
    title: string
    intro?: ReactNode
    left: ReactNode
    right: ReactNode
    mobileOrder?: 'plan-first' | 'payment-first'
}) {
    const paymentFirst = mobileOrder === 'payment-first'
    return (
        <DialogContent aria-describedby={undefined} className="gap-0 bg-popover sm:max-w-[min(76rem,100%_-_4rem)] sm:overflow-hidden sm:[&>[data-slot=dialog-close]]:top-6 sm:[&>[data-slot=dialog-close]]:right-6">
            <DialogTitle className="sr-only">{title}</DialogTitle>
            <div className="flex min-w-0 flex-col gap-4 sm:grid sm:h-[min(56rem,calc(100dvh_-_4rem))] sm:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] sm:grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,27.5rem)]">
                {/* `contents` below sm hands intro and details to the outer column, so `order` can slot the payment between them. */}
                <div className="max-sm:contents sm:flex sm:min-h-0 sm:flex-col sm:overflow-y-auto sm:p-2">
                    {intro && <div className="max-sm:order-1 max-sm:px-2 max-sm:pt-2">{intro}</div>}
                    <div className={cn('flex flex-col max-sm:px-2 max-sm:pb-2 sm:flex-1', paymentFirst ? 'max-sm:order-3' : 'max-sm:order-2', !intro && 'max-sm:pt-2')}>{left}</div>
                </div>
                <div className={cn('relative flex flex-col overflow-hidden rounded-xl bg-muted/50 p-5 ring-1 ring-border sm:min-h-0 sm:overflow-y-auto sm:p-6', paymentFirst ? 'max-sm:order-2' : 'max-sm:order-3')}>{right}</div>
            </div>
        </DialogContent>
    )
}
