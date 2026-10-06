// Open dialogs, innermost last. Only the topmost one reacts to Escape and traps focus.
export const modalStack: HTMLElement[] = []
export const isModalOpen = () => modalStack.length > 0

/** True when a keyboard shortcut should be ignored because the user is typing or a dialog owns the keyboard. */
export function shortcutBlocked(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (isModalOpen() || document.querySelector('.menu')) return true
  return !!target?.closest('input, textarea, select, [contenteditable=true]')
}
