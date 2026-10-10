/** Remove only this package's generated output before emitting a fresh artifact. */
import { lstat, rm } from 'node:fs/promises'
const output = new URL('../lib/', import.meta.url)
try {
  const stat = await lstat(output)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('lib must be a real generated directory')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
await rm(output, { recursive: true, force: true })
