import { task } from '@trigger.dev/sdk/v3'
import { startAgentOnEngine, stopAgentsOnEngine } from '@/app/api/_services/agent-activation.service'
import { taskLogger as logger, triggerTask } from '@rerun/cloud/tasks'

// `switchOn` is a plan that grew, waking coworkers; without it the batch is switched off.
export type SyncAgentActivationPayload = { agentIds: string[]; switchOn?: boolean }

// The engine half of a plan-driven deactivation. The webhook has already written
// `agents.disabled_at`, which is what gates every interactive path; stopping the schedules and
// flipping the engine config means reaching a box that may be asleep, and a webhook that waits for
// it times out. Retried hard: an agent left on its cron is an agent still spending on a plan that
// no longer covers it.
export const syncAgentActivationTask = task({
    id: 'sync-agent-activation',
    maxDuration: 300,
    retry: { maxAttempts: 5, factor: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 60000 },
    run: (payload: SyncAgentActivationPayload) => syncAgentActivationRun(payload),
})

export async function syncAgentActivationRun({ agentIds, switchOn }: SyncAgentActivationPayload) {
    const step = switchOn ? 'activation' : 'deactivation'
    logger.log(`agent ${step} starting`, { count: agentIds.length })
    if (switchOn) for (const agentId of agentIds) await startAgentOnEngine(agentId)
    else await stopAgentsOnEngine(agentIds)
    logger.log(`agent ${step} done`, { count: agentIds.length })
    return { agentIds }
}

// Fire-and-forget from the webhook: a Trigger outage must not turn a downgrade into a 500 and an
// endless Stripe retry, since the flag that gates access is already written.
export async function requestAgentActivationSync(agentIds: string[], { switchOn = false }: { switchOn?: boolean } = {}): Promise<void> {
    if (agentIds.length === 0) return
    try {
        await triggerTask<typeof syncAgentActivationTask>('sync-agent-activation', switchOn ? { agentIds, switchOn } : { agentIds })
    } catch (err) {
        console.error(`Failed to schedule an agent ${switchOn ? 'activation' : 'deactivation'}`, err)
    }
}
