/** Published-artifact checks for service-derived RPC and the browser module table. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import SessionLinkService, { sessionLinkDomainSpec } from '../lib/index.js'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

test('built SRC methods retain the named wire fields and cancellation position', async () => {
  const ctx = new Context()
  try {
    const service = new SessionLinkService(ctx)
    const expected = { view: ['signal'],
      linkFrom: ['request'], unlinkFrom: ['request'], setAutoWakeFrom: ['request'],
      activityView: ['request'], cancelMessageFrom: ['request'], extendChainWakeFrom: ['request'] }
    assert.equal(service.typertRemote.namespace, 'gcDuolink')
    assert.deepEqual(remoteMethods(service).map(marker => marker.exportName ?? marker.method).sort(), Object.keys(expected).sort())
    for (const [method, names] of Object.entries(expected)) {
      const source = service[method].toString()
      const actual = source.match(/^[^(]*\(([^)]*)\)/)?.[1].split(',').map(name => name.trim()).filter(Boolean)
      assert.deepEqual(actual, names, `${method} named arguments changed`)
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

test('browser factory only requests seeded React and Host UI modules', () => {
  const source = readFileSync(new URL('lib/client.js', root), 'utf8')
  let registration
  new Function('window', source)({ __ModuleLoader__: { load(value) { registration = value } } })
  assert.equal(registration?.id, manifest.name)
  const requested = []
  const require = createRequire(import.meta.url)
  const client = registration.factory(specifier => {
    requested.push(specifier)
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { MenuItemButton() {} }
    assert.match(specifier, /^react(?:-dom)?(?:\/|$)/)
    return require(specifier)
  })
  assert.equal(typeof client.apply, 'function')
  assert.ok(client.inject.includes('connection'))
  assert.ok(client.inject.includes('slots'))
  assert.ok(requested.includes('react'))
  assert.ok(requested.includes('@deepseek-ai/dsh-client-ui-primitives'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-renderer'))
  assert.ok(!source.includes('data-duolink-copy-session-id'))
  assert.ok(!source.includes('row.copy.id'))
  assert.ok(!source.includes('session-link/changed'))
})

test('host imports are declared peers and every bundle row is exported', () => {
  assert.equal(manifest.dsh.bundle.patch, './gc-duolink.patch.yml')
  assert.equal(sessionLinkDomainSpec.name, 'gc_duolink')
  assert.equal(sessionLinkDomainSpec.global.schema.safeParse({ initialized: true }).success, false)
  assert.equal(sessionLinkDomainSpec.global.schema.safeParse({ product: 'dsh-gc-duolink', initialized: true }).success, true)
  for (const peer of ['@deepseek-ai/dsh-agent-preset-registry', '@deepseek-ai/dsh-session-persistence']) {
    assert.equal(manifest.peerDependenciesMeta?.[peer]?.optional, true, `${peer} must be optional for ordinary spawn`)
  }
  for (const file of ['index.js', 'tools.js', 'command.js']) {
    const source = readFileSync(new URL(`lib/${file}`, root), 'utf8')
    for (const match of source.matchAll(/from ["'](@deepseek-ai\/[^"']+)["']/g)) {
      const name = match[1].split('/').slice(0, 2).join('/')
      assert.ok(manifest.peerDependencies[name], `${file} undeclared peer ${name}`)
      assert.notEqual(name, '@deepseek-ai/dsh-session-link')
    }
  }
  const patch = readFileSync(new URL(manifest.dsh.bundle.patch, root), 'utf8')
  const rows = [...patch.matchAll(/name:\s*([^\s]+)/g)].map(match => match[1])
  assert.deepEqual([...patch.matchAll(/id:\s*([^\s]+)/g)].map(match => match[1]),
    ['gc-duolink', 'tool-gc-duolink', 'command-gc-duolink'])
  assert.deepEqual(rows, [manifest.name, `${manifest.name}/tools`, `${manifest.name}/command`])
  for (const name of rows) {
    const key = name === manifest.name ? '.' : `.${name.slice(manifest.name.length)}`
    const entry = manifest.exports[key]
    assert.ok(entry, `bundle export ${key} missing`)
    assert.ok(existsSync(new URL(typeof entry === 'string' ? entry : entry.default, root)))
  }
  assert.ok(!patch.includes('probe'))
})
