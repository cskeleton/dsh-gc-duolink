/**
 * Round-2 review-defect grip tests (R##-prefixed). Each case pins one confirmed
 * review finding through the harness the reviewer normalized in
 * `artifacts/review/model-routing-probes.spec.ts`; R01 specifically proves the
 * PRODUCTION assembly (raw-loader sub-plugin + cordis inject, no test escape)
 * admits a tracked spawn.
 * @module
 */

import { expect, it } from 'vitest'
import { A, BASE, spawn, stack } from '../artifacts/review/model-routing-probes.spec.ts'
import { MockAdapter, textResponse } from './helpers/mock-adapter.ts'

it('R01: production assembly mounts the task service without test escape', async () => {
  const adapter = new MockAdapter([textResponse('ok')])
  const s = await stack(adapter, [BASE, A], /* realController= */ false, /* taskAssembly= */ 'mounted')
  const result = await spawn(s, 'r01', {})
  expect(result.outcome).toBe('admitted')
  // cordis injection alone (never a defineProperty escape) exposes the service.
  expect(s.ctx.sessionLinkTasks).toBeDefined()
})
