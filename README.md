# Filebrowser2

A self-hosted file browser with scoped users and durable resumable uploads. Run it on your own storage, create the first administrator through the setup wizard, and give each user the access they need.

![File workspace in light mode](docs/images/workspace-light.png)

## Quick start

With Docker Compose:

```sh
docker compose up --build -d
```

Open **http://127.0.0.1:8080** and choose your administrator username and password. There is no default password. Files and private application state persist in separate Docker volumes.

For local development, use Node.js 24+ and npm 11+:

```sh
npm ci
cp .env.example .env
npm run dev
```

Open **http://127.0.0.1:5173**. Local defaults store files in `./data` and account/session/upload metadata in `./.filebrowser`; both are ignored by Git. The backend listens on port 3000. To build and run a native production instance, use `npm run build` and `npm start` with your chosen storage and state paths.

See [deployment and configuration](docs/deployment.md) for native services, container bindings, HTTPS proxies, backups, and optional whole-host administration.

## Features

- First-run setup, scrypt password hashes, revocable sessions, login throttling, and server-side permission enforcement.
- Administrator console for creating users, assigning home folders, changing permissions, resetting passwords, and disabling accounts.
- Files and folders, list/grid views, search, sorting, rename, empty-folder/file deletion, text/image previews, and HTTP byte-range downloads.
- Light, dark and system themes; compact and comfortable layouts; a file inspector, context menus, keyboard shortcuts, and a command palette.
- Resumable uploads up to 1 TiB per file, with SHA-256 manifests and sequential 100 MiB chunks. Each current chunk can use one, two, or four connections.
- Local filesystem storage with an explicit adapter contract. Staging supports destinations on different mounted filesystems; remote adapters are future work.

Symlinks, traversal segments, special files and reserved `.filebrowser-*` paths are inaccessible through the file API. Users see their assigned folder as `/`. Browse/preview, download, upload, create-folder, rename and delete permissions are independent.

## Durable uploads

Before upload, a browser worker scans the source through 4 MiB read buffers and hashes each chunk. It sends the immutable checksum manifest to initialize a session. Chunks commit in order; connections can run concurrently only within the current chunk.

The server streams parts into one temporary chunk, verifies its SHA-256, appends it to the growing file, syncs the file, and commits the new offset in a FULL-synchronous SQLite transaction. It acknowledges afterward. A failed chunk is discarded and retried as a whole. Duplicate commits and lost responses are reconciled against the server's durable offset.

An unfinished upload appears as `filename.uploading`. Recovery discards incomplete chunks and truncates uncommitted tails. Completion exposes the final name using the same inode, with an exclusive hard link, directory sync and unlink. There is no full-file concatenation or copy, and no second full-file allocation. A private anchor supports recovery; payload and chunk staging share the destination filesystem.

Pausing retains the source and manifest while the page is open. After a browser restart, select the original file to verify its manifest again and resume from the committed offset. The server needs the growing file plus at most one temporary chunk per active upload. These guarantees depend on filesystem locking, `fsync` and storage hardware honoring writes.

Read [the upload protocol](docs/upload-protocol.md) for state transitions, disk/memory bounds, endpoints, tradeoffs and failure cases. Tests cover real 100 MiB chunks, interrupted transfers, corruption, process crashes, 1 GiB stress uploads and 200 GiB manifests. A full 200 GB payload and physical power-loss testing have not been performed.

![Transfers in dark mode](docs/images/transfers-dark.png)

The screenshots show disposable demonstration fixtures.

## Development and release

```sh
npm run check
npx playwright install chromium
npm run test:e2e
```

[The testing guide](docs/testing.md) explains the container stress suite, mounted-filesystem fixtures and optional PostgreSQL checks. Verification output is generated locally and excluded from source releases. Application state uses SQLite and needs no database service; the starter's optional Prisma/PostgreSQL tooling remains available.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for development conventions, [SECURITY.md](SECURITY.md) for private vulnerability reporting, and [the release guide](docs/releasing.md) for portable source/runtime packaging. Version history is in [CHANGELOG.md](CHANGELOG.md).

## Project structure

| Path | Purpose |
| --- | --- |
| `frontend/` | File UI, setup, administration, hashing worker and upload coordinator |
| `backend/` | Authenticated HTTP API, SQLite state, storage adapters and upload recovery |
| `shared/` | Shared types and limits |
| `tests/` | HTTP, storage, crash-recovery, production and browser checks |
| `scripts/` | Build, packaging and disposable verification tools |
| `examples/` | Portable service configuration |
| `docs/` | Deployment, upload protocol, testing and release guides |
| `licenses/` | Notices for bundled fonts and frontend libraries |

## License and attribution

Project source is [MIT licensed](LICENSE). Third-party packages and bundled fonts retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md). [NOTICE.md](NOTICE.md) credits the starter and interface design influences.
