# Filebrowser

A private file workspace with first-run setup, scoped accounts, and resumable uploads. Built from [KevinWang15/ts-fullstack-starter](https://github.com/KevinWang15/ts-fullstack-starter), commit `260e5a088d8abeb6dbd2289f05d224cbe9f78ff8`: React 19, Vite, SCSS, Fastify, shared TypeScript types, and esbuild production packaging. Fonts are bundled locally.

## Run locally

Requires Node.js 24+ and npm 11+.

```sh
npm ci
cp .env.example .env
npm run dev
```

Open **http://127.0.0.1:5173**. The setup wizard creates your administrator account; there is no preset password. The backend listens on port 3000. Your files go in `./data` and private account/session/upload records go in `./.filebrowser`. Both are ignored by Git.

## What is implemented

- One-time setup wizard: workspace name, administrator username, and password.
- Revocable server-side sessions, scrypt password hashes, login throttling, CSRF request verification, session invalidation on access/password changes, and protection against removing the last enabled administrator.
- File and folder browsing, list/grid views, search and sorting, folder creation, rename, empty-folder/file deletion, text previews, and downloads with HTTP byte ranges.
- Administrator console: create and edit accounts, reset passwords, disable accounts, select a home folder, and individually assign browse/preview, download, upload, create-folder, rename, and delete permissions. Members see their assigned folder as `/`.
- Activity history and workspace/account settings.
- Resumable uploads up to **1 TiB per file** with sequential **100 MiB** chunks, SHA-256 manifests, and 1, 2, or 4 parallel connections **inside the current chunk**.
- Worker-based file hashing using 4 MiB read buffers; upload progress, pause/resume, exponential backoff, and resumption after browser/server restarts.
- A storage contract separating ordinary file operations from durable sequential-upload capabilities. The local implementation is shipped; remote adapters are future work.

Symlinks, traversal segments, and reserved `.filebrowser-*` paths are inaccessible through the API. Uploaded file content is delivered as an attachment, or as sandboxed plain text for supported previews. File operations enforce permissions on the server.

## How resumption works

Before the first upload, a browser worker scans the file and calculates the SHA-256 hash of every chunk. Only the hash list is sent to initialize the session. The full file is never loaded into browser memory. Pausing in the same browser retains its computed manifest; after reloading, select the original file to verify its manifest again and resume from the last committed chunk.

The server stages one chunk, verifies its checksum, appends it to the growing file, calls `fsync`, and records the new offset in a SQLite transaction with `synchronous=FULL`. It acknowledges only after this commit. A lost response is handled by asking for the current server offset; duplicate commits return the existing result. Startup truncates any bytes beyond the recorded offset and discards incomplete chunks.

An unfinished file appears beside its destination as `filename.uploading`, labeled “Uploading” in the browser. Only committed bytes count toward its displayed size. It cannot be downloaded, previewed, renamed, or deleted through the file API; use Transfers to resume or cancel it. Its final name and pending name are reserved until completion or cancellation.

Completion moves `filename.uploading` to `filename` on the same filesystem. The local backend uses an exclusive hard link, directory sync, and unlink to move the same inode without overwriting an existing destination. A private hard-link anchor shares those blocks and supports crash recovery. There is **no full-file concatenation or copy**. A durable publishing state completes an interrupted move; a durable canceling state retries interrupted cleanup. This move atomically exposes complete bytes but briefly allows both names, so the backend does not advertise general atomic-move support. Names too long to append the suffix receive a shortened, deterministic hashed pending name within the filesystem’s 255-byte limit. Completed files whose own names end in `.uploading` remain ordinary files.

Read [the upload protocol and failure analysis](docs/upload-protocol.md) for exact invariants, endpoints, tradeoffs, and operating assumptions.

## Production

```sh
npm ci
npm run build
FB_STORAGE_ROOT=/srv/filebrowser/files \
FB_STATE_DIR=/srv/filebrowser/state \
FB_PUBLIC_ORIGIN=https://files.example.com \
FB_SECURE_COOKIES=true \
HOST=127.0.0.1 PORT=3000 npm start
```

The bundled backend serves the built frontend. Terminate HTTPS at your reverse proxy and forward the configured public origin. The local backend requires a filesystem with working file/directory `fsync`, same-volume hard links, and SQLite locking. Linux with a local filesystem is the supported target. One process owns the storage root and state directory; OS-managed locks reject a second writer and automatically release after a crash.

For nginx, the upload location needs streaming request bodies and generous transfer timeouts:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 101m;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    client_body_timeout 3600s;
}
```

`proxy_request_buffering off` is necessary for the stated storage bound: a buffering proxy can independently spool the entire incoming request. Configure the correct `FB_PUBLIC_ORIGIN` because the backend connection uses HTTP while the public origin uses HTTPS. HTTP development uses `FB_SECURE_COOKIES=false`.

Run as an unprivileged OS account that owns these directories. Application-managed paths must not be concurrently renamed or replaced by unrelated host processes. Back up the file volume and private state together while the application is stopped; include the SQLite database and its WAL when copying state. A file volume alone cannot reconstruct account records or committed upload offsets.

Use either the native commands above or the included container:

```sh
docker compose up --build -d
```

The default container endpoint is http://127.0.0.1:8080, with separate persistent volumes for files and state. Set the HTTPS origin and secure-cookie environment variables in Compose when using a TLS proxy. Open the endpoint to complete setup before giving other people access.

The default chunk is **100 MiB (104,857,600 bytes)**. `FB_UPLOAD_CHUNK_SIZE` accepts an integer from 64 KiB through 100 MiB for faster verification. `FB_MAX_FILE_SIZE` can lower the file limit; it must fit within 12,000 chunks and 1 TiB. For example, `FB_UPLOAD_CHUNK_SIZE=102400` permits a 1 GiB fixture with 10,486 chunks. The bootstrap API supplies these limits to the browser, including its hashing worker. Existing sessions retain their original chunk size and can resume after the configuration changes.

## Development and validation

```sh
npm run check           # lint, types, production build, backend and starter checks
npx playwright install chromium
npm run test:e2e        # builds and runs the real browser workflow
npm audit
```

An existing Chromium binary can be selected with `FB_CHROMIUM_PATH=/absolute/path/to/chrome`. Tests create disposable directories and do not initialize your own workspace.

Backend coverage includes real HTTP streaming, an actual 100 MiB chunk followed by a second chunk, dropped connections, corrupt and incomplete chunks, stale attempts, duplicate commits, destination conflicts, scope/permission enforcement, and SIGKILL immediately after append, publication-link creation, publication, and cancellation cleanup. A **200 GiB manifest** is validated without creating a 200 GiB test fixture. The browser test uploads 101 MiB, interrupts the next chunk, reloads, reselects the source, and verifies byte-identical completion. It also exercises setup, users, previews, downloads, and mobile layout. A full 200 GB transfer and physical power-loss/hardware tests have **not** been performed.

The dedicated [container verification configuration](compose.verify.yml) adds a production app with 100 KiB chunks, a Chromium runner, disposable PostgreSQL, and a second production app with a 32 MiB filesystem. The scripts under `scripts/verify-container-*.mjs` exercise a real 1 GiB transfer, controlled server SIGKILL/restart, actual `ENOSPC`, each permission independently, and browser resumption after interruption/reload. The host fault helper records memory samples and performs the two fault injections. The [verification report](verification/REPORT.md) includes results, screenshots, limitations, and reproduction commands. The complete [verification bundle](https://transfer.ke.wang/attachments/941faccc292446c6bf0a9ed2ad93b83b?fileName=filebrowser-verification-2026-10-06-uploading-suffix.tar.gz) was uploaded to session `111111` and its downloaded SHA-256 was verified.

The starter's optional Prisma/PostgreSQL tools and their isolated checks remain available. Application state uses Node's built-in SQLite; it needs no database service. The PostgreSQL fixture test is skipped unless `TEST_DATABASE_URL` is supplied. Nodemon uses explicit backend/shared watch roots and a Chokidar 4 override to avoid the vulnerable legacy brace parser. For scripts outside those watch roots, pass `--watch` explicitly.

## Repository map

| Directory | Purpose |
| --- | --- |
| `frontend/` | Setup, login, file UI, administration, hashing worker, upload coordinator |
| `backend/app.ts` | Authenticated HTTP API and runtime request validation |
| `backend/auth.ts` | Passwords and revocable cookie sessions |
| `backend/store.ts` | Durable state, SQLite schema, and instance exclusion |
| `backend/uploads.ts` | Upload state machine and crash recovery |
| `backend/storage/` | Virtual paths, storage contracts, local streaming implementation |
| `shared/types.ts` | Shared API types and file/chunk limits |
| `tests/` | HTTP, large-file, crash, production, toolchain, and browser tests |
| `scripts/verify-container-*.mjs` | Production-container API, browser, large-transfer, disk-pressure, and fault-injection harnesses |
| `verification/` | Verification report, screenshots, and machine-readable evidence |

## Scope

This first version provides local storage. It does not yet provide an rclone bridge, cloud backends, public share links, recursive folder deletion, ZIP downloads, file editing, or a storage quota system. Transfers persist until completed or explicitly canceled; they do not silently expire. Automatic retries stop after eight consecutive failures, preserving committed progress for manual resumption.

Downloads support HTTP byte ranges. Strong file-version validators (`ETag`/`If-Range`) and tests of native browser download interruption/resumption remain to be implemented; current download verification covers complete downloads and explicit range requests.
