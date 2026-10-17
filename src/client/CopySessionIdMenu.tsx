/** Session-row utility independent of link membership and Host queries. */
import { useState, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import { Styles } from './styles.tsx'

/** Keep plain-HTTP installations usable and report failure from either route. */
async function copySessionId(value: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return
    }
  } catch {
    // A denied Clipboard API may still allow copying from a selected textarea.
  }
  const previousFocus = document.activeElement
  const area = document.createElement('textarea')
  area.value = value
  area.readOnly = true
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  try {
    area.focus()
    area.select()
    if (typeof document.execCommand !== 'function' || !document.execCommand('copy')) {
      throw new Error('Clipboard copy failed')
    }
  } finally {
    area.remove()
    if (previousFocus instanceof HTMLElement) previousFocus.focus()
  }
}

export function CopySessionIdMenu({ sessionId, useMenuOpenState, t }: {
  readonly sessionId: SessionId
  readonly useMenuOpenState: () => readonly [boolean, (open: boolean) => void]
  readonly t: TranslateNS<typeof NS>
}): ReactNode {
  const [, setMenuOpen] = useMenuOpenState()
  const [copying, setCopying] = useState(false)
  const [failed, setFailed] = useState(false)
  return <><Styles /><button type="button" role="menuitem" className="gcdl-menu-item"
    data-duolink-copy-session-id="" disabled={copying} onClick={async () => {
      setCopying(true)
      setFailed(false)
      try {
        await copySessionId(sessionId)
        setMenuOpen(false)
      } catch {
        setFailed(true)
      } finally {
        setCopying(false)
      }
    }}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </svg>{t('row.copy.id')}
  </button>{failed ? <span className="gcdl-notice" role="alert">{t('row.copy.error')}</span> : null}</>
}
