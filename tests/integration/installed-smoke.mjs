/** Install the built plugin into an isolated shipped Web profile and exercise its real browser surface. */
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
const temp = await mkdtemp(join(tmpdir(), 'dsh-gc-duolink-installed-'))
const home = join(temp, 'home')
const workspace = join(temp, 'workspace')
const profile = 'gc-duolink-smoke'
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', npm_config_cache: join(temp, 'npm-cache') }
const artifactDir = resolve(process.env.SMOKE_ARTIFACT_DIR ?? join(pluginDir, 'output', 'playwright'))
const alphaId = 'session-link-smoke-alpha'
const betaId = 'session-link-smoke-beta'
// Gamma never runs a foreground turn, so mail addressed to it stays queued.
const gammaId = 'session-link-smoke-gamma'
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
    assert.ok(basename(target).startsWith('dsh-gc-duolink-installed-'))
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
    for (const [id, title] of [[alphaId, 'Link alpha'], [betaId, 'Link beta'], [gammaId, 'Link gamma']]) {
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
              source: { kind: 'gc-duolink-message', messageId: 'session-link-smoke-message', linkId: 'session-link-smoke-source', senderId: alphaId, senderTitle: 'Link alpha' },
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

async function missingLinkRpc(namespace = 'gcDuolink') {
  const absent = await page.evaluate(async namespace => {
    const response = await fetch(`/api/${namespace}/view`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: `${namespace}/view`, payload: { args: {} } }),
    })
    return { status: response.status, result: response.ok ? (await response.json()).result : undefined }
  }, namespace)
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
  assert.equal(process.env.SMOKE_UPGRADE_FROM, undefined, 'Old-package migration is unsupported; use an isolated fresh profile')
  await command(['plugin', '--profile', profile, 'add', '--ignore-scripts', '--config.auto-install-peers=false', `link:${pluginDir}`])
  const profileDir = join(home, 'profiles', profile)
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  assert.ok(manifest.dependencies?.['dsh-gc-duolink'], 'built plugin is linked in the profile')
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-gc-duolink'), 'new bundle is enabled')
  await seedSessions()
  const oldStoragePath = join(home, 'storages/session_link.json')
  const oldStorage = '{"foreignOldPlugin":"must remain untouched; not a DuoLink domain"}\n'
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(oldStoragePath, oldStorage)
  const overlay = join(temp, 'smoke.patch.yml')
  await writeFile(overlay, [
    // Invalid old settings must not bind to DuoLink's independently named row.
    '- id: session-link', '  config:', '    uiPollIntervalMs: 1',
    '- id: hmr', '  disabled: true',
    '- id: session-telemetry-otel', '  disabled: true',
    '- id: session-log-deepseek', '  config:', '    enabled: false',
    '- id: session-title-llm', '  disabled: true',
    '- id: agent-instructions', '  disabled: true',
    '- id: ui-plugin-manager', '  config:', '    registryProbeEnabled: false',
    '- id: ui-settings-general', '  config:', '    welcomeNoticeVersion: 2026-09-28.1',
    '- id: ui-settings-models', '  config:', '    credentialOnboarding: false',
    '- id: gc-duolink', '  config:', '    uiPollIntervalMs: 1000', '    maxPendingPerTarget: 48',
    '- id: workspace-controller', '  config:', `    documentsDirectory: ${JSON.stringify(join(temp, 'Documents'))}`,
    '- id: directory-picker', '  disabled: true',
    '- insert:', '    - id: directory-picker-browse', "      name: '@deepseek-ai/dsh-host-directory-picker-browse'",
    '    - id: ui-directory-picker-browse', "      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'", '',
  ].join('\n'))
  const toolVerifier = join(temp, 'verify-tools.mjs')
  await writeFile(toolVerifier, [
    "import assert from 'node:assert/strict'",
    "export const inject = ['tools', 'agents', 'appReady', 'gcDuolink']",
    "const names = ['gc_duolink_list_links', 'gc_duolink_send_message', 'gc_duolink_cancel_message', 'gc_duolink_spawn_session', 'gc_duolink_list_models']",
    "const oldNames = ['session_list_links', 'session_send_session_message', 'session_cancel_session_message', 'session_spawn_linked_session', 'session_list_models']",
    'export function apply(ctx) {',
    '  ctx.effect(() => ctx.appReady.onReady(() => {',
    "    assert.equal(ctx.get('sessionLinks'), undefined, 'old service alias is absent')",
    "    for (const name of names) assert.equal(ctx.tools.get(name), undefined, `Global tool layer exposes ${name}`)",
    "    process.stdout.write('SESSION_LINK_GLOBAL_TOOLS_ABSENT=PASS\\n')",
    "  }), 'integration: global tool layer')",
    // Reported after creation settles, independent of listener order.
    "  ctx.on('agent/created', ({ agent }) => { setTimeout(() => {",
    "    const preset = ctx.get('agentPresets')?.composedPreset(agent.ctx)",
    "    const visible = names.filter(name => ctx.tools.get(name, agent) !== undefined).length",
    "    for (const name of oldNames) assert.equal(ctx.tools.get(name, agent), undefined, `Old tool alias ${name} is absent`)",
    "    process.stdout.write(`SESSION_LINK_AGENT ${agent.id} preset=${preset} tools=${visible}\\n`)",
    '  }, 500) })',
    // Seed real mail through the packed service once the gamma link exists. No
    // target ever runs a turn in this profile (there is no model provider), so
    // delivered mail is impossible here by design; the recent section is
    // exercised through terminal `revoked` records after the unlink.
    "  ctx.effect(() => {",
    "    let seeded = false",
    '    const seed = setInterval(async () => {',
    '      try {',
    '        if (seeded) return',
    `        const alpha = ctx.agents.get('${alphaId}')`,
    '        if (alpha === undefined) return',
    `        const links = ctx.gcDuolink.list('${alphaId}')`,
    `        if (!links.some(link => link.memberIds.includes('${gammaId}'))) return`,
    // Imported-history fixture for the dialog only: prior-day wakes do not
    // make model calls in this provider-free Web profile. Real wake spending
    // and post-extension dispatch are exercised by initial-model-fixture.mjs.
    `        const group = links.find(link => link.memberIds.includes('${gammaId}'))`,
    '        let parentId',
    '        for (let step = 1; step <= 8; step += 1) {',
    '          const id = `smoke-wake-history-${step}`',
    `          await ctx.gcDuolink.messages.put(id, { linkId: group.id, senderId: step % 2 ? '${alphaId}' : '${gammaId}',`,
    `            targetId: step % 2 ? '${gammaId}' : '${alphaId}', senderTitle: 'Imported wake history', text: 'prior-day wake fixture',`,
    '            status: "delivered", wakesUsed: 1, chainLength: step, attempts: 0, seq: step, createdAt: new Date(Date.now() - 86400000 + step).toISOString(),',
    '            ...(parentId === undefined ? {} : { inReplyTo: parentId }) })',
    '          parentId = id',
    '        }',
    '        for (let index = 1; index <= 25; index += 1) {',
    `          const text = index === 13 ? 'queued smoke envelope 13 '.padEnd(600, 'long body ') : \`queued smoke envelope \${index}\``,
    `          await ctx.gcDuolink.send(alpha, '${gammaId}', { targetId: '${gammaId}', text, ...(index === 13 ? { wake: false } : {}), ...(index === 15 ? { inReplyTo: parentId } : {}) })`,
    '        }',
    '        seeded = true',
    '        clearInterval(seed)',
    "        process.stdout.write('SESSION_LINK_PENDING_SEEDED=25\\n')",
    '      } catch (error) {',
    "        process.stdout.write(`SESSION_LINK_SEED_ERROR ${error?.message ?? error}\\n`)",
    '      }',
    '    }, 1000)',
    '    return () => clearInterval(seed)',
    "  }, 'integration: seed peer mail')",
    '}', '',
  ].join('\n'))
  const verificationOverlay = join(temp, 'verification.patch.yml')
  await writeFile(verificationOverlay, `${await readFile(overlay, 'utf8')}- insert:\n    - id: gc-duolink-integration-verifier\n      name: ${JSON.stringify(toolVerifier)}\n`)
  browser = await chromium.launch(process.env.BROWSER_EXECUTABLE_PATH === undefined ? {} : { executablePath: process.env.BROWSER_EXECUTABLE_PATH })
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  page.on('pageerror', error => failures.push(error.message))
  await startServer(verificationOverlay)
  await missingLinkRpc('sessionLinks')
  assert.equal(await readFile(oldStoragePath, 'utf8'), oldStorage, 'old storage is neither read nor rewritten')
  assert.ok(output.includes('SESSION_LINK_GLOBAL_TOOLS_ABSENT=PASS'), 'the installed tools stay out of the global tool layer')
  await requireRpc('session/rename', { sessionId: alphaId, title: 'Link alpha' })
  betaReadThroughSeq = (await requireRpc('session/rename', { sessionId: betaId, title: 'Link beta' })).seq
  await selectSession('Link alpha')
  const view = await requireRpc('gcDuolink/view')
  assert.equal(view.pollIntervalMs, 1000, 'the profile controls the plugin polling interval')
  assert.ok(view.sessions.some(session => session.id === alphaId && session.title === 'Link alpha'))
  assert.ok(view.sessions.some(session => session.id === betaId && session.ordinary && !session.blank))
  // The final UI assertions are kept below so every browser action uses the installed bundle.
  await runScenario({ page, rpc, requireRpc, eventually, selectSession, alphaId, betaId, gammaId, artifactDir })
  assert.equal(await readFile(oldStoragePath, 'utf8'), oldStorage, 'new mail never writes to the old domain')
  assert.ok((await readFile(join(home, 'storages/gc_duolink.json'), 'utf8')).includes('dsh-gc-duolink'), 'new store carries its own product identity')
  await page.screenshot({ path: join(artifactDir, 'installed-session-link.png') })
  assert.deepEqual(failures, [], 'browser emitted no unhandled JavaScript errors')
  await stopServer()
  const invalidOverlay = join(temp, 'invalid-plugin.patch.yml')
  await writeFile(invalidOverlay, `${await readFile(overlay, 'utf8')}- id: gc-duolink\n  config:\n    uiPollIntervalMs: 1\n`)
  await startServer(invalidOverlay)
  const coreSessions = await requireRpc('session/list', undefined, { args: { _request: {} } })
  assert.ok(coreSessions.items.some(session => session.sessionId === alphaId), 'core Session listing remains usable after plugin configuration fails')
  await selectSession('Link alpha')
  await selectSession('Link beta')
  const isolatedHistory = await requireRpc('session/page', { address: { kind: 'session', sessionId: betaId }, throughSeq: betaReadThroughSeq, maxMessages: 20 })
  assert.ok(JSON.stringify(isolatedHistory).includes(peerHistoryText), 'history body remains readable after plugin configuration fails')
  await missingLinkRpc()
  assert.ok(/gc-duolink[\s\S]*(?:invalid|fail|warn|error|between|minimum|min)|(?:invalid|fail|warn|error)[\s\S]*gc-duolink/i.test(output), 'failed plugin emits an explicit startup diagnostic')
  await page.screenshot({ path: join(artifactDir, 'session-link-invalid-config.png') })
  await stopServer()
  await command(['plugin', '--profile', profile, 'remove', 'dsh-gc-duolink'])
  await startServer(overlay)
  await selectSession('Link alpha')
  await selectSession('Link beta')
  const absentHistory = await requireRpc('session/page', { address: { kind: 'session', sessionId: betaId }, throughSeq: betaReadThroughSeq, maxMessages: 20 })
  assert.ok(JSON.stringify(absentHistory).includes(peerHistoryText), 'peer-attributed history remains readable after its producer is removed')
  assert.ok(JSON.stringify(absentHistory).includes('gc-duolink-message'), 'history preserves the removed producer attribution')
  await missingLinkRpc()
  assert.equal(await page.locator('[data-gc-duolink-action]').count(), 0, 'removed plugin has no header action')
  assert.equal(await page.locator('[data-duolink-copy-session-id]').count(), 0, 'removed plugin has no copy menu')
  assert.deepEqual(failures, [], 'plugin-free browser emitted no unhandled JavaScript errors')
  const summary = JSON.stringify({ result: 'PASS', packageName: 'dsh-gc-duolink', isolatedFromOldPlugin: true, oldConfigIgnored: true, oldStorageUntouched: true, oldRpcAbsent: true, copySessionId: true, dshVersion: version.trim(), installation: 'built directory link', modelCalls: 0, toolsScopedToListedPresets: true, explicitSessionIdAdopted: true, invalidPluginConfigCoreUsable: true, pluginAbsentSessionsReadable: true, activityViewPaged: true, activityCursorRejected: true, mailSurface: true, mailFailureRetained: true, quickPeerOpen: true, managedSessionOpen: true, unlinkRevokesQueuedMail: true, humanMessageCancellation: true, noWakeActivity: true, chainWakeDialog: true, chainWakeExtension: true, artifactDir })
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

async function runScenario({ page, rpc, requireRpc, eventually, selectSession, alphaId, betaId, gammaId, artifactDir }) {
  assert.equal((await requireRpc('gcDuolink/view')).links.length, 0, 'copy works before any link is created')
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
  const copyRow = page.locator(`[data-row-key="session:${betaId}"]`)
  await copyRow.hover()
  await copyRow.getByRole('button', { name: 'Session actions for Link beta', exact: true }).click()
  const copy = page.getByRole('menuitem', { name: 'Copy Session ID', exact: true })
  await copy.waitFor()
  assert.equal(await copy.count(), 1, 'exactly one copy entry is installed')
  await page.screenshot({ path: join(artifactDir, 'duolink-copy-session-id.png') })
  await copy.click()
  await copy.waitFor({ state: 'hidden' })
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), betaId, 'system clipboard contains the clicked row ID')
  assert.ok(await page.getByText('Link alpha.', { exact: true }).isVisible(), 'copy leaves the foreground conversation unchanged')
  const concurrent = await Promise.all([
    rpc('gcDuolink/linkFrom', { callerId: alphaId, peerId: betaId, autoWake: false }),
    rpc('gcDuolink/linkFrom', { callerId: betaId, peerId: alphaId, autoWake: false }),
  ])
  assert.equal(concurrent.filter(result => result.ok).length, 1, 'concurrent requests for one pair create one group over the real wire')
  const created = concurrent.find(result => result.ok).value
  await requireRpc('gcDuolink/unlinkFrom', { callerId: alphaId, linkId: created.linkId })
  const header = page.locator('[data-gc-duolink-action]')
  await header.waitFor({ timeout: 15_000 })
  await header.click()
  const quick = page.getByRole('dialog', { name: 'Quick link', exact: true })
  await quick.waitFor({ timeout: 15_000 })
  await quick.getByRole('textbox', { name: 'Search title or ID' }).fill('Link beta')
  await quick.getByRole('button', { name: /Link beta/ }).click()
  assert.equal((await requireRpc('gcDuolink/view')).links.length, 0, 'selecting a candidate is not confirmation')
  const initialWake = quick.getByRole('switch', { name: 'My messages → wake peer', exact: true })
  assert.equal(await initialWake.getAttribute('aria-checked'), 'true', 'new peer wake default is explicit')
  assert.equal(await quick.getByRole('switch', { name: 'Peer messages → wake me', exact: true }).getAttribute('aria-checked'), 'true')
  await initialWake.click()
  await quick.getByRole('button', { name: 'Link', exact: true }).click()
  let link
  await eventually(async () => {
    const view = await requireRpc('gcDuolink/view')
    link = view.links.find(group => group.memberIds.includes(alphaId) && group.memberIds.includes(betaId))
    return link !== undefined
  }, 'UI add writes one durable link')
  assert.deepEqual(link.autoWakeSessionIds, [alphaId], 'unchecked peer wake preserves independently checked caller wake')
  await eventually(async () => await quick.count() === 0, 'successful quick link dismisses the picker')
  await eventually(async () => await page.locator('[data-gc-duolink-row-action].gcdl-row-linked').count() === 2, 'both linked sidebar right actions show membership')
  assert.equal(await page.locator('[data-gc-duolink-mark]').count(), 0, 'plugin does not decorate the left execution dot')
  // Rename above materializes Host title/workspace projections and attaches beta.
  // Compare the existing Agent baseline; this is not evidence of cold resume.
  await eventually(async () => output.includes(`SESSION_LINK_AGENT ${betaId} `), 'seeded beta projection is materialized')
  const beforeAgents = (output.match(/SESSION_LINK_AGENT /g) ?? []).length
  // Manage beta from the list without switching the foreground conversation.
  const betaRow = page.getByRole('treeitem').filter({ hasText: 'Link beta' }).last()
  await betaRow.hover()
  await betaRow.locator('[data-gc-duolink-row-action]').click()
  const panel = page.locator('[data-gc-duolink-panel]')
  await panel.waitFor({ timeout: 15_000 })
  assert.equal(await panel.getAttribute('data-gc-duolink-owner'), betaId)
  assert.ok(await page.getByText('Link alpha.', { exact: true }).isVisible(), 'row management leaves the conversation on alpha')
  await panel.getByRole('switch', { name: 'Peer messages → wake me', exact: true }).click()
  await eventually(async () => (await requireRpc('gcDuolink/view')).links[0]?.autoWakeSessionIds.includes(betaId), 'row-owner mutation grants beta, not the mounted alpha')
  assert.equal((output.match(/SESSION_LINK_AGENT /g) ?? []).length, beforeAgents, 'row management creates no additional Agents')
  const alphaRow = page.getByRole('treeitem').filter({ hasText: 'Link alpha' }).last()
  await alphaRow.hover()
  await alphaRow.locator('[data-gc-duolink-row-action]').click()
  await eventually(async () => await panel.getAttribute('data-gc-duolink-owner') === alphaId, 'row params update an existing management tab')
  const peerWake = panel.getByRole('switch', { name: 'My messages → wake peer · Link beta', exact: true })
  await peerWake.click()
  await eventually(async () => await peerWake.getAttribute('aria-checked') === 'false', 'independent peer toggle off')
  await peerWake.click()
  await eventually(async () => (await requireRpc('gcDuolink/view')).links.find(group => group.id === link.id)?.autoWakeSessionIds.includes(betaId), 'UI wake writes the peer flag')
  await requireRpc('gcDuolink/setAutoWakeFrom', { callerId: alphaId, linkId: link.id, peerId: betaId, on: false })
  await eventually(async () => await peerWake.getAttribute('aria-checked') === 'false', 'background mutation becomes visible through polling')
  // M1 activity surface: packed RPC paging, the mail tab, and the header quick view.
  const gammaLink = await requireRpc('gcDuolink/linkFrom', { callerId: alphaId, peerId: gammaId, autoWake: false })
  await eventually(async () => output.includes('SESSION_LINK_PENDING_SEEDED=25'), 'queued smoke envelopes are admitted by the packed plugin')
  const first = await requireRpc('gcDuolink/activityView', { sessionId: alphaId, section: 'pending' })
  assert.equal(first.total, 25, 'pending total counts every queued envelope')
  assert.equal(first.entries.length, 20, 'the default page size applies over the wire')
  assert.ok(first.nextCursor !== undefined, 'a second page is advertised')
  assert.ok(first.entries[0].preview.includes('queued smoke envelope 1'), 'admission order leads the first page')
  assert.ok(first.entries[0].blockingReasons.includes('cold-target'), 'a cold target explains its queue state')
  assert.equal(first.summary.pendingOutbound, 25)
  assert.equal(first.summary.wake.limit, 12)
  assert.ok(first.entries[12].blockingReasons.includes('wake-not-requested'), 'explicit no-wake intent is projected by the packed RPC')
  const second = await requireRpc('gcDuolink/activityView', { sessionId: alphaId, section: 'pending', cursor: first.nextCursor })
  assert.equal(second.entries.length, 5, 'the opaque cursor continues the same admission order')
  assert.ok(second.entries[0].preview.includes('queued smoke envelope 21'), 'the second page resumes after the first')
  assert.equal(second.nextCursor, undefined, 'the chain ends after the last entry')
  const invalidCursor = await rpc('gcDuolink/activityView', { sessionId: alphaId, section: 'pending', cursor: 'not-a-cursor' })
  assert.equal(invalidCursor.ok, false, 'a forged cursor is rejected over the wire')
  assert.ok(JSON.stringify(invalidCursor.error).includes('ACTIVITY_CURSOR_INVALID'), 'the rejection carries the cursor code')
  // Mail surface inside the alpha management tab opened above.
  const mail = panel.locator('section.gcdl-mail')
  await eventually(async () => (await mail.textContent()).includes('Outbound 25'), 'mail summary counts queued envelopes')
  assert.ok((await mail.textContent()).includes('Wake 0/12'), 'mail summary shows the day budget')
  assert.ok((await mail.textContent()).includes('queued smoke envelope 1'), 'first-page rows render')
  assert.ok((await mail.textContent()).includes('Enqueued'), 'rows carry their enqueue time')
  assert.ok((await mail.textContent()).includes('target not resident'), 'rows explain why they are queued')
  assert.ok((await mail.textContent()).includes('wake not requested; awaiting target activity'), 'the UI distinguishes send intent from missing permission')
  // A failed next page keeps page one and reports raw detail.
  const alerts = async () => (await mail.getByRole('alert').allTextContents()).join(' ')
  await page.route('**/api/gcDuolink/activityView', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }))
  await mail.getByRole('button', { name: 'Load more', exact: true }).click()
  await eventually(async () => (await alerts()).includes('Next page unavailable'), 'raw paging failure surfaces')
  assert.ok((await mail.textContent()).includes('queued smoke envelope 1'), 'page one survives the paging failure')
  await page.unroute('**/api/gcDuolink/activityView')
  await mail.getByRole('button', { name: 'Retry', exact: true }).last().click()
  await eventually(async () => (await mail.textContent()).includes('queued smoke envelope 21'), 'retry appends the second page')
  // A failed refresh keeps the stale snapshot with its sampled time.
  await page.route('**/api/gcDuolink/activityView', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }))
  await mail.getByRole('button', { name: 'Refresh', exact: true }).click()
  await eventually(async () => (await alerts()).includes('Refresh unavailable'), 'refresh failure surfaces without dropping rows')
  assert.ok((await mail.textContent()).includes('queued smoke envelope 21'), 'the stale snapshot stays rendered')
  await page.screenshot({ path: join(artifactDir, 'session-link-mail-stale.png') })
  await page.unroute('**/api/gcDuolink/activityView')
  await mail.getByRole('button', { name: 'Retry', exact: true }).first().click()
  await eventually(async () => await mail.getByRole('alert').count() === 0, 'refresh retry clears the alert')
  // Human extension uses the actual packed RPC; cancelling the dialog is read-only.
  const extensionRow = mail.locator('article.gcdl-mail-entry', { hasText: 'queued smoke envelope 15' })
  const extensionId = first.entries[14].messageId
  const extensionButton = extensionRow.locator('[data-gc-duolink-extend]')
  const extensionCalls = []
  const observeExtension = request => {
    if (new URL(request.url()).pathname === '/api/gcDuolink/extendChainWakeFrom') {
      extensionCalls.push(request.postDataJSON().payload.args.request)
    }
  }
  page.on('request', observeExtension)
  assert.ok((await extensionRow.textContent()).includes('8/8'), 'exhausted chain usage appears inline')
  assert.equal(await page.locator('[data-gc-duolink-wake-dialog]').count(), 0, 'dialog never opens itself')
  await extensionButton.click()
  const extensionDialog = page.getByRole('dialog', { name: 'Increase wake budget for this reply chain', exact: true })
  await extensionDialog.waitFor()
  assert.ok((await extensionDialog.textContent()).includes('New limit: 12 wakes'))
  assert.ok((await extensionDialog.textContent()).includes('wake not authorized'), 'other blockers remain visible before confirmation')
  assert.ok(await extensionDialog.getByRole('radio', { name: 'Add 4 wakes', exact: true }).evaluate(el => el === document.activeElement), 'modal receives focus')
  await page.screenshot({ path: join(artifactDir, 'session-link-wake-dialog.png') })
  const dialogLight = await extensionDialog.evaluate(el => getComputedStyle(el).color)
  await page.emulateMedia({ colorScheme: 'dark' })
  await eventually(async () => await page.locator('body').getAttribute('data-ds-dark-theme') !== null, 'dark dialog host theme')
  assert.notEqual(await extensionDialog.evaluate(el => getComputedStyle(el).color), dialogLight, 'dialog follows the Host theme')
  await page.screenshot({ path: join(artifactDir, 'session-link-wake-dialog-dark.png') })
  await page.emulateMedia({ colorScheme: 'light' })
  await eventually(async () => await page.locator('body').getAttribute('data-ds-dark-theme') === null, 'restore light dialog host theme')
  await page.setViewportSize({ width: 820, height: 1000 })
  await page.screenshot({ path: join(artifactDir, 'session-link-wake-dialog-narrow.png') })
  assert.ok(await extensionDialog.evaluate(el => el.getBoundingClientRect().width <= innerWidth && el.scrollWidth <= el.clientWidth + 1), 'dialog fits the narrow viewport')
  await extensionDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(extensionCalls.length, 0, 'cancel sends no extension request')
  assert.ok(await extensionButton.evaluate(el => el === document.activeElement), 'cancel restores focus')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await extensionButton.click()
  await extensionDialog.getByRole('radio', { name: 'Custom', exact: true }).check()
  await extensionDialog.getByRole('spinbutton').fill('0')
  assert.equal(await extensionDialog.locator('[data-gc-duolink-extend-confirm]').isDisabled(), true)
  await extensionDialog.getByRole('radio', { name: 'Add 8 wakes', exact: true }).check()
  assert.ok((await extensionDialog.textContent()).includes('New limit: 16 wakes'))
  await extensionDialog.getByRole('radio', { name: 'Add 4 wakes', exact: true }).check()
  await extensionDialog.getByRole('button', { name: 'Add and continue', exact: true }).click()
  await eventually(async () => await extensionDialog.count() === 0, 'accepted extension closes the dialog')
  assert.equal(extensionCalls.length, 1)
  assert.equal(extensionCalls[0].sessionId, alphaId)
  assert.equal(extensionCalls[0].messageId, extensionId)
  assert.equal(extensionCalls[0].additional, 4)
  assert.equal(extensionCalls[0].expectedExtra, 0)
  assert.ok((await mail.locator('[data-gc-duolink-wake-result="applied"]').textContent()).includes('remains queued'), 'permission blocker does not become false execution success')
  const extended = await requireRpc('gcDuolink/extendChainWakeFrom', extensionCalls[0])
  assert.equal(extended.outcome, 'replayed')
  assert.equal(extended.budget.chain.extra, 4)
  assert.equal(extended.budget.chain.limit, 12)
  assert.equal(extended.budget.chain.used, 8)
  assert.equal(extended.continuation, 'queued')
  await eventually(async () => (await extensionRow.textContent()).includes('8/12'), 'mailbox refresh shows the increased limit')
  assert.equal(await extensionButton.count(), 0, 'exhaustion action disappears after extension')
  const staleExtension = await requireRpc('gcDuolink/extendChainWakeFrom', { ...extensionCalls[0], requestId: 'smoke-stale-extension' })
  assert.equal(staleExtension.outcome, 'conflict')
  assert.equal(staleExtension.budget.chain.extra, 4)
  page.off('request', observeExtension)
  // The pending tab with both pages loaded is the documented mail surface.
  const cancelRow = mail.locator('article.gcdl-mail-entry', { hasText: 'queued smoke envelope 25' })
  await cancelRow.waitFor()
  const cancelId = second.entries.at(-1).messageId
  const unrelated = await rpc('gcDuolink/cancelMessageFrom', { sessionId: betaId, messageId: cancelId })
  assert.equal(unrelated.ok, false, 'unrelated session cannot cancel another pair mail')
  assert.match(unrelated.error.message, /only the sender or target Session may cancel/)
  await cancelRow.getByRole('button', { name: 'Cancel queued message', exact: true }).click()
  await mail.locator('[data-gc-duolink-cancel-result="cancelled"]').waitFor()
  await eventually(async () => (await mail.textContent()).includes('Outbound 24'), 'UI cancellation refreshes the pending count')
  assert.deepEqual(await requireRpc('gcDuolink/cancelMessageFrom', { sessionId: gammaId, messageId: cancelId }),
    { messageId: cancelId, outcome: 'already_terminal', status: 'cancelled' }, 'recipient repeat returns the actual terminal state')
  const targetCancelId = second.entries.at(-2).messageId
  assert.deepEqual(await requireRpc('gcDuolink/cancelMessageFrom', { sessionId: gammaId, messageId: targetCancelId }),
    { messageId: targetCancelId, outcome: 'cancelled', status: 'cancelled' }, 'recipient may cancel ordinary pending mail')
  await eventually(async () => (await mail.textContent()).includes('Outbound 23'), 'recipient cancellation converges through polling')
  await mail.locator('[data-gc-duolink-cancel-result="cancelled"]').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(artifactDir, 'session-link-mail.png') })
  // Header glance plus the linked-session quick view open a peer session.
  await page.locator('[data-gc-duolink-action]').click()
  const quickView = page.getByRole('dialog', { name: 'Quick link', exact: true })
  await quickView.waitFor({ timeout: 15_000 })
  await eventually(async () => (await quickView.textContent()).includes('Wake 0/12'), 'header glance shows the day budget')
  const glance = quickView.locator('.gcdl-footnote', { hasText: 'Inbound' })
  assert.ok(((await glance.getAttribute('title')) ?? '').startsWith('Updated '), 'the glance carries a sampled-time staleness hint')
  assert.ok((await quickView.textContent()).includes('Linked sessions'), 'header quick view lists linked peers')
  await quickView.locator('button[title="Open session \\"Link beta\\""]').click()
  await page.getByText('Link beta.', { exact: true }).first().waitFor({ timeout: 15_000 })
  await selectSession('Link alpha')
  // Unlink revokes queued mail; the mounted mail view converges through polling.
  await requireRpc('gcDuolink/unlinkFrom', { callerId: alphaId, linkId: gammaLink.linkId })
  await eventually(async () => (await requireRpc('gcDuolink/activityView', { sessionId: alphaId, section: 'pending' })).total === 0, 'unlink revokes queued mail')
  const revoked = await requireRpc('gcDuolink/activityView', { sessionId: alphaId, section: 'recent' })
  assert.ok(revoked.total >= 25, 'revoked mail lands in the recent section')
  assert.ok(revoked.entries.every(entry => entry.status === 'revoked' || entry.status === 'cancelled'), 'recent rows retain unlink and cancellation outcomes')
  assert.equal(revoked.entries.filter(entry => entry.status === 'cancelled').length, 2, 'unlink preserves cancellation tombstones')
  assert.ok(revoked.entries.some(entry => entry.preview.includes('queued smoke envelope 1')), 'recent previews match the queued envelopes')
  await alphaRow.hover()
  await alphaRow.locator('[data-gc-duolink-row-action]').click()
  await eventually(async () => await panel.getAttribute('data-gc-duolink-owner') === alphaId, 'management tab returns to alpha')
  await eventually(async () => (await mail.textContent()).includes('No messages'), 'revoked mail disappears from the mounted view')
  // The recent tab lists the revoked envelopes, including the long body.
  await mail.getByRole('tab', { name: 'Recent', exact: true }).click()
  await eventually(async () => (await mail.textContent()).includes('queued smoke envelope 13'), 'recent tab lists revoked mail')
  assert.ok((await mail.textContent()).includes('Revoked'), 'recent rows carry the revoked status')
  assert.ok((await mail.textContent()).includes('long body'), 'long previews render in recent rows')
  // Round-2 lifecycle boundaries: remount consistency and inactivity read
  // isolation. (The interrupted-first-read boundary runs after the reload
  // below, where a fresh controller starts its first read.)
  // A foreground-switch remount keeps the selected tab consistent with the retained section.
  await alphaRow.hover()
  await alphaRow.locator('[data-gc-duolink-row-action]').click()
  await eventually(async () => await panel.getAttribute('data-gc-duolink-owner') === alphaId, 'panel owner returns to alpha')
  await eventually(async () => (await mail.textContent()).includes('Revoked'), 'alpha recent rows stay retained')
  await selectSession('Link beta')
  await selectSession('Link alpha')
  await eventually(async () => (await mail.textContent()).includes('queued smoke envelope 13'), 'remount keeps the retained recent rows')
  assert.equal((await mail.getByRole('tab', { selected: true }).textContent())?.trim(), 'Recent', 'remount keeps the selected tab consistent with the retained section')
  // While alpha's mail is unsubscribed, client writes never re-read it.
  await betaRow.hover()
  await betaRow.locator('[data-gc-duolink-row-action]').click()
  await eventually(async () => await panel.getAttribute('data-gc-duolink-owner') === betaId, 'alpha mail unsubscribes behind the beta panel')
  let alphaReads = 0
  await page.route('**/api/gcDuolink/activityView', route => {
    if ((route.request().postData() ?? '').includes(alphaId)) alphaReads += 1
    return route.continue()
  })
  const betaWake = panel.getByRole('switch', { name: 'Peer messages → wake me', exact: true })
  await betaWake.click()
  await eventually(async () => await betaWake.getAttribute('aria-checked') === 'true', 'beta wake grant toggles on')
  await betaWake.click()
  await eventually(async () => await betaWake.getAttribute('aria-checked') === 'false', 'beta wake grant toggles back off')
  await new Promise(resolve => setTimeout(resolve, 2_500))
  assert.equal(alphaReads, 0, 'an unsubscribed owner issues no activity reads on writes')
  await page.unroute('**/api/gcDuolink/activityView')
  await alphaRow.hover()
  await alphaRow.locator('[data-gc-duolink-row-action]').click()
  await eventually(async () => await panel.getAttribute('data-gc-duolink-owner') === alphaId, 'panel owner returns to alpha for the layout checks')
  await eventually(async () => (await mail.textContent()).includes('queued smoke envelope 13'), 'reactivation converges on the retained recent rows')
  // Narrow viewports keep the mail surface usable, long body included.
  await page.setViewportSize({ width: 820, height: 1000 })
  await eventually(async () => (await mail.textContent()).includes('queued smoke envelope 13'), 'narrow viewport still renders the mail surface')
  await page.screenshot({ path: join(artifactDir, 'session-link-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await mail.getByRole('tab', { name: 'Pending', exact: true }).click()
  // The management tab of a non-current session opens that session.
  const betaRowAgain = page.getByRole('treeitem').filter({ hasText: 'Link beta' }).last()
  await betaRowAgain.hover()
  await betaRowAgain.locator('[data-gc-duolink-row-action]').click()
  await eventually(async () => await panel.getAttribute('data-gc-duolink-owner') === betaId, 'beta management tab is keyed to beta')
  await panel.getByRole('button', { name: 'Open managed session', exact: true }).click()
  await page.getByText('Link beta.', { exact: true }).first().waitFor({ timeout: 15_000 })
  await selectSession('Link alpha')
  const commands = await requireRpc('commands/list', undefined, { args: { agentId: alphaId } })
  assert.ok(commands.some(command => command.name === 'gc-duolink'), 'session-link command is visible to the resumed ordinary Session')
  assert.ok(!commands.some(command => command.name === 'session-link'), 'old command alias is absent')
  await eventually(async () => output.includes(`SESSION_LINK_AGENT ${alphaId} preset=standard tools=5`), 'all five tools mount in the standard-preset Agent scope')
  const minimal = await requireRpc('session/create', { cwd: workspace, agentPreset: 'minimal' })
  assert.equal(minimal.agentPreset, 'minimal')
  const minimalCommands = await requireRpc('commands/list', undefined, { args: { agentId: minimal.sessionId } })
  assert.ok(!minimalCommands.some(command => command.name === 'gc-duolink'), 'the minimal preset receives no session-link command')
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
  await page.route('**/api/gcDuolink/view', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }))
  await panel.getByRole('alert').waitFor({ timeout: 15_000 })
  assert.ok((await panel.textContent()).includes('Link beta'), 'failed refresh retains the last useful catalog')
  await page.screenshot({ path: join(artifactDir, 'session-link-refresh-error.png') })
  await page.unroute('**/api/gcDuolink/view')
  await panel.getByRole('button', { name: 'Retry', exact: true }).click()
  await eventually(async () => await panel.getByRole('alert').count() === 0, 'retry restores the catalog')
  // An interrupted first read after reload restarts on remount instead of
  // sticking on loading.
  let activityReads = 0
  await page.route('**/api/gcDuolink/activityView', async route => {
    activityReads += 1
    await new Promise(resolve => setTimeout(resolve, 700))
    // The interrupted request is aborted by the client, so its route may
    // already be handled by the time the delay elapses.
    await route.continue().catch(() => {})
  })
  await page.reload({ waitUntil: 'load' })
  await selectSession('Link alpha')
  await page.locator('[data-gc-duolink-action]').click()
  await page.getByRole('dialog', { name: 'Quick link', exact: true }).getByRole('button', { name: 'Manage links', exact: true }).click()
  await panel.waitFor({ timeout: 15_000 })
  await eventually(async () => activityReads > 0, 'the first read is in flight')
  await selectSession('Link beta')
  await selectSession('Link alpha')
  await page.locator('[data-gc-duolink-action]').click()
  await page.getByRole('dialog', { name: 'Quick link', exact: true }).getByRole('button', { name: 'Manage links', exact: true }).click()
  await panel.waitFor({ timeout: 15_000 })
  await page.unroute('**/api/gcDuolink/activityView')
  await eventually(async () => (await mail.textContent()).includes('No messages'), 'an interrupted first read restarts on remount')
  assert.ok((await panel.textContent()).includes('Link beta'), 'link survives browser reload')
  await panel.getByRole('button', { name: 'Unlink', exact: true }).click()
  await panel.getByRole('button', { name: 'Confirm unlink', exact: true }).click()
  await eventually(async () => (await requireRpc('gcDuolink/view')).links.length === 0, 'UI revoke removes the durable group')
  await eventually(async () => await page.locator('[data-gc-duolink-row-action].gcdl-row-linked').count() === 0, 'revoke clears membership color without removing quick-link actions')
  const selfLink = await rpc('gcDuolink/linkFrom', { callerId: alphaId, peerId: alphaId, autoWake: false })
  assert.equal(selfLink.ok, false, 'the Host rejects a self link over the real wire')
}
