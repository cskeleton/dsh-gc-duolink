/** Native bootstrap feasibility probe. All runtime classes come from the shipped CLI. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const require = createRequire(process.env.INITIAL_MODEL_PROOF_INSTALLATION_PACKAGE)
// The Loader imports the same ESM packages concurrently; require(esm) would race it.
const { SessionId } = await import(require.resolve('@deepseek-ai/dsh-session'))
const { LlmAdapter, createUserMessage, ToolCallId } = await import(require.resolve('@deepseek-ai/dsh-llm'))
const phase = process.env.INITIAL_MODEL_PROOF_PHASE
const cwd = process.env.INITIAL_MODEL_PROOF_WORKSPACE
const requests = []
const checks = []
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

export const inject = ['llm', 'appReady', 'sessions', 'sessionPersistence', 'sessionController', 'agents', 'agentPresets', 'agentDefaultModel', 'systemPrompt', 'tools']

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
    const replay = await packedCall(ctx, 'session_spawn_linked_session', spawnArgs('A'), callKey('A'))
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

function spawnArgs(m) {
  return { cwd, title: `proof ${m}`, task: 'proof two-step', auto_awake: false, wake_caller: false,
    ...m === 'BASE' ? {} : { initial_model: { provider: 'initial-proof', model: m, ...m === 'A' ? { reasoning_effort: 'high' } : {} } } }
}

async function packedSeed(ctx) {
  await turn(ctx, ids.caller, 'BASE')
  const catalog = await packedCall(ctx, 'session_list_models', {}, 'packed-catalog')
  assert.equal(catalog.isError, false, JSON.stringify(catalog))
  assert.equal(catalog.value.initialModelSelection, true)
  assert.equal('taskHost' in catalog.value, false)
  const results = await Promise.all(['A', 'B', 'BASE'].map(m => packedCall(ctx, 'session_spawn_linked_session', spawnArgs(m), callKey(m))))
  for (const [i, m] of ['A', 'B', 'BASE'].entries()) {
    const result = results[i]
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(result.value.sessionId, ids[m])
    assert.equal('taskId' in result.value, false)
    if (m !== 'BASE') {
      const sidecar = JSON.parse(result.content.filter(b => b.type === 'text')[1].text)
      assert.equal(sidecar.type, 'session-link/initial-model')
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
  const replays = await Promise.all([1, 2].map(() => packedCall(ctx, 'session_spawn_linked_session', spawnArgs('A'), callKey('A'))))
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
    const result = await packedCall(ctx, 'session_spawn_linked_session', changed, callKey('A'))
    assert.equal(result.isError, true)
    assert.ok(JSON.stringify(result).includes('REPLAY_CONFLICT'))
  }
  const addedModel = await packedCall(ctx, 'session_spawn_linked_session', { ...spawnArgs('BASE'), initial_model: { provider: 'initial-proof', model: 'A' } }, callKey('BASE'))
  assert.equal(addedModel.isError, true)
  assert.ok(JSON.stringify(addedModel).includes('REPLAY_CONFLICT'))
  checks.push('model/body suffix/grants/removal and ordinary-to-model changes reject replay')
  const sessionsBefore = (await ctx.sessionPersistence.list()).length
  for (const args of [
    { ...spawnArgs('A'), initial_model: { provider: 'initial-proof', model: 'A', reasoning_effort: 'unsupported' } },
    { ...spawnArgs('BASE'), provider: 'initial-proof', model: 'A' },
    { ...spawnArgs('BASE'), initial_model: { provider: 'initial-proof' } },
  ]) assert.equal((await packedCall(ctx, 'session_spawn_linked_session', args, 'packed-invalid')).isError, true)
  const sendWithModel = await packedCall(ctx, 'session_send_session_message', { session_id: ids.A, message: 'rejected', initial_model: { provider: 'initial-proof', model: 'A' } }, 'packed-send-invalid')
  assert.equal(sendWithModel.isError, true)
  assert.ok(JSON.stringify(sendWithModel).includes('send accepts no model'))
  assert.equal((await ctx.sessionPersistence.list()).length, sessionsBefore)
  assert.equal(requests.length, beforeReplay)
  checks.push('invalid effort/shape/retired args and send selection: no Session or request')
  await activate(ctx, ids.collision)
  const collision = await packedCall(ctx, 'session_spawn_linked_session', spawnArgs('A'), callKey('collision'))
  assert.equal(collision.isError, true)
  assert.ok(JSON.stringify(collision).includes('SESSION_CONFLICT'))
  assert.equal(requests.length, beforeReplay)
  checks.push('preexisting target ID refuses repair/activation/task dispatch')
  const linked = ctx.get('sessionLinks').spawnReplay(ids.caller, callKey('B'))
  await ctx.get('sessionLinks').unlink(linked.linkId)
  assert.equal((await packedCall(ctx, 'session_spawn_linked_session', spawnArgs('B'), callKey('B'))).isError, true)
  assert.equal(requests.length, beforeReplay)
  checks.push('human unlink is not revived by replay')
  const duplicate = await Promise.all([1, 2].map(() => packedCall(ctx, 'session_spawn_linked_session', spawnArgs('A'), 'packed-same-call-new')))
  assert.ok(duplicate.every(result => !result.isError), JSON.stringify(duplicate))
  assert.equal(duplicate[0].value.sessionId, duplicate[1].value.sessionId)
  assert.equal(duplicate[0].value.messageId, duplicate[1].value.messageId)
  await ctx.agents.get(duplicate[0].value.sessionId).whenIdle()
  assert.equal((await inspect(ctx, duplicate[0].value.sessionId)).events.filter(e => e.type === 'user/message' && e.data.source.kind === 'session-link-message').length, 1)
  checks.push('concurrent first attempts with the same payload share creation and delivery')
  for (const [i, ordered] of [[spawnArgs('A'), spawnArgs('BASE')], [spawnArgs('BASE'), spawnArgs('A')]].entries()) {
    const race = await Promise.all(ordered.map(args => packedCall(ctx, 'session_spawn_linked_session', args, `packed-cross-mode-${i}`)))
    assert.equal(race.filter(result => !result.isError).length, 1)
    assert.ok(JSON.stringify(race.find(result => result.isError)).includes('REPLAY_CONFLICT'), JSON.stringify(race))
    const winner = race.find(result => !result.isError)
    await ctx.agents.get(winner.value.sessionId).whenIdle()
    assert.equal((await inspect(ctx, winner.value.sessionId)).events.filter(e => e.type === 'user/message' && e.data.source.kind === 'session-link-message').length, 1)
  }
  checks.push('selected/ordinary same-call races in both orders have one winner and one task')
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
        result = { phase, status: 'PASS', checks, requests, paidModelCalls: 0, mockModelCalls: requests.length }
      } catch (error) {
        result = { phase, status: 'FAIL', checks, requests, error: error.stack, paidModelCalls: 0, mockModelCalls: requests.length }
      }
      await writeFile(process.env.INITIAL_MODEL_PROOF_REPORT, JSON.stringify(result, null, 2) + '\n')
      process.stdout.write(`INITIAL_MODEL_PROOF_RESULT=${JSON.stringify({ phase, status: result.status, error: result.error })}\n`)
    })
  }), 'initial-model proof')
}
