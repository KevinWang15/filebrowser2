// Open dialogs, innermost last. Only the topmost one reacts to Escape and traps focus.
export const modalStack: HTMLElement[] = []
interface FocusTarget { element: HTMLElement | null; parent: HTMLElement | null }
const focusTargets = new Map<HTMLElement, FocusTarget>()
const originalState = new Map<HTMLElement, { inert: boolean; hidden: string | null }>()

function updateBackground() {
  const active = modalStack.at(-1)
  if (active) {
    for (const element of document.body.children) {
      if (!(element instanceof HTMLElement) || element.hasAttribute('data-overlay')) continue
      if (!originalState.has(element)) originalState.set(element, { inert: element.inert, hidden: element.getAttribute('aria-hidden') })
      element.inert = element !== active
      if (element === active) element.removeAttribute('aria-hidden')
      else element.setAttribute('aria-hidden', 'true')
    }
  } else {
    for (const [element, state] of originalState) {
      element.inert = state.inert
      if (state.hidden === null) element.removeAttribute('aria-hidden')
      else element.setAttribute('aria-hidden', state.hidden)
    }
    originalState.clear()
  }
}

export function registerModal(root: HTMLElement) {
  focusTargets.set(root, { element: document.activeElement instanceof HTMLElement ? document.activeElement : null, parent: modalStack.at(-1) ?? null })
  modalStack.push(root); updateBackground()
}

export function unregisterModal(root: HTMLElement) {
  const index = modalStack.indexOf(root), wasActive = index === modalStack.length - 1
  const previous = focusTargets.get(root) ?? { element: null, parent: null }
  // A dialog replaced underneath another dialog must pass on its original focus target.
  for (const [modal, target] of focusTargets) if (target.parent === root) focusTargets.set(modal, previous)
  focusTargets.delete(root)
  if (index >= 0) modalStack.splice(index, 1)
  updateBackground()
  if (wasActive && previous.element?.isConnected) previous.element.focus()
}

/** True when a keyboard shortcut should be ignored because the user is typing or a dialog owns the keyboard. */
export function shortcutBlocked(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (modalStack.length > 0 || document.querySelector('.menu')) return true
  return !!target?.closest('input, textarea, select, [contenteditable=true]')
}
