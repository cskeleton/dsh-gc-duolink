/** Observe a new Workspace arrive through the shipped GUI's live subscription. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

export async function openWorkspaceBrowser(authUrl, gate, artifactDir) {
  const browser = await chromium.launch(process.env.BROWSER_EXECUTABLE_PATH === undefined
    ? {} : { executablePath: process.env.BROWSER_EXECUTABLE_PATH })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, locale: 'en-US' })
    const failures = []
    page.on('pageerror', error => { failures.push(error.message) })
    await page.goto(authUrl)
    const continuation = page.getByRole('button', { name: /^(Continue|继续)$/ })
    if (await continuation.isVisible()) await continuation.click()
    await page.locator('[data-row-key^="workspace:"]').first().waitFor({ timeout: 30_000 })
    // The welcome dialog mounts asynchronously after the first shell paint.
    if (await continuation.isVisible()) await continuation.click()
    const selected = page.locator('[data-row-key^="session:"][aria-selected="true"]')
    await selected.first().waitFor({ timeout: 15_000 })
    const originalSelection = await selected.first().getAttribute('data-row-key')
    assert.equal(await page.getByRole('treeitem').filter({ hasText: 'desktop-unopened' }).count(), 0,
      'unregistered target does not exist in the initial browser tree')
    await writeFile(gate, 'browser subscribed\n')
    return {
      close: () => browser.close(),
      async verify(placement) {
        await mkdir(artifactDir, { recursive: true })
        await page.screenshot({ path: join(artifactDir, 'workspace-before-interaction.png') })
        if (await continuation.isVisible()) await continuation.click()
        assert.equal(await selected.first().getAttribute('data-row-key'), originalSelection,
          'Workspace registration never switches the current conversation')
        const group = page.locator(`[data-row-key="workspace:${placement.liveWorkspaceId}"]`)
        await group.waitFor({ timeout: 20_000 })
        assert.ok((await group.textContent()).includes(placement.liveWorkspaceTitle))
        if (await group.getAttribute('aria-expanded') === 'false') await group.click()
        const session = page.locator(`[data-row-key="session:${placement.liveSessionId}"]`)
        await session.waitFor({ timeout: 15_000 })
        assert.ok((await session.textContent()).includes('placement-unopened'))
        await session.click()
        await page.waitForFunction(id => document.querySelector(`[data-row-key="session:${id}"]`)
          ?.getAttribute('aria-selected') === 'true', placement.liveSessionId, { timeout: 15_000 })
        await page.getByText('reply BASE', { exact: true }).last().waitFor({ timeout: 15_000 })
        const screenshot = join(artifactDir, 'workspace-live-created.png')
        await page.screenshot({ path: screenshot })
        await page.reload()
        await group.waitFor({ timeout: 15_000 })
        if (await group.getAttribute('aria-expanded') === 'false') await group.click()
        await session.waitFor({ timeout: 15_000 })
        assert.deepEqual(failures, [], 'no unhandled browser errors')
        return { status: 'PASS', workspaceAppearedWithoutReload: true, currentConversationPreserved: true, spawnedSessionVisible: true,
          spawnedConversationOpened: true, persistedAfterReload: true, browserErrors: failures, screenshot }
      },
    }
  } catch (error) {
    await browser.close()
    throw error
  }
}
