// Explicit configurations for disposable local verification targets.
export const verificationLocalTarget = (root = '/files', readOnly = false) => ({ name: 'Local', enabled: true, readOnly, connection: { type: 'local', root } })
export const verificationTargetId = bootstrap => {
  const target = bootstrap.targets.find(target => target.name === 'Local')
  if (!target) throw new Error('Configure the named Local verification target first')
  return target.id
}
