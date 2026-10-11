/**
 * Per-Agent mounting for the Session Link tool and command rows. Preset rows
 * are not Loader groups, so a bundle patch cannot insert children into their
 * `config.plugins`; instead each row registers into the scope of every live
 * top-level Agent whose bound preset is listed, and follows later preset
 * selections and plugin unload.
 * @module dsh-session-link/scope
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import z from '@deepseek-ai/schemastery'
import { subagentOwned } from './link.ts'

/** Row configuration shared by the tool and command rows. */
export interface PresetScopeConfig {
  /**
   * Exact preset allowlist when specified (an empty list enables none).
   * When omitted, standard/ptc/cordis and the registry's effective default
   * receive the contribution. `minimal` is always excluded. Without the
   * registry, only automatic mode falls back to every top-level Agent.
   */
  readonly presets?: string[]
}

/** Preserve omission through Loader validation so explicit lists remain exact. */
export const PresetScopeConfig: z<PresetScopeConfig> = z.object({
  // Schemastery arrays implicitly default to []; clear it so omission differs
  // from an explicitly empty allowlist even after Loader resolves this schema.
  presets: z.array(z.string()).extra('default', undefined),
})

const STANDARD_PRESETS: readonly string[] = ['standard', 'ptc', 'cordis']

/**
 * Resolve one row's preset list without freezing the registry's current default.
 * @param config - row configuration as mounted, or omitted by programmatic callers.
 * @returns an exact allowlist, or undefined for automatic preset selection.
 */
export function resolvePresets(config: PresetScopeConfig = {}): readonly string[] | undefined {
  return PresetScopeConfig(config).presets
}

/**
 * Keep one child plugin mounted under each eligible Agent's `agent.ctx`, so
 * its registrations land in that Agent's scope. An Agent scope exposes only
 * the services its minting plugin injected, so the child declares its own
 * `inject`. Subagent-owned Agents never receive it. A failed child is logged
 * per Agent and leaves other Agents unaffected.
 * @param ctx - row context carrying the Agent registry.
 * @param presets - resolved preset ids from the row config.
 * @param label - child plugin name and diagnostic label.
 * @param inject - services the child plugin requires, such as `tools` or `commands`.
 * @param contribute - registers through the scoped child context.
 */
export function mountPerPresetAgent(
  ctx: Context,
  presets: readonly string[] | undefined,
  label: string,
  inject: readonly string[],
  contribute: (scoped: Context) => void,
): void {
  const mounted = new Map<Agent, () => void>()
  const eligible = (agent: Agent): boolean => {
    if (ctx.agents.get(agent.id) !== agent) return false
    if (subagentOwned(ctx, agent.id, agent.session.header)) return false
    const registry = ctx.get('agentPresets')
    if (registry === undefined) return presets === undefined
    const preset = registry.composedPreset(agent.ctx)
    if (preset === undefined || preset === 'minimal') return false
    if (presets !== undefined) return presets.includes(preset)
    // SDK defaultId resolves selectedDefault.get() ?? config.default. Read it
    // on each evaluation rather than snapshotting the default at plugin mount.
    return STANDARD_PRESETS.includes(preset) || preset === registry.defaultId
  }
  /** Mount or withdraw for one Agent; resolves once a new mount settles, never rejecting. */
  const sync = async (agent: Agent | undefined): Promise<undefined> => {
    if (agent === undefined) return
    const dispose = mounted.get(agent)
    const want = eligible(agent)
    if (want && dispose === undefined) {
      const fiber = agent.ctx.plugin({ name: label, inject: [...inject], apply: contribute })
      mounted.set(agent, () => { void fiber.dispose() })
      try {
        await fiber.await()
      } catch (error: unknown) {
        ctx.logger.warn(`${label}: mount for "${agent.id}" failed: ${String(error)}`)
      }
    } else if (!want && dispose !== undefined) {
      mounted.delete(agent)
      dispose()
    }
  }
  // `agent/created` is a serial dispatch: awaiting the mount publishes the Agent with its contribution in place.
  ctx.on('agent/created', ({ agent }) => sync(agent))
  ctx.on('agent-preset/selected', (sessionId) => { void sync(ctx.agents.get(sessionId)) })
  // The Agent's own fiber disposes the child plugin; only the bookkeeping is dropped here.
  ctx.on('agent/disposed', ({ agent }) => { mounted.delete(agent) })
  ctx.effect(() => () => {
    for (const dispose of mounted.values()) dispose()
    mounted.clear()
  }, label)
  for (const agent of ctx.agents.list()) void sync(agent)
}
