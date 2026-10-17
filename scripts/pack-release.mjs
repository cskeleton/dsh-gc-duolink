/** Pack verified build output without ever replacing a different same-version archive. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const root = process.cwd()
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/)
const temporary = mkdtempSync(join(tmpdir(), 'dsh-release-pack-'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
    { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }))[0]
  const archive = join(temporary, packed.filename)
  const files = {}
  for (const { path } of packed.files) {
    const source = resolve(root, path)
    assert.ok(source.startsWith(root + sep), `Package file escapes workspace: ${path}`)
    const bytes = execFileSync('tar', ['-xOf', archive, `package/${path}`], { maxBuffer: 16 * 1024 * 1024 })
    assert.deepEqual(bytes, readFileSync(source), `Packed file differs from workspace: ${path}`)
    files[path] = hash(bytes)
  }
  for (const entry of Object.values(manifest.exports ?? {})) {
    for (const target of typeof entry === 'string' ? [entry] : Object.values(entry)) {
      assert.ok(Object.hasOwn(files, target.replace(/^\.\//, '')), `Missing export: ${target}`)
    }
  }
  const directory = join(root, 'output', manifest.version)
  const destination = join(directory, packed.filename)
  const bytes = readFileSync(archive)
  const sha256 = hash(bytes)
  if (existsSync(destination)) {
    assert.ok(readFileSync(destination).equals(bytes),
      `Refusing to overwrite ${destination}: this version already has different contents. Bump package.json version before making another delivery.`)
    console.log(JSON.stringify({ archive: destination, sha256, reused: true }))
  } else {
    mkdirSync(directory, { recursive: true })
    // Exclusive creation also protects against two simultaneous packaging runs.
    writeFileSync(destination, bytes, { flag: 'wx' })
    writeFileSync(join(directory, 'SHA256SUMS'), `${sha256}  ${packed.filename}\n`, { flag: 'wx' })
    writeFileSync(join(directory, 'delivery-manifest.json'), JSON.stringify({
      packageName: manifest.name, packageVersion: manifest.version, createdAt: new Date().toISOString(),
      archive: packed.filename, sha256, bytes: bytes.length, fileCount: packed.files.length,
      published: false, installedToUserProfile: false,
      checks: { archiveWorkspaceByteMatch: 'PASS', allExportsPresent: 'PASS' }, files,
    }, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ archive: destination, sha256, fileCount: packed.files.length, reused: false }))
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
