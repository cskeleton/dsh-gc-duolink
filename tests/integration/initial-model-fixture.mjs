/** Native bootstrap feasibility probe. All runtime classes come from the shipped CLI. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

const require = createRequire(process.env.INITIAL_MODEL_PROOF_INSTALLATION_PACKAGE)
// The Loader imports the same ESM packages concurrently; require(esm) would race it.
const { SessionId } = await import(require.resolve('@deepseek-ai/dsh-session'))
const { LlmAdapter, createUserMessage, ToolCallId } = await import(require.resolve('@deepseek-ai/dsh-llm'))
const phase = process.env.INITIAL_MODEL_PROOF_PHASE
const cwd = process.env.INITIAL_MODEL_PROOF_WORKSPACE
const requests = []
const checks = []
let workspacePlacement
const ids = Object.fromEntries(['A', 'B', 'BASE', 'caller', 'unrelated', 'collision'].map(n => [n, SessionId(`initial-proof-${n}`)]))
const packedPlugin = process.env.INITIAL_MODEL_PROOF_PLUGIN === '1'
const callKey = m => `packed-proof-${m}`
if (packedPlugin) for (const m of ['A', 'B', 'BASE', 'collision']) {
  const hex = createHash('sha256').update(`${ids.caller}\0${callKey(m)}`).digest('hex')
  ids[m] = SessionId(`session-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`)
}
const expectedEffort = model => model === 'A' || model === 'B' ? 'high' : 'low'
const route = model => ({ provider: 'initial-proof', model, ...model === 'B' ? {} : { reasoningEffort: expectedEffort(model) } })

class ProofAdapter extends LlmAdapter {
  async listModels(provider) {
    return await Promise.all(['A', 'B', 'C', 'BASE'].map(model => this.resolveModel(provider, model)))
  }
  async resolveModel(provider, model) {
    assert.equal(provider, 'initial-proof')
    assert.ok(['A', 'B', 'C', 'BASE'].includes(model))
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }], defaultEffort: model === 'B' ? 'high' : 'low' } }
  }
  async *stream(options) {
    const messages = options.messages
    const prompt = messages.filter(m => m.role === 'system').map(m => m.content.map(b => b.text ?? '').join('')).join('\n')
    requests.push({ provider: options.provider, model: options.model, effort: options.reasoningEffort, prompt })
    assert.equal(options.reasoningEffort, expectedEffort(options.model), 'B uses its own high default; caller BASE uses low')
    assert.ok(prompt.includes(`proof provider=initial-proof model=${options.model}`), 'native prompt variables match adapter request')
    const needsTool = messages.some(m => m.role === 'user' && m.content.some(b => b.text?.includes('proof two-step')))
      && !messages.some(m => m.role === 'tool')
    const block = needsTool
      ? { type: 'tool-call', id: ToolCallId('proof-call'), name: 'initial_proof_probe', arguments: '{}' }
      : { type: 'text', text: `reply ${options.model}` }
    yield { type: 'block-start', index: 0, blockType: block.type }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: needsTool ? 'tool-calls' : 'stop' } }
  }
}

export const inject = ['llm', 'appReady', 'sessions', 'sessionPersistence', 'sessionController', 'agents', 'agentPresets', 'agentDefaultModel', 'systemPrompt', 'tools', 'workspaceRegistry']

async function inspect(ctx, id) {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try { return { header: handle.header, events: (await handle.read()).events } }
  finally { await handle.close() }
}

// No publish/announce, Agent creation, request interception, or global selection writes.
async function seed(ctx, id, selection) {
  await mkdir(cwd, { recursive: true })
  const preset = await ctx.agentPresets.resolve()
  assert.equal(preset.failure, undefined)
  const session = ctx.sessions.prepare(id, { meta: { cwd, agentPreset: preset.id, isSeeded: false, delegationDepth: 0 } })
  session.append('model/selection', selection)
  const handle = await ctx.sessionPersistence.create(session.header)
  try {
    await handle.append(session.snapshotEvents())
    await handle.flush()
  } finally { await handle.close() }
  const durable = await inspect(ctx, id)
  assert.deepEqual(durable.events.find(e => e.type === 'model/selection').data, selection)
  assert.equal(durable.header.agentPreset, preset.id)
  assert.equal(durable.header.isSeeded, false)
  assert.equal(durable.header.parentSession, undefined)
  assert.equal(durable.header.cwd, cwd)
  assert.equal(ctx.agents.get(id), undefined)
  return durable
}

async function activate(ctx, id) {
  const result = await ctx.sessionController.create({ sessionId: id, cwd })
  assert.equal(result.sessionId, id, JSON.stringify(result))
  const agent = ctx.agents.get(id)
  assert.ok(agent)
  assert.equal(ctx.agentPresets.composedPreset(agent.ctx), (await ctx.agentPresets.resolve()).id)
  return agent
}

async function turn(ctx, id, expected, text = 'proof ordinary turn') {
  const agent = await activate(ctx, id)
  const before = requests.length
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'initial-proof' } }))
  await agent.whenIdle()
  await ctx.sessionPersistence.flush()
  const actual = requests.slice(before)
  assert.ok(actual.length > 0, 'actual adapter request observed')
  assert.ok(actual.every(r => r.model === expected))
  assert.ok(actual.every(r => r.effort === expectedEffort(expected)))
  return actual
}

async function run(ctx) {
  assert.deepEqual(ctx.agentDefaultModel.currentSelection(), { provider: 'initial-proof', model: 'BASE', reasoningEffort: 'low' })
  const defaults = ctx.agentDefaultModel.currentSelection()
  if (phase === 'seed') {
    if (packedPlugin) {
      await packedSeed(ctx)
      await packedWorkspacePlacement(ctx)
      await new Promise(resolve => setTimeout(resolve, 250))
      assert.deepEqual(ctx.agentDefaultModel.currentSelection(), defaults)
      checks.push('application in-memory default unchanged after plugin spawn and replays')
      return
    }
    await Promise.all(['A', 'B'].map(m => seed(ctx, ids[m], route(m))))
    checks.push('concurrent detached A/B seed: append-flush-close-read')
    assert.equal(requests.length, 0)
    checks.push('no activation or model request before restart')
    await assert.rejects(seed(ctx, ids.A, route('B')))
    assert.deepEqual((await inspect(ctx, ids.A)).events.find(e => e.type === 'model/selection').data, route('A'))
    checks.push('ID collision refuses overwrite and sends zero requests')
  } else if (phase === 'execute') {
    if (packedPlugin) {
      const placement = JSON.parse(await readFile(process.env.INITIAL_MODEL_PROOF_WORKSPACE_REPORT, 'utf8'))
      for (const item of placement.grouped) {
        assert.ok(ctx.workspaceRegistry.get(item.workspaceId)?.sessionIds.includes(item.sessionId), 'Workspace membership survives actual Host restart')
      }
      assert.ok(ctx.workspaceRegistry.list().every(w => placement.ungrouped.every(id => !w.sessionIds.includes(id))))
      checks.push('grouped and ungrouped spawn placement survives actual Host restart')
      const page = await ctx.get('gcDuolink').activityView({ sessionId: ids.caller, section: 'recent', peerId: SessionId('initial-proof-wake-peer') })
      const message = page.entries.find(entry => entry.preview.endsWith('extension proof 9'))
      assert.ok(message, 'extended message survives an actual Host restart')
      assert.equal(message.wakeBudget.chain.extra, 4)
      assert.equal(message.wakeBudget.chain.used, 9)
      const before = requests.length
      const replay = await ctx.get('gcDuolink').extendChainWakeFrom({ sessionId: ids.caller, messageId: message.messageId,
        additional: 4, expectedExtra: 0, requestId: 'packed-chain-extension' })
      assert.equal(replay.outcome, 'replayed')
      assert.equal(replay.budget.chain.extra, 4)
      assert.equal(requests.length, before, 'terminal replay grants no extra credit and makes no model request')
      checks.push('chain extension and request receipt survive Host restart; replay never regrants or redispatches')
    }
    await turn(ctx, ids.caller, 'BASE')
    await turn(ctx, ids.unrelated, 'BASE')
    // Interleaved calls use separate sessions; assertions inspect each turn's own log below.
    await Promise.all(['A', 'B', 'BASE'].map(async m => {
      const agent = await activate(ctx, ids[m])
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'proof two-step' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const models = agent.session.snapshotEvents().filter(e => e.type === 'assistant/message').map(e => e.data.message.source.model)
      assert.ok(models.length >= 2 && models.every(model => model === m))
    }))
    await ctx.sessionPersistence.flush()
    checks.push('first request plus tool step: concurrent A/B/BASE, prompt and effort match')
    for (const m of ['A', 'B', 'BASE']) await turn(ctx, ids[m], m)
    checks.push('next ordinary turn keeps initial model')
    await turn(ctx, ids.caller, 'BASE')
    await turn(ctx, ids.unrelated, 'BASE')
    checks.push('caller and unrelated session stay BASE')
  } else if (phase === 'replay-human') {
    assert.ok(packedPlugin)
    await activate(ctx, ids.caller)
    await activate(ctx, ids.A)
    await ctx.sessionController.selectModel({ sessionId: ids.A, ...route('C') })
    await turn(ctx, ids.A, 'C')
    const before = requests.length
    const replay = await packedCall(ctx, 'gc_duolink_spawn_session', spawnArgs('A'), callKey('A'))
    assert.equal(replay.isError, false, JSON.stringify(replay))
    assert.equal(replay.value.initialModel.model, 'A', 'initial configuration label is a historical fact')
    assert.equal(requests.length, before, 'replay never dispatches a second task')
    await turn(ctx, ids.A, 'C')
    checks.push('human C followed by real spawn replay retains C and the original message')
    return
  } else if (phase === 'resume') {
    for (const m of ['A', 'B', 'BASE']) await turn(ctx, ids[m], packedPlugin && m === 'A' ? 'C' : m)
    checks.push('after-response restart: native request/header retains initial model without seed hook')
    if (!packedPlugin) {
      const result = await ctx.sessionController.selectModel({ sessionId: ids.A, ...route('C') })
      assert.deepEqual(result.selected, route('C'))
      await turn(ctx, ids.A, 'C')
    }
    checks.push('native human selection C takes effect and is not restored to A')
    return
  } else if (phase === 'human-resume') {
    await turn(ctx, ids.A, 'C')
    await turn(ctx, ids.B, 'B')
    checks.push('restart after human selection preserves C')
  } else throw new Error(`Unknown proof phase: ${phase}`)
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.deepEqual(ctx.agentDefaultModel.currentSelection(), defaults)
  checks.push('application in-memory default unchanged after pending work settles')
}

async function packedCall(ctx, name, args, key) {
  return await ctx.tools.execute({ agent: ctx.agents.get(ids.caller), name, arguments: args,
    callId: ToolCallId(key), signal: new AbortController().signal })
}

async function packedWorkspacePlacement(ctx) {
  const gate = process.env.INITIAL_MODEL_PROOF_BROWSER_GATE
  if (gate) {
    const deadline = Date.now() + 45_000
    while (true) {
      try { await access(gate); break }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      assert.ok(Date.now() < deadline, 'browser must subscribe before placement begins')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  const grouped = []
  const ungrouped = []
  const model = { provider: 'initial-proof', model: 'B' }
  const create = async (key, args) => {
    const result = await packedCall(ctx, 'gc_duolink_spawn_session', { title: key, task: 'workspace placement proof', ...args }, key)
    assert.equal(result.isError, false, JSON.stringify(result))
    await ctx.agents.get(result.value.sessionId).whenIdle()
    const logged = await inspect(ctx, result.value.sessionId)
    assert.equal(logged.header.parentSession, undefined)
    assert.equal(logged.header.delegationDepth, 0)
    assert.equal(logged.header.cwd, args.cwd ?? cwd)
    return result.value.sessionId
  }
  assert.ok(ctx.workspaceRegistry.list().every(w => !w.sessionIds.includes(ids.caller)))
  for (const [key, args] of [['placement-ungrouped', {}], ['placement-ungrouped-model', { initial_model: model }]]) {
    const id = await create(key, args)
    assert.ok(ctx.workspaceRegistry.list().every(w => !w.sessionIds.includes(id)))
    ungrouped.push(id)
  }
  const callerWorkspace = await ctx.workspaceRegistry.create(cwd, 'Caller project')
  await callerWorkspace.attachSession(ids.caller)
  for (const [key, args] of [['placement-inherited', {}], ['placement-inherited-model', { initial_model: model }]]) {
    const id = await create(key, args)
    assert.ok(callerWorkspace.sessionIds.includes(id))
    grouped.push({ sessionId: id, workspaceId: callerWorkspace.id, title: key })
  }
  const unseen = join(cwd, 'desktop-unopened')
  assert.equal(await ctx.workspaceRegistry.resolveByPath(cwd), callerWorkspace)
  const unseenId = await create('placement-unopened', { cwd: unseen })
  const unseenWorkspace = await ctx.workspaceRegistry.resolveByPath(unseen)
  assert.ok(unseenWorkspace?.sessionIds.includes(unseenId))
  assert.ok(!callerWorkspace.sessionIds.includes(unseenId), 'subdirectory never inherits parent grouping')
  grouped.push({ sessionId: unseenId, workspaceId: unseenWorkspace.id, title: 'placement-unopened' })
  const existing = join(dirname(cwd), 'existing-unopened')
  await mkdir(existing)
  assert.equal(await ctx.workspaceRegistry.resolveByPath(existing), undefined)
  const existingId = await create('placement-existing-model', { cwd: existing, initial_model: model })
  const existingWorkspace = await ctx.workspaceRegistry.resolveByPath(existing)
  assert.ok(existingWorkspace.sessionIds.includes(existingId))
  grouped.push({ sessionId: existingId, workspaceId: existingWorkspace.id, title: 'placement-existing-model' })
  const alias = join(cwd, 'desktop-alias')
  await symlink(unseen, alias)
  const aliasId = await create('placement-symlink-model', { cwd: alias, initial_model: model })
  assert.equal((await ctx.workspaceRegistry.resolveByPath(alias)).id, unseenWorkspace.id)
  assert.ok(unseenWorkspace.sessionIds.includes(aliasId))
  grouped.push({ sessionId: aliasId, workspaceId: unseenWorkspace.id, title: 'placement-symlink-model' })
  const replayArgs = { cwd: unseen, title: 'placement-unopened', task: 'workspace placement proof' }
  await unseenWorkspace.detachSession(unseenId)
  const before = requests.length
  const replay = await packedCall(ctx, 'gc_duolink_spawn_session', replayArgs, 'placement-unopened')
  assert.equal(replay.isError, false, JSON.stringify(replay))
  assert.equal(replay.value.sessionId, unseenId)
  assert.ok(!unseenWorkspace.sessionIds.includes(unseenId), 'completed replay preserves a human detach')
  assert.equal(requests.length, before)
  // Restore via an explicit human action so the browser can inspect both new rows.
  await unseenWorkspace.attachSession(unseenId)
  workspacePlacement = { grouped, ungrouped, liveWorkspaceId: unseenWorkspace.id, liveWorkspaceTitle: unseenWorkspace.title, liveSessionId: unseenId }
  await writeFile(process.env.INITIAL_MODEL_PROOF_WORKSPACE_REPORT, JSON.stringify(workspacePlacement, null, 2) + '\n')
  checks.push('ordinary/selected omitted cwd inherits grouped or Ungrouped; explicit missing/existing unseen directories register; symlinks reuse; replay preserves human detach')
}

function spawnArgs(m) {
  return { cwd, title: `proof ${m}`, task: 'proof two-step', auto_awake: false, wake_caller: false,
    ...m === 'BASE' ? {} : { initial_model: { provider: 'initial-proof', model: m, ...m === 'A' ? { reasoning_effort: 'high' } : {} } } }
}

async function packedSeed(ctx) {
  await turn(ctx, ids.caller, 'BASE')
  const catalog = await packedCall(ctx, 'gc_duolink_list_models', {}, 'packed-catalog')
  assert.equal(catalog.isError, false, JSON.stringify(catalog))
  assert.equal(catalog.value.initialModelSelection, true)
  assert.equal('taskHost' in catalog.value, false)
  const results = await Promise.all(['A', 'B', 'BASE'].map(m => packedCall(ctx, 'gc_duolink_spawn_session', spawnArgs(m), callKey(m))))
  for (const [i, m] of ['A', 'B', 'BASE'].entries()) {
    const result = results[i]
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(result.value.sessionId, ids[m])
    assert.equal('taskId' in result.value, false)
    if (m !== 'BASE') {
      const sidecar = JSON.parse(result.content.filter(b => b.type === 'text')[1].text)
      assert.equal(sidecar.type, 'gc-duolink/initial-model')
      assert.deepEqual(sidecar.initialModel, result.value.initialModel)
      if (m === 'B') assert.equal(result.value.initialModel.reasoningEffort, undefined)
    }
    await ctx.agents.get(ids[m]).whenIdle()
    const logged = await inspect(ctx, ids[m])
    const models = logged.events.filter(e => e.type === 'assistant/message').map(e => e.data.message.source.model)
    assert.deepEqual(models, [m, m])
    assert.equal(logged.header.parentSession, undefined)
    assert.equal(logged.header.isSeeded, false)
    assert.equal(logged.header.agentPreset, (await ctx.agentPresets.resolve()).id)
  }
  checks.push('packed tools: native A/B/BASE initial tasks and tool step, preset/CWD/top-level identity')
  assert.ok(requests.filter(r => r.model === 'B').every(r => r.effort === 'high'))
  assert.ok(requests.some(r => r.model === 'BASE' && r.effort === 'low'))
  checks.push('omitted B effort uses model default high, distinct from caller BASE low')
  const beforeReplay = requests.length
  const replays = await Promise.all([1, 2].map(() => packedCall(ctx, 'gc_duolink_spawn_session', spawnArgs('A'), callKey('A'))))
  assert.ok(replays.every(result => !result.isError && result.value.messageId === results[0].value.messageId))
  await ctx.agents.get(ids.A).whenIdle()
  assert.equal(requests.length, beforeReplay)
  checks.push('same-call concurrent replays reuse original mailbox message, no model requests')
  for (const changed of [
    { ...spawnArgs('A'), task: 'proof two-step DIFFERENT SUFFIX' },
    { ...spawnArgs('A'), initial_model: { provider: 'initial-proof', model: 'B' } },
    { ...spawnArgs('A'), auto_awake: true },
    (({ initial_model, ...plain }) => plain)(spawnArgs('A')),
  ]) {
    const result = await packedCall(ctx, 'gc_duolink_spawn_session', changed, callKey('A'))
    assert.equal(result.isError, true)
    assert.ok(JSON.stringify(result).includes('REPLAY_CONFLICT'))
  }
  const addedModel = await packedCall(ctx, 'gc_duolink_spawn_session', { ...spawnArgs('BASE'), initial_model: { provider: 'initial-proof', model: 'A' } }, callKey('BASE'))
  assert.equal(addedModel.isError, true)
  assert.ok(JSON.stringify(addedModel).includes('REPLAY_CONFLICT'))
  checks.push('model/body suffix/grants/removal and ordinary-to-model changes reject replay')
  const sessionsBefore = (await ctx.sessionPersistence.list()).length
  for (const args of [
    { ...spawnArgs('A'), initial_model: { provider: 'initial-proof', model: 'A', reasoning_effort: 'unsupported' } },
    { ...spawnArgs('BASE'), provider: 'initial-proof', model: 'A' },
    { ...spawnArgs('BASE'), initial_model: { provider: 'initial-proof' } },
  ]) assert.equal((await packedCall(ctx, 'gc_duolink_spawn_session', args, 'packed-invalid')).isError, true)
  const sendWithModel = await packedCall(ctx, 'gc_duolink_send_message', { session_id: ids.A, message: 'rejected', initial_model: { provider: 'initial-proof', model: 'A' } }, 'packed-send-invalid')
  assert.equal(sendWithModel.isError, true)
  assert.ok(JSON.stringify(sendWithModel).includes('send accepts no model'))
  assert.equal((await ctx.sessionPersistence.list()).length, sessionsBefore)
  assert.equal(requests.length, beforeReplay)
  checks.push('invalid effort/shape/retired args and send selection: no Session or request')
  // Explicit no-wake must survive the actual packed tool/schema path even
  // with a live idle target that has a valid automatic-wake grant.
  const mailService = ctx.get('gcDuolink')
  const aLink = mailService.spawnReplay(ids.caller, callKey('A')).linkId
  await mailService.setMemberAutoWake(aLink, ids.A, true)
  const quietArgs = { session_id: ids.A, message: 'packed information only', wake: false }
  const quiet = await packedCall(ctx, 'gc_duolink_send_message', quietArgs, 'packed-quiet-mail')
  assert.equal(quiet.isError, false, JSON.stringify(quiet))
  assert.equal(quiet.value.status, 'queued')
  assert.equal(mailService.message(quiet.value.messageId).wake, false)
  const quietReplay = await packedCall(ctx, 'gc_duolink_send_message', { ...quietArgs, wake: true }, 'packed-quiet-mail')
  assert.deepEqual(quietReplay.value, quiet.value)
  assert.equal(mailService.message(quiet.value.messageId).wakesUsed, 0)
  assert.equal(requests.length, beforeReplay)
  const quietPage = await mailService.activityView({ sessionId: ids.caller, section: 'pending' })
  assert.ok(quietPage.entries.find(entry => entry.messageId === quiet.value.messageId).blockingReasons.includes('wake-not-requested'))
  assert.equal((await packedCall(ctx, 'gc_duolink_send_message', { ...quietArgs, wake: 'false' }, 'packed-invalid-wake')).isError, true)
  assert.equal((await packedCall(ctx, 'gc_duolink_spawn_session', { ...spawnArgs('A'), wake: false }, 'packed-spawn-wake')).isError, true)
  assert.deepEqual(await mailService.cancelMessageFrom({ sessionId: ids.A, messageId: quiet.value.messageId }),
    { messageId: quiet.value.messageId, outcome: 'cancelled', status: 'cancelled' })
  await mailService.setMemberAutoWake(aLink, ids.A, false)
  assert.equal(requests.length, beforeReplay)
  checks.push('packed wake:false stays queued under a grant, replay cannot elevate, strict schema and human cancel succeed without requests')
  await activate(ctx, ids.collision)
  const collision = await packedCall(ctx, 'gc_duolink_spawn_session', spawnArgs('A'), callKey('collision'))
  assert.equal(collision.isError, true)
  assert.ok(JSON.stringify(collision).includes('SESSION_CONFLICT'))
  assert.equal(requests.length, beforeReplay)
  checks.push('preexisting target ID refuses repair/activation/task dispatch')
  const linked = ctx.get('gcDuolink').spawnReplay(ids.caller, callKey('B'))
  await ctx.get('gcDuolink').unlink(linked.linkId)
  assert.equal((await packedCall(ctx, 'gc_duolink_spawn_session', spawnArgs('B'), callKey('B'))).isError, true)
  assert.equal(requests.length, beforeReplay)
  checks.push('human unlink is not revived by replay')
  const duplicate = await Promise.all([1, 2].map(() => packedCall(ctx, 'gc_duolink_spawn_session', spawnArgs('A'), 'packed-same-call-new')))
  assert.ok(duplicate.every(result => !result.isError), JSON.stringify(duplicate))
  assert.equal(duplicate[0].value.sessionId, duplicate[1].value.sessionId)
  assert.equal(duplicate[0].value.messageId, duplicate[1].value.messageId)
  await ctx.agents.get(duplicate[0].value.sessionId).whenIdle()
  assert.equal((await inspect(ctx, duplicate[0].value.sessionId)).events.filter(e => e.type === 'user/message' && e.data.source.kind === 'gc-duolink-message').length, 1)
  checks.push('concurrent first attempts with the same payload share creation and delivery')
  for (const [i, ordered] of [[spawnArgs('A'), spawnArgs('BASE')], [spawnArgs('BASE'), spawnArgs('A')]].entries()) {
    const race = await Promise.all(ordered.map(args => packedCall(ctx, 'gc_duolink_spawn_session', args, `packed-cross-mode-${i}`)))
    assert.equal(race.filter(result => !result.isError).length, 1)
    assert.ok(JSON.stringify(race.find(result => result.isError)).includes('REPLAY_CONFLICT'), JSON.stringify(race))
    const winner = race.find(result => !result.isError)
    await ctx.agents.get(winner.value.sessionId).whenIdle()
    assert.equal((await inspect(ctx, winner.value.sessionId)).events.filter(e => e.type === 'user/message' && e.data.source.kind === 'gc-duolink-message').length, 1)
  }
  checks.push('selected/ordinary same-call races in both orders have one winner and one task')
  await proveChainExtension(ctx)
}

/** Actual alternating Agent deliveries spend the default chain budget; no forged usage counters. */
async function proveChainExtension(ctx) {
  const links = ctx.get('gcDuolink')
  const peerId = SessionId('initial-proof-wake-peer')
  await seed(ctx, peerId, route('A'))
  const peer = await activate(ctx, peerId)
  const caller = ctx.agents.get(ids.caller)
  await links.link('extension proof', [caller.id, peerId], { kind: 'human' }, { autoWakeSessionIds: [caller.id, peerId] })
  let previous
  for (let step = 1; step <= 8; step += 1) {
    const sender = step % 2 ? caller : peer
    const target = step % 2 ? peer : caller
    const sent = await links.send(sender, target.id, { targetId: target.id, text: `extension proof ${step}`,
      ...(previous === undefined ? {} : { inReplyTo: previous }), idempotencyKey: `extension-proof-${step}` })
    assert.equal(sent.status, 'accepted')
    await target.whenIdle()
    previous = sent.messageId
  }
  const beforeBlocked = requests.length
  const queued = await links.send(caller, peerId, { targetId: peerId, text: 'extension proof 9', inReplyTo: previous,
    idempotencyKey: 'extension-proof-9' })
  assert.equal(queued.status, 'queued')
  assert.equal(requests.length, beforeBlocked)
  const pending = await links.activityView({ sessionId: caller.id, section: 'pending', peerId })
  assert.equal(pending.entries[0].wakeBudget.chain.used, 8)
  assert.equal(pending.entries[0].wakeBudget.chain.limit, 8)
  assert.equal(pending.entries[0].wakeBudget.targetDay.limit, 12)
  const request = { sessionId: caller.id, messageId: queued.messageId, additional: 4, expectedExtra: 0, requestId: 'packed-chain-extension' }
  const [extended, replay] = await Promise.all([links.extendChainWakeFrom(request), links.extendChainWakeFrom(request)])
  assert.equal(extended.outcome, 'applied')
  assert.equal(extended.continuation, 'accepted')
  assert.equal(extended.budget.chain.limit, 12)
  assert.equal(replay.outcome, 'replayed')
  assert.equal(replay.budget.chain.extra, 4)
  await peer.whenIdle()
  assert.equal(requests.length, beforeBlocked + 1, 'one additional wake dispatches exactly one mock request')
  const conflict = await links.extendChainWakeFrom({ ...request, requestId: 'packed-chain-stale' })
  assert.equal(conflict.outcome, 'conflict')
  assert.equal(conflict.budget.chain.extra, 4)
  assert.equal(requests.length, beforeBlocked + 1)
  checks.push('8 actual bidirectional wakes exhaust the chain; human +4 dispatches pending message once; concurrent replay/stale request cannot double-grant')
}

export function apply(ctx) {
  ctx.llm.registerAdapter(['initial-proof'], new ProofAdapter())
  ctx.systemPrompt.section({ name: 'initial-proof', order: 9999, text: 'proof provider={{provider}} model={{model}}' })
  ctx.tools.register({ name: 'initial_proof_probe', description: 'Zero-side-effect proof tool', parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] }, execute: async () => 'proof-tool-result' })
  ctx.effect(() => ctx.appReady.onReady(() => {
    setImmediate(async () => {
      let result
      try {
        await run(ctx)
        result = { phase, status: 'PASS', checks, requests, paidModelCalls: 0, mockModelCalls: requests.length,
          ...(workspacePlacement === undefined ? {} : { workspacePlacement }) }
      } catch (error) {
        result = { phase, status: 'FAIL', checks, requests, error: error.stack, paidModelCalls: 0, mockModelCalls: requests.length }
      }
      await writeFile(process.env.INITIAL_MODEL_PROOF_REPORT, JSON.stringify(result, null, 2) + '\n')
      process.stdout.write(`INITIAL_MODEL_PROOF_RESULT=${JSON.stringify({ phase, status: result.status, error: result.error })}\n`)
    })
  }), 'initial-model proof')
}
