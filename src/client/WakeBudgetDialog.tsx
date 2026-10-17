/** Explicit human intent to extend one chain, with receipts kept across uncertain retries. */
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SessionLinkActivityEntry, SessionLinkExtendWakeRequest, SessionLinkExtendWakeResult } from '../types.ts'
import type { LinkInjected, LinkProps } from './components.tsx'
import { LinkBusyError } from './state.ts'

type Intent = Omit<SessionLinkExtendWakeRequest, 'sessionId'>

export function WakeBudgetDialog({ entry, trigger, extend, onClose, onResult, onConflict, t }: {
  readonly entry: SessionLinkActivityEntry
  readonly trigger: HTMLElement
  readonly extend: NonNullable<LinkInjected['extendChainWake']>
  readonly onClose: () => void
  readonly onResult: (result: SessionLinkExtendWakeResult) => void
  readonly onConflict: () => void
  readonly t: LinkProps['t']
}): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const first = useRef<HTMLInputElement>(null)
  const live = useRef(false)
  const sending = useRef(false)
  const intent = useRef<Intent | undefined>(undefined)
  const [budget, setBudget] = useState(entry.wakeBudget!)
  const [reasons, setReasons] = useState(entry.blockingReasons)
  const [choice, setChoice] = useState('4')
  const [custom, setCustom] = useState('4')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const id = useId()
  const additional = choice === 'custom' ? Number(custom) : Number(choice)
  const valid = Number.isInteger(additional) && additional >= 1 && additional <= 100
    && Number.isSafeInteger(budget.chain.limit + additional)

  useLayoutEffect(() => {
    live.current = true
    const node = dialog.current!
    node.showModal()
    first.current?.focus()
    return () => {
      live.current = false
      if (node.open) node.close()
      if (trigger.isConnected) trigger.focus()
    }
  }, [trigger])

  const change = (update: () => void): void => {
    // Changing a selection is an explicit new intent. Unchanged retries retain
    // every field, even if a newer mailbox snapshot arrived after a lost reply.
    intent.current = undefined
    setError(null)
    update()
  }
  const confirm = async (): Promise<void> => {
    if (!valid || sending.current || !budget.canExtend) return
    sending.current = true
    setBusy(true)
    setError(null)
    const request = intent.current ?? {
      messageId: entry.messageId, additional, expectedExtra: budget.chain.extra,
      requestId: crypto.randomUUID(),
    }
    intent.current = request
    try {
      const result = await extend(request)
      if (!live.current) return
      if (result.outcome === 'conflict') {
        setBudget(result.budget)
        setReasons(result.blockingReasons)
        setConflict(true)
        intent.current = undefined
        onConflict()
      } else {
        onResult(result)
      }
    } catch (reason) {
      if (live.current && !(reason instanceof LinkBusyError)) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      sending.current = false
      if (live.current) setBusy(false)
    }
  }

  return createPortal(<dialog ref={dialog} className="gcdl-wake-dialog" aria-labelledby={`${id}-title`}
    aria-describedby={`${id}-hint`} data-gc-duolink-wake-dialog
    onCancel={event => { event.preventDefault(); if (!sending.current) onClose() }}>
    <form onSubmit={event => { event.preventDefault(); void confirm() }}>
      <h2 id={`${id}-title`}>{t('mail.extend.title')}</h2>
      <p data-gc-duolink-dialog-budget>{t('mail.extend.chain', { used: budget.chain.used, limit: budget.chain.limit })}</p>
      <fieldset disabled={busy} className="gcdl-wake-options">
        <legend>{t('mail.extend.amount')}</legend>
        {['4', '8', 'custom'].map(value => <label key={value}>
          <input ref={value === '4' ? first : undefined} type="radio" name={`${id}-amount`} value={value}
            checked={choice === value} onChange={() => { change(() => { setChoice(value) }) }} />
          {value === 'custom' ? t('mail.extend.custom') : t('mail.extend.preset', { count: value })}
        </label>)}
        {choice !== 'custom' ? null : <label className="gcdl-wake-custom" htmlFor={`${id}-custom`}>
          {t('mail.extend.custom.range')}
          <input id={`${id}-custom`} className="gcdl-input" type="number" min="1" max="100" step="1" required
            value={custom} aria-invalid={!valid} onChange={event => { change(() => { setCustom(event.target.value) }) }} />
        </label>}
      </fieldset>
      <p data-gc-duolink-limit-preview>{valid ? t('mail.extend.preview', { limit: budget.chain.limit + additional }) : t('mail.extend.invalid')}</p>
      <p>{t('mail.extend.target.day', { used: budget.targetDay.used, limit: budget.targetDay.limit, day: budget.targetDay.day,
        reset: new Date(budget.targetDay.resetsAt).toLocaleString() })}</p>
      {budget.targetDay.used < budget.targetDay.limit ? null : <p className="gcdl-notice">{t('mail.extend.day.exhausted')}</p>}
      <p>{t('mail.extend.message', { used: budget.message.used, limit: budget.message.limit })}</p>
      {budget.message.used < budget.message.limit ? null : <p className="gcdl-notice">{t('mail.extend.message.exhausted')}</p>}
      {reasons.length === 0 ? null : <p>{t('mail.blocking', { reasons: reasons.map(reason => t(`mail.reason.${reason}`)).join(' · ') })}</p>}
      <p id={`${id}-hint`} className="gcdl-footnote">{t('mail.extend.hint')}</p>
      {conflict ? <p className="gcdl-notice" role="status">{t('mail.extend.conflict')}</p> : null}
      {!budget.canExtend ? <p className="gcdl-notice" role="status">{t('mail.extend.unavailable')}</p> : null}
      {error === null ? null : <p className="gcdl-notice" role="alert">{error} · {t('mail.extend.unknown')}</p>}
      <div className="gcdl-confirm-actions">
        <button type="button" className="gcdl-button" disabled={busy} onClick={onClose}>{t('revoke.cancel')}</button>
        <button type="submit" className="gcdl-button" disabled={busy || !valid || !budget.canExtend} data-gc-duolink-extend-confirm>
          {t(error !== null ? 'mail.extend.retry' : 'mail.extend.confirm')}
        </button>
      </div>
    </form>
  </dialog>, document.body)
}
