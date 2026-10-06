import { useMemo, useState } from 'react'
import { IconCornerDownLeft, IconSearch, type Icon } from '@tabler/icons-react'
import { Modal } from './Modal'

export interface Command { id: string; label: string; group: string; icon: Icon; shortcut?: string; keywords?: string; run: () => void }

function score(command: Command, query: string) {
  if (!query) return 1
  const haystack = `${command.label} ${command.group} ${command.keywords ?? ''}`.toLowerCase()
  if (haystack.startsWith(query)) return 3
  if (command.label.toLowerCase().split(/\s+/).some(word => word.startsWith(query))) return 2
  let index = 0
  for (const char of query) { index = haystack.indexOf(char, index); if (index < 0) return 0; index++ }
  return 1
}

/** Ctrl/⌘ K launcher for navigation and actions. Typing a path starting with "/" opens that folder. */
export function CommandPalette({ commands, onOpenPath, onClose }: { commands: Command[]; onOpenPath: (path: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const normalized = query.trim().toLowerCase()
  const results = useMemo(() => {
    const matched = commands.map(command => ({ command, rank: score(command, normalized) })).filter(item => item.rank > 0).sort((a, b) => b.rank - a.rank).map(item => item.command)
    if (normalized.startsWith('/')) matched.unshift({ id: 'path', label: `Open folder ${query.trim()}`, group: 'Go to', icon: IconCornerDownLeft, run: () => onOpenPath(query.trim()) })
    return matched
  }, [commands, normalized, query, onOpenPath])
  const index = Math.min(active, Math.max(0, results.length - 1))
  const run = (command: Command) => { onClose(); command.run() }
  return <Modal title="Command palette" size="md" className="palette" onClose={onClose}>
    <div className="palette-search">
      <IconSearch size={16} />
      <input data-autofocus className="palette-input" placeholder="Type a command, or a folder path like /Projects" value={query} aria-label="Command"
        aria-controls="palette-list" aria-activedescendant={results[index] ? 'cmd-' + results[index].id : undefined} role="combobox" aria-expanded="true"
        onChange={event => { setQuery(event.target.value); setActive(0) }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index + 1) % Math.max(1, results.length)) }
          if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index - 1 + results.length) % Math.max(1, results.length)) }
          if (event.key === 'Enter' && results[index]) { event.preventDefault(); run(results[index]) }
        }} />
    </div>
    <div className="palette-list" id="palette-list" role="listbox" aria-label="Commands">
      {!results.length && <p className="palette-empty">No matching commands</p>}
      {results.map((command, position) => {
        const header = !normalized && (position === 0 || results[position - 1].group !== command.group) ? command.group : null
        return <div key={command.id} role="presentation">
          {header && <div className="palette-group" role="presentation">{header}</div>}
          <div id={'cmd-' + command.id} role="option" aria-selected={position === index} className={`palette-item ${position === index ? 'is-active' : ''}`}
            onMouseMove={() => setActive(position)} onClick={() => run(command)}>
            <command.icon size={15} stroke={1.75} /><span>{command.label}</span>{command.shortcut && <kbd className="kbd">{command.shortcut}</kbd>}
          </div>
        </div>
      })}
    </div>
    <footer className="palette-foot"><span><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> navigate</span><span><kbd className="kbd">↵</kbd> run</span><span><kbd className="kbd">Esc</kbd> close</span></footer>
  </Modal>
}
