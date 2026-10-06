import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import type { AuditEntry, Permissions, UploadManifest, UploadSession, User } from '@/shared/types'

export interface UserRow {
  id: string; username: string; role: 'admin' | 'user'; scope: string
  permissions: string; disabled: number; password_hash: string; created_at: string
}
export interface UploadRow {
  id: string; user_id: string; path: string; manifest: string; manifest_hash: string
  next_chunk: number; committed_bytes: number; status: UploadSession['status']
  inode: string; created_at: string; updated_at: string; error: string | null
}

export function publicUser(row: UserRow): User {
  return { id: row.id, username: row.username, role: row.role, scope: row.scope,
    permissions: JSON.parse(row.permissions) as Permissions, disabled: !!row.disabled, createdAt: row.created_at }
}

export function publicUpload(row: UploadRow, parsedManifest?: UploadManifest): UploadSession {
  const manifest = parsedManifest ?? JSON.parse(row.manifest) as UploadManifest
  return { id: row.id, name: manifest.name, directory: manifest.directory, size: manifest.size,
    chunkSize: manifest.chunkSize, totalChunks: manifest.hashes.length, nextChunk: row.next_chunk,
    committedBytes: row.committed_bytes, manifestHash: row.manifest_hash, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at, error: row.error }
}

export class Store {
  readonly db: DatabaseSync
  private readonly instanceLock: DatabaseSync
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    // A kernel-managed SQLite exclusive lock is released even on SIGKILL. An
    // in-memory mutex alone cannot protect chunk writes from a second process.
    this.instanceLock = new DatabaseSync(join(directory, 'instance.sqlite'))
    chmodSync(join(directory, 'instance.sqlite'), 0o600)
    try { this.instanceLock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;') }
    catch (error) { this.instanceLock.close(); throw new Error('Another Filebrowser process owns this state directory', { cause: error }) }
    this.db = new DatabaseSync(join(directory, 'filebrowser.sqlite'))
    chmodSync(join(directory, 'filebrowser.sqlite'), 0o600)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE NOT NULL,
        password_hash TEXT NOT NULL, role TEXT NOT NULL, scope TEXT NOT NULL,
        permissions TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), path TEXT NOT NULL,
        manifest TEXT NOT NULL, manifest_hash TEXT NOT NULL, next_chunk INTEGER NOT NULL DEFAULT 0,
        committed_bytes INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
        inode TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS upload_target ON uploads(path)
        WHERE status IN ('uploading', 'publishing');
      CREATE INDEX IF NOT EXISTS uploads_user ON uploads(user_id);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
        detail TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `)
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now())
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  setting(key: string, fallback = ''): string {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? fallback
  }
  setSetting(key: string, value: string) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
  }
  user(id: string) { return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined }
  username(name: string) { return this.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(name) as unknown as UserRow | undefined }
  users() { return this.db.prepare('SELECT * FROM users ORDER BY created_at, username').all() as unknown as UserRow[] }
  upload(id: string) { return this.db.prepare('SELECT * FROM uploads WHERE id = ?').get(id) as unknown as UploadRow | undefined }
  private metadataFields = "id,user_id,path,manifest_hash,next_chunk,committed_bytes,status,inode,created_at,updated_at,error,'' AS manifest"
  uploadMetadata(id: string) { return this.db.prepare(`SELECT ${this.metadataFields} FROM uploads WHERE id = ?`).get(id) as unknown as UploadRow | undefined }
  activeUploads() { return this.db.prepare(`SELECT ${this.metadataFields} FROM uploads WHERE status IN ('uploading','publishing')`).all() as unknown as UploadRow[] }
  retainedUploads() { return this.db.prepare(`SELECT ${this.metadataFields} FROM uploads WHERE status IN ('uploading','publishing','canceling','failed') ORDER BY status='failed'`).all() as unknown as UploadRow[] }
  uploadIds() { return new Set((this.db.prepare('SELECT id FROM uploads').all() as { id: string }[]).map(row => row.id)) }
  userUploads(id: string) { return this.db.prepare(`SELECT ${this.metadataFields} FROM uploads WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`).all(id) as unknown as UploadRow[] }
  audit(actor: string, action: string, detail: string) {
    this.db.prepare('INSERT INTO audit(actor,action,detail,created_at) VALUES(?,?,?,?)').run(actor, action, detail, new Date().toISOString())
  }
  audits(): AuditEntry[] {
    return this.db.prepare('SELECT id,actor,action,detail,created_at AS createdAt FROM audit ORDER BY id DESC LIMIT 100').all() as unknown as AuditEntry[]
  }
  close() { this.db.close(); this.instanceLock.close() }
}
