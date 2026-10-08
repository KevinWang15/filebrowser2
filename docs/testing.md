# Testing

Checks create disposable file/state directories. Do not point them at real account databases or user data. Fixture credentials in tests are synthetic and are not application defaults.

## Standard checks

```sh
npm ci
npm run check
npx playwright install chromium
npm run test:e2e
```

`npm run check` runs lint, type checks, frontend/backend builds and Node tests. CI supplies a mounted-filesystem fixture, then installs Chromium and runs the browser workflow. No database service or generated ORM client is needed. An existing Chromium can be selected with `FB_CHROMIUM_PATH`.

Backend tests cover permissions, first-run setup, authenticated file operations, actual 100 MiB streaming, corrupt/incomplete chunks, interrupted connections, duplicate commits, missing data, publication conflicts, cancellation, and SIGKILL recovery at durable transitions. The browser workflow uploads 101 MiB, interrupts the second chunk, reloads, verifies the source manifest, and completes with matching bytes.

Archive checks cover binary and Unicode contents, empty directories, deduplicated mixed selections, private-state and unfinished-upload exclusion, scopes, permission changes, expiring single-use links, limits, backpressure and client disconnects. Read-only checks cover administrator write rejection, state isolation and retention of interrupted uploads for a later writable restart. Browser checks download real TAR files and exercise Ctrl/Command+Up navigation.

## Mounted filesystems

`tests/storage-mounts.test.js` requires actual mount boundaries: set `FB_TEST_STORAGE_ROOT` to a disposable directory and `FB_TEST_MOUNT_PATH` to a mounted directory beneath it. The container runner supplies a tmpfs mount automatically. Set `FB_TEST_BIND_MOUNT=true` to exercise a separate bind mount that shares its device with the root; CI checks both layouts. Coverage includes device-local staging, four-part chunks, corruption rollback, orphan cleanup, unavailable-device retention and interrupted publication/cancellation.

## Production-container checks

For managed SMB exports, use a separate disposable Compose project:

```sh
mkdir -p verification
docker compose -p filebrowser-smb-verify -f compose.verify.yml -f compose.verify.smb.yml build app smb smb-client runner diskfull
docker compose -p filebrowser-smb-verify -f compose.verify.yml -f compose.verify.smb.yml up -d app smb
docker compose -p filebrowser-smb-verify -f compose.verify.yml -f compose.verify.smb.yml run --rm smb-client
FB_VERIFY_PROJECT=filebrowser-smb-verify node scripts/verify-container-shares-recovery.mjs
docker compose -p filebrowser-smb-verify -f compose.verify.yml -f compose.verify.smb.yml run --rm runner node scripts/verify-container-shares-browser.mjs
docker compose -p filebrowser-smb-verify -f compose.verify.yml -f compose.verify.smb.yml down -v
```

The native `smbclient` harness checks authentication, SMB1/SMB2 rejection, actual encrypted SMB3 packets, a resumed 257 MiB download, HTTP byte ranges, read-only operations, scopes, private files, symlinks, OS identities and supplementary groups, credential reuse/rotation, existing-session revocation and replaced-directory rejection. Its writable fixture volume belongs only to this verification project. Create the evidence directory on the host before mounting it, so the host recovery helper can write its results as an ordinary user. The recovery helper restarts the companion, kills the application, asserts lease expiry and restores access with the same credentials. It also tests malformed control files, offline removal acknowledgment, expired and superseded policies during deliberately delayed configuration, and an unwritable control directory. Test-only delays are installed inside the disposable companion; production code has no fault-injection switches. The browser helper exercises administrator/member controls and captures desktop and mobile screenshots. Run these in the stated order against fresh volumes. `tests/shares.test.js` separately checks the API, private control files, durable metadata, publication failure recovery and browser-password revocation. SMB access is not enabled for ordinary backend test fixtures.

The dedicated Compose project isolates persistent fixtures, Chromium and a 32 MiB tmpfs used to trigger real ENOSPC:

```sh
docker compose -p filebrowser-verify -f compose.verify.yml build
docker compose -p filebrowser-verify -f compose.verify.yml up -d app diskfull
docker compose -p filebrowser-verify -f compose.verify.yml run --rm runner npm run check
docker compose -p filebrowser-verify -f compose.verify.yml run --rm runner node scripts/verify-container-browser.mjs setup
```

For the 1 GiB stress transfer, run these commands concurrently in three separate terminals after browser setup:

```sh
# Terminal 1, on the Docker host
node scripts/verify-container-faults.mjs
```

```sh
# Terminal 2
docker compose -p filebrowser-verify -f compose.verify.yml run --rm runner node scripts/verify-container-upload.mjs
```

```sh
# Terminal 3
docker compose -p filebrowser-verify -f compose.verify.yml run --rm runner node scripts/verify-container-disk.mjs
```

The fault helper deliberately kills only this Compose project's app and fills only its diskfull fixture. The scripts communicate through the ignored `verification/` directory. Use a fresh project fixture for each full run; retain outputs while investigating a failure.

For a different Compose project, set `FB_VERIFY_PROJECT` on the host fault helper to the same `-p` name. `FB_VERIFY_HOST_URL` overrides its published app address, and `FB_VERIFY_OUTPUT` selects its evidence directory. Mount that same evidence directory at `/evidence` in the runner. This keeps restart markers and results from earlier runs out of the new run.

After the upload and disk checks, run the API permission matrix, then the browser finish phase:

```sh
docker compose -p filebrowser-verify -f compose.verify.yml run --rm runner node scripts/verify-container-api.mjs
docker compose -p filebrowser-verify -f compose.verify.yml run --rm runner node scripts/verify-container-browser.mjs finish
docker compose -p filebrowser-verify -f compose.verify.yml run --rm runner node scripts/verify-container-browser-faults.mjs
docker compose -p filebrowser-verify -f compose.verify.yml run --rm runner node scripts/verify-container-ui.mjs
docker compose -p filebrowser-verify -f compose.verify.yml up -d readonly
docker compose -p filebrowser-verify -f compose.verify.yml run --rm runner node scripts/verify-container-readonly.mjs
docker compose -p filebrowser-verify -f compose.verify.yml run --rm runner node scripts/verify-container-throughput.mjs
docker compose -p filebrowser-verify -f compose.verify.yml stop
```

The finish phase changes a fixture password, so it follows the other API/upload checks. Fault/UI browser scripts default to that changed password; `FB_VERIFY_ADMIN_PASSWORD` overrides it. The 100 KiB configuration makes a 1 GiB file use 10,486 sequential chunks. Do not use the temporary verification limit for a 200 GB production transfer.

The read-only script runs after the API and general browser checks, seeds a small download fixture through the writable app, and then performs administrator setup against the separate read-only container. Run it while other scripts are not mutating that volume, so its final comparison can assert that storage remained unchanged. Its file volume is physically mounted read-only; account state uses writable tmpfs. It checks native file/TAR downloads, range and HEAD metadata, every file mutation endpoint, hidden write controls and user administration. The throughput script then varies real upload request delays and checks that the summary height remains fixed at desktop, tablet and mobile widths.

Tests validate a 200 GiB manifest without allocating a 200 GiB file. A full 200 GB payload, physical power loss, and faulty hardware are not covered. Real remote adapters are covered by the separate target suite below. Passing process-crash tests does not establish protection against every storage failure.

## Native remote storage containers

`compose.targets.verify.yml` provides MinIO, OpenSSH, plain FTP and certificate-verified FTPS (vsftpd). The S3 fixture builds the pinned MinIO source revision `07c3a429bfed433e49018cb0f78a52145d4bedeb` rather than relying on a mutable or unavailable binary image. They use disposable volumes and synthetic credentials. The remote test suite is enabled with `FB_TEST_REMOTES=true`; ordinary local tests report these conditional tests as skipped. The dedicated job executes them against real protocol servers.

```sh
mkdir -p verification/targets
docker compose -p filebrowser-targets-verify -f compose.targets.verify.yml build
docker compose -p filebrowser-targets-verify -f compose.targets.verify.yml up -d --wait --no-build minio remotes
node scripts/verify-remote-containers.mjs
```

The host driver obtains the fixture's public host key and CA certificate and runs native remote HTTP/upload tests and browser checks. It verifies sequential commits, bounded staging, chunk checksum rollback, process SIGKILL during append/publication/cancellation, interrupted remote writes, same-length corruption, truncated acknowledged data, host-key enforcement, target isolation, range reads, archives, grant changes, target switching, and actual browser uploads. Screenshots and assertion results are written under `verification/targets/`.

```sh
docker compose -p filebrowser-targets-verify -f compose.targets.verify.yml down -v
```

Use a different `FB_TARGET_VERIFY_PROJECT` and `FB_TARGET_VERIFY_OUTPUT` for another isolated project or evidence directory. Private CA trust is passed only to the disposable application and runner. No production default trusts the fixture certificates.
