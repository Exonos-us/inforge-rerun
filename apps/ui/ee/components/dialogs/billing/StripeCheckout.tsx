'use client'

import { BillingAddressElement, CheckoutElementsProvider, ExpressCheckoutElement, PaymentElement, TaxIdElement, useCheckout } from '@stripe/react-stripe-js/checkout'
import type { Appearance, StripeCheckoutExpressCheckoutElementOptions, StripeExpressCheckoutElementConfirmEvent } from '@stripe/stripe-js'
import { useTheme } from 'next-themes'
import { useState, type ReactNode } from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import { TooltipDisabledReason } from '@/components/ui/tooltip'
import { stripeBrowser } from '@/ee/lib/billing/stripe-client'
import { cn } from '@/lib/utils'

import { Notice, PromoCodeField, usd } from './parts'

// No `verification` option: the element refuses to load with it on an account without Stripe Tax
// Complete. The number is still checked against VIES once it lands on the customer.
const TAX_ID_OPTIONS = { visibility: 'auto' } as const

function appearanceFor(theme: string | undefined): Appearance {
    return {
        theme: theme === 'light' ? 'stripe' : 'night',
        variables: { borderRadius: '8px', fontSizeBase: '14px', spacingUnit: '3px' },
    }
}

// A Checkout Session rendered by the app (`ui_mode: 'elements'`). Every child reads the session
// through `useCheckout`: its totals, `confirm`, `runServerUpdate`. The appearance is read once: the
// options of a mounted provider cannot change.
export function StripeCheckoutProvider({ clientSecret, children }: { clientSecret: string; children: ReactNode }) {
    const { resolvedTheme } = useTheme()
    const [options] = useState(() => ({ clientSecret, elementsOptions: { appearance: appearanceFor(resolvedTheme) } }))
    return (
        <CheckoutElementsProvider stripe={stripeBrowser()} options={options}>
            {children}
        </CheckoutElementsProvider>
    )
}

export function StripePaymentFieldsSkeleton() {
    return (
        <div className="flex flex-col gap-4">
            <div className="grid grid-cols-3 gap-2">
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
            </div>
            <Skeleton className="h-10 w-full" />
            <div className="grid grid-cols-2 gap-2">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
            </div>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-5 w-48" />
        </div>
    )
}

// The Payment Element never offers Apple Pay in a Chromium browser nor Google Pay in Safari: only the
// Express Checkout Element set to `always` does. Once it is on the page, Stripe moves the wallets
// out of the Payment Element, so they are never shown twice. Link stays in the Payment Element.
const WALLET_OPTIONS: StripeCheckoutExpressCheckoutElementOptions = {
    buttonHeight: 44,
    buttonTheme: undefined,
    buttonType: { applePay: 'subscribe', googlePay: 'subscribe' },
    layout: undefined,
    paymentMethodOrder: ['apple_pay', 'google_pay'],
    paymentMethods: { applePay: 'always', googlePay: 'always', link: 'never', paypal: 'never', amazonPay: 'never', klarna: 'never' },
}

export type WalletPayment = {
    onConfirm: (event: StripeExpressCheckoutElementConfirmEvent) => void
    // This mode of the element has no click hook, so a wallet that may not pay yet is greyed out and
    // its clicks never reach the iframe.
    disabledReason?: string
}

// The wallets, the card and the billing address. The address is not optional: the tax is computed from
// it, and a wallet hands over its own. The tax ID sits behind Stripe's own "purchasing as a business"
// box: in this mode `tax_id_collection` on the session draws nothing by itself.
export function StripePaymentFields({ wallet }: { wallet?: WalletPayment }) {
    const checkout = useCheckout()
    const [walletsShown, setWalletsShown] = useState(false)
    if (checkout.type === 'loading') return <StripePaymentFieldsSkeleton />
    if (checkout.type === 'error') return <Notice tone="danger">{checkout.error.message}</Notice>

    return (
        <div className="flex flex-col gap-4">
            {wallet && (
                <div className={cn('flex flex-col gap-4', !walletsShown && 'hidden')}>
                    {/* The tooltip sits on a layer above the element rather than around it: wrapping it
                        only while disabled would remount the element, and Stripe draws it back empty. */}
                    <div className="relative">
                        <div className={cn(wallet.disabledReason && 'pointer-events-none opacity-50')}>
                            <ExpressCheckoutElement
                                options={WALLET_OPTIONS}
                                onAvailablePaymentMethodsChange={({ paymentMethods }) => setWalletsShown(!!paymentMethods)}
                                onConfirm={event => {
                                    if (wallet.disabledReason) return event.paymentFailed({ reason: 'fail', message: wallet.disabledReason })
                                    wallet.onConfirm(event)
                                }}
                            />
                        </div>
                        {wallet.disabledReason && (
                            <TooltipDisabledReason reason={wallet.disabledReason} className="absolute inset-0">
                                <span className="size-full" />
                            </TooltipDisabledReason>
                        )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="h-px flex-1 bg-border" />
                        or pay with card
                        <span className="h-px flex-1 bg-border" />
                    </div>
                </div>
            )}
            <PaymentElement options={{ layout: 'tabs' }} />
            <BillingAddressElement />
            <TaxIdElement options={TAX_ID_OPTIONS} />
        </div>
    )
}

// The session takes promotion codes, but in this mode Stripe draws no field for them. The discount
// reads off the next invoice when nothing is due today, which is every trial.
export function StripePromoCode({ disabled }: { disabled?: boolean }) {
    const checkout = useCheckout()
    if (checkout.type !== 'success') return null

    const session = checkout.checkout
    const discount = session.discountAmounts?.find(amount => amount.promotionCode)
    const discountCents = Math.max(discount?.minorUnitsAmount ?? 0, session.recurring?.dueNext.discount.minorUnitsAmount ?? 0)
    const applied = discount?.promotionCode
        ? { code: discount.promotionCode, discount: discount.percentOff != null ? `${discount.percentOff}% off` : `${usd(discountCents)} off` }
        : null

    return (
        <PromoCodeField
            applied={applied}
            disabled={disabled}
            onApply={async code => {
                const result = await session.applyPromotionCode(code)
                return result.type === 'error' ? result.error.message : null
            }}
            onRemove={async () => {
                const result = await session.removePromotionCode()
                return result.type === 'error' ? result.error.message : null
            }}
        />
    )
}
