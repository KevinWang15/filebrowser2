# Release verification

The 0.1.0 release candidate was checked on Linux on 2026-10-07 using disposable accounts, file trees, databases and mounted filesystems.

| Check | Result |
| --- | --- |
| Native lint, type checks, production builds and Node tests | Passed: 35 tests; PostgreSQL and mounted-filesystem suites skipped without their optional fixtures |
| Fresh container build and `npm run check` with PostgreSQL and a tmpfs mount | Passed: 41 tests, no failures or skips |
| Chromium workflow against the production backend | Passed: first-run setup, file operations, 101 MiB upload, interruption, reload/resume, scoped users and mobile layout |
| Runtime distribution smoke test | Passed: standalone packaged server, setup discovery, authentication boundary, frontend assets and served font/dependency license notices |
| Source distribution guards | Passed: clean tracked-source export; rejected dirty worktrees and committed generated logs |
| Production dependency audit | No reported vulnerabilities at the time of verification |

The container tests exercised actual 100 MiB streaming, sequential commits, corrupt-chunk rollback, missing upload data, process termination at durable transitions, publication conflicts, cancellation and device-local staging. The mounted fixture also checked orphan cleanup and retention when a filesystem becomes unavailable. The runtime package was started from its own isolated directory and dependency tree.

The public source was reviewed for private deployment details, credentials, account state and generated reports. The two screenshots in this repository show disposable fixture data. Release source archives omit Git metadata; a separate clean-history Git export can be used when earlier private history must not be published.

This release verification did not transfer a full 200 GB payload or simulate physical power loss or faulty hardware. A 200 GiB manifest is tested without allocating that payload. Remote storage adapters have not been implemented. See [the testing guide](testing.md) for reproducible commands and the larger stress-test harness.
