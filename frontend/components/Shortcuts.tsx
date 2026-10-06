import { IconKeyboard } from '@tabler/icons-react'
import { Modal } from './Modal'

const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
const GROUPS: [string, [string[], string][]][] = [
  ['General', [[[mod, 'K'], 'Command palette'], [['?'], 'Keyboard shortcuts'], [['/'], 'Filter current list'], [['G', 'F'], 'Go to files'], [['G', 'T'], 'Go to transfers']]],
  ['Files', [[['↑', '↓'], 'Move cursor'], [['Shift', '↑'], 'Extend selection'], [['Space'], 'Toggle selection'], [[mod, 'A'], 'Select all'], [['↵'], 'Open'],
    [['Backspace'], 'Parent folder'], [['F2'], 'Rename'], [['Del'], 'Delete'], [['N'], 'New folder'], [['U'], 'Upload'], [['I'], 'Toggle details'], [['R'], 'Refresh']]],
  ['Viewer', [[['←', '→'], 'Previous / next file'], [['Esc'], 'Close']]],
]

export function Shortcuts({ onClose }: { onClose: () => void }) {
  return <Modal title="Keyboard shortcuts" icon={<IconKeyboard size={17} />} size="md" onClose={onClose}>
    <div className="modal-body shortcuts">
      {GROUPS.map(([group, items]) => <section key={group}><h4>{group}</h4><dl>
        {items.map(([keys, label]) => <div key={label}><dt>{label}</dt><dd>{keys.map(key => <kbd key={key} className="kbd">{key}</kbd>)}</dd></div>)}
      </dl></section>)}
    </div>
  </Modal>
}
