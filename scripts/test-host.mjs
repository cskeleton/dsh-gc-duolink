/** Run the imported host regression suites against an explicit DSH source checkout. */
import { spawnSync } from 'node:child_process'
if (!process.env.DSH_SOURCE_ROOT) throw new Error('Host regression tests require DSH_SOURCE_ROOT pointing to a DeepSeek Harness checkout')
const result = spawnSync('pnpm', ['exec', 'vitest', 'run',
  'tests/link.spec.ts', 'tests/remote.spec.ts',
  'tests/tool-session-link.spec.ts', 'tests/command-session-link.spec.ts',
  'tests/review-m1-backend.spec.ts',
  'tests/workspace-spawn.spec.ts',
], { stdio: 'inherit', env: process.env })
if (result.error) throw result.error
if (result.signal) throw new Error(`Host tests terminated by ${result.signal}`)
process.exit(result.status ?? 1)
