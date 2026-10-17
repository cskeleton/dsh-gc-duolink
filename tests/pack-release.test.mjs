/** Reproduce the delivery mistake in a disposable package, never the user's workspace. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('release packaging permits identical retries and refuses changed same-version artifacts', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'dsh-pack-contract-'))
  try {
    mkdirSync(join(fixture, 'lib'))
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({
      name: 'dsh-pack-fixture', version: '1.0.0', files: ['lib'], exports: { '.': './lib/index.js' },
    }))
    writeFileSync(join(fixture, 'lib/index.js'), 'export const version = 1\n')
    const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/pack-release.mjs', import.meta.url))], {
      cwd: fixture, encoding: 'utf8', env: { ...process.env, npm_config_cache: join(fixture, 'npm-cache') },
    })
    const first = run()
    assert.equal(first.status, 0, first.stderr)
    const archive = join(fixture, 'output/1.0.0/dsh-pack-fixture-1.0.0.tgz')
    const original = readFileSync(archive)
    const retry = run()
    assert.equal(retry.status, 0, retry.stderr)
    assert.equal(JSON.parse(retry.stdout).reused, true)
    writeFileSync(join(fixture, 'lib/index.js'), 'export const version = 2\n')
    const changed = run()
    assert.notEqual(changed.status, 0)
    assert.match(changed.stderr, /Refusing to overwrite/)
    assert.deepEqual(readFileSync(archive), original)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
