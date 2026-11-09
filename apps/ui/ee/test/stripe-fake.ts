import Stripe from 'stripe'
import { vi } from 'vitest'

// Offline: `webhooks` only signs and verifies locally, so the real one is kept and a webhook route
// under test checks a genuine signature rather than a mocked `constructEventAsync`.
const offline = new Stripe('sk_test_vitest')

export const TEST_WEBHOOK_SECRET = 'whsec_vitest'

// Every resource the server code calls, each method a bare vi.fn(). Used as the `stripe` export of
// @/lib/billing/stripe, keeping the module's pure helpers real:
//
//   vi.mock('@/ee/lib/billing/stripe', async importOriginal => ({
//       ...(await importOriginal<typeof import('@/ee/lib/billing/stripe')>()),
//       stripe: (await import('@/ee/test/stripe-fake')).fakeStripe(),
//   }))
export function fakeStripe() {
    return {
        webhooks: offline.webhooks,
        customers: { create: vi.fn(), retrieve: vi.fn(), update: vi.fn(), createTaxId: vi.fn(), deleteTaxId: vi.fn() },
        subscriptions: { create: vi.fn(), retrieve: vi.fn(), update: vi.fn(), list: vi.fn(), cancel: vi.fn() },
        subscriptionSchedules: { create: vi.fn(), retrieve: vi.fn(), update: vi.fn(), release: vi.fn() },
        checkout: { sessions: { create: vi.fn(), retrieve: vi.fn(), update: vi.fn() } },
        setupIntents: { retrieve: vi.fn() },
        paymentMethods: { retrieve: vi.fn() },
        paymentIntents: { retrieve: vi.fn() },
        charges: { retrieve: vi.fn() },
        transfers: { create: vi.fn(), createReversal: vi.fn(), retrieve: vi.fn() },
        invoices: { createPreview: vi.fn(), list: vi.fn(), retrieve: vi.fn(), voidInvoice: vi.fn(), pay: vi.fn() },
        coupons: { create: vi.fn(), retrieve: vi.fn() },
        invoicePayments: { list: vi.fn() },
        billingPortal: { sessions: { create: vi.fn() }, configurations: { list: vi.fn(), create: vi.fn(), update: vi.fn() } },
        accounts: { retrieve: vi.fn(), create: vi.fn(), update: vi.fn(), createLoginLink: vi.fn() },
        accountLinks: { create: vi.fn() },
    }
}

export type FakeStripe = ReturnType<typeof fakeStripe>

// A POST carrying `event` with a valid `stripe-signature` for `secret`.
export function signedStripeRequest(event: { id: string; type: string; data: { object: unknown }; [key: string]: unknown }, { url = 'https://rerun.test/api/webhooks/stripe', secret = TEST_WEBHOOK_SECRET } = {}) {
    const payload = JSON.stringify({ object: 'event', api_version: '2025-01-01', created: 0, livemode: false, ...event })
    const signature = offline.webhooks.generateTestHeaderString({ payload, secret })
    return new Request(url, { method: 'POST', body: payload, headers: { 'stripe-signature': signature, 'content-type': 'application/json' } })
}
