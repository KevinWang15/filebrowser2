# Deployment

Filebrowser2 requires Node.js 24 or a newer supported LTS release. Linux is the supported application host. Named targets may use local filesystems, S3-compatible storage, FTP/FTPS or SFTP. Use a supported OS and a filesystem with working file/directory `fsync`, hard links, and SQLite locking. Other operating systems have not been validated. Application state uses SQLite; no PostgreSQL server is needed.

## Container

```sh
docker compose up --build -d
```

Open `http://127.0.0.1:8080` and complete the setup wizard. The container runs as the unprivileged `node` user, with separate persistent volumes for files and state. The published port is loopback-only by default. To expose the container directly, deliberately change the host binding in `compose.yml`.

CI publishes `ghcr.io/kevinwang15/filebrowser2:latest` for Linux AMD64 and ARM64 after the application, browser, SMB, and remote-storage checks pass. The image includes the compiled web application, production Node dependencies, trusted CA certificates, Samba, and the account/configuration tools used by the SMB agent. Pull access follows the package's visibility; a private package requires registry authentication. To use the prebuilt image:

```sh
docker run -d --name filebrowser2 --restart unless-stopped \
  -p 127.0.0.1:8080:3000 \
  -v filebrowser-files:/files -v filebrowser-state:/state \
  ghcr.io/kevinwang15/filebrowser2:latest
```

The supplied Compose files can also use the published image without a local build:

```sh
docker compose up -d --no-build --pull always
```

Set `FB_IMAGE` to select another image tag or digest. The optional SMB service uses the same image with its companion command and OS user; see [network sharing](network-shares.md).

## Native build or runtime package

For a source checkout:

```sh
npm ci
npm run build
HOST=127.0.0.1 PORT=3000 \
FB_SETUP_LOCAL_PATH=/srv/filebrowser/files \
FB_STATE_DIR=/var/lib/filebrowser \
npm start
```

Run as an OS account that owns the file and state directories. Paths can be absolute or relative to the working directory. A portable runtime package contains `app/dist`, the exact production dependencies, notices, and a sample service. Install Node separately, then launch it with:

```sh
HOST=127.0.0.1 PORT=3000 \
FB_SETUP_LOCAL_PATH=/srv/filebrowser/files \
FB_STATE_DIR=/var/lib/filebrowser \
node --enable-source-maps /opt/filebrowser/app/dist/server/server.js
```

The [systemd example](../examples/systemd/filebrowser.service) assumes this runtime layout, `/usr/bin/node`, a `filebrowser` OS account, and existing writable storage/state directories. Adjust those paths and the user for your installation. Optional environment overrides live in `/etc/filebrowser.env`. Install the unit, run `systemctl daemon-reload`, and enable it with `systemctl enable --now filebrowser`. View its log with `journalctl -u filebrowser`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address; use `0.0.0.0` for all IPv4 interfaces |
| `PORT` | `3000` | HTTP port |
| `FB_SETUP_LOCAL_PATH` | `./data` | Wizard suggestion only; does not create a target |
| `FB_SETUP_LOCAL_READ_ONLY` | `false` | Preselect Read only in setup, for a physically read-only local mount |
| `FB_STATE_DIR` | `./.filebrowser-state` | Private writable SQLite state, target encryption key and remote chunk staging |
| `FB_PUBLIC_ORIGIN` | Request origin | Actual browser-facing origin when behind a proxy |
| `FB_SECURE_COOKIES` | `false` | Set `true` when the browser uses HTTPS |
| `FB_UPLOAD_CHUNK_SIZE` | `104857600` | Chunk bytes, from 64 KiB through 100 MiB |
| `FB_MAX_FILE_SIZE` | Up to 1 TiB | Must also fit within 12,000 chunks |
| `FB_LOG_LEVEL` | `info` | Logging level |
| `FB_BUILD_COMMIT` | `local` | Optional build identifier returned by `/health` |

The container's internal `HOST` is `0.0.0.0`, while Compose publishes it on host loopback by default. Native defaults come from `.env.example` and the server. The bootstrap API advertises upload limits to the browser. Existing upload sessions retain their original chunk size.

Configure targets in **Storage targets**, then grant each member independent access in **People & access**. A Local target's root is a path inside the application container or host. Add bind mounts for additional local directories; remote targets need no file volume. The setup suggestion never exposes a directory on its own.

Keep state outside all visible local targets, or inside a reserved `.filebrowser-*` directory. For optional whole-host administration, explicitly create a Local target with root `/`, use private state such as `/var/lib/filebrowser/.filebrowser-state`, and run with the intended OS permissions. File APIs reject symlinks, special files and reserved paths. Each writable local root has an exclusive application lock.

For a physically read-only bind mount, mount it with `:ro` and check **Read only** when creating the corresponding Local target in setup or administration. Account administration and other writable targets remain available. Retained uploads can resume after that target becomes writable again. Read-only local targets create no lock or staging files on the file mount.

Changing a target to read/write does not grant operating-system permissions or change its mount options. The application checks local write access and acquires the storage lock before saving a read/write transition or re-enabling a writable local target. If that check fails, the existing target settings are preserved. In the container, `/` belongs to the container filesystem and the application runs as `node` (UID 1000); choose a writable mounted directory owned by that user for uploads.

To browse the host's entire filesystem in a container, bind host `/` to `/files` and configure the Local target as `/files`, with **Read only** enabled for a read-only bind. Set `FB_SETUP_LOCAL_READ_ONLY=true` to preselect that choice. The target appears as `/` in the browser; a target configured as `/` instead browses the container's filesystem. Docker may require `rslave` bind propagation when the source includes its own data directory.

For an explicitly writable container `/` target, persist `/.filebrowser-uploads` as well as private state. With a whole-host bind, keep its underlying directory inside a reserved `.filebrowser-*` directory too; for example, precreate `.filebrowser-state/root-staging` in the state volume and mount that volume subpath at `/.filebrowser-uploads`. It contains the upload registry for mounted filesystems, which is needed to resume host uploads after recreating the container. Files written into the container's own writable layer remain subject to the container's lifecycle; host files belong under the `/files` mount.

Keep private state in a reserved directory when browsing a filesystem that contains it. Set `FB_STATE_DIR=/state/.filebrowser-state` with the existing state volume still mounted at `/state`. This also protects state reached through the host filesystem bind. For an existing installation, stop the application, back up the state volume, and move its existing contents (including hidden files, `targets.key`, SQLite files, and protocol state) into that subdirectory before changing `FB_STATE_DIR`. Preserve ownership and permissions. Setting the variable without moving existing state creates a fresh installation. Never disable the private-state validation to make a root target work.

Connections and grants live in SQLite. Target secrets are encrypted with the private `targets.key` in the state directory; preserve that key with the database. SFTP requires a pinned SHA-256 server host key and OpenSSH fsync support for upload. FTPS verifies normal certificate trust; install private CA certificates through Node's `NODE_EXTRA_CA_CERTS` when needed. Never disable TLS verification. S3 connections specify bucket, region, optional endpoint/prefix and credentials. See [target semantics](storage-targets.md).

The application initializes its current schema only in an empty database. Existing state must use that schema; startup does not add missing tables or migrate state. Configure storage targets through setup or administration and server options through environment variables.

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

One process owns its state directory and each writable local target root. OS-managed locks reject a second writer and release after a crash. Stop the service before replacing the application or taking a consistent backup. Preserve the private state, `targets.key`, SQLite database/WAL, local file volumes and unfinished upload stages together. Remote stages also depend on the local receipt metadata; retain both sides of an unfinished transfer. Never reset account state to install an update.

For local targets, upload payloads and temporary chunks are staged on their destination filesystem. Remote adapters keep one bounded chunk plus receipt metadata in private state; configure enough state space for concurrent chunks. S3 incomplete multipart uploads should have an appropriate bucket lifecycle cleanup policy for uploads whose initialization response was lost. The central `.filebrowser-uploads` registry tracks stages on other volumes. Back up each mounted volume's staging if it contains unfinished transfers. Storage hardware must honor acknowledged writes; the app cannot repair lost hardware writes or hostile concurrent directory replacement by other host processes.
