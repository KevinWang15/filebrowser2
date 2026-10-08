export const localTarget = (root, readOnly = false) => ({ name: 'Fixture', enabled: true, readOnly, connection: { type: 'local', root } })
export async function firstTarget(request) {
  const response = await request('/targets')
  if (!response.ok) throw new Error('Cannot load fixture targets: ' + await response.text())
  return (await response.json())[0].id
}
