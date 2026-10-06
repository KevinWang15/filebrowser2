# Testing

Checks create disposable file/state directories. Do not point them at real account databases or user data. Fixture credentials in tests are synthetic and are not application defaults.

## Standard checks

```sh
npm ci
npm run check
npx playwright install chromium
npm run test:e2e
```

`npm run check` runs lint, type checks, frontend/backend builds and Node tests. PostgreSQL integration is optional outside CI: set `TEST_DATABASE_URL` to a disposable database to include it. CI supplies a disposable PostgreSQL service and mounted-filesystem fixture. An existing Chromium can be selected with `FB_CHROMIUM_PATH`.

Backend tests cover permissions, first-run setup, authenticated file operations, actual 100 MiB streaming, corrupt/incomplete chunks, interrupted connections, duplicate commits, missing data, publication conflicts, cancellation, and SIGKILL recovery at durable transitions. The browser workflow uploads 101 MiB, interrupts the second chunk, reloads, verifies the source manifest, and completes with matching bytes.

## Mounted filesystems

`tests/storage-mounts.test.js` requires two actual devices: set `FB_TEST_STORAGE_ROOT` to a disposable directory and `FB_TEST_MOUNT_PATH` to a mounted directory beneath it. The container runner supplies a tmpfs mount automatically. Coverage includes device-local staging, four-part chunks, corruption rollback, orphan cleanup, unavailable-device retention and interrupted publication/cancellation.

## Production-container checks

The dedicated Compose project isolates persistent fixtures, Chromium, PostgreSQL, and a 32 MiB tmpfs used to trigger real ENOSPC:

```sh
docker compose -p filebrowser-verify -f compose.verify.yml build
docker compose -p filebrowser-verify -f compose.verify.yml up -d app database diskfull
docker compose -p filebrowser-verify -f compose.verify.yml run --rm runner npm run check
docker compose -p filebrowser-verify -f compose.verify.yml run --rm runner node scripts/verify-container-browser.mjs setup
```

For the 1 GiB stress transfer, run `node scripts/verify-container-faults.mjs` on the Docker host while `verify-container-upload.mjs` and `verify-container-disk.mjs` run concurrently in separate runner containers. The fault helper deliberately kills only this Compose project's app and fills only its diskfull fixture. The scripts communicate through the ignored `verification/` directory. Use a fresh project fixture for each full run; retain outputs while investigating a failure.

After the upload and disk checks, run the API permission matrix, then the browser finish phase:

```sh
docker compose -p filebrowser-verify -f compose.verify.yml run --rm runner node scripts/verify-container-api.mjs
docker compose -p filebrowser-verify -f compose.verify.yml run --rm runner node scripts/verify-container-browser.mjs finish
docker compose -p filebrowser-verify -f compose.verify.yml run --rm runner node scripts/verify-container-browser-faults.mjs
docker compose -p filebrowser-verify -f compose.verify.yml run --rm runner node scripts/verify-container-redesign.mjs
docker compose -p filebrowser-verify -f compose.verify.yml stop
```

The finish phase changes a fixture password, so it follows the other API/upload checks. Fault/redesign browser scripts default to that changed password; `FB_VERIFY_ADMIN_PASSWORD` overrides it. The 100 KiB configuration makes a 1 GiB file use 10,486 sequential chunks. Do not use the temporary verification limit for a 200 GB production transfer.

Tests validate a 200 GiB manifest without allocating a 200 GiB file. A full 200 GB payload, physical power loss, faulty hardware and remote storage adapters are not covered. Passing process-crash tests does not establish protection against every storage failure.
