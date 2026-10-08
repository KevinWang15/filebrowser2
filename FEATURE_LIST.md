# Feature list

Implemented capabilities in the current Filebrowser2 codebase. Each category contains a flat list of feature points; storage-specific requirements and limits are included with the affected feature. This inventory covers the backend, frontend, storage adapters, optional SMB companion, and deployment and verification tooling.

Implementation details are in the [HTTP API](backend/app.ts), [storage adapters](backend/storage/), [upload coordinator](backend/uploads.ts), [frontend](frontend/), and [SMB management](backend/shares/). Usage and guarantees are documented in the [storage target guide](docs/storage-targets.md), [upload protocol](docs/upload-protocol.md), [network sharing guide](docs/network-shares.md), and [deployment guide](docs/deployment.md).

## Workspace setup

- Four-step first-run wizard for workspace name, storage, administrator account, and review.
- Optional first storage target: configure a local directory, S3-compatible bucket, FTP/FTPS server, or SFTP server during setup, or add storage later.
- Explicit storage configuration: no filesystem is exposed until a named target is configured; the suggested local path is only a wizard default.
- Initial read-only target configuration directly in the setup wizard, with a deployment option to preselect read-only access.
- Administrator password confirmation, show/hide controls, and a locally evaluated zxcvbn-ts strength meter that checks common passwords, repetition, sequences, keyboard patterns, and account/workspace names, with improvement suggestions.
- Automatic sign-in after successful setup and protection against repeating or concurrently completing setup.
- Retryable local setup failures that clean up the attempted target and leave administrator creation unfinished.
- Configurable workspace name displayed in the sidebar and sign-in screen, editable later by administrators.

## Authentication (authn)

- Username/password sign-in with case-insensitive username lookup and unique usernames.
- Passwords of 12–128 characters for setup, account creation, and password changes; usernames use letters, numbers, dots, underscores, and hyphens.
- Salted scrypt password hashing and timing-safe hash comparison; unknown usernames also go through password verification.
- Cryptographically random cookie sessions with a seven-day lifetime; only SHA-256 token hashes are stored in SQLite.
- HttpOnly, SameSite=Strict session cookies with configurable Secure cookies for HTTPS deployments.
- Sign-out revokes the current session and interrupts the user's active upload attempts.
- Self-service password changes verify the current password and revoke all browser sessions and active upload attempts.
- Per-IP throttling of setup, login, and password verification attempts; successful verification refunds its own attempt without clearing earlier failures.
- Disabled-account sign-in rejection and revalidation of session/account state after asynchronous work.
- Automatic return to the sign-in flow when the frontend receives an expired or revoked session response.

## Authorization (authz)

- Administrator and member roles, with administrator-only account, target, workspace, audit, and share management.
- Administrators receive full access to every enabled target, subject to the target's read-only setting.
- Independent member grants for each target, with one existing home directory and its own permissions per grant.
- Scoped virtual roots: each assigned home directory appears as `/`, and file operations resolve within that scope.
- Six independent permissions: read/browse, download, upload, create folders, rename, and delete.
- Folder uploads require both upload and create-folder access; file-only uploads require upload access, and directory creation/reuse does not require browse access.
- Separate preview permissions: text previews require read access; image previews and thumbnails require download access.
- Read only overrides all write permissions for members and administrators while keeping browsing and downloads available.
- Target visibility limited to enabled targets the current user can access; accounts may have no target grants.
- Upload sessions restricted to their owner; upload writes also require current target access and a destination within the user's current scope.
- Server-side permission checks for every protected operation, including native download links and archive tickets.
- Repeated authorization checks during storage operations, streamed downloads, archive generation, upload reception, and chunk acknowledgment.
- Account/grant changes revoke sessions and active upload attempts; revoked download and archive streams are closed.
- Grant revocation, password changes, and edits to permissions on unchanged scopes remain possible while remote storage is offline; new scopes must resolve to existing directories.
- Permission-aware navigation, buttons, context menus, command actions, and transfer controls in the frontend.

## Account administration

- Create accounts and edit usernames, roles, passwords, enabled status, and target grants.
- Enable or disable accounts while retaining their files and transfer history.
- Administrator password resets without requiring the user's old password.
- Safeguards against disabling the current administrator's own account or removing the last enabled administrator through disabling or demotion.
- Per-target permission presets: Read only, Contributor, Collaborator, and Full access, with individual permission switches for customization.
- Account directory with role, target count, permission summary, active/disabled status, and creation date.
- Search accounts by username or grant home folder; filter all accounts, active administrators, active members, or disabled accounts.
- Member account settings for appearance, password changes, storage/transfer information, and their own network share connection information.

## Storage target management

- Multiple named local, S3, FTP/FTPS, and SFTP targets with immutable UUID identities and case-insensitively unique names.
- Administrator console to add, edit, test, enable, disable, mark read-only, and remove eligible targets.
- Connection tests verify access to the configured root or bucket and return the adapter's capabilities.
- Target-specific routes, grants, upload sessions, destination reservations, archives, and file/upload audit records; identical paths on different targets remain independent.
- Targets as the first level of My files, with target-qualified folder URLs; unavailable or ungranted route targets show a chooser instead of silently switching storage.
- Encrypted connection configuration using AES-256-GCM and a separate private `targets.key` file.
- Write-only secret fields: admin responses redact saved credentials and identify which fields already have secrets; blank secret fields on edits preserve existing values.
- Credential renewal while uploads are retained, allowing recovery without discarding verified progress; connection edits require resolving existing protocol shares.
- Immutable target type and location; other connection setting changes require resolving retained uploads, while name, enabled, and read-only flags can change independently.
- Local read/write transitions and re-enabling writable targets verify write access and the storage lock before saving, preserving the previous configuration on failure.
- Detection and rejection of equal or overlapping namespaces within a storage type, including local directory identity checks and remote bucket-prefix/root checks.
- Disabling a target preserves transfer state for later recovery; targets with transfer history or shares must be disabled instead of removed.
- Removing an eligible target removes its connection and grants while leaving stored files intact.
- Lazy remote backend initialization: browsing one target does not contact unrelated targets, and remote recovery does not prevent application startup.
- Explicit adapter capabilities for range reads, moves, sequential uploads, durability, exclusive publication, native directory exports, and multipart limits.
- Per-target capacity and availability reporting, with explicit unknown-capacity states for remote adapters.

## Local filesystem storage

- Host/container directory targets with absolute roots or roots resolved from relative configuration paths.
- Writable root initialization, regular file/directory browsing, folder creation, renaming, deletion, streamed reads, and filesystem capacity reporting.
- Physical read-only mount support without creating lock or staging files on the file mount; private application state remains separately writable.
- Upload staging follows mount boundaries, including separate bind mounts on the same filesystem, so payload publication and visible upload files stay on the destination mount.
- File publication and file rename through exclusive hard links followed by unlinking, preserving the inode and avoiding replacement of an existing destination.
- File and directory fsync around upload checkpoints, publication, and filesystem mutations.
- Upload staging on the destination filesystem, including nested mounts on a different device, with a durable central stage registry.
- Device/inode checks for upload ownership and native directory exports; unavailable mounted staging retains its identity instead of creating replacement data on another filesystem.
- Exclusive application locks for writable local roots, released by the OS after process termination.
- Explicit whole-host browsing through a local target rooted at `/`, subject to OS permissions and protected private state paths.

## S3-compatible storage

- Bucket, region, optional custom endpoint, optional key prefix, access key, secret key, optional session token, and path-style request configuration.
- Virtual directories backed by object prefixes and explicit markers for empty folders.
- Paginated object listings, object metadata, streamed reads, and HTTP byte-range reads.
- Individual object rename using checksum-verified multipart streaming and source deletion, with bounded local staging; this rename is non-atomic and directory rename is unsupported.
- Checksum-verified multipart uploads with persisted upload IDs, part numbers, ETags, checksums, and end offsets.
- Resume validation of remotely saved parts against their recorded checksums, sizes, and ETags.
- Conditional publication that preserves existing destination objects, plus upload identity metadata for reconciling a lost completion acknowledgment.
- Compatibility requires an endpoint that honors SHA-256 multipart checksums and conditional completion/publication semantics.
- Empty-file publication and cancellation/orphan cleanup of managed multipart stages.
- Multipart limits of 10,000 parts and at least 5 MiB per multipart chunk except the final part; effective file limits also depend on the configured chunk size.
- Incomplete uploads appear as virtual pending entries in Filebrowser2; no final object is exposed until publication.

## FTP and FTPS storage

- Passive FTP connections with configurable host, port, username, password, and absolute root.
- Optional FTPS with certificate verification; private CA trust can be supplied through Node's certificate configuration.
- Directory listing, metadata, streamed downloads, range reads, folder creation, rename, and recursive file/folder deletion.
- Resumable offset writes through REST STREAM, with an explicit rejection when the server does not advertise restart-write support.
- Private remote upload stages and read-back SHA-256 verification of each saved chunk before checkpoint acknowledgment.
- Verification of saved receipt hashes after restart/reconnect and of the complete saved file before final rename.
- Recovery by overwriting an unacknowledged tail at the durable offset; only one temporary chunk is staged locally per session.
- Explicit weaker upload guarantees: FTP provides no portable remote fsync or exclusive no-replace rename, so publication assumes no competing external writer.

## SFTP storage

- SSH-backed targets with configurable host, port, username, and absolute root.
- Password or private-key authentication, including optional private-key passphrases.
- Required SHA-256 host-key pinning to verify server identity.
- Directory listing, metadata, streamed/ranged reads, folder creation, rename, and recursive file/folder deletion.
- Offset writes to owned private remote stages, requiring the OpenSSH fsync extension for uploads.
- Remote file fsync and read-back SHA-256 checks before recording each saved chunk's receipt.
- Saved-prefix verification after restart/reconnect and truncation of unacknowledged tails before retry.
- Reconciliation of a lost final rename acknowledgment by checking the published file against saved chunk hashes.
- Bounded reuse of authenticated SSH connections, keepalives, connection timeouts, and cleanup on target reconfiguration or shutdown.
- Explicit handling of connections lost during reads or writes so transfers fail visibly and can retry.

## File browsing and navigation

- List and grid layouts with file/folder names, type labels/icons, sizes, and modification times.
- Directory-first sorting by name, size, type, or modification time in ascending or descending order, with natural numeric name ordering.
- Case-insensitive filename filtering within the current folder, with match counts and a clear-filter action.
- Breadcrumb hierarchy from My files to the target and folder ancestors, parent navigation back to the target list, and browser history through hash routes.
- Direct folder navigation by typing a `/path` in the command palette.
- Manual refresh and automatic listing refresh when browser transfers create pending entries, finish, or cancel, including ancestor listings when nested uploads create child folders.
- Protection against stale listing responses after navigation or a newer refresh.
- Checkbox, single-click, Ctrl/Command-click, Shift-range, keyboard, and select-all selection; unfinished uploads are excluded from bulk selection.
- Selection summaries for item count and file bytes, plus folder/file/byte/upload counts for the current folder.
- Optional details inspector for a file, folder, current directory, or multiple selected items.
- Folder inspector showing immediate child counts, file bytes, and a sample of contents; totals exclude recursive subfolder sizes.
- Clipboard copying of file and folder virtual paths, with a fallback when the Clipboard API is unavailable.
- Virtualized list rows for directories larger than 250 entries and lazy raster thumbnails in grid view.
- Loading skeletons, empty-folder and no-match states, and retry/root-navigation actions for failed listings.
- Ordinary dotfiles and supported Unicode filenames, including completed files whose names end in `.uploading`.
- File types and icons distinguish server-managed unfinished uploads from ordinary completed files with a `.uploading` suffix.

## File and folder operations

- Create folders in the current target and virtual directory.
- Rename files and filesystem directories within their parent directory; S3 supports individual object rename only.
- Rename dialog selects the basename while preserving the extension for convenient editing.
- Create-folder and rename dialogs reject reserved names, slashes, control characters, whitespace-only names, and names exceeding 255 UTF-8 bytes before submission, using the same filename rules as the API.
- Delete files and folders recursively across all target types, including nested files and empty directories; multiple selected items are processed individually with progress and per-item failure messages.
- Recursive deletion rechecks delete access and upload/share protections during traversal, preserves private or unsupported entries, and refreshes the listing after partial failures.
- Confirmation dialogs for permanent deletion and prevention of renaming/deleting the user's virtual root.
- Destination conflict checks that preserve existing names and report busy or conflicting operations.
- Protection of unfinished upload destinations, pending names, and containing directories from conflicting mutations.
- Protection of shared directories and their ancestors from rename/deletion until protocol share removal is acknowledged.
- Per-target serialization of file mutations and upload initialization/finalization/cancellation, with retryable busy responses.
- File, folder, selection, and background context menus plus row/grid overflow actions.

## File previews and metadata

- Plain-text preview for TXT, MD, JSON, CSV, LOG, YAML/YML, TOML, INI, TS, JS, CSS/SCSS, and XML files up to 1 MiB, with identical format and size rules in the browser and API.
- Text rendered as literal text through a sandboxed endpoint; full viewer output is limited to 4,000 lines, with a notice for additional lines.
- Image preview for PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, and SVG files up to 25 MiB in the UI, subject to browser decoding support.
- Lazy grid thumbnails for supported raster formats up to 8 MiB, with file-icon fallback on failure.
- Full file viewer with previous/next sibling navigation, arrow-key controls, and permission-aware download/rename/delete actions.
- Metadata including file type, formatted size, exact byte count, modification timestamp, and scoped location.
- Delayed inspector previews and shorter text excerpts to keep cursor navigation responsive.
- Pending-upload details explain transfer state and link to Transfers; previews become available after completion.
- Explicit no-preview, image-decoding failure, loading, and preview-fetch error states.

## Downloads and archives

- Authenticated native browser file downloads with attachment disposition and UTF-8 filenames.
- Streamed file responses with backpressure and single HTTP byte ranges, including open-ended and suffix ranges.
- Efficient HEAD responses for file and range metadata without reading the payload; invalid ranges receive 416 responses.
- Streamed uncompressed TAR downloads of the current folder or a selected folder, preserving empty directories and Unicode names.
- One TAR for mixed file/folder selections or multiple files, with duplicate selections and selected descendants deduplicated.
- Relative archive paths preserve separate files with identical basenames; a single folder archive contains its children relative to that folder.
- Archives exclude private state, symlinks, special files, unsupported names, and managed unfinished uploads while retaining ordinary dotfiles and ordinary `.uploading` names.
- No completed temporary archive, full-tree manifest, or browser-side archive buffering; cancellation closes source streams and releases archive resources.
- Two-minute, single-use archive tickets tied to the authenticated user, target, current download permission, and unchanged scope; HEAD probes do not consume tickets.
- Archive selections limited to 1,000 items and 64 KiB of serialized paths, with budgets of eight pending tickets/two active streams per user and 64 tickets/eight streams application-wide.
- Live-view archive generation that reports concurrent file-size changes as failures; TAR downloads do not support byte ranges or filesystem snapshots.
- Byte ranges support compatible download clients; ETag/If-Range validation is not implemented.

## Upload intake and integrity

- Multi-file picker and drag-and-drop into the current folder, upload dialog, or an individual folder row/card.
- Choose-folder picker in supporting browsers and recursive folder drag-and-drop preserve the selected root and nested paths under the destination folder.
- Each folder-upload file becomes an independent transfer with its own destination, checksum manifest, progress, pause/resume, and cancellation; identical basenames in different folders remain separate files.
- Folder drag-and-drop accepts mixed files and directories and reads every directory batch, including folders with more than 100 entries.
- The upload dialog shows directory-scanning and error states; closing the dialog or navigating away cancels its scan, and unreadable selections fail before any partial selection is queued.
- All selected relative paths are validated before queueing, rejecting traversal, reserved names, unsupported components, mismatched filenames, and destination paths longer than 4,096 characters.
- Parent folders are created as needed within the user's scope and existing directories are reused; conflicting files are reported and existing files are preserved.
- Empty directories are omitted; canceling a transfer removes its owned upload data while retaining any parent folders already created.
- Browser upload queue processes one file at a time while allowing one, two, or four parallel connections inside the current chunk.
- Default 100 MiB chunks, configurable from 64 KiB to 100 MiB, with a general ceiling of 1 TiB and 12,000 chunks subject to target limits.
- Frontend size/multipart checks before hashing and independent server-side manifest validation.
- Background worker scans the complete source using 4 MiB read buffers and computes an ordered SHA-256 chunk manifest.
- Immutable manifest identity covers source size, chunk size, and chunk hashes; target and destination are fixed separately in the session.
- Strict sequential chunk commits: chunk N+1 cannot begin before chunk N is acknowledged.
- Exact part offsets and lengths, random attempt fencing tokens, and rejection of duplicate parts, stale attempts, and out-of-order chunks.
- Streaming binary part reception into one temporary chunk, with disjoint offsets for parallel parts and bounded memory use.
- Entire staged chunk verified against its manifest hash before committing to the storage backend.
- Whole-attempt rollback on incomplete, oversized, corrupted, or interrupted parts, including closure of sibling streams.
- Both final and pending names reserved per target; matching active manifests for the same owner/destination reuse the existing session.
- Empty-file uploads and names up to 255 UTF-8 bytes; long pending names use a safely truncated basename and deterministic hash suffix.
- Up to 64 unfinished sessions across the application, including retained failed/canceling sessions.
- Visible `.uploading` entries show saved bytes; local targets use hard-link aliases and remote targets use virtual browser entries.
- Managed unfinished files cannot be previewed or downloaded and direct conflicting mutations are blocked.

## Upload durability and recovery

- SQLite checkpoints advance only after storage commit verification and persist before acknowledgment.
- Repeated earlier chunk commits and lost acknowledgments return saved progress without duplicating bytes.
- Browser reload recovery lists retained sessions; selecting the original file verifies size and the full manifest before resuming.
- Started folder-upload sessions retain each file's nested destination across reload and resume by selecting that file's original source; files queued only in browser memory must be selected again.
- Existing sessions retain their original chunk size after runtime configuration changes.
- Local startup recovery restores missing owned pending aliases, truncates unacknowledged tails, and reconciles interrupted publication/cancellation.
- Remote recovery runs on resume, completion, or cancellation so an offline remote does not block unrelated targets at startup.
- Durable backend receipts for S3, FTP/FTPS, and SFTP; resume validates saved remote checkpoints before advancing.
- Publication begins only when every chunk is committed and exposes the final name without concatenating or allocating another full local payload.
- Local growing payload plus at most one temporary chunk per session; remote transfers retain at most one local chunk plus receipt metadata.
- Recoverable publishing and canceling states, with owned stage cleanup and orphan cleanup that preserve unrelated final files and pending-name replacements.
- Missing or damaged acknowledged data produces a visible data-loss failure instead of silently advancing progress; local checkpoints validate identity and length rather than continually rehashing saved bytes.
- Capacity checks before initialization/chunks where supported, plus disk-full/quota errors that retain committed progress for later resume.
- Transient chunk failures retry with exponential backoff and jitter, checking authoritative progress first; retries stop after eight consecutive failures for manual intervention.
- Authentication, permission, missing-session, destination-conflict, data-loss, and disk-full conditions stop automatic chunk retries.
- Target disabling or read-only policy preserves saved uploads for later recovery when access becomes writable again.
- Upload guarantees reflect adapter and filesystem support; SFTP cannot flush every parent directory, and FTP lacks portable durable flush/exclusive publication.

## Transfer management

- Transfer table across targets with filename, destination, state, percentage, file size, current chunk, verified bytes, speed, and estimated time remaining.
- Visible queued, hashing, uploading, verifying, reconnecting, paused, needs-file, completed, and failed states.
- Pause and resume controls, original-file selection after reload, and manual recovery of failed transfers.
- Cancel confirmation shows saved progress to discard; cancellation removes owned temporary data and can be retried after interrupted cleanup.
- Change connections per chunk between 1×, 2×, and 4× for subsequent attempts.
- All, in-progress, and completed filters, plus browser-local clearing of completed rows without deleting server history or files.
- Aggregate active/running counts, remaining bytes, throughput, and overall progress.
- Sidebar/status-bar transfer summaries, attention counts, and completion notifications.
- Read-only/unavailable-target controls prevent browser transfer actions when current access does not permit upload.
- Tab-close warning while queued or active work is present; committed server progress survives interrupted browser work.
- Server retains transfer history and exposes the user's latest 200 records through the transfer API.

## Network sharing (SMB)

- Optional Samba companion for authenticated, read-only SMB3 exports of local target directories to Finder, Explorer, and other SMB clients.
- Administrator share creation with name, local target, directory, and owner; enable, disable, remove, and credential-reset actions in Settings.
- Exports restricted to directories inside the owner's scope with both read and download access; remote targets do not support native directory export.
- Separate high-entropy SMB credentials per user, reused across that user's shares; password reset applies to all their SMB shares.
- New protocol passwords returned only when issued and shown in a copy/show-hide dialog; plaintext passwords are not persisted or returned by listing APIs.
- Member visibility limited to their own share connection details, with scoped paths and copyable SMB addresses.
- Configurable public SMB hostname/IP, with the web hostname used by the UI by default.
- Share states and explanations for active, pending, disabled, blocked, and unavailable service/access conditions.
- Required SMB encryption/signing and NTLMv2 authentication; guest access, SMB1, symlink following, and private `.filebrowser-*` paths are blocked.
- All `.uploading` names hidden and inaccessible through SMB, including ordinary files with that suffix.
- Device/inode checks for mounted roots and shared directories; changed/missing directories are blocked individually while unaffected shares remain usable.
- Physical read-only file mounts and reproduction of the application's UID, GID, and supplementary groups for filesystem reads.
- Permission, account, share, and protocol-credential changes replace the SMB daemon and close existing desktop connections.
- Browser password changes/resets disable the user's SMB grants and invalidate protocol credentials until reset and re-enabled.
- Atomic bounded policy publication, a two-second heartbeat, and a ten-second lease that closes SMB access when policy renewal stops or becomes invalid.
- Companion restart reconstructs managed configuration and password files from current policy, excluding orphan definitions/credentials; up to 200 shares are supported.
- Committed account/share changes and newly issued credentials survive control-publication failures; availability is reported and saved policy is reapplied after repair.
- Share removal requires companion acknowledgment before releasing directories for rename/deletion; offline removal disables access and remains retryable.
- Share names and paths validated against Samba parsing constraints; `%` paths and paths ending in whitespace cannot be exported.

## Interface, preferences, and accessibility

- Light, dark, and system themes with compact or comfortable density and appearance applied before first paint.
- Browser-local persistence of theme, density, layout, sorting, inspector visibility, and connection count, synchronized across components/tabs.
- Responsive desktop/tablet/mobile layouts for navigation, file views, transfer summaries, settings, viewers, and administration.
- Command palette with fuzzy matching for navigation, file actions, appearance changes, shortcuts, sign-out, and direct folder paths.
- Keyboard shortcuts for workspace navigation, filtering, upload, folder creation, refresh, inspector toggle, rename, and delete.
- Keyboard file/grid cursor navigation, range selection, Home/End/Page movement, Ctrl/Command+A, parent navigation, and Enter/Space actions.
- Keyboard viewer navigation and an in-app shortcut reference; shortcuts respect text inputs, dialogs, and menus.
- Accessible dialog labels, focus trapping/restoration, inert backgrounds, and topmost-dialog Escape handling.
- Keyboard-operable context menus, visible focus indicators, screen-reader labels, live progress/status messages, and reduced-motion support.
- Success/error toasts with dismissal, timed expiration, and hover-to-pause behavior; contextual tooltips support pointer and keyboard focus.
- Locally bundled fonts, icons, and frontend assets for a self-hosted interface.

## Audit and observability

- Persistent audit events for setup, sign-in, password changes, account/access edits, target changes, file mutations, upload lifecycle, share lifecycle/credentials, and workspace settings.
- Administrator activity view for the 100 most recent events, including timestamp, actor, action, target association where recorded, and detail.
- Activity search by actor, detail, action/label, or target; filters for files, uploads, authentication, and administration.
- System information API with accessible target capacities/errors, account count for administrators, active upload count, and application version.
- Storage usage meters in the sidebar/settings and explicit unknown-capacity or unavailable-target messages.
- `/health` endpoint returns service status and build commit identifier; container health checks and companion health checks are provided.
- Configurable server log level and structured HTTP errors for validation, permissions, storage conflicts, unavailable targets, and disk/quota exhaustion.
- Credential-redacted target responses, generic unexpected-error messages, and audit entries that omit target connection secrets.

## Security and isolation

- Authenticated file API with same-origin session cookies; write requests require `X-Filebrowser-Request: 1` and origin verification.
- Strict input schemas, UUID/session validation, JSON body limits, bounded manifests, and binary upload length validation.
- Path normalization rejects traversal segments, backslashes, control characters, and case-insensitive reserved `.filebrowser-*` components.
- Shared browser/API filename validation enforces addressable names up to 255 UTF-8 bytes, including multibyte Unicode names; unsupported native names are skipped instead of breaking listings or archives.
- Local and remote filesystem path checks reject symlinks and special files; local file opens use no-follow semantics.
- Private application state kept outside visible local targets or inside reserved namespaces, with private state directories/database/key file permissions.
- Security headers for content-type sniffing, framing, referrers, and no-store API caching; file/preview responses have a restrictive sandbox Content Security Policy.
- Exclusive SQLite process lock for application state and additional locks for writable local storage roots.
- Download/archive concurrency budgets, unfinished-upload limits, and bounded caches/stream buffers to control resource use.
- Production static serving rejects missing API/asset paths instead of serving the SPA and does not expose the server bundle from the frontend root.

## Deployment and distribution

- Linux hosting with Node.js 24+ and SQLite built into Node; no external database service or generated ORM client is required.
- Native production build/start, portable runtime packages, and a sample systemd service.
- Docker runtime runs as an unprivileged user with separate persistent file/state volumes and loopback-only published web access by default in Compose.
- Complete published image includes production Node dependencies, CA certificates, Samba, and SMB account/configuration tools; Compose reuses it for the web service and optional root-run companion.
- Configurable listen host/port, private state location, setup path suggestion, upload limits, public origin, Secure cookies, logging, and build commit.
- HTTPS reverse-proxy configuration for same-origin checks, secure sessions, streamed upload bodies, and long transfers.
- Graceful SIGINT/SIGTERM shutdown closes streams, attempts, targets, shares, and database locks.
- One current state schema, initialized only in an empty database, without schema migrations or alternate configuration/API aliases.
- Portable runtime packaging includes compiled server/client assets, exact production dependency versions, licenses/notices, deployment guidance, service examples, source commit metadata, and server SHA-256.
- Source archive packaging requires a clean committed tree, excludes Git history, rejects private/generated artifacts, and writes a SHA-256 sidecar.
- CI calls a dedicated reusable image workflow after application/browser, native SMB, and remote storage checks; builds Linux AMD64/ARM64 images for main, develop, and version tags, and builds pull requests without publishing.
- GHCR publication with branch/version/commit tags, source commit health metadata, OCI labels, and keyless Cosign signing/verification through GitHub OIDC.
- Backup guidance covers SQLite/WAL, target encryption keys, file volumes, mounted upload stages, and local/remote receipt metadata.
- Bundled third-party notices and licenses available alongside built frontend assets and release packages.

## Verification tooling

- Lint, TypeScript checks, production builds, Node backend tests, and Playwright browser checks through project scripts.
- HTTP tests for setup/authentication, permission changes, target isolation, path security, read-only operation, download metadata, and archive resource budgets.
- Upload tests for real 100 MiB chunks, parallel parts, ordering, checksum rollback, lost acknowledgments, stale attempts, pending-name collisions, and reload recovery.
- Process-SIGKILL fault fixtures for interruption during append, publication, and cancellation, plus missing/corrupted saved-data checks.
- Mounted-filesystem fixtures verify destination-device staging and recovery; container checks exercise disk exhaustion, bounded staging, and large sequential transfers.
- Native MinIO, FTP, certificate-verified FTPS, and OpenSSH fixtures for remote CRUD, range reads, archives, uploads, reconnection, credential repair, and crash recovery.
- Native SMB fixtures verify desktop access, read-only enforcement, revocation, restart reconstruction, lease expiry, delayed policies, and control-publication failures.
- Browser workflows cover setup, scoped members, file actions, previews, native downloads/TARs, worker hashing, resume, target switching, mobile layout, and appearance persistence across reload.
- Folder-upload browser checks exercise the native folder picker, nested paths, duplicate basenames, Unicode names, empty files, directory reuse, per-file reload recovery, drop destinations, ancestor refresh, permission restrictions, and recursive deletion with partial-failure reporting.
- Directory-intake tests cover listings spanning multiple browser batches, mixed file/folder drops, invalid paths, unreadable entries, and scan cancellation.
- File-rule checks cover UTF-8 filename limits, reserved names, managed upload suffixes, and text-preview boundaries.
- Portable-runtime relocation/boot tests and source-package checks for notices, static assets, clean-tree requirements, and private/generated file exclusion.
- Large-transfer checks include 1 GiB payloads and 200 GiB manifests; full 200 GB payloads and physical power-loss behavior have not been verified.
