# Changelog

## Unreleased

Planned initial release (`0.1.0`).

- First-run administrator setup and revocable authenticated sessions.
- Named local, S3, FTP/FTPS and SFTP targets with encrypted credentials and independent user grants, scopes and permissions.
- Application state and `.filebrowser-*` paths follow ordinary target scopes, permissions, and shares; administrators control their exposure without automatic state-directory exclusions.
- Browsing, folder creation, deletion, previews and byte-range downloads across all target types; file rename and filesystem-directory rename according to each adapter's capabilities.
- Recursive folder deletion across all targets, with confirmation, per-operation authorization checks, active upload/share protection, and listing refresh after partial failures.
- Streaming folder and mixed-selection TAR downloads, empty-directory preservation, and cancellation cleanup.
- Efficient HEAD metadata for files, ranges and archives; unsupported native names cannot break directory listings.
- Local target recovery failures do not block application startup; saved upload checkpoints remain available for retry.
- Target edits recheck administrator access before committing; active downloads recheck on access changes and expire even when their sources stall, without per-buffer database queries.
- Pending-file progress follows upload session identity across scoped folders and shortened long filenames.
- Targets as the first level of My files, target and folder breadcrumbs, and parent navigation back to the target list.
- Read-only targets and mounts, explicit target-qualified state and routes, and Ctrl/Command+Up navigation.
- Signed GHCR container publishing for Linux AMD64 and ARM64 after CI verification.
- Resumable uploads with SHA-256 manifests, sequential 100 MiB chunks, up to four connections within a chunk, and durable crash recovery.
- Folder picker and recursive drag-and-drop with preserved directory paths and independent resumable file transfers.
- Visible `.uploading` entries, bounded remote multipart/offset writes and publication without local full-file assembly; local staging on the destination filesystem across mounted volumes.
- Responsive light/dark UI, keyboard navigation, a command palette, transfer controls, and stable throughput display.
- Folder navigation and refreshes reject stale responses to avoid stuck or outdated listings.
- Container and native deployment, portable runtime packaging, and reproducible backend/browser verification.
- Optional Samba companion for authenticated, read-only SMB3 directory exports, per-user protocol credentials, scope enforcement, session revocation and directory identity checks.
