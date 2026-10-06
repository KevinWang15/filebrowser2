# Root deployment on icdesign.com

The installed service listens on **0.0.0.0:7288**, runs as **root**, and manages regular files and directories beneath **/**. Application account permissions still apply. Symlinks, reserved `.filebrowser-*` paths and special device files remain inaccessible through the API. FUSE mounts retain their own access restrictions.

Open **http://192.168.1.7:7288** from a network that can reach the host, or connect through an SSH tunnel:

```sh
ssh -p 7822 -L 7288:127.0.0.1:7288 root@icdesign.com
```

Open **http://127.0.0.1:7288** on your computer. Deployment initially left setup ready for your chosen administrator password; a later final check found it completed with one administrator. Sign in with the account created during setup. The deployment tools provisioned no production account or default password.

On 2026-10-07 the listener changed from loopback to all IPv4 interfaces. Health checks succeeded on the host's LAN address `192.168.1.7`, while connections to `icdesign.com:7288` from the deployment machine were refused. Public access depends on the host's firewall/router and port forwarding; those settings were not changed.

## Service operations

The host uses Upstart. Its PM2 command cannot load a dependency, and the existing Node 16 cannot run the application's built-in SQLite implementation. Filebrowser therefore has an independent Upstart job and private Node 24 runtime.

```sh
status filebrowser2
restart filebrowser2
stop filebrowser2
start filebrowser2
tail -f /var/log/upstart/filebrowser2.log
```

The job starts at runlevels 2–5 and respawns after a process crash. It stops after ten respawns in sixty seconds, leaving repeated startup failures visible in its log. Production uploads use the default **100 MiB** chunks and at most four connections within a chunk.

| Path | Purpose |
| --- | --- |
| `/etc/init/filebrowser2.conf` | Installed Upstart job |
| `/root/filebrowser2/app/` | Compiled frontend/backend and production dependency graph |
| `/root/filebrowser2/runtime/` | Private Node executable, loader and shared libraries |
| `/root/filebrowser2/.filebrowser-state/` | Private SQLite accounts, sessions, upload metadata and locks |
| `/root/filebrowser2/deployment.json` | Source, server hash and dependency provenance |
| `/.filebrowser-uploads/` | Central private upload registry and root-device staging |
| `<volume>/.filebrowser-uploads-<device>/` | Staging for destinations on another device |
| `/.filebrowser-lock` | Exclusive storage-root instance lock |

Private directories have mode 0700; SQLite account files have mode 0600. Stop the application before backing up its state and file volumes together. Retain each mounted volume's private staging if it contains unfinished uploads. Do not remove state to perform an update.

## Offline packaging and updates

The target needs no npm install, PostgreSQL service, Docker upgrade, or change to its system Node. `scripts/package-deployment.mjs` copies the built application from a verified local Docker image and walks the exact installed production dependency graph, including nested dependencies. Use the same lockfile and installed packages as the image:

```sh
npm ci
docker compose -p filebrowser-deploy-verify -f compose.verify.yml build app runner
docker compose -p filebrowser-deploy-verify -f compose.verify.yml up -d database
docker compose -p filebrowser-deploy-verify -f compose.verify.yml run --rm runner npm run check
node scripts/package-deployment.mjs /tmp/filebrowser2-release
```

The deployed private runtime comes from the official `node:24-bookworm-slim` image: Node 24.21.0 plus its Debian 12 loader and required libraries. The executable wrapper explicitly invokes that private loader. Launch commands and child processes must use `runtime/bin/node`; `node.real` alone would use the incompatible system loader. Neither the system libraries nor existing PM2 applications were modified.

Transfer release files over SCP using SSH port 7822. For an update, stop only `filebrowser2`, preserve its private state and staging, replace the application files, validate the job with `init-checkconf`, and start it again. Use archive timestamps of zero or suppress future-timestamp warnings when extracting on this host, whose clock was behind the build machine at deployment.

`scripts/verify-deployment.mjs` creates disposable state and test folders, exercises 101 MiB uploads on both the root device and `/mnt/sda3`, and removes its own fixtures. It owns the storage-root lock, so production must be stopped while running it. `scripts/verify-deployment-service.mjs` checks a freshly installed production service and deliberately kills/restarts it; it requires zero production users. These are commissioning checks, not checks to run against active user uploads.

The target's Ubuntu 14.04 and Linux 3.16 are outside Node 24's supported platform matrix. The private runtime passed the actual target checks, but this does not establish upstream support or substitute for a future OS upgrade. See the [verification report](REPORT.md) for evidence and limits.
