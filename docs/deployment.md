# Deployment

Filebrowser2 requires Node.js 24 or a newer supported LTS release. Linux with a local filesystem is the supported deployment target. Use a supported OS and a filesystem with working file/directory `fsync`, hard links, and SQLite locking. Other operating systems have not been validated. Application state uses SQLite; no PostgreSQL server is needed.

## Container

```sh
docker compose up --build -d
```

Open `http://127.0.0.1:8080` and complete the setup wizard. The container runs as the unprivileged `node` user, with separate persistent volumes for files and state. The published port is loopback-only by default. To expose the container directly, deliberately change the host binding in `compose.yml`.

## Native build or runtime package

For a source checkout:

```sh
npm ci
npm run build
HOST=127.0.0.1 PORT=3000 \
FB_STORAGE_ROOT=/srv/filebrowser/files \
FB_STATE_DIR=/var/lib/filebrowser \
npm start
```

Run as an OS account that owns the file and state directories. Paths can be absolute or relative to the working directory. A portable runtime package contains `app/dist`, the exact production dependencies, notices, and a sample service. Install Node separately, then launch it with:

```sh
HOST=127.0.0.1 PORT=3000 \
FB_STORAGE_ROOT=/srv/filebrowser/files \
FB_STATE_DIR=/var/lib/filebrowser \
node --enable-source-maps /opt/filebrowser/app/dist/server/server.js
```

The [systemd example](../examples/systemd/filebrowser.service) assumes this runtime layout, `/usr/bin/node`, a `filebrowser` OS account, and existing writable storage/state directories. Adjust those paths and the user for your installation. Optional environment overrides live in `/etc/filebrowser.env`. Install the unit, run `systemctl daemon-reload`, and enable it with `systemctl enable --now filebrowser`. View its log with `journalctl -u filebrowser`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address; use `0.0.0.0` for all IPv4 interfaces |
| `PORT` | `3000` | HTTP port |
| `FB_STORAGE_ROOT` | `./data` | Root exposed by the file API |
| `FB_STATE_DIR` | `./.filebrowser` | Private accounts, sessions and durable upload records |
| `FB_PUBLIC_ORIGIN` | Request origin | Actual browser-facing origin when behind a proxy |
| `FB_SECURE_COOKIES` | `false` | Set `true` when the browser uses HTTPS |
| `FB_UPLOAD_CHUNK_SIZE` | `104857600` | Chunk bytes, from 64 KiB through 100 MiB |
| `FB_MAX_FILE_SIZE` | Up to 1 TiB | Must also fit within 12,000 chunks |
| `FB_LOG_LEVEL` | `info` | Logging level |
| `FB_BUILD_COMMIT` | `local` | Optional build identifier returned by `/health` |

The container's internal `HOST` is `0.0.0.0`, while Compose publishes it on host loopback by default. Native defaults come from `.env.example` and the server. The bootstrap API advertises upload limits to the browser. Existing upload sessions retain their original chunk size.

Keep state outside the storage root, or inside a reserved `.filebrowser-*` directory. For optional whole-host administration, `FB_STORAGE_ROOT=/` can use `FB_STATE_DIR=/var/lib/filebrowser/.filebrowser-state`. Run with an OS identity that has the intended host permissions. The API still rejects symlinks, special files and reserved paths; FUSE mounts enforce their own access rules.

## HTTPS reverse proxy

Set `FB_PUBLIC_ORIGIN=https://files.example.com` and `FB_SECURE_COOKIES=true` for HTTPS. Forward the browser's Host header. For nginx:

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

Streaming request bodies avoids another proxy-managed chunk copy on disk. HTTP byte ranges support compatible download clients; persistent browser download resumption still depends on that browser or download manager. ETag/If-Range validation is not implemented.

## Updates and backups

One process owns a storage root and state directory. OS-managed locks reject a second writer and release after a crash. Stop the service before replacing the application or taking a consistent backup. Preserve the private state, SQLite database/WAL, file volume and unfinished upload stages together. Never reset account state to install an update.

Upload payloads and temporary chunks are staged on their destination filesystem. The central `.filebrowser-uploads` registry tracks stages on other volumes. Back up each mounted volume's staging if it contains unfinished transfers. Storage hardware must honor acknowledged writes; the app cannot repair lost hardware writes or hostile concurrent directory replacement by other host processes.
