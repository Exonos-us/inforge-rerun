import { useLocalSearchParams } from 'expo-router'

import { SignInFlowProvider, type SignInStep } from '@/components/auth/SignInFlow'
import { SignInSheet } from '@/components/auth/SignInSheet'
import type { StartLayout } from '@/components/auth/steps/StartStep'

// Dev only: the sign-in sheet in each of its steps, reachable while signed in.
const STEPS: Record<string, SignInStep> = {
    start: { name: 'start' },
    phone: { name: 'phone' },
    email: { name: 'email' },
    server: { name: 'server' },
    'code-phone': { name: 'code', method: 'phone', channel: 'whatsapp' },
    'code-email': { name: 'code', method: 'email' },
}

export default function SignInSheetLab() {
    const params = useLocalSearchParams<{ layout?: StartLayout; step?: string }>()
    const step = STEPS[params.step ?? 'start'] ?? STEPS.start
    return (
        <SignInFlowProvider key={`${params.layout}-${params.step}`} initialStep={step}>
            <SignInSheet startLayout={params.layout === 'choices' ? 'choices' : 'phone-first'} />
        </SignInFlowProvider>
    )
}
