/** Exercise the shipped UI and the Host's real locale preference in an isolated profile. */
import assert from 'node:assert/strict'
import { join } from 'node:path'

export async function verifyCompactUi({ page, requireRpc, eventually, alphaId, betaId, gammaId, artifactDir }) {
  const alphaRow = page.locator(`[data-row-key="session:${alphaId}"]`)
  await alphaRow.hover()
  await alphaRow.getByRole('button', { name: 'Session actions for Link alpha', exact: true }).click()
  const linkMenu = page.getByRole('menuitem', { name: 'Session links…', exact: true })
  await linkMenu.waitFor()
  assert.equal(await alphaRow.locator('[data-gc-duolink-row-action]').count(), 0, 'unlinked Session has a menu entry but no row action')
  assert.equal(await linkMenu.count(), 1)
  assert.equal(await page.locator('[data-duolink-copy-session-id]').count(), 0, 'DuoLink contributes no copy action')
  const nativeCopyCount = await page.getByRole('menuitem', { name: 'Copy Session ID', exact: true }).count()
  assert.ok(nativeCopyCount <= 1, 'the Host copy action has no duplicate')
  const menuStyle = element => {
    const style = getComputedStyle(element)
    return { fontSize: style.fontSize, lineHeight: style.lineHeight,
      paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, minHeight: style.minHeight }
  }
  const linkStyle = await linkMenu.evaluate(menuStyle)
  const nativeStyle = await page.getByRole('menuitem', { name: /^Rename/ }).evaluate(menuStyle)
  assert.deepEqual(linkStyle, nativeStyle, 'DuoLink uses the same typography and spacing as native menu rows')
  await page.screenshot({ path: join(artifactDir, 'ui-menu-en.png') })
  await linkMenu.click()
  assert.ok(await page.getByText('Link alpha.', { exact: true }).isVisible(), 'menu manages its row without switching the conversation')
  await requireRpc('session/rename', { sessionId: betaId, title: '调研：跨会话消息通信与运行状态可视化 / Research across agent sessions' })
  // The native title service may truncate user input; assert against its published value.
  const renamed = (await requireRpc('gcDuolink/view')).sessions.find(session => session.id === betaId)
  const longTitle = renamed.title
  assert.ok(longTitle.includes('Research'))
  const groups = await Promise.all([betaId, gammaId].map(peerId =>
    requireRpc('gcDuolink/linkFrom', { callerId: alphaId, peerId, autoWake: false })))
  await alphaRow.hover()
  await alphaRow.locator('[data-gc-duolink-row-action]').click()
  const panel = page.locator('[data-gc-duolink-panel]')
  const pair = panel.getByRole('region', { name: longTitle, exact: true })
  await pair.waitFor()
  assert.equal(await pair.getByText(longTitle, { exact: true }).count(), 1, 'peer title appears once per pair')
  assert.equal(await pair.locator('.gcdl-peer-main .gcdl-peer-title').count(), 0, 'status row contains no duplicate name')
  assert.equal(await pair.locator('header').getByRole('button', { name: 'Unlink', exact: true }).count(), 1)
  assert.equal(await pair.getByText('My messages → wake peer', { exact: true }).count(), 1, 'visible wake label has no duplicate title')
  const expandedHeight = (await pair.boundingBox()).height
  await pair.getByRole('button', { name: `Collapse "${longTitle}"`, exact: true }).click()
  assert.equal(await pair.getByRole('switch').count(), 0)
  const collapsedHeight = (await pair.boundingBox()).height
  assert.ok(collapsedHeight < expandedHeight / 2, 'collapse leaves a compact header')
  await pair.getByRole('button', { name: `Expand "${longTitle}"`, exact: true }).click()
  const contrast = await pair.evaluate(element => ({
    title: getComputedStyle(element.querySelector('.gcdl-group-title')).color,
    metadata: getComputedStyle(element.querySelector('.gcdl-peer-meta')).color,
    weight: Number(getComputedStyle(element.querySelector('.gcdl-group-title')).fontWeight),
  }))
  assert.notEqual(contrast.title, contrast.metadata)
  assert.ok(contrast.weight >= 600)
  await page.screenshot({ path: join(artifactDir, 'ui-compact-en.png') })

  await page.locator('[data-gc-duolink-action]').click()
  let quick = page.getByRole('dialog', { name: 'Quick link', exact: true })
  await quick.waitFor()
  const candidates = quick.locator('[data-gc-duolink-candidate]')
  assert.equal(await candidates.count(), 3)
  const catalog = await requireRpc('gcDuolink/view')
  const expected = catalog.sessions.filter(session => session.id !== alphaId && session.ordinary && !session.archived && !session.blank
    && !catalog.links.some(group => group.memberIds.includes(alphaId) && group.memberIds.includes(session.id)))
  assert.deepEqual(await candidates.evaluateAll(elements => elements.map(element => element.dataset.gcDuolinkCandidate)), expected.slice(0, 3).map(session => session.id))
  await quick.getByRole('button', { name: 'Show more (up to 8)', exact: true }).click()
  assert.equal(await candidates.count(), 8)
  const beyondEight = expected[8]
  assert.ok(beyondEight, 'fixture has a searchable candidate beyond the initial eight')
  await quick.getByRole('textbox').fill(beyondEight.id)
  assert.equal(await candidates.count(), 1)
  assert.equal(await candidates.first().getAttribute('data-gc-duolink-candidate'), beyondEight.id)
  await quick.getByRole('textbox').fill('')

  const setLanguage = async language => {
    const settings = await requireRpc('settings/describe')
    const locale = settings.namespaces.find(namespace => namespace.ns === 'locale')
    assert.ok(locale, 'DSH owns the shared locale preference')
    await requireRpc('settings/mutate', undefined, { args: { ns: 'locale',
      ops: [{ op: 'set', path: ['preference'], value: language }], expectedRevision: locale.revision } })
    await page.waitForFunction(language => document.documentElement.lang.startsWith(language), language)
  }
  await setLanguage('zh')
  quick = page.getByRole('dialog', { name: '快速互联', exact: true })
  await quick.waitFor()
  assert.equal(await quick.getByRole('button', { name: '展示更多（最多 8 个）', exact: true }).count(), 1)
  await page.setViewportSize({ width: 820, height: 1000 })
  const open = quick.locator('.gcdl-quick-peers').getByRole('button', { name: '打开会话', exact: true }).first()
  const actionStyle = await open.evaluate(element => {
    const style = getComputedStyle(element)
    return { whiteSpace: style.whiteSpace, flexShrink: style.flexShrink,
      height: element.getBoundingClientRect().height, lineHeight: Number.parseFloat(style.lineHeight),
      padding: Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom) }
  })
  assert.equal(actionStyle.whiteSpace, 'nowrap')
  assert.equal(actionStyle.flexShrink, '0')
  assert.ok(actionStyle.height <= actionStyle.lineHeight + actionStyle.padding + 1, '打开会话 stays on one line')
  await page.screenshot({ path: join(artifactDir, 'ui-quick-zh-narrow.png') })
  await quick.getByRole('button', { name: '关闭快速互联', exact: true }).click()
  assert.equal(await panel.getByRole('button', { name: '打开受管会话', exact: true }).count(), 1)
  await page.screenshot({ path: join(artifactDir, 'ui-compact-zh.png') })
  // Narrow layouts hide the Session tree behind the sidebar rail; inspect its row menu at full width.
  await page.setViewportSize({ width: 1440, height: 1000 })
  await alphaRow.hover()
  await alphaRow.getByRole('button', { name: '会话“Link alpha”的操作', exact: true }).click()
  const zhMenu = page.getByRole('menuitem', { name: '会话互联…', exact: true })
  await zhMenu.waitFor()
  assert.deepEqual(await zhMenu.evaluate(menuStyle), await page.getByRole('menuitem', { name: /^重命名/ }).evaluate(menuStyle))
  await page.screenshot({ path: join(artifactDir, 'ui-menu-zh.png') })
  await zhMenu.click()
  await page.setViewportSize({ width: 820, height: 1000 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await eventually(async () => await page.locator('body').getAttribute('data-ds-dark-theme') !== null, 'Host dark theme')
  await page.screenshot({ path: join(artifactDir, 'ui-compact-zh-dark.png') })
  await setLanguage('en')
  assert.equal(await panel.getByRole('button', { name: 'Open managed session', exact: true }).count(), 1, 'mounted panel follows language without reload')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 1440, height: 1000 })
  for (const group of groups) await requireRpc('gcDuolink/unlinkFrom', { callerId: alphaId, linkId: group.linkId })
  await eventually(async () => await alphaRow.locator('[data-gc-duolink-row-action]').count() === 0, 'last unlink removes the row action')
  await alphaRow.hover()
  await alphaRow.getByRole('button', { name: 'Session actions for Link alpha', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Session links…', exact: true }).waitFor()
  await page.screenshot({ path: join(artifactDir, 'ui-row-unlinked.png') })
  await page.getByRole('menuitem', { name: 'Session links…', exact: true }).click()
  await requireRpc('session/rename', { sessionId: betaId, title: 'Link beta' })
  return { status: 'PASS', rowActionOnlyWhenLinked: true, nativeMenuStyle: linkStyle, nativeMenuStyleMatches: true,
    pluginCopyRemoved: true, nativeCopyCount, localeFollowsHostWithoutReload: true, recentCandidates: [3, 8], searchBeyondEight: true,
    openActionSingleLine: true, headerUnlink: true, collapsibleGroups: true, duplicatePairTitleRemoved: true,
    groupHeight: { expanded: expandedHeight, collapsed: collapsedHeight }, lightAndDarkScreenshots: true }
}
