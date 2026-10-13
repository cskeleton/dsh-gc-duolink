/** Install the packed plugin into an isolated shipped Web profile and exercise its real browser surface. */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const pluginDir = fileURLToPath(new URL('../..', import.meta.url))
const binary = process.env.DSH_BIN ?? 'dsh'
const playwrightRequire = createRequire(process.env.PLAYWRIGHT_PACKAGE ?? join(pluginDir, 'package.json'))
const { chromium } = playwrightRequire('playwright')
const temp = await mkdtemp(join(tmpdir(), 'dsh-session-link-installed-'))
const home = join(temp, 'home')
const workspace = join(temp, 'workspace')
const profile = 'session-link-smoke'
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', npm_config_cache: join(temp, 'npm-cache') }
const artifactDir = resolve(process.env.SMOKE_ARTIFACT_DIR ?? join(pluginDir, 'output', 'playwright'))
const alphaId = 'session-link-smoke-alpha'
const betaId = 'session-link-smoke-beta'
const peerHistoryText = 'Peer history remains readable.'
let betaReadThroughSeq
let server
let browser
let page
let output = ''
const failures = []

/** Refuse cleanup outside the exact isolated home or named generated artifacts. */
async function removeGenerated(path, options) {
  const target = resolve(path)
  if (target === resolve(temp)) {
    assert.equal(await realpath(dirname(target)), await realpath(tmpdir()))
    assert.ok(basename(target).startsWith('dsh-session-link-installed-'))
  } else {
    assert.equal(dirname(target), artifactDir)
    assert.ok(['installed-smoke-result.json', 'installed-session-link-failure.png'].includes(basename(target)))
  }
  await rm(target, options)
}

function sanitized(text) {
  return text.replace(/https?:\/\/[^\s)]+/g, '[URL]').replace(/\u001b\[[0-9;]*m/g, '')
}

async function command(args, cwd = workspace) {
  try {
    return await runFile(binary, args, { cwd, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  } catch (error) {
    throw new Error(`dsh ${args[0]} failed: ${sanitized(error.stderr ?? error.message)}`, { cause: error })
  }
}

/** The same persistence API used by apps/web/tests/scaffold.ts seeds closed, ordinary Sessions. */
async function seedSessions() {
  const { stdout } = await runFile('which', [binary])
  const launcher = await realpath(stdout.trim())
  const installationRequire = createRequire(join(dirname(dirname(launcher)), 'package.json'))
  const { Context } = installationRequire('@deepseek-ai/cordis')
  const { SessionId, SESSION_FORMAT_VERSION } = installationRequire('@deepseek-ai/dsh-session')
  const { createSystemMessage } = installationRequire('@deepseek-ai/dsh-llm')
  const Persistence = installationRequire('@deepseek-ai/dsh-session-persistence-jsonl').default
  const ctx = new Context()
  try {
    await ctx.plugin(Persistence, { root: join(home, 'sessions') })
    for (const [id, title] of [[alphaId, 'Link alpha'], [betaId, 'Link beta']]) {
      const at = Date.now() - 60_000
      const header = { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: at, isSeeded: false, cwd: workspace, delegationDepth: 0 }
      const handle = await ctx.sessionPersistence.create(header)
      try {
        const events = [
          { type: 'turn/start', data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user', rpcId: 'seed' } } } },
          { type: 'step/start', data: { turn: 1, step: 1 } },
          { type: 'system/message', data: { turn: 1, step: 1, message: createSystemMessage('') }, surfaceOp: 'append' },
          { type: 'user/message', data: { id: '00000000-0000-4000-9000-000000000001', role: 'user', content: [{ type: 'text', text: `${title}.` }], source: { kind: 'user', rpcId: 'seed' } }, surfaceOp: 'append' },
          ...id === betaId ? [{
            type: 'user/message', data: {
              id: '00000000-0000-4000-9000-000000000002', role: 'user', content: [{ type: 'text', text: peerHistoryText }],
              source: { kind: 'session-link-message', messageId: 'session-link-smoke-message', linkId: 'session-link-smoke-source', senderId: alphaId, senderTitle: 'Link alpha' },
            }, surfaceOp: 'append',
          }] : [],
          { type: 'session/title', data: { title, messageSeqs: [], source: { kind: 'user' } } },
          { type: 'step/end', data: { turn: 1, step: 1 } },
          { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
        ].map((event, seq) => ({ ...event, seq, time: at + seq }))
        await handle.append(events)
        if (id === betaId) betaReadThroughSeq = events.at(-1).seq
      } finally {
        await handle.close()
      }
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

async function stopServer() {
  if (server === undefined || server.exitCode !== null) return
  server.kill('SIGTERM')
  await Promise.race([once(server, 'exit'), new Promise(resolve => setTimeout(resolve, 10_000))])
  if (server.exitCode === null) {
    server.kill('SIGKILL')
    await once(server, 'exit')
  }
}

async function startServer(overlay) {
  output = ''
  server = spawn(binary, ['--profile', profile, '--patch', overlay, '--no-open', '--port', '0'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', chunk => { output += chunk.toString() })
  server.stderr.on('data', chunk => { output += chunk.toString() })
  let authUrl
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const match = /dsh web:\s+(https?:\/\/[^\s]+)/.exec(output)
    if (match !== null) { authUrl = match[1]; break }
    if (server.exitCode !== null) throw new Error(`Web profile exited before readiness: ${sanitized(output)}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(authUrl, `Web profile did not become ready: ${sanitized(output)}`)
  await page.goto(authUrl, { waitUntil: 'load' })
  await page.locator('[class*="frame"]').waitFor({ timeout: 30_000 })
  const continueButton = page.getByRole('button', { name: /^(Continue|继续)$/ })
  if (await continueButton.isVisible()) await continueButton.click()
  return new URL(authUrl).origin
}

async function rpc(method, request, extra = {}) {
  const envelope = await page.evaluate(async ({ method, request, extra }) => {
    const response = await fetch(`/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: request === undefined ? {} : { request }, ...extra } }),
    })
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`)
    return await response.json()
  }, { method, request, extra })
  assert.equal(envelope.type, 'server-response')
  return envelope.result
}

async function requireRpc(method, request, extra = {}) {
  const result = await rpc(method, request, extra)
  assert.equal(result.ok, true, `${method}: ${JSON.stringify(result.error)}`)
  return result.value
}

async function missingLinkRpc() {
  const absent = await page.evaluate(async () => {
    const response = await fetch('/api/sessionLinks/view', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'sessionLinks/view', payload: { args: {} } }),
    })
    return { status: response.status, result: response.ok ? (await response.json()).result : undefined }
  })
  assert.ok(absent.status === 404 || absent.result?.ok === false, 'unavailable plugin has no successful RPC namespace')
}

async function eventually(check, label, timeout = 15_000) {
  const deadline = Date.now() + timeout
  let last
  do {
    try { if (await check()) return } catch (error) { last = error }
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}`, { cause: last })
}

async function selectSession(title) {
  const ungrouped = page.getByRole('treeitem', { name: /^Ungrouped/ })
  if (await ungrouped.count() > 0 && await ungrouped.getAttribute('aria-expanded') === 'false') await ungrouped.click()
  const row = page.getByRole('treeitem').filter({ hasText: title }).last()
  await row.waitFor({ timeout: 15_000 })
  await row.click()
  await page.getByText(`${title}.`, { exact: true }).waitFor({ timeout: 15_000 })
}

try {
  await mkdir(workspace, { recursive: true })
  await mkdir(artifactDir, { recursive: true })
  await removeGenerated(join(artifactDir, 'installed-smoke-result.json'), { force: true })
  const { stdout: version } = await command(['--version'])
  await command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'])
  const { stdout: packed } = await runFile('npm', ['pack', '--json', '--pack-destination', temp], { cwd: pluginDir, env, timeout: 60_000 })
  const packageTarball = join(temp, JSON.parse(packed)[0].filename)
  await command(['plugin', '--profile', profile, 'add', '--ignore-scripts', '--config.auto-install-peers=false', packageTarball])
  const profileDir = join(home, 'profiles', profile)
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  assert.ok(manifest.dependencies?.['dsh-session-link'], 'packed plugin is installed in the profile')
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-session-link'), 'installed bundle is enabled')
  await seedSessions()
  const overlay = join(temp, 'smoke.patch.yml')
  await writeFile(overlay, [
    '- id: hmr', '  disabled: true',
    '- id: session-telemetry-otel', '  disabled: true',
    '- id: session-log-deepseek', '  config:', '    enabled: false',
    '- id: session-title-llm', '  disabled: true',
    '- id: agent-instructions', '  disabled: true',
    '- id: ui-plugin-manager', '  config:', '    registryProbeEnabled: false',
    '- id: ui-settings-general', '  config:', '    welcomeNoticeVersion: 2026-09-28.1',
    '- id: ui-settings-models', '  config:', '    credentialOnboarding: false',
    '- id: session-link', '  config:', '    uiPollIntervalMs: 1000',
    '- id: workspace-controller', '  config:', `    documentsDirectory: ${JSON.stringify(join(temp, 'Documents'))}`,
    '- id: directory-picker', '  disabled: true',
    '- insert:', '    - id: directory-picker-browse', "      name: '@deepseek-ai/dsh-host-directory-picker-browse'",
    '    - id: ui-directory-picker-browse', "      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'", '',
  ].join('\n'))
  const toolVerifier = join(temp, 'verify-tools.mjs')
  await writeFile(toolVerifier, [
    "import assert from 'node:assert/strict'",
    "export const inject = ['tools', 'agents', 'appReady', 'sessionLinks']",
    "const names = ['session_list_links', 'session_send_session_message', 'session_cancel_session_message', 'session_spawn_linked_session', 'session_list_models']",
    'export function apply(ctx) {',
    '  ctx.effect(() => ctx.appReady.onReady(() => {',
    "    for (const name of names) assert.equal(ctx.tools.get(name), undefined, `Global tool layer exposes ${name}`)",
    "    process.stdout.write('SESSION_LINK_GLOBAL_TOOLS_ABSENT=PASS\\n')",
    "  }), 'integration: global tool layer')",
    // Reported after creation settles, independent of listener order.
    "  ctx.on('agent/created', ({ agent }) => { setTimeout(() => {",
    "    const preset = ctx.get('agentPresets')?.composedPreset(agent.ctx)",
    "    const visible = names.filter(name => ctx.tools.get(name, agent) !== undefined).length",
    "    process.stdout.write(`SESSION_LINK_AGENT ${agent.id} preset=${preset} tools=${visible}\\n`)",
    '  }, 500) })',
    '}', '',
  ].join('\n'))
  const verificationOverlay = join(temp, 'verification.patch.yml')
  await writeFile(verificationOverlay, `${await readFile(overlay, 'utf8')}- insert:\n    - id: session-link-integration-verifier\n      name: ${JSON.stringify(toolVerifier)}\n`)
  browser = await chromium.launch(process.env.BROWSER_EXECUTABLE_PATH === undefined ? {} : { executablePath: process.env.BROWSER_EXECUTABLE_PATH })
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => failures.push(error.message))
  await startServer(verificationOverlay)
  assert.ok(output.includes('SESSION_LINK_GLOBAL_TOOLS_ABSENT=PASS'), 'the installed tools stay out of the global tool layer')
  await requireRpc('session/rename', { sessionId: alphaId, title: 'Link alpha' })
  betaReadThroughSeq = (await requireRpc('session/rename', { sessionId: betaId, title: 'Link beta' })).seq
  await selectSession('Link alpha')
  const view = await requireRpc('sessionLinks/view')
  assert.equal(view.pollIntervalMs, 1000, 'the profile controls the plugin polling interval')
  assert.ok(view.sessions.some(session => session.id === alphaId && session.title === 'Link alpha'))
  assert.ok(view.sessions.some(session => session.id === betaId && session.ordinary && !session.blank))
  // The final UI assertions are kept below so every browser action uses the installed bundle.
  await runScenario({ page, rpc, requireRpc, eventually, selectSession, alphaId, betaId, artifactDir })
  await page.screenshot({ path: join(artifactDir, 'installed-session-link.png') })
  assert.deepEqual(failures, [], 'browser emitted no unhandled JavaScript errors')
  await stopServer()
  const invalidOverlay = join(temp, 'invalid-plugin.patch.yml')
  await writeFile(invalidOverlay, `${await readFile(overlay, 'utf8')}- id: session-link\n  config:\n    uiPollIntervalMs: 1\n`)
  await startServer(invalidOverlay)
  const coreSessions = await requireRpc('session/list', undefined, { args: { _request: {} } })
  assert.ok(coreSessions.items.some(session => session.sessionId === alphaId), 'core Session listing remains usable after plugin configuration fails')
  await selectSession('Link alpha')
  await selectSession('Link beta')
  const isolatedHistory = await requireRpc('session/page', { address: { kind: 'session', sessionId: betaId }, throughSeq: betaReadThroughSeq, maxMessages: 20 })
  assert.ok(JSON.stringify(isolatedHistory).includes(peerHistoryText), 'history body remains readable after plugin configuration fails')
  await missingLinkRpc()
  assert.ok(/session-link[\s\S]*(?:invalid|fail|warn|error|between|minimum|min)|(?:invalid|fail|warn|error)[\s\S]*session-link/i.test(output), 'failed plugin emits an explicit startup diagnostic')
  await page.screenshot({ path: join(artifactDir, 'session-link-invalid-config.png') })
  await stopServer()
  await command(['plugin', '--profile', profile, 'remove', 'dsh-session-link'])
  await startServer(overlay)
  await selectSession('Link alpha')
  await selectSession('Link beta')
  const absentHistory = await requireRpc('session/page', { address: { kind: 'session', sessionId: betaId }, throughSeq: betaReadThroughSeq, maxMessages: 20 })
  assert.ok(JSON.stringify(absentHistory).includes(peerHistoryText), 'peer-attributed history remains readable after its producer is removed')
  assert.ok(JSON.stringify(absentHistory).includes('session-link-message'), 'history preserves the removed producer attribution')
  await missingLinkRpc()
  assert.equal(await page.locator('[data-session-link-action]').count(), 0, 'removed plugin has no header action')
  assert.deepEqual(failures, [], 'plugin-free browser emitted no unhandled JavaScript errors')
  const summary = JSON.stringify({ result: 'PASS', dshVersion: version.trim(), installation: 'packed tarball', modelCalls: 0, toolsScopedToListedPresets: true, explicitSessionIdAdopted: true, invalidPluginConfigCoreUsable: true, pluginAbsentSessionsReadable: true, artifactDir })
  await writeFile(join(artifactDir, 'installed-smoke-result.json'), `${summary}\n`)
  await removeGenerated(join(artifactDir, 'installed-session-link-failure.png'), { force: true })
  console.log(summary)
} catch (error) {
  if (page !== undefined) {
    await page.screenshot({ path: join(artifactDir, 'installed-session-link-failure.png') }).catch(captureError => {
      console.error(`Failure screenshot could not be saved: ${sanitized(String(captureError))}`)
    })
  }
  console.error(sanitized(error.stack ?? String(error)))
  if (output !== '') console.error(sanitized(output))
  process.exitCode = 1
} finally {
  await browser?.close()
  await stopServer()
  await removeGenerated(temp, { recursive: true, force: true })
}

async function runScenario({ page, rpc, requireRpc, eventually, selectSession, alphaId, betaId, artifactDir }) {
  const concurrent = await Promise.all([
    rpc('sessionLinks/linkFrom', { callerId: alphaId, peerId: betaId, autoWake: false }),
    rpc('sessionLinks/linkFrom', { callerId: betaId, peerId: alphaId, autoWake: false }),
  ])
  assert.equal(concurrent.filter(result => result.ok).length, 1, 'concurrent requests for one pair create one group over the real wire')
  const created = concurrent.find(result => result.ok).value
  await requireRpc('sessionLinks/unlinkFrom', { callerId: alphaId, linkId: created.linkId })
  const header = page.locator('[data-session-link-action]')
  await header.waitFor({ timeout: 15_000 })
  await header.click()
  const quick = page.getByRole('dialog', { name: 'Quick link', exact: true })
  await quick.waitFor({ timeout: 15_000 })
  await quick.getByRole('textbox', { name: 'Search title or ID' }).fill('Link beta')
  await quick.getByRole('button', { name: /Link beta/ }).click()
  assert.equal((await requireRpc('sessionLinks/view')).links.length, 0, 'selecting a candidate is not confirmation')
  const initialWake = quick.getByRole('switch', { name: 'My messages → wake peer', exact: true })
  assert.equal(await initialWake.getAttribute('aria-checked'), 'true', 'new peer wake default is explicit')
  assert.equal(await quick.getByRole('switch', { name: 'Peer messages → wake me', exact: true }).getAttribute('aria-checked'), 'true')
  await initialWake.click()
  await quick.getByRole('button', { name: 'Link', exact: true }).click()
  let link
  await eventually(async () => {
    const view = await requireRpc('sessionLinks/view')
    link = view.links.find(group => group.memberIds.includes(alphaId) && group.memberIds.includes(betaId))
    return link !== undefined
  }, 'UI add writes one durable link')
  assert.deepEqual(link.autoWakeSessionIds, [alphaId], 'unchecked peer wake preserves independently checked caller wake')
  await eventually(async () => await quick.count() === 0, 'successful quick link dismisses the picker')
  await eventually(async () => await page.locator('[data-session-link-row-action].slp-row-linked').count() === 2, 'both linked sidebar right actions show membership')
  assert.equal(await page.locator('[data-session-link-mark]').count(), 0, 'plugin does not decorate the left execution dot')
  // Rename above materializes Host title/workspace projections and attaches beta.
  // Compare the existing Agent baseline; this is not evidence of cold resume.
  await eventually(async () => output.includes(`SESSION_LINK_AGENT ${betaId} `), 'seeded beta projection is materialized')
  const beforeAgents = (output.match(/SESSION_LINK_AGENT /g) ?? []).length
  // Manage beta from the list without switching the foreground conversation.
  const betaRow = page.getByRole('treeitem').filter({ hasText: 'Link beta' }).last()
  await betaRow.hover()
  await betaRow.locator('[data-session-link-row-action]').click()
  const panel = page.locator('[data-session-link-panel]')
  await panel.waitFor({ timeout: 15_000 })
  assert.equal(await panel.getAttribute('data-session-link-owner'), betaId)
  assert.ok(await page.getByText('Link alpha.', { exact: true }).isVisible(), 'row management leaves the conversation on alpha')
  await panel.getByRole('switch', { name: 'Peer messages → wake me', exact: true }).click()
  await eventually(async () => (await requireRpc('sessionLinks/view')).links[0]?.autoWakeSessionIds.includes(betaId), 'row-owner mutation grants beta, not the mounted alpha')
  assert.equal((output.match(/SESSION_LINK_AGENT /g) ?? []).length, beforeAgents, 'row management creates no additional Agents')
  const alphaRow = page.getByRole('treeitem').filter({ hasText: 'Link alpha' }).last()
  await alphaRow.hover()
  await alphaRow.locator('[data-session-link-row-action]').click()
  await eventually(async () => await panel.getAttribute('data-session-link-owner') === alphaId, 'row params update an existing management tab')
  const peerWake = panel.getByRole('switch', { name: 'My messages → wake peer · Link beta', exact: true })
  await peerWake.click()
  await eventually(async () => await peerWake.getAttribute('aria-checked') === 'false', 'independent peer toggle off')
  await peerWake.click()
  await eventually(async () => (await requireRpc('sessionLinks/view')).links.find(group => group.id === link.id)?.autoWakeSessionIds.includes(betaId), 'UI wake writes the peer flag')
  await requireRpc('sessionLinks/setAutoWakeFrom', { callerId: alphaId, linkId: link.id, peerId: betaId, on: false })
  await eventually(async () => await peerWake.getAttribute('aria-checked') === 'false', 'background mutation becomes visible through polling')
  const commands = await requireRpc('commands/list', undefined, { args: { agentId: alphaId } })
  assert.ok(commands.some(command => command.name === 'session-link'), 'session-link command is visible to the resumed ordinary Session')
  await eventually(async () => output.includes(`SESSION_LINK_AGENT ${alphaId} preset=standard tools=5`), 'all five tools mount in the standard-preset Agent scope')
  const minimal = await requireRpc('session/create', { cwd: workspace, agentPreset: 'minimal' })
  assert.equal(minimal.agentPreset, 'minimal')
  const minimalCommands = await requireRpc('commands/list', undefined, { args: { agentId: minimal.sessionId } })
  assert.ok(!minimalCommands.some(command => command.name === 'session-link'), 'the minimal preset receives no session-link command')
  await eventually(async () => output.includes(`SESSION_LINK_AGENT ${minimal.sessionId} preset=minimal tools=0`), 'the minimal preset receives no session-link tools')
  // A replayed spawn relies on the shipped controller adopting an explicit Session id.
  const spawnedId = 'session-5e55a1e0-0000-4000-8000-000000000001'
  const firstCreate = await requireRpc('session/create', { cwd: workspace, sessionId: spawnedId })
  const replayCreate = await requireRpc('session/create', { cwd: workspace, sessionId: spawnedId })
  assert.equal(firstCreate.sessionId, spawnedId)
  assert.equal(replayCreate.sessionId, spawnedId, 'a repeated explicit id adopts the same Session')
  await page.emulateMedia({ colorScheme: 'light' })
  await eventually(async () => await page.locator('body').getAttribute('data-ds-dark-theme') === null, 'light host theme')
  const light = await panel.evaluate(element => getComputedStyle(element).color)
  await page.screenshot({ path: join(artifactDir, 'session-link-light.png') })
  await page.emulateMedia({ colorScheme: 'dark' })
  await eventually(async () => await page.locator('body').getAttribute('data-ds-dark-theme') !== null, 'dark host theme')
  const dark = await panel.evaluate(element => getComputedStyle(element).color)
  assert.notEqual(light, dark, 'plugin follows the Host theme tokens')
  await page.screenshot({ path: join(artifactDir, 'session-link-dark.png') })
  await page.route('**/api/sessionLinks/view', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }))
  await panel.getByRole('alert').waitFor({ timeout: 15_000 })
  assert.ok((await panel.textContent()).includes('Link beta'), 'failed refresh retains the last useful catalog')
  await page.screenshot({ path: join(artifactDir, 'session-link-refresh-error.png') })
  await page.unroute('**/api/sessionLinks/view')
  await panel.getByRole('button', { name: 'Retry', exact: true }).click()
  await eventually(async () => await panel.getByRole('alert').count() === 0, 'retry restores the catalog')
  await page.reload({ waitUntil: 'load' })
  await selectSession('Link alpha')
  await page.locator('[data-session-link-action]').click()
  await page.getByRole('dialog', { name: 'Quick link', exact: true }).getByRole('button', { name: 'Manage links', exact: true }).click()
  await panel.waitFor({ timeout: 15_000 })
  assert.ok((await panel.textContent()).includes('Link beta'), 'link survives browser reload')
  await panel.getByRole('button', { name: 'Unlink', exact: true }).click()
  await panel.getByRole('button', { name: 'Confirm unlink', exact: true }).click()
  await eventually(async () => (await requireRpc('sessionLinks/view')).links.length === 0, 'UI revoke removes the durable group')
  await eventually(async () => await page.locator('[data-session-link-row-action].slp-row-linked').count() === 0, 'revoke clears membership color without removing quick-link actions')
  const selfLink = await rpc('sessionLinks/linkFrom', { callerId: alphaId, peerId: alphaId, autoWake: false })
  assert.equal(selfLink.ok, false, 'the Host rejects a self link over the real wire')
}
