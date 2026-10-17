/** Browser-only Session Link contributions, with no Harness Client value imports. */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionLinkAddRequest, SessionLinkRevokeRequest, SessionLinkWakeRequest } from '../types.ts'
import { createLinkSource, createMailController, createWriteGate, type MailController } from './state.ts'
import {
  HeaderAction, ManagedLinkTab, ManagedLinkTabTitle, RowLinkAction, RowLinkMenu,
  type LinkInjected, type LinkActions,
} from './components.tsx'
import { TurnCard } from './TurnCard.tsx'
import { CopySessionIdMenu } from './CopySessionIdMenu.tsx'
import { sessionLinkTurnDefinition } from './turn.ts'
import { isActivityView, isCancelResult, isExtendWakeResult, isLinkView } from './rpc.ts'
import { en, NS, zh } from './locales.ts'

const TAB_ID = 'dsh-gc-duolink/panel'
const TAB_KIND = 'gcDuolink'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    gcDuolink: { readonly sessionId: SessionId }
  }
}

/** Required UI services; unavailable services leave this feature inactive. */
export const inject = ['slots', 'locale', 'connection', 'sidebarRightTabs', 'sidebarRight', 'uiWorkspace']

/**
 * Register the plugin's controls for the lifetime of their allocated slots.
 * Every write goes to the Host; accepted writes refresh all mounted surfaces.
 * @param ctx - active browser plugin context.
 */
export function apply(ctx: Context & { readonly connection: ConnectionHandle }): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'gc-duolink: locale')
  const t = ctx.locale.bind(NS)
  const invoke = async (method: string, args: object, signal?: AbortSignal): Promise<unknown> => {
    const result = await ctx.connection.rpc.call('/api', `gcDuolink/${method}`, { args }, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const source = createLinkSource({
    load: async signal => {
      const value = await invoke('view', {}, signal)
      if (!isLinkView(value)) throw new Error(t('panel.protocol.error'))
      return value
    },
    subscribeReset: listener => ctx.on('connection/reset', listener),
  })
  ctx.effect(() => () => source.dispose(), 'gc-duolink: view lifetime')
  // One mailbox source per owner Session; panel, glance, and popover share it.
  const mails = new Map<SessionId, MailController>()
  const mailFor = (sessionId: SessionId): MailController => {
    const existing = mails.get(sessionId)
    if (existing !== undefined) return existing
    const controller = createMailController({
      load: async (query, signal) => {
        const value = await invoke('activityView', { request: { sessionId, ...query } }, signal)
        if (!isActivityView(value)) throw new Error(t('panel.protocol.error'))
        return value
      },
      pollIntervalMs: () => source.getSnapshot().view?.pollIntervalMs ?? 30_000,
      subscribeReset: listener => ctx.on('connection/reset', listener),
    })
    mails.set(sessionId, controller)
    return controller
  }
  ctx.effect(() => () => {
    for (const controller of mails.values()) controller.dispose()
    mails.clear()
  }, 'gc-duolink: mail lifetime')
  // One write at a time across header, panel, and cards; clicks during a pending write are refused.
  const gate = createWriteGate()
  const mutate = (
    method: string,
    request: SessionLinkAddRequest | SessionLinkRevokeRequest | SessionLinkWakeRequest,
  ): Promise<void> => gate(async () => {
    await invoke(method, { request })
    if (!await source.refresh()) throw new Error(t('panel.refresh.error'))
    // A write changes pending mail for every linked owner; re-read rather
    // than trusting the interval so mailbox rows never lag their own write.
    for (const controller of mails.values()) controller.invalidate()
  })
  const openPanelFor = (sessionId: SessionId): void => {
    ctx.sidebarRight.openTab(TAB_KIND, { params: { sessionId } })
  }
  const actionsFor = (sessionId: SessionId): LinkActions => ({
    link: (peerId, autoWake, autoWakeCaller) => mutate('linkFrom', { callerId: sessionId, peerId, autoWake, autoWakeCaller }),
    setWake: (linkId, peerId, on) => mutate('setAutoWakeFrom', { callerId: sessionId, linkId, peerId, on }),
    unlink: linkId => mutate('unlinkFrom', { callerId: sessionId, linkId }),
    cancelMessage: messageId => gate(async () => {
      const value = await invoke('cancelMessageFrom', { request: { sessionId, messageId } })
      if (!isCancelResult(value) || value.messageId !== messageId) throw new Error(t('panel.protocol.error'))
      // Read failures remain mailbox errors; they must not erase the Host's
      // accepted cancellation outcome or suggest that a retry is required.
      for (const controller of mails.values()) controller.invalidate()
      return value
    }),
    extendChainWake: request => gate(async () => {
      const value = await invoke('extendChainWakeFrom', { request: { ...request, sessionId } })
      if (!isExtendWakeResult(value) || value.messageId !== request.messageId || value.requestId !== request.requestId) {
        throw new Error(t('panel.protocol.error'))
      }
      // Acknowledgement and read failures are distinct: never discard an
      // applied receipt merely because one subscribed mailbox cannot refresh.
      for (const controller of mails.values()) controller.invalidate()
      return value
    }),
    loadActivity: async query => {
      const value = await invoke('activityView', { request: { sessionId, ...query } })
      if (!isActivityView(value)) throw new Error(t('panel.protocol.error'))
      return value
    },
    mail: mailFor(sessionId),
    openPanel: () => { openPanelFor(sessionId) },
    openSession: id => { ctx.uiWorkspace.openSession(id) },
  })
  const injected = (sessionId: SessionId): LinkInjected => ({
    hooks: { links: source }, refresh: source.refresh, ...actionsFor(sessionId),
  })
  const managedInjected = (sessionId: SessionId) => ({ ...injected(sessionId), actionsFor })
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID, kind: TAB_KIND, title: () => t('tab.title'),
  }), 'gc-duolink: tab type')
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'dsh-gc-duolink/header', order: -5, locale: NS,
    inject: injected,
  }, HeaderAction))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS, inject: managedInjected,
  }, ManagedLinkTab))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS, inject: managedInjected,
  }, ManagedLinkTabTitle))
  const rowInjected = () => ({ hooks: { links: source }, openPanelFor })
  ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.row.action', id: 'dsh-gc-duolink/row-action', order: 50, locale: NS,
    inject: rowInjected,
  }, RowLinkAction))
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item', id: 'dsh-gc-duolink/menu', order: 350, locale: NS,
    inject: rowInjected,
  }, RowLinkMenu))
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item', id: 'dsh-gc-duolink/copy-session-id', order: 500, locale: NS,
  }, CopySessionIdMenu))
  ctx.inject(['uiConversation'], cardCtx => {
    cardCtx.uiConversation.events.register(sessionLinkTurnDefinition)
    cardCtx.slots.inject('conversation.chat.turnTail', () => cardCtx.slots.register({
      name: 'conversation.chat.turnTail', id: 'dsh-gc-duolink/created', order: 20, locale: NS,
      inject: injected,
    }, TurnCard))
  })
}
