import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import type { AuditEntry, Permissions, UploadManifest, UploadSession, User, TargetGrant, TargetConnection } from '@/shared/types'

export interface UserRow {
  id: string; username: string; role: 'admin' | 'user'; disabled: number; password_hash: string; created_at: string
}
export interface TargetRow {
  id: string; name: string; type: TargetConnection['type']; connection: string;
  enabled: number; read_only: number; created_at: string
}
export interface UploadRow {
  id: string; user_id: string; target_id: string; path: string; manifest: string; manifest_hash: string
  next_chunk: number; committed_bytes: number; status: UploadSession['status']
  storage_token: string; created_at: string; updated_at: string; error: string | null
}

export function publicUpload(row: UploadRow, parsedManifest?: UploadManifest): UploadSession {
  const manifest = parsedManifest ?? JSON.parse(row.manifest) as UploadManifest
  return { id: row.id, targetId: row.target_id, name: manifest.name, directory: manifest.directory, size: manifest.size,
    chunkSize: manifest.chunkSize, totalChunks: manifest.hashes.length, nextChunk: row.next_chunk,
    committedBytes: row.committed_bytes, manifestHash: row.manifest_hash, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at, error: row.error }
}

export class Store {
  readonly db: DatabaseSync
  private readonly instanceLock: DatabaseSync
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    // A kernel-managed SQLite exclusive lock is released even on SIGKILL. An
    // in-memory mutex alone cannot protect chunk writes from a second process.
    this.instanceLock = new DatabaseSync(join(directory, 'instance.sqlite'))
    chmodSync(join(directory, 'instance.sqlite'), 0o600)
    try { this.instanceLock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;') }
    catch (error) { this.instanceLock.close(); throw new Error('Another Filebrowser process owns this state directory', { cause: error }) }
    this.db = new DatabaseSync(join(directory, 'filebrowser.sqlite'))
    chmodSync(join(directory, 'filebrowser.sqlite'), 0o600)
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get()
    if ((existing && version !== 2) || (version !== 0 && version !== 2)) {
      this.close()
      throw new Error('This database uses an unsupported schema. Multi-target installations require a fresh state directory; no automatic migration is performed.')
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE NOT NULL,
        password_hash TEXT NOT NULL, role TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS targets (
        id TEXT PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE NOT NULL, type TEXT NOT NULL,
        connection TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        read_only INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS target_grants (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
        scope TEXT NOT NULL, permissions TEXT NOT NULL, PRIMARY KEY(user_id,target_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), target_id TEXT NOT NULL REFERENCES targets(id), path TEXT NOT NULL,
        manifest TEXT NOT NULL, manifest_hash TEXT NOT NULL, next_chunk INTEGER NOT NULL DEFAULT 0,
        committed_bytes INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
        storage_token TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS upload_target ON uploads(target_id,path)
        WHERE status IN ('uploading', 'publishing');
      CREATE INDEX IF NOT EXISTS uploads_user ON uploads(user_id);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
        detail TEXT NOT NULL, target_id TEXT REFERENCES targets(id) ON DELETE SET NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS network_share_accounts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        protocol TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
        username TEXT UNIQUE NOT NULL, secret TEXT NOT NULL,
        credentials_valid INTEGER NOT NULL DEFAULT 1,
        UNIQUE(protocol,user_id)
      );
      CREATE TABLE IF NOT EXISTS network_shares (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        protocol TEXT NOT NULL, name TEXT UNIQUE COLLATE NOCASE NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id), target_id TEXT NOT NULL REFERENCES targets(id), path TEXT NOT NULL,
        directory_dev TEXT NOT NULL, directory_ino TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
        FOREIGN KEY(protocol,user_id) REFERENCES network_share_accounts(protocol,user_id)
      );
      PRAGMA user_version = 2;
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
  grants(id: string): TargetGrant[] {
    return (this.db.prepare('SELECT target_id,scope,permissions FROM target_grants WHERE user_id=?').all(id) as { target_id: string; scope: string; permissions: string }[])
      .map(row => ({ targetId: row.target_id, scope: row.scope, permissions: JSON.parse(row.permissions) as Permissions }))
  }
  publicUser(row: UserRow): User {
    return { id: row.id, username: row.username, role: row.role, grants: this.grants(row.id), disabled: !!row.disabled, createdAt: row.created_at }
  }
  setGrants(id: string, grants: TargetGrant[]) {
    this.db.prepare('DELETE FROM target_grants WHERE user_id=?').run(id)
    for (const grant of grants) this.db.prepare('INSERT INTO target_grants(user_id,target_id,scope,permissions) VALUES(?,?,?,?)')
      .run(id, grant.targetId, grant.scope, JSON.stringify(grant.permissions))
  }
  targets() { return this.db.prepare('SELECT * FROM targets ORDER BY created_at,name').all() as unknown as TargetRow[] }
  target(id: string) { return this.db.prepare('SELECT * FROM targets WHERE id=?').get(id) as unknown as TargetRow | undefined }
  upload(id: string) { return this.db.prepare('SELECT * FROM uploads WHERE id = ?').get(id) as unknown as UploadRow | undefined }
  private metadataFields = "id,user_id,target_id,path,manifest_hash,next_chunk,committed_bytes,status,storage_token,created_at,updated_at,error,'' AS manifest"
  uploadMetadata(id: string) { return this.db.prepare(`SELECT ${this.metadataFields} FROM uploads WHERE id = ?`).get(id) as unknown as UploadRow | undefined }
  activeUploads() { return this.db.prepare(`SELECT ${this.metadataFields} FROM uploads WHERE status IN ('uploading','publishing')`).all() as unknown as UploadRow[] }
  retainedUploads() { return this.db.prepare(`SELECT ${this.metadataFields} FROM uploads WHERE status IN ('uploading','publishing','canceling','failed') ORDER BY status='failed'`).all() as unknown as UploadRow[] }
  uploadIds() { return new Set((this.db.prepare('SELECT id FROM uploads').all() as { id: string }[]).map(row => row.id)) }
  userUploads(id: string) { return this.db.prepare(`SELECT ${this.metadataFields} FROM uploads WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`).all(id) as unknown as UploadRow[] }
  audit(actor: string, action: string, detail: string, targetId: string | null = null) {
    this.db.prepare('INSERT INTO audit(actor,action,detail,target_id,created_at) VALUES(?,?,?,?,?)').run(actor, action, detail, targetId, new Date().toISOString())
  }
  audits(): AuditEntry[] {
    return this.db.prepare('SELECT id,actor,action,detail,target_id AS targetId,created_at AS createdAt FROM audit ORDER BY id DESC LIMIT 100').all() as unknown as AuditEntry[]
  }
  close() { this.db.close(); this.instanceLock.close() }
}
