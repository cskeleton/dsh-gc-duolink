/** Linked-spawn transcript rows rendered through the Turn-tail slot. */
import type { ReactNode } from 'react'
import type { LinkProps } from './components.tsx'
import { LinkIcon } from './components.tsx'
import { Styles } from './styles.tsx'
import { sessionTitle } from './selectors.ts'
import {
  selectLinkedSpawns, selectTrackedTasks, type SessionLinkTurnOwner, type TrackedTaskFact,
} from './turn.ts'

/** Settled spawned Sessions and the current wake flags read from the Host. */
export function TurnCard({ sessionId, turn, seq, useLinks, useTasks, openPanel, openSession, t }: LinkProps & SessionLinkTurnOwner): ReactNode {
  const view = useLinks(snapshot => snapshot.view)
  useTasks(snapshot => snapshot)
  const created = selectLinkedSpawns({ turn, seq })?.created ?? []
  const tasks = selectTrackedTasks({ turn, seq }) ?? []
  if (created.length === 0 && tasks.length === 0) return null
  return <><Styles />
    {created.map(spawn => {
      const group = view?.links.find(link => link.id === spawn.linkId && link.memberIds.includes(spawn.sessionId))
      const wake = group === undefined ? null : group.autoWakeSessionIds.includes(spawn.sessionId)
      return <div key={spawn.callId} className="slp-card" data-session-link-created="">
        <LinkIcon /><span className="slp-card-title">{t('card.linked', { title: sessionTitle(view, spawn.sessionId) })}</span>
        {wake === null ? null : <>
          <span className="slp-card-wake">{t(wake ? 'card.wake.on' : 'card.wake.off')}</span>
          <span className="slp-card-wake">{t(group?.autoWakeSessionIds.includes(sessionId) ? 'card.wake.self.on' : 'card.wake.self.off')}</span>
        </>}
        <button type="button" className="slp-text-button" onClick={openPanel}>{t('card.open')}</button>
      </div>
    })}
    {tasks.map(task => <TrackedTaskCard key={`${task.tool}:${task.callId}`} task={task} openSession={openSession} t={t} />)}
  </>
}

/**
 * One tracked-task card: state + honest route labels + inspect pointers. The
 * needs_decision-no-Session branch never renders a session jump, because the
 * durable projection has no Session to open yet. `accepted` stays delivery
 * acceptance only — never task success.
 */
function TrackedTaskCard({ task, openSession, t }: {
  readonly task: TrackedTaskFact
  readonly openSession: LinkProps['openSession']
  readonly t: LinkProps['t']
}): ReactNode {
  const waiting = task.outcome === 'needs_decision'
  return <div className="slp-task-card" data-session-link-task-result="" data-session-link-task-outcome={task.outcome}>
    <div className="slp-task-card-heading">
      <span className="slp-task-kind">{t(task.tool === 'session_spawn_linked_session' ? 'task.card.spawn' : 'task.card.send')}</span>
      <span className="slp-task-title">{task.taskId}</span>
      <span className={`slp-task-badge${waiting ? ' slp-task-badge-warn' : ''}`}>
        {waiting ? t('task.card.waiting') : t('task.card.admitted', { status: t(task.status === 'accepted' ? 'task.card.accepted' : 'task.card.queued') })}
      </span>
    </div>
    <div className="slp-task-line">
      <span className={`slp-task-badge${task.scope === 'session' ? ' slp-task-badge-info' : ''}`}>
        {t(task.scope === 'session' ? 'task.card.scope.session' : 'task.card.scope.task')}
      </span>
      {task.requestedModel === undefined ? null
        : <span><b>{t('task.card.requested')}</b>{task.requestedModel}</span>}
      {task.selectedModel === undefined || task.selectedModel === task.requestedModel ? null
        : <span><b>{t('task.card.selected')}</b>{task.selectedModel}</span>}
      <span className="slp-task-meta">{task.taskState}{task.executionState === undefined ? '' : ` · ${task.executionState}`}</span>
      {task.reason === undefined ? null : <span className="slp-task-meta">{t('task.card.reason')}: {task.reason}</span>}
      {task.attempts === undefined ? null : <span className="slp-task-meta">{t('task.card.attempts', { count: task.attempts })}</span>}
    </div>
    {waiting
      ? <div className="slp-task-note slp-task-note-warn">{t(task.sessionId === undefined ? 'task.card.nojump' : 'task.card.waiting.hint')}</div>
      : null}
    <div className="slp-task-line">
      <span className="slp-task-meta">{t('task.card.inspect', { revision: task.taskRevision })}</span>
      {/* A needs_decision task binds no Session only when the spawn precheck
          failed before one was created; whenever a Session exists it may be
          opened, waiting or not. */}
      {task.sessionId === undefined ? null
        : <button type="button" className="slp-text-button" onClick={() => { openSession(task.sessionId!) }}>{t('peer.open')}</button>}
    </div>
    {waiting ? null
      : <div className="slp-task-meta">{t('task.card.notdone')}</div>}
  </div>
}
