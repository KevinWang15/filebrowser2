# Source cleanup verification

Reviewed on 2026-10-07 after the multi-target storage refactor. Application behavior and the target state schema are preserved; the cleanup removes unused source, tooling and documentation.

## Findings and changes

- Removed the empty Prisma schema, unused database factory, client generator, PostgreSQL fixture, database CLI commands and their configuration. Application state uses Node's built-in SQLite. The four deleted test cases exercised only that unused scaffold.
- Pruned **130 dependency entries**, reducing the lockfile from **542 to 412** entries. No packages were added and no remaining dependency versions changed. Prisma-specific dependency overrides were removed with their packages.
- Removed the unused `@consts` and `@shared` aliases. Frontend, backend and development-tool tests use the same `@/` project alias.
- Moved storage capabilities into the storage layer. Local, S3 and FTP/SFTP adapters and the target registry share the same capability definitions and chunk limits. Adapters no longer import their parent registry; the application import graph has no cycles.
- Made internal schemas, helpers and component types private; removed unused filename/modal/count helpers and an unnecessary user-serialization wrapper. Byte formatting now belongs to the formatting module.
- API and frontend versions come from `package.json` through one shared module. Release documentation no longer requires three independent edits to bump the version.
- Removed four unused style rules, four superseded verification reports and their two unreferenced screenshots. Current storage and SMB evidence remains in [storage target verification](storage-targets-verification.md).
- Updated ignored state paths, notices, configuration and testing instructions. Remote-fixture evidence defaults to `verification/targets/`, with the existing environment override for isolated runs.

## Validation

| Check | Result |
| --- | --- |
| Lint, type checks and production frontend/backend builds | Passed on the host and in a freshly built container |
| Combined Node suite with native remote services and a mounted tmpfs | **90 passed, zero failures or skips**, in about 87 seconds |
| Multi-target production browser workflow | **7 checks passed**, including five connections, grants, independent namespaces and interrupted S3 upload/reload/resume |
| Chromium end-to-end workflow | **1 passed**; real 101 MiB upload, interrupted chunk, reload, manifest verification, scopes and mobile controls |
| Native encrypted SMB3 workflow | **16 checks passed**, including two independent local targets and revocation of an existing connection |
| Dependency audit | **Zero reported vulnerabilities**, including development dependencies |
| Reference and consistency review | No unused application exports or import cycles found; relative Markdown links and source neutrality checks passed |

The full container suite contains the previous 94 cases minus the four removed Prisma-only fixture cases. Remote, mounted-filesystem, crash recovery and application permission coverage is retained. The browser and SMB harnesses have overlapping coverage and should not be added into a unique-test count. The earlier 1 GiB stress and physical ENOSPC evidence is recorded in [storage target verification](storage-targets-verification.md); those long production stress runs were not repeated for this source cleanup.

The review checks references using the installed TypeScript compiler and examines compiled CSS selectors, direct dependencies, relative Markdown links and source imports. Tests and fixture entry points are included when deciding whether an export is unused. Dynamically assembled CSS classes, protocol/state versions, private-state guards and the development debugger/watch workflow are retained because they have active consumers.

Local Debian and Go downloads timed out while rebuilding the unchanged fixture services. Verification uses the previously built MinIO image with the same pinned source revision and the unchanged native protocol fixture image. The application and runner were rebuilt from current source in the previously verified Node/Chromium base. A fresh `npm ci` and production build succeeded in that base. The packaged runtime omits optional native SSH acceleration. The cached SMB companion is byte-for-byte identical to the freshly compiled agent (`d46c69dec2b65f2197eb190e02dd8d1b01c0eb5e60f8710c539458bfe9fc5c50`). CI checks the normal Dockerfile separately.
