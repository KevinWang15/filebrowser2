import type { Transfer, TransferState } from '../upload-engine'

export const STATE_LABELS: Record<TransferState, string> = {
  queued: 'In queue', hashing: 'Checking your file', uploading: 'Uploading', verifying: 'Verifying & saving', retrying: 'Reconnecting',
  paused: 'Paused', 'needs-file': 'Ready to resume', completed: 'Complete', failed: 'Needs attention',
}
const RUNNING: TransferState[] = ['queued', 'hashing', 'uploading', 'verifying', 'retrying']
export const isRunning = (task: Transfer) => RUNNING.includes(task.state)
export const transferProgress = (task: Transfer) => task.state === 'completed' ? 1
  : task.state === 'hashing' ? (task.size ? task.hashedBytes / task.size : 1)
    : task.size ? (task.committedBytes + task.sentBytes) / task.size : 0
