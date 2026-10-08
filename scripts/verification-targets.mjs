// Explicit configurations for disposable local verification targets.
export const verificationLocalTarget = (root = '/files', readOnly = false) => ({ name: 'Local', enabled: true, readOnly, connection: { type: 'local', root } })
export const verificationTargetId = bootstrap => {
  const target = bootstrap.targets.find(target => target.name === 'Local')
  if (!target) throw new Error('Configure the named Local verification target first')
  return target.id
}

export async function openTarget(page, name = 'Local', path = '/') {
  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'My files', exact: true }).click()
  await page.getByRole('list', { name: 'Storage targets', exact: true }).getByRole('button', { name, exact: true }).click()
  for (const folder of path.split('/').filter(Boolean)) await page.getByRole('button', { name: folder, exact: true }).click()
}
