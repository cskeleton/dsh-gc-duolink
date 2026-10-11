/**
 * Single-flight lazy installation of the host task-execution capability
 * (`ctx.taskHost`) onto live Agents, shared by the admission layer and the
 * task runtime (MODEL_ROUTING_PLAN final review, IMPORTANT-1 + F-C1b).
 *
 * Two concurrent tracked admissions to the SAME live target previously both
 * ran the capability factory: duplicate route-freeze listeners landed on the
 * Agent context, and the loser's live claims became invisible to the winner.
 * Every creation now joins ONE in-flight Promise per Agent: the factory runs
 * at most once per unresolved capability, every caller receives the SAME
 * instance, and any exception releases the flight so a later caller retries
 * honestly. A host without the factory yields undefined.
 * @module dsh-session-link/task-host-lazy
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveTaskHost } from './host-capability.ts'
import type { HostTaskHostCapability } from './host-capability.ts'

/** In-flight capability creations, keyed by the live Agent they install onto. */
const flights = new Map<Agent, Promise<HostTaskHostCapability | undefined>>()

/**
 * The capability factory, hosted outside the plugin's type surface because the
 * published `lib/types` declarations precede the host extension. Resolved
 * through the installed module's runtime namespace so the capability class is
 * the SAME identity any host-mounted capability the caller also resolved.
 */
async function createTaskHostLazy(
  ctx: Context,
  agent: Agent,
): Promise<HostTaskHostCapability | undefined> {
  const mod = await import('@deepseek-ai/dsh-api-session-controller') as Record<string, unknown>
  const factory = mod.createTaskHost as ((ctx: Context, agent: Agent) => HostTaskHostCapability) | undefined
  return factory === undefined ? undefined : factory(ctx, agent)
}

/**
 * Resolve (or lazily install, single-flighted) the task-host capability of one
 * live Agent. Idempotent: an Agent that already resolves a capability returns
 * it directly; concurrent creators join one flight; the created capability is
 * published on `agent.ctx` BEFORE the flight resolves so no later resolution
 * ever re-enters the factory.
 * @param agent - the live top-level Agent to arm.
 * @returns the capability, or undefined when the host cannot fabricate one.
 */
export function ensureTaskHostLazy(agent: Agent): Promise<HostTaskHostCapability | undefined> {
  const existing = resolveTaskHost(agent.ctx)
  if (existing !== undefined) return Promise.resolve(existing)
  const flying = flights.get(agent)
  if (flying !== undefined) return flying
  const flight = (async () => {
    try {
      // A second path may have published the capability while this flight
      // queued behind the dynamic import; resolve once more before fabricating.
      const resolved = resolveTaskHost(agent.ctx)
      if (resolved !== undefined) return resolved
      const capability = await createTaskHostLazy(agent.ctx, agent)
      if (capability === undefined) return undefined
      // cordis' service accessor publishes through `Fiber.provide`;
      // defineProperty makes the value visible to every later
      // `resolveTaskHost(agent.ctx)` the plugin and the runtime call.
      Object.defineProperty(agent.ctx, 'taskHost', { value: capability, configurable: true })
      return capability
    } catch {
      return undefined
    } finally {
      flights.delete(agent)
    }
  })()
  flights.set(agent, flight)
  return flight
}
