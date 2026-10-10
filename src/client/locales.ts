/** Locale-owned copy for the external Session Link plugin. */
export const NS = 'sessionLink.external'

export const zh = {
  'trigger.label': '会话互联',
  'trigger.badge.aria': '{count} 个互联会话',
  'popover.manage': '管理互联',
  'panel.loading': '正在加载互联状态…',
  'panel.error': '互联状态不可用',
  'panel.protocol.error': '插件与当前 Harness 的响应格式不兼容',
  'panel.retry': '重试',
  'panel.empty': '还没有互联的会话',
  'panel.empty.hint': '在右侧「会话互联」面板中添加',
  'panel.refresh.error': '操作已保存，暂时无法刷新互联状态，请重试',
  'row.wake': '送达唤醒',
  'row.wake.title': '开启后，本会话发给对方的消息会自动唤醒对方',
  'peer.running': '运行中',
  'peer.idle': '空闲',
  'peer.archived': '已归档',
  'peer.open': '打开会话',
  'peer.open.title': '打开会话「{title}」',
  'peer.revoke': '解除互联',
  'revoke.confirm': '解除后，该组会话间的待投递消息将不再送达',
  'revoke.action': '确认解除',
  'revoke.cancel': '取消',
  'add.title': '添加互联',
  'add.search': '搜索标题或 ID',
  'add.wake': '送达唤醒',
  'add.wake.hint': '对方收到本会话的消息时自动唤醒',
  'add.action': '建立互联',
  'add.empty': '没有可互联的会话',
  'tab.title': '会话互联',
  'tab.command.hint': '也可以用 /session-link 命令管理',
  'mark.wake.on': '已互联，送达唤醒开',
  'mark.wake.off': '已互联，送达唤醒关',
  'card.linked': '已与「{title}」建立互联',
  'card.wake.on': '送达唤醒：开',
  'card.wake.off': '送达唤醒：关',
  'card.open': '查看互联',
} as const

export type LinkLocaleKey = keyof typeof zh

export const en: Record<LinkLocaleKey, string> = {
  'trigger.label': 'Session links',
  'trigger.badge.aria': '{count} linked session(s)',
  'popover.manage': 'Manage links',
  'panel.loading': 'Loading link state…',
  'panel.error': 'Link state unavailable',
  'panel.protocol.error': 'The plugin response is incompatible with this Harness version.',
  'panel.retry': 'Retry',
  'panel.empty': 'No linked sessions yet',
  'panel.empty.hint': 'Add one from the Session links panel',
  'panel.refresh.error': 'The change was saved, but link state could not refresh. Please retry.',
  'row.wake': 'Auto wake',
  'row.wake.title': 'When on, messages this session sends to the peer wake it automatically',
  'peer.running': 'Running',
  'peer.idle': 'Idle',
  'peer.archived': 'Archived',
  'peer.open': 'Open session',
  'peer.open.title': 'Open session "{title}"',
  'peer.revoke': 'Unlink',
  'revoke.confirm': 'Once unlinked, queued messages between sessions in this group stop being delivered.',
  'revoke.action': 'Confirm unlink',
  'revoke.cancel': 'Cancel',
  'add.title': 'Link a session',
  'add.search': 'Search title or ID',
  'add.wake': 'Auto wake',
  'add.wake.hint': 'Wake the peer when this session sends it a message',
  'add.action': 'Link',
  'add.empty': 'No sessions available to link',
  'tab.title': 'Session links',
  'tab.command.hint': 'Also manageable with the /session-link command',
  'mark.wake.on': 'Linked, auto wake on',
  'mark.wake.off': 'Linked, auto wake off',
  'card.linked': 'Linked with "{title}"',
  'card.wake.on': 'Auto wake: on',
  'card.wake.off': 'Auto wake: off',
  'card.open': 'View link',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** External Session Link surfaces. */
    'sessionLink.external': LinkLocaleKey
  }
}
