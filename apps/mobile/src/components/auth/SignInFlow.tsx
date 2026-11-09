import type { PhoneChannel } from '@rerun/contracts'
import type { CountryCode } from 'libphonenumber-js/min'
import { createContext, useContext, useState, type ReactNode } from 'react'

import { deviceCountry } from '@/lib/phone'

export type SignInStep =
    | { name: 'start' }
    | { name: 'phone' }
    | { name: 'email' }
    | { name: 'server' }
    // `resendIn` is what the hub said is left of a code sent earlier.
    | { name: 'code'; method: 'phone'; channel: PhoneChannel; resendIn?: number }
    | { name: 'code'; method: 'email' }

type SignInFlow = {
    country: CountryCode
    setCountry: (country: CountryCode) => void
    phone: string
    setPhone: (phone: string) => void
    email: string
    setEmail: (email: string) => void
    step: SignInStep
    // Which way the last move went, so a step slides in from the side it comes from.
    direction: 'forward' | 'back'
    goTo: (step: SignInStep) => void
    back: () => void
    // Something is on its way to the hub: the Foreman thinks while it is.
    thinking: boolean
    setThinking: (thinking: boolean) => void
}

const SignInFlowContext = createContext<SignInFlow | null>(null)

// What the sign-in steps share: the country sheet and the code step read what the first step typed.
export function SignInFlowProvider({ initialStep = { name: 'start' }, children }: { initialStep?: SignInStep; children: ReactNode }) {
    const [country, setCountry] = useState<CountryCode>(deviceCountry)
    const [phone, setPhone] = useState('')
    const [email, setEmail] = useState('')
    const [history, setHistory] = useState<SignInStep[]>(() => (initialStep.name === 'start' ? [initialStep] : [{ name: 'start' }, initialStep]))
    const [direction, setDirection] = useState<'forward' | 'back'>('forward')
    const [thinking, setThinking] = useState(false)

    const goTo = (step: SignInStep) => {
        setDirection('forward')
        setHistory(previous => [...previous, step])
    }
    const back = () => {
        setDirection('back')
        setHistory(previous => (previous.length > 1 ? previous.slice(0, -1) : previous))
    }

    const step = history[history.length - 1]
    return <SignInFlowContext.Provider value={{ country, setCountry, phone, setPhone, email, setEmail, step, direction, goTo, back, thinking, setThinking }}>{children}</SignInFlowContext.Provider>
}

export function useSignInFlow(): SignInFlow {
    const value = useContext(SignInFlowContext)
    if (!value) throw new Error('useSignInFlow must be used inside SignInFlowProvider')
    return value
}
