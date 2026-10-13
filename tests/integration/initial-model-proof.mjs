/** Prove initial model persistence on a shipped, isolated Host without installing this plugin. */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, copyFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const project = fileURLToPath(new URL('../..', import.meta.url))
const fixture = join(project, 'tests/integration/initial-model-fixture.mjs')
const packedPlugin = process.env.INITIAL_MODEL_PROOF_PLUGIN === '1'
const resultFile = join(project, packedPlugin ? 'output/initial-model-installed-result.json' : 'output/initial-model-proof-result.json')
const phases = (process.env.INITIAL_MODEL_PROOF_PHASES ?? (packedPlugin ? 'seed,execute,replay-human,resume,human-resume' : 'seed,execute,resume,human-resume')).split(',')
const timeoutMs = Number(process.env.INITIAL_MODEL_PROOF_TIMEOUT_MS ?? 60_000)
const reports = []
const configurationIntegrity = []
let temp
let child
let installation
let currentPhase
let phaseOutput = ''

function sanitized(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, '').replace(/https?:\/\/[^\s)]+/g, '[URL]')
}

async function installedBinary() {
  const requested = process.env.DSH_BIN ?? 'dsh'
  const candidates = isAbsolute(requested) || requested.includes('/')
    ? [resolve(requested)]
    : (process.env.PATH ?? '').split(delimiter).map(path => join(path, requested))
  let launcher
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); launcher = await realpath(candidate); break }
    catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error }
  }
  assert.ok(launcher, `Cannot resolve executable ${requested}`)
  let directory = dirname(launcher)
  while (true) {
    const manifest = join(directory, 'package.json')
    try {
      const pkg = JSON.parse(await readFile(manifest, 'utf8'))
      if (pkg.name === '@deepseek-ai/dsh') {
        assert.ok(launcher.includes(`${delimiter === ':' ? '/' : '\\'}node_modules${delimiter === ':' ? '/' : '\\'}`), 'Proof requires an installed official dsh package, not a source checkout')
        return { binary: launcher, packageJson: manifest, packageName: pkg.name, packageVersion: pkg.version }
      }
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error }
    const parent = dirname(directory)
    assert.notEqual(parent, directory, `Resolved executable is not the official @deepseek-ai/dsh launcher: ${launcher}`)
    directory = parent
  }
}

async function collectInstalledPackages() {
  const require = createRequire(installation.packageJson)
  const packages = {}
  for (const name of [
    '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-session-persistence', '@deepseek-ai/dsh-session-persistence-jsonl',
    '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-agent-preset', '@deepseek-ai/dsh-agent-preset-registry',
  ]) {
    const packageJson = await realpath(require.resolve(`${name}/package.json`))
    const manifest = JSON.parse(await readFile(packageJson, 'utf8'))
    assert.equal(manifest.name, name)
    packages[name] = { version: manifest.version, packageJson, entrypoint: await realpath(require.resolve(name)) }
  }
  // Import ESM asynchronously; require(ESM) can race Node's module linking jobs.
  const controller = await import(pathToFileURL(packages['@deepseek-ai/dsh-api-session-controller'].entrypoint).href)
  const controllerPublicExports = Object.keys(controller).sort()
  assert.equal(Object.hasOwn(controller, 'createTaskHost'), false, 'The shipped controller does not export createTaskHost')
  return { packages, controllerPublicExports, createTaskHostExported: false }
}

async function configContent(path) {
  try { return await readFile(path) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

function sameContent(before, after) {
  return before === null ? after === null : after !== null && before.equals(after)
}

function contentHash(content) {
  return content === null ? null : createHash('sha256').update(content).digest('hex')
}

async function stopChild() {
  const running = child
  child = undefined
  if (running === undefined || running.pid === undefined || running.exitCode !== null || running.signalCode !== null) return
  const exited = new Promise(resolve => running.once('exit', resolve))
  running.kill('SIGTERM')
  let timer
  await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 5000) })])
  clearTimeout(timer)
  if (running.exitCode === null && running.signalCode === null) {
    running.kill('SIGKILL')
    await exited
  }
}

async function runPhase(phase, env, overlay, workspace, configuration) {
  currentPhase = phase
  phaseOutput = ''
  const reportPath = join(temp, `${phase}.json`)
  const result = await new Promise((resolveResult, reject) => {
    let stdout = ''
    let settled = false
    const timer = setTimeout(() => finish(new Error(`Phase ${phase} timed out after ${timeoutMs} ms`)), timeoutMs)
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolveResult(value)
    }
    child = spawn(installation.binary, ['--profile', 'initial-model-proof', '--patch', overlay, '--no-open', '--port', '0'], {
      cwd: workspace,
      env: { ...env, INITIAL_MODEL_PROOF_PHASE: phase, INITIAL_MODEL_PROOF_REPORT: reportPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.on('error', error => finish(error))
    child.on('exit', (code, signal) => finish(new Error(`Phase ${phase} exited before its report (code=${code}, signal=${signal})`)))
    child.stderr.on('data', chunk => {
      phaseOutput = (phaseOutput + chunk.toString()).slice(-32_768)
      const failure = /initial-model-proof-fixture[^\n]*(?:failed to import|pending \(waiting for)[^\n]*/.exec(phaseOutput)
      if (failure) finish(new Error(`Phase ${phase} fixture did not activate: ${sanitized(failure[0])}`))
    })
    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
      phaseOutput = (phaseOutput + chunk.toString()).slice(-32_768)
      let newline
      while ((newline = stdout.indexOf('\n')) !== -1) {
        const line = stdout.slice(0, newline).trim()
        stdout = stdout.slice(newline + 1)
        if (!line.startsWith('INITIAL_MODEL_PROOF_RESULT=')) continue
        try { finish(undefined, JSON.parse(line.slice('INITIAL_MODEL_PROOF_RESULT='.length))) }
        catch (error) { finish(new Error(`Phase ${phase} emitted invalid report JSON`, { cause: error })) }
      }
    })
  })
  // Let queued Host configuration writes settle before shutdown and inspect the durable bytes afterward.
  await new Promise(resolve => setTimeout(resolve, 300))
  await stopChild()
  const persisted = JSON.parse(await readFile(reportPath, 'utf8'))
  assert.equal(persisted.phase, result.phase, `Phase ${phase} stdout and persisted phase differ`)
  assert.equal(persisted.status, result.status, `Phase ${phase} stdout and persisted status differ`)
  reports.push(persisted)
  assert.equal(persisted.phase, phase, 'Fixture reports the requested phase')
  assert.equal(persisted.status, 'PASS', `Phase ${phase}: ${persisted.error ?? JSON.stringify(persisted.checks)}`)
  assert.equal(persisted.paidModelCalls, 0, `Phase ${phase} made a paid model call`)
  assert.ok(Number.isInteger(persisted.mockModelCalls) && persisted.mockModelCalls >= 0, 'Fixture reports a mock call count')
  if (phase === 'seed' || phase === 'execute') {
    const profilePatch = await configContent(configuration.profilePatchPath)
    const overlayAfter = await configContent(overlay)
    const integrity = {
      phase,
      profilePatchUnchanged: sameContent(configuration.profilePatch, profilePatch),
      overlayUnchanged: sameContent(configuration.overlay, overlayAfter),
      profilePatchSha256Before: contentHash(configuration.profilePatch),
      profilePatchSha256After: contentHash(profilePatch),
      overlaySha256Before: contentHash(configuration.overlay),
      overlaySha256After: contentHash(overlayAfter),
    }
    configurationIntegrity.push(integrity)
    assert.equal(integrity.profilePatchUnchanged, true, `Phase ${phase} changed profile cordis.patch.yml`)
    assert.equal(integrity.overlayUnchanged, true, `Phase ${phase} changed the proof overlay`)
  }
}

let summary
try {
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, 'INITIAL_MODEL_PROOF_TIMEOUT_MS must be positive')
  assert.ok(phases.length >= 3 && phases.slice(0, 2).join(',') === 'seed,execute' && phases.includes('resume'), 'Proof phases require seed,execute followed by native resume')
  assert.ok(phases.every(phase => /^[a-z-]+$/.test(phase)), 'Phase names must contain lowercase letters and hyphens')
  await access(fixture)
  installation = await installedBinary()
  Object.assign(installation, await collectInstalledPackages())
  temp = await mkdtemp(join(tmpdir(), 'dsh-initial-model-proof-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  await mkdir(workspace, { recursive: true })
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    INITIAL_MODEL_PROOF_WORKSPACE: workspace,
    INITIAL_MODEL_PROOF_INSTALLATION_PACKAGE: installation.packageJson,
    INITIAL_MODEL_PROOF_PLUGIN: packedPlugin ? '1' : '0',
  }
  // Never let the project's development aliases or a source tree select Host packages.
  delete env.DSH_SOURCE_ROOT
  delete env.NODE_PATH
  delete env.NODE_OPTIONS
  const { stdout: version } = await runFile(installation.binary, ['--version'], { cwd: workspace, env, timeout: 30_000 })
  installation.cliVersion = version.trim()
  assert.equal(installation.cliVersion, installation.packageVersion)
  await runFile(installation.binary, ['--profile', 'initial-model-proof', '--from-default-profile', 'web', '--dump-config'], {
    cwd: workspace, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  })
  if (packedPlugin) {
    const { stdout } = await runFile('npm', ['pack', '--json', '--pack-destination', temp], { cwd: project, env, timeout: 60_000 })
    const tarball = join(temp, JSON.parse(stdout)[0].filename)
    await runFile(installation.binary, ['plugin', '--profile', 'initial-model-proof', 'add', '--ignore-scripts', '--config.auto-install-peers=false', tarball], { cwd: workspace, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  }
  const manifest = JSON.parse(await readFile(join(home, 'profiles/initial-model-proof/package.json'), 'utf8'))
  assert.equal(Boolean(manifest.dependencies?.['dsh-session-link']), packedPlugin)
  const overlay = join(temp, 'initial-model-proof.patch.yml')
  const isolatedFixture = join(temp, 'initial-model-fixture.mjs')
  await copyFile(fixture, isolatedFixture)
  const diagnosticsFixture = join(temp, 'proof-diagnostics.mjs')
  await writeFile(diagnosticsFixture, `export const inject = ['appReady']; export function apply(ctx) {
    ctx.effect(() => ctx.appReady.onReady(() => {
      for (const m of ctx.logger.buffer) if (m.type === 'error') process.stderr.write('PROOF_LOADER_ERROR=' + JSON.stringify(m) + '\\n');
    }));
  }\n`)
  await writeFile(overlay, [
    ...['hmr', 'client-hmr', 'session-telemetry-otel', 'desktop-product-telemetry', 'product-analytics', 'session-title-llm', 'agent-instructions', 'llm-pi-ai', 'llm-deepseek', 'llm-deepseek-account'].flatMap(id => [`- id: ${id}`, '  disabled: true']),
    '- id: session-log-deepseek', '  config:', '    enabled: false',
    '- id: agent-default-model', '  config:', '    provider: initial-proof', '    model: BASE', '    reasoningEffort: low',
    '- id: system-prompt', '  config:', "    personaPrefix: 'proof provider={{provider}} model={{model}}'",
    '- id: ui-settings-models', '  config:', '    credentialOnboarding: false',
    '- id: ui-plugin-manager', '  config:', '    registryProbeEnabled: false',
    '- id: workspace-controller', '  config:', `    documentsDirectory: ${JSON.stringify(join(temp, 'Documents'))}`,
    '- insert:', '    - id: proof-diagnostics', `      name: ${JSON.stringify(diagnosticsFixture)}`,
    '    - id: initial-model-proof-fixture', `      name: ${JSON.stringify(isolatedFixture)}`, '',
  ].join('\n'))
  const profilePatchPath = join(home, 'profiles/initial-model-proof/cordis.patch.yml')
  const configuration = {
    profilePatchPath,
    profilePatch: await configContent(profilePatchPath),
    overlay: await configContent(overlay),
  }
  for (const phase of phases) {
    if (packedPlugin && phase === 'resume') {
      await runFile(installation.binary, ['plugin', '--profile', 'initial-model-proof', 'remove', 'dsh-session-link'], { cwd: workspace, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
    }
    await runPhase(phase, env, overlay, workspace, configuration)
  }
  const mockModelCalls = reports.reduce((count, report) => count + report.mockModelCalls, 0)
  assert.ok(mockModelCalls > 0, 'Proof must exercise real Agent requests through the mock model provider')
  summary = { status: 'PASS', installation, pluginInstalled: packedPlugin, pluginRemovedBeforeResume: packedPlugin, sourceCheckoutUsed: false, paidModelCalls: 0, mockModelCalls, configurationIntegrity, phases: reports }
} catch (error) {
  summary = { status: 'FAIL', installation, phase: currentPhase, configurationIntegrity, phases: reports, error: sanitized(error.stack ?? error), diagnostics: sanitized(phaseOutput) }
  process.exitCode = 1
} finally {
  await stopChild()
  if (temp) await rm(temp, { recursive: true, force: true })
}
await mkdir(dirname(resultFile), { recursive: true })
await writeFile(resultFile, `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify({ status: summary.status, resultFile, ...summary.status === 'FAIL' ? { error: summary.error } : { paidModelCalls: summary.paidModelCalls, mockModelCalls: summary.mockModelCalls } }))
