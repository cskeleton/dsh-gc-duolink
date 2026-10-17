/**
 * Human-facing `/gc-duolink` command over the Session Link registry. Every
 * mutation records the human as its granting authority; the model never sees
 * this command. It registers in the scope of top-level Agents whose preset
 * the row config lists.
 * @module dsh-gc-duolink/command-session-link
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionLinkError, SessionLinkId } from './index.ts'
import type {} from './index.ts'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { mountPerPresetAgent, PresetScopeConfig, resolvePresets } from './scope.ts'

export const name = 'command-gc-duolink'
export const inject = ['commands', 'gcDuolink', 'agents', 'sessions']

/** Row configuration: which presets' top-level Agents receive the command. */
export type Config = PresetScopeConfig
/** Loader-visible row schema. */
export const Config = PresetScopeConfig

const USAGE = 'Usage: /gc-duolink [list|add <peer-session-id> [wake]|wake <peer-session-id> on|off|revoke <link-id>]'

/** One successful listing row, rendered for the dispatching human. */
function listing(ctx: Context, invocation: CommandInvocation): string {
  const links = ctx.gcDuolink.list(invocation.agent.id)
  if (links.length === 0) {
    return '本会话不属于任何会话互联组。用 /gc-duolink add <另一个会话ID> 把另一个已有会话与本会话互联，对方会话 ID 可在其会话信息或 /gc-duolink 输出中查看。'
  }
  return links.map((link) => {
    const peers = link.memberIds
      .filter(member => member !== invocation.agent.id)
      .map((member) => {
        const live = ctx.agents.get(member)
        const autoWake = link.autoWakeSessionIds.includes(member) ? 'auto-wake 开' : 'auto-wake 关'
        const status = live === undefined ? '未激活' : live.status === 'running' ? '运行中' : '空闲'
        return `  - ${member}（${status}，${autoWake}）`
      })
    return `互联组「${link.name}」 <${link.id}>（修订 ${link.revision}）\n${peers.join('\n')}`
  }).join('\n\n')
}

/** Parse `/gc-duolink` grammar; anything unrecognized is a usage error. */
function parse(input: string):
  | { readonly kind: 'list' }
  | { readonly kind: 'add'; readonly sessionId: SessionId; readonly wake: boolean }
  | { readonly kind: 'wake'; readonly sessionId: SessionId; readonly on: boolean }
  | { readonly kind: 'revoke'; readonly linkId: SessionLinkId }
  | { readonly kind: 'invalid' } {
  const trimmed = input.trim()
  if (trimmed.length === 0 || trimmed === 'list') return { kind: 'list' }
  const add = /^add\s+(\S+)(?:\s+(wake))?\s*$/iu.exec(trimmed)
  if (add !== null && add[1] !== undefined) {
    return { kind: 'add', sessionId: brandString<SessionId>(add[1]), wake: add[2] !== undefined }
  }
  const wake = /^wake\s+(\S+)\s+(on|off)\s*$/iu.exec(trimmed)
  if (wake !== null && wake[1] !== undefined && wake[2] !== undefined) {
    return { kind: 'wake', sessionId: brandString<SessionId>(wake[1]), on: wake[2].toLowerCase() === 'on' }
  }
  const revoke = /^revoke\s+(\S+)\s*$/iu.exec(trimmed)
  if (revoke !== null && revoke[1] !== undefined) {
    return { kind: 'revoke', linkId: SessionLinkId(revoke[1]) }
  }
  return { kind: 'invalid' }
}

/** Execute one parsed `/gc-duolink` invocation. */
async function execute(
  ctx: Context,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const parsed = parse(invocation.rawInput)
  switch (parsed.kind) {
    case 'invalid':
      return { kind: 'error', text: USAGE }
    case 'list':
      return { kind: 'success', text: listing(ctx, invocation) }
    case 'add': {
      if (parsed.sessionId === invocation.agent.id) {
        return { kind: 'error', text: '不能把会话与自身互联' }
      }
      const tail = String(parsed.sessionId).split('-').at(-1) ?? String(parsed.sessionId)
      let id: SessionLinkId
      try {
        ctx.gcDuolink.assertOrdinaryTarget(invocation.agent.id, invocation.agent.session.header)
        ctx.gcDuolink.assertOrdinaryTarget(parsed.sessionId, await ctx.gcDuolink.inspectHeader(parsed.sessionId))
        ;({ id } = await ctx.gcDuolink.link(
          `互联-${tail}`,
          [invocation.agent.id, parsed.sessionId],
          { kind: 'human' },
          { autoWakeSessionIds: parsed.wake ? [parsed.sessionId] : [], requireNewPair: true },
        ))
      } catch (error: unknown) {
        if (!(error instanceof SessionLinkError)) throw error
        return {
          kind: 'error',
          text: error.code === 'LINK_ALREADY_LINKED'
            ? `会话 ${parsed.sessionId} 已与本会话互联，用 /gc-duolink 查看现有互联组`
            : error.message,
        }
      }
      return {
        kind: 'success',
        text: `已把会话 ${parsed.sessionId} 与本会话互联（组 ${id}${parsed.wake ? '，auto-wake 已开' : ''}）：双方可用 gc_duolink_send_message 互发消息；随时用 /gc-duolink revoke ${id} 解除。`,
      }
    }
    case 'revoke': {
      const linked = ctx.gcDuolink.list(invocation.agent.id).find(link => link.id === parsed.linkId)
      if (linked === undefined) {
        return { kind: 'error', text: `当前会话不属于互联组 ${parsed.linkId}（用 /gc-duolink 查看本会话的互联组）` }
      }
      try {
        await ctx.gcDuolink.unlink(parsed.linkId)
      } catch (error: unknown) {
        if (error instanceof SessionLinkError) return { kind: 'error', text: error.message }
        throw error
      }
      return {
        kind: 'success',
        text: `已解除互联组「${linked.name}」：双方不能再互发消息，未投递的消息已标记为 revoked（已送达的内容保留在各自会话中）。`,
      }
    }
    case 'wake': {
      const owned = ctx.gcDuolink.list(invocation.agent.id)
      const hit = owned
        .map(link => ({ link, peer: parsed.sessionId }))
        .filter(({ link, peer }) => link.memberIds.includes(peer))
      if (parsed.sessionId === invocation.agent.id) {
        return { kind: 'error', text: 'auto-wake 只针对互联的对方会话设置' }
      }
      if (hit.length === 0) {
        return { kind: 'error', text: `会话 ${parsed.sessionId} 与本会话不在同一互联组` }
      }
      try {
        for (const { link, peer } of hit) {
          await ctx.gcDuolink.setMemberAutoWake(link.id, peer, parsed.on, invocation.agent.id)
        }
      } catch (error: unknown) {
        if (error instanceof SessionLinkError) return { kind: 'error', text: error.message }
        throw error
      }
      return {
        kind: 'success',
        text: parsed.on
          ? `已开启：发往 ${parsed.sessionId} 的会话消息可自动唤醒它（受每日/每条消息预算限制）。`
          : `已关闭：发往 ${parsed.sessionId} 的会话消息将排队等待其下一轮工作，不再自动唤醒。`,
      }
    }
  }
}

/**
 * Register the `/gc-duolink` command in each eligible top-level Agent's scope.
 * @param ctx - registrant context carrying the command, Session Link, and Agent registries.
 * @param config - presets whose top-level Agents receive the command.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const command: CommandDefinition = {
    definitionId: CommandDefinitionId('dsh-gc-duolink/command'),
    name: 'gc-duolink',
    description: '查看本会话的互联组，开关对端自动唤醒，或解除互联',
    input: { hint: '[list|add <peer-session-id> [wake]|wake <peer-session-id> on|off|revoke <link-id>]' },
    handler: invocation => execute(ctx, invocation),
  }
  mountPerPresetAgent(ctx, resolvePresets(config), 'gc-duolink-command', ['commands'], (scoped) => {
    scoped.commands.register(command)
  })
}
